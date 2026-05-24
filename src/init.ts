import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pickAgents } from "./agent-prompt.js";
import {
  ensureDir,
  readMasterDir,
  renderTemplate,
  setVerbose,
  writeRendered,
} from "./agents/io.js";
import { AGENTS, getAgent } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import { configPath, masterDir, upsertConfig } from "./agentforge-config.js";
import { pickLanguage } from "./lang-prompt.js";
import { printLogo } from "./logo.js";
import { promptPath } from "./path-prompt.js";
import { pickSkills } from "./skill-prompt.js";
import { LANG_LABEL, SKILLS, type Lang, type SkillSpec } from "./skills-data.js";

const BASE_DIRS = ["repos", "anvil", "artifacts"];

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export type InitOptions = {
  pathArg?: string;
  forceSkills: boolean;
  forceClaude: boolean;
  yes: boolean;
  lang?: Lang;
  agents?: AgentId[];
};

export async function runInit(opts: InitOptions): Promise<void> {
  // Pre-flight validation (before logo / prompts) for the explicit-path case.
  if (opts.pathArg) {
    const targetAbs = resolve(opts.pathArg);

    // (a) refuse filesystem root — would try to mkdir /repos, /anvil etc.
    if (targetAbs === dirname(targetAbs)) {
      process.stderr.write(
        `\nerror: ${targetAbs} is the filesystem root — pick a real directory to host the workspace.\n\n`,
      );
      process.exit(1);
    }

    // (b) refuse if target sits inside another agentforge workspace —
    //     workspaces shouldn't nest (repos/ is meant for git checkouts).
    if (!opts.forceSkills && !opts.forceClaude) {
      const outer = findEnclosingWorkspace(targetAbs);
      if (outer && outer !== targetAbs) {
        process.stderr.write(
          `\n${YELLOW}⚠${RESET} ${targetAbs} sits inside another agentforge workspace:\n` +
            `  ${DIM}${outer}${RESET}\n\n` +
            `  Workspaces shouldn't nest. ${DIM}repos/${RESET} is meant for ${BOLD}git checkouts${RESET}, not nested workspaces.\n` +
            `  Pick a path outside ${DIM}${outer}${RESET}, or pass ${CYAN}--force${RESET} to override.\n\n`,
        );
        process.exit(1);
      }
    }

    // (c) already-initialized? — block re-init (drift trap from earlier).
    if (!opts.forceSkills && !opts.forceClaude && existsSync(configPath(targetAbs))) {
      printAlreadyInitialized(targetAbs);
      process.exit(1);
    }

    // (d) dir exists and has unrelated content — refuse before scrambling
    //     workspace files in among the user's project.
    if (!opts.forceSkills && !opts.forceClaude) {
      const intruders = unexpectedEntries(targetAbs);
      if (intruders.length > 0) {
        printNotEmpty(targetAbs, intruders);
        process.exit(1);
      }
    }
  }

  printLogo();

  const targetPath = await resolveTargetPath(opts);
  const targetAbs = resolve(targetPath);

  // Same checks for the interactive path (no --path arg given).
  if (
    !opts.forceSkills &&
    !opts.forceClaude &&
    existsSync(configPath(targetAbs))
  ) {
    printAlreadyInitialized(targetAbs);
    process.exit(1);
  }
  if (!opts.forceSkills && !opts.forceClaude) {
    const intruders = unexpectedEntries(targetAbs);
    if (intruders.length > 0) {
      printNotEmpty(targetAbs, intruders);
      process.exit(1);
    }
  }

  const agentIds = await resolveAgents(opts);
  const lang = await resolveLanguage(opts);
  const selectedSkills = await selectSkills(opts, lang);

  const root = resolve(targetPath);

  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }

  // Workspace skeleton — quiet, one summary line.
  setVerbose(false);
  for (const dir of BASE_DIRS) {
    ensureDir(join(root, dir), dir);
  }
  ensureDir(masterDir(root), "agentforge/skills");
  setVerbose(true);
  line(
    `${GREEN}+${RESET} workspace skeleton  ${DIM}(${BASE_DIRS.join("/, ")}/, agentforge/)${RESET}`,
  );

  // Master skills — quiet writes, one summary line.
  setVerbose(false);
  let written = 0;
  for (const s of selectedSkills) {
    const rendered = renderTemplate(s.template, lang);
    const destAbs = join(masterDir(root), `${s.id}.md`);
    const destRel = `agentforge/skills/${s.id}.md`;
    writeRendered(destAbs, destRel, rendered, opts.forceSkills);
    written++;
  }
  upsertConfig(root, { version: 1, lang, agents: agentIds });
  setVerbose(true);
  line(
    `${GREEN}+${RESET} master skills        ${DIM}(${written} skill${written === 1 ? "" : "s"} → agentforge/skills/, + agentforge/config.json)${RESET}`,
  );

  // Adapter installs — quiet, one line per agent.
  const { skills: masterSkills, skipped } = readMasterDir(masterDir(root));
  if (skipped.length > 0) {
    for (const sk of skipped) {
      line(`  ${DIM}skipped master file ${sk.file} — ${sk.reason}${RESET}`);
    }
  }
  setVerbose(false);
  try {
    for (const id of agentIds) {
      const adapter = getAgent(id);
      adapter.install({
        root,
        masterSkills,
        skillCatalog: SKILLS.slice(),
        lang,
        forceSkills: opts.forceSkills,
        forceClaude: opts.forceClaude,
      });
      line(
        `${GREEN}+${RESET} ${adapter.label.padEnd(18)} ${DIM}(${adapter.outputSummary})${RESET}`,
      );
    }
  } finally {
    setVerbose(true);
  }

  printNextSteps(root, agentIds, lang);
}

