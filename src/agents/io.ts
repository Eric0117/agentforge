import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANG_INSTRUCTIONS, type Lang } from "../skills-data.js";
import type { MasterSkill } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = resolve(here, "..", "templates");

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let VERBOSE = true;

/**
 * Toggle progress logging for adapter file operations.
 * Used by `init` to quiet per-agent install output and instead print a single
 * summary line per agent.
 */
export function setVerbose(v: boolean): void {
  VERBOSE = v;
}

function logIf(s: string): void {
  if (VERBOSE) console.log(s);
}

export function ensureDir(full: string, label: string): void {
  if (existsSync(full)) {
    logIf(`${DIM}  exists:${RESET}  ${label}/`);
  } else {
    mkdirSync(full, { recursive: true });
    logIf(`${GREEN}+${RESET} created: ${label}/`);
  }
}

/**
 * Render a template with the language placeholder substituted.
 */
export function renderTemplate(templateName: string, lang: Lang): string {
  const src = join(TEMPLATES, templateName);
  if (!existsSync(src)) {
    throw new Error(`template missing: ${src}`);
  }
  return readFileSync(src, "utf8").replaceAll(
    "{{OUTPUT_LANGUAGE_INSTRUCTION}}",
    LANG_INSTRUCTIONS[lang],
  );
}

/**
 * Write content to dst, respecting force / backup semantics:
 *  - if dst exists and !force → skip with a message
 *  - if dst exists and force → write a .bak alongside, then overwrite
 *  - otherwise → write fresh
 */
export function writeRendered(
  dst: string,
  destRel: string,
  content: string,
  force: boolean,
): void {
  const exists = existsSync(dst);
  if (exists && !force) {
    logIf(
      `${YELLOW}  skipped:${RESET} ${destRel}  ${DIM}(exists; use --force / --force-skills / --force-claude to overwrite)${RESET}`,
    );
    return;
  }
  if (exists && force) {
    // Pick a .bak name that doesn't already exist — preserves prior backups
    // from earlier sync-skills runs instead of silently overwriting them.
    let bak = `${dst}.bak`;
    let bakRel = `${destRel}.bak`;
    let n = 2;
    while (existsSync(bak)) {
      bak = `${dst}.bak.${n}`;
      bakRel = `${destRel}.bak.${n}`;
      n++;
    }
    writeFileSync(bak, readFileSync(dst, "utf8"));
    logIf(`${DIM}  backup:${RESET}  ${bakRel}`);
  }
  // make sure parent dir exists
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, content);
  logIf(`${GREEN}+${RESET} wrote:   ${destRel}`);
}

/**
 * Split a SKILL.md.tpl into its YAML frontmatter and body.
 * Returns { frontmatter: Record, body: string } where frontmatter is parsed
 * loosely (only top-level key: value pairs; multi-line values are joined).
 */
/** Valid skill id: lowercase kebab-case, must start with a letter. */
const SKILL_ID_RE = /^[a-z][a-z0-9-]*$/;

export type MasterScanResult = {
  skills: MasterSkill[];
  /** Files we couldn't load at all — they don't make it into adapter output. */
  skipped: Array<{ file: string; reason: string }>;
  /** Files that loaded but have a minor inconsistency worth telling the user. */
  warnings: Array<{ file: string; warning: string }>;
};

/**
 * Read the workspace master skills directory and parse every `*.md` file.
 * Tolerant of files the user dropped in by hand: invalid file names, missing
 * frontmatter, and `name:`/filename mismatches are surfaced as
 * `skipped` (hard fail) or `warnings` (soft) — the rest still flow through.
 */