async function resolveTargetPath(opts: InitOptions): Promise<string> {
  if (opts.pathArg) return opts.pathArg;
  if (opts.yes) return process.cwd();
  return promptPath("Workspace directory", process.cwd());
}

async function resolveAgents(opts: InitOptions): Promise<AgentId[]> {
  if (opts.agents && opts.agents.length > 0) return opts.agents;
  if (opts.yes) return ["claude"];
  // requireAtLeastOne: interactive picker won't return [] — it re-prompts.
  return pickAgents(opts.lang ?? "en", { requireAtLeastOne: true });
}

async function resolveLanguage(opts: InitOptions): Promise<Lang> {
  if (opts.lang) return opts.lang;
  if (opts.yes) return "en";
  return pickLanguage();
}

async function selectSkills(
  opts: InitOptions,
  lang: Lang,
): Promise<SkillSpec[]> {
  if (opts.yes) return SKILLS.slice();
  const ids = await pickSkills(
    SKILLS.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description[lang],
      details: s.details[lang],
    })),
  );
  return SKILLS.filter((s) => ids.includes(s.id));
}

function printNextSteps(
  root: string,
  agentIds: AgentId[],
  lang: Lang,
) {
  const repos = join(root, "repos");
  const repoCount = existsSync(repos)
    ? readdirSync(repos, { withFileTypes: true }).filter((d) => d.isDirectory())
        .length
    : 0;

  console.log("");
  console.log(
    `${BOLD}${GREEN}✓${RESET} workspace ready at ${CYAN}${root}${RESET}  ${DIM}(lang: ${LANG_LABEL[lang]})${RESET}`,
  );
  console.log("");
  console.log(`${BOLD}Next steps:${RESET}`);
  if (repoCount === 0) {
    console.log(
      `  cd ${root}/repos && git clone <repo-url>    ${DIM}# add repos to work with${RESET}`,
    );
    console.log(
      `  cd ${root} && ${launchHint(agentIds)}        ${DIM}# launch your agent${RESET}`,
    );
  } else {
    console.log(
      `  ${DIM}(found ${repoCount} repo${repoCount === 1 ? "" : "s"} in repos/)${RESET}`,
    );
    console.log(`  cd ${root} && ${launchHint(agentIds)}`);
  }
  console.log("");
  console.log(`${BOLD}Useful commands:${RESET}`);
  console.log(
    `  ${CYAN}agentforge list-skills${RESET}        ${DIM}# see what's installed${RESET}`,
  );
  console.log(
    `  ${CYAN}agentforge add-skill${RESET}          ${DIM}# create your own skill${RESET}`,
  );
  console.log(
    `  ${CYAN}agentforge sync-skills${RESET}        ${DIM}# propagate master edits to all agents${RESET}`,
  );
  console.log(
    `  ${CYAN}agentforge add-agent${RESET}          ${DIM}# add another agent later${RESET}`,
  );
  console.log("");
}

function launchHint(agentIds: AgentId[]): string {
  const cmds = agentIds.map((id) => {
    switch (id) {
      case "claude":
        return "claude";
      case "cursor":
        return "cursor .";
      case "codex":
        return "codex";
    }
  });
  return cmds.join("  /  ");
}

function line(s: string) {
  console.log(s);
}

/** Files / dirs that agentforge owns at the workspace root. Anything else
 * in the target dir means the user picked a path that's already in use. */
const WORKSPACE_ENTRIES = new Set<string>([
  ...BASE_DIRS,
  "agentforge",
  ".claude",
  ".cursor",
  ".agents",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
]);

/**
 * Return entries in `dir` that don't belong to agentforge. Dotfiles other
 * than agentforge's own (`.claude`, `.cursor`, `.agents`, `.cursorrules`) are
 * surfaced too — `.git/`, `.env`, IDE folders etc. mean this is already
 * someone's project.
 */
function unexpectedEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name !== ".DS_Store") // macOS OS noise
    .filter((name) => !WORKSPACE_ENTRIES.has(name))
    .sort();
}

function printNotEmpty(targetAbs: string, intruders: string[]) {
  const preview = intruders.slice(0, 6);
  const extra = intruders.length - preview.length;
  const list = preview
    .map((n) => `    ${DIM}-${RESET} ${n}`)
    .join("\n");
  const more = extra > 0 ? `\n    ${DIM}… and ${extra} more${RESET}` : "";
  process.stderr.write(
    `\n${YELLOW}⚠${RESET} ${targetAbs} isn't empty.\n\n` +
      `  It contains files that don't look like agentforge:\n${list}${more}\n\n` +
      `  agentforge would overlay its workspace structure (${DIM}repos/, anvil/, artifacts/, agentforge/${RESET}) on top.\n` +
      `  Pick an empty directory, or pass ${CYAN}--force${RESET} to proceed anyway (existing files are not touched, only the workspace structure is added).\n\n`,
  );
}

/**
 * Walk up from `start` looking for a parent directory that has
 * `agentforge/config.json`. Returns the workspace root if found, else null.
 * Returns `start` itself if `start` is already a workspace.
 */
function findEnclosingWorkspace(start: string): string | null {
  let cur = start;
  while (true) {
    if (existsSync(configPath(cur))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null; // reached FS root
    cur = parent;
  }
}

function printAlreadyInitialized(targetAbs: string) {
  process.stderr.write(
    `\n${YELLOW}⚠${RESET} ${targetAbs} is already an agentforge workspace.\n\n` +
      `  Use one of these instead:\n` +
      `    ${CYAN}agentforge add-agent${RESET}      ${DIM}# install another agent (Claude / Cursor / Codex)${RESET}\n` +
      `    ${CYAN}agentforge add-skill${RESET}      ${DIM}# create a new skill${RESET}\n` +
      `    ${CYAN}agentforge sync-skills${RESET}    ${DIM}# propagate master skill edits to every agent${RESET}\n` +
      `    ${CYAN}agentforge list-skills${RESET}    ${DIM}# see what's installed${RESET}\n` +
      `    ${CYAN}agentforge doctor${RESET}         ${DIM}# diagnose the workspace${RESET}\n\n` +
      `  Or pass ${CYAN}--force${RESET} to overwrite everything (existing files are backed up to .bak).\n\n`,
  );
}