export function readMasterDir(masterDirAbs: string): MasterScanResult {
  if (!existsSync(masterDirAbs)) {
    return { skills: [], skipped: [], warnings: [] };
  }
  // Guard: someone may have created `agentforge/skills` as a file by hand.
  try {
    if (!statSync(masterDirAbs).isDirectory()) {
      return {
        skills: [],
        skipped: [
          {
            file: masterDirAbs,
            reason: "exists but is not a directory — remove it and run `agentforge init --force-skills` to recreate",
          },
        ],
        warnings: [],
      };
    }
  } catch (e) {
    return {
      skills: [],
      skipped: [{ file: masterDirAbs, reason: `unreadable: ${(e as Error).message}` }],
      warnings: [],
    };
  }

  const allEntries = readdirSync(masterDirAbs, { withFileTypes: true });
  const entries = allEntries
    .filter((e) => e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();

  const skills: MasterSkill[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  const warnings: Array<{ file: string; warning: string }> = [];

  // Surface broken symlinks separately — they vanish from the normal
  // file scan, which makes them very confusing.
  const dangling = new Set<string>();
  for (const e of allEntries) {
    if (!e.name.endsWith(".md")) continue;
    const abs = join(masterDirAbs, e.name);
    try {
      const lst = lstatSync(abs);
      if (lst.isSymbolicLink() && !existsSync(abs)) {
        skipped.push({
          file: e.name,
          reason: "dangling symlink — target doesn't exist",
        });
        dangling.add(e.name);
      }
    } catch {
      /* ignore */
    }
  }

  for (const file of entries) {
    if (dangling.has(file)) continue; // already reported above
    const id = file.slice(0, -3); // strip `.md`

    // (1) filename validity — agent adapters use this id as a directory /
    // filename, so we have to be strict.
    if (!SKILL_ID_RE.test(id)) {
      skipped.push({
        file,
        reason: `invalid skill id "${id}" — must be kebab-case (lowercase letters/digits/hyphens, start with a letter)`,
      });
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(join(masterDirAbs, file), "utf8");
    } catch (e) {
      skipped.push({ file, reason: `unreadable: ${(e as Error).message}` });
      continue;
    }

    const { frontmatter, body } = splitFrontmatter(raw);

    // (2) required frontmatter
    if (!frontmatter["name"] || !frontmatter["description"]) {
      skipped.push({
        file,
        reason: "missing frontmatter `name:` or `description:`",
      });
      continue;
    }

    // (2.5) YAML block scalars (`description: |` / `>`) — our parser only
    // reads the first line of each key, so the multiline body would silently
    // be lost. Reject with a clear hint to use a single-line description.
    if (
      frontmatter["description"] === "|" ||
      frontmatter["description"] === ">" ||
      frontmatter["description"]?.startsWith("|") ||
      frontmatter["description"]?.startsWith(">")
    ) {
      skipped.push({
        file,
        reason: "`description:` uses a YAML block scalar (`|` / `>`) which agentforge doesn't support — write it as one line on the same row as `description:`",
      });
      continue;
    }

    // (3) frontmatter `name:` must itself be kebab-case — agents echo it.
    if (!SKILL_ID_RE.test(frontmatter["name"])) {
      skipped.push({
        file,
        reason: `frontmatter \`name: ${frontmatter["name"]}\` is not kebab-case (lowercase letters/digits/hyphens, start with a letter)`,
      });
      continue;
    }

    // (4) frontmatter name vs filename mismatch — adapters would emit one as
    // the dir/file and the other inside the frontmatter, so we'd ship two
    // different identities for the same skill. Skip rather than propagate.
    if (frontmatter["name"] !== id) {
      skipped.push({
        file,
        reason: `frontmatter \`name: ${frontmatter["name"]}\` doesn't match the filename id \`${id}\`. Rename the file or the \`name:\` field so they agree, then re-run \`agentforge sync-skills\`.`,
      });
      continue;
    }

    // (4) suspiciously empty body — only HTML comments / whitespace.
    const stripped = body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, "")
      .trim();
    if (stripped.length < 20) {
      warnings.push({
        file,
        warning:
          "body looks like a placeholder (no real content yet). Fill it in and re-run `agentforge sync-skills`.",
      });
    }

    skills.push({ id, frontmatter, body, raw });
  }

  return { skills, skipped, warnings };
}

/**
 * Write a single master skill file. Honors force/backup semantics
 * shared with adapter writes.
 */
export function writeMasterSkill(
  masterDirAbs: string,
  id: string,
  content: string,
  force: boolean,
): void {
  const dst = join(masterDirAbs, `${id}.md`);
  const destRel = `agentforge/skills/${id}.md`;
  writeRendered(dst, destRel, content, force);
}

export function splitFrontmatter(
  rendered: string,
): { frontmatter: Record<string, string>; body: string } {
  if (!rendered.startsWith("---")) {
    return { frontmatter: {}, body: rendered };
  }
  const end = rendered.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: rendered };
  const head = rendered.slice(4, end); // skip leading "---\n"
  const body = rendered.slice(end + 4).replace(/^\n+/, "");

  const fm: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const raw of head.split("\n")) {
    const m = raw.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) {
      currentKey = m[1];
      // Trim trailing whitespace so invisible spaces don't tank later
      // validation (e.g. `name: my-skill   ` failing SKILL_ID_RE).
      fm[currentKey] = m[2].trimEnd();
    } else if (currentKey && raw.trim() !== "") {
      // continuation line for the previous key
      fm[currentKey] = `${fm[currentKey]} ${raw.trim()}`.trim();
    }
  }
  return { frontmatter: fm, body };
}
