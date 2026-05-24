import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMasterDir } from "./agents/io.js";
import { AGENTS } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import { masterDir, readConfig } from "./agentforge-config.js";
import { LANG_INSTRUCTIONS, type Lang } from "./skills-data.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const OK = `${GREEN}✓${RESET}`;
const WARN = `${YELLOW}⚠${RESET}`;
const FAIL = `${RED}✗${RESET}`;

const AGENT_FILES: Record<AgentId, { dir: string; guide: string }> = {
  claude: { dir: ".claude/skills", guide: "CLAUDE.md" },
  cursor: { dir: ".cursor/rules", guide: ".cursorrules" },
  codex: { dir: ".agents/skills", guide: "AGENTS.md" },
};

export type DoctorOptions = { pathArg?: string };

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());
  let issues = 0;
  let warnings = 0;

  console.log(`${BOLD}🩺 agentforge doctor${RESET}  ${DIM}${root}${RESET}\n`);

  // ── Workspace ──────────────────────────────────────────────────────
  console.log(`${BOLD}Workspace${RESET}`);
  const cfg = readConfig(root);
  if (!cfg) {
    console.log(`  ${FAIL} not initialized — no agentforge/config.json`);
    console.log(
      `    ${DIM}run ${CYAN}agentforge init${RESET}${DIM} here to set one up${RESET}\n`,
    );
    printToolsSection();
    process.exit(1);
  }

  console.log(
    `  ${OK} config.json  ${DIM}(v${1}, lang=${cfg.lang}, agents=${
      cfg.agents.join(", ") || "—"
    })${RESET}`,
  );

  const md = masterDir(root);
  if (!existsSync(md)) {
    console.log(`  ${FAIL} master skills directory missing: ${md}`);
    issues++;
  } else {
    const { skills, skipped, warnings: masterWarnings } = readMasterDir(md);
    console.log(
      `  ${OK} master skills  ${DIM}(${skills.length} valid)${RESET}`,
    );
    if (skipped.length > 0) {
      console.log(
        `  ${FAIL} ${skipped.length} invalid master file(s) — ${DIM}skipped during sync${RESET}`,
      );
      for (const s of skipped) {
        console.log(`    ${DIM}- ${s.file}: ${s.reason}${RESET}`);
      }
      issues += skipped.length;
    }
    if (masterWarnings.length > 0) {
      console.log(
        `  ${WARN} ${masterWarnings.length} master file warning(s)`,
      );
      for (const w of masterWarnings) {
        console.log(`    ${DIM}- ${w.file}: ${w.warning}${RESET}`);
      }
      warnings += masterWarnings.length;
    }
  }

  // ── Agents ─────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Agents${RESET}`);
  if (cfg.agents.length === 0) {
    console.log(`  ${WARN} no agents installed — run ${CYAN}agentforge add-agent${RESET}`);
    warnings++;
  } else {
    const masterIds = existsSync(md)
      ? new Set(readMasterDir(md).skills.map((s) => s.id))
      : new Set<string>();

    for (const id of cfg.agents) {
      const adapter = AGENTS.find((a) => a.id === id);
      const label = adapter?.label ?? id;
      const { dir, guide } = AGENT_FILES[id];
      const dirAbs = join(root, dir);
      const guideAbs = join(root, guide);

      const dirExists = existsSync(dirAbs);
      const guideExists = existsSync(guideAbs);
      const present = dirExists ? countSkills(id, dirAbs) : new Set<string>();
      const missing = [...masterIds].filter((mid) => !present.has(mid));
      const orphans = [...present].filter((pid) => !masterIds.has(pid));

      if (!dirExists || !guideExists) {
        console.log(
          `  ${FAIL} ${label}  ${DIM}${
            !dirExists ? `${dir} missing` : `${guide} missing`
          }${RESET}`,
        );
        console.log(
          `    ${DIM}run ${CYAN}agentforge sync-skills${RESET}${DIM} to regenerate${RESET}`,
        );
        issues++;
        continue;
      }

      const noteParts: string[] = [`${present.size} skill${present.size === 1 ? "" : "s"}`];
      if (missing.length > 0) noteParts.push(`${YELLOW}${missing.length} not propagated${DIM}`);
      if (orphans.length > 0) noteParts.push(`${YELLOW}${orphans.length} orphan${DIM}`);

      const mark = missing.length === 0 && orphans.length === 0 ? OK : WARN;
      console.log(
        `  ${mark} ${label}  ${DIM}(${noteParts.join(", ")})${RESET}`,
      );
      if (missing.length > 0) {
        console.log(
          `    ${DIM}missing:${RESET} ${missing.join(", ")}  ${DIM}→ ${CYAN}agentforge sync-skills${RESET}`,
        );
        warnings++;
      }
      if (orphans.length > 0) {
        console.log(
          `    ${DIM}orphan: ${orphans.join(", ")}  → ${CYAN}agentforge remove-skill <id>${RESET}`,
        );
        warnings++;
      }
    }

    // Whole-agent orphans: agent dir/guide present but agent NOT in config.
    // Happens when the user manually deletes from config or copies an
    // existing tree from elsewhere.
    for (const id of Object.keys(AGENT_FILES) as AgentId[]) {
      if (cfg.agents.includes(id)) continue;
      const { dir, guide } = AGENT_FILES[id];
      const hasDir = existsSync(join(root, dir));
      const hasGuide = existsSync(join(root, guide));
      if (hasDir || hasGuide) {
        const label = AGENTS.find((a) => a.id === id)?.label ?? id;
        const which = [hasDir ? dir : null, hasGuide ? guide : null]
          .filter(Boolean)
          .join(", ");
        console.log(
          `  ${WARN} ${label}  ${DIM}files present but not in config: ${which}${RESET}`,
        );
        console.log(
          `    ${DIM}→ ${CYAN}agentforge add-agent ${id}${RESET}${DIM} to re-register, or ${CYAN}agentforge remove-agent ${id}${RESET}${DIM} to clean up${RESET}`,
        );
        warnings++;
      }
    }
  }

  // ── Lang drift ─────────────────────────────────────────────────────
  // config.lang is supposed to reflect what's actually written into master
  // skills (the {{OUTPUT_LANGUAGE_INSTRUCTION}} placeholder is substituted at
  // init time). If someone edited config.lang by hand, the master content
  // now lies — agents will respond in the wrong language.
  const drift = detectLangDrift(md, cfg.lang);
  if (drift) {
    console.log(`\n${BOLD}Language${RESET}`);
    console.log(
      `  ${WARN} config.lang=${BOLD}${cfg.lang}${RESET}${DIM} but master files were written for ${BOLD}${drift}${RESET}${DIM}.${RESET}`,
    );
    console.log(
      `    ${DIM}→ ${CYAN}agentforge init ${root} --lang ${cfg.lang} --force-skills${RESET}${DIM} to rewrite master files, then ${CYAN}agentforge sync-skills${RESET}`,
    );
    warnings++;
  }

  // ── External tools ─────────────────────────────────────────────────
  printToolsSection();

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`${BOLD}Summary${RESET}`);
  if (issues === 0 && warnings === 0) {
    console.log(`  ${OK} workspace is healthy.`);
    process.exit(0);
  }
  if (issues > 0) console.log(`  ${FAIL} ${issues} issue${issues === 1 ? "" : "s"}`);
  if (warnings > 0)
    console.log(`  ${WARN} ${warnings} warning${warnings === 1 ? "" : "s"}`);
  process.exit(issues > 0 ? 1 : 0);
}

/**
 * Walk master skills and decide which lang their substituted
 * {{OUTPUT_LANGUAGE_INSTRUCTION}} block actually matches. Returns the
 * detected lang if it differs from `expected`, or null if they agree (or if
 * we can't tell — e.g. no master files, or no language section).
 */
function detectLangDrift(md: string, expected: Lang): Lang | null {
  if (!existsSync(md)) return null;
  const langs: Lang[] = ["en", "ko", "ja"];
  const entries = readdirSync(md, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .slice(0, 3); // sample a few; checking all 9 would be wasteful
  if (entries.length === 0) return null;

  for (const file of entries) {
    let body: string;
    try {
      body = readFileSync(join(md, file), "utf8");
    } catch {
      continue;
    }
    for (const l of langs) {
      if (body.includes(LANG_INSTRUCTIONS[l])) {
        return l === expected ? null : l;
      }
    }
  }
  return null;
}

function countSkills(agent: AgentId, dir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (agent === "claude" && e.isDirectory()) ids.add(e.name);
    else if (agent === "cursor" && e.isFile() && e.name.endsWith(".mdc"))
      ids.add(e.name.slice(0, -4));
    else if (agent === "codex" && e.isFile() && e.name.endsWith(".md"))
      ids.add(e.name.slice(0, -3));
  }
  return ids;
}

function printToolsSection() {
  console.log(`\n${BOLD}External tools${RESET}`);
  printTool("git", ["--version"], "required for worktrees + history");
  printTool("gh", ["--version"], "needed by pr-create / pr-review-analyze / incident-context");
  const editor = process.env["VISUAL"] || process.env["EDITOR"];
  if (editor) {
    console.log(`  ${OK} $EDITOR  ${DIM}${editor}${RESET}`);
  } else {
    console.log(
      `  ${WARN} $EDITOR not set  ${DIM}— ${CYAN}agentforge add-skill${RESET}${DIM} falls back to vim/nano${RESET}`,
    );
  }
  console.log(`  ${OK} node  ${DIM}${process.version}${RESET}\n`);
}

function printTool(cmd: string, args: string[], purpose: string) {
  try {
    const out = execSync(`${cmd} ${args.join(" ")}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .split("\n")[0];
    console.log(`  ${OK} ${cmd}  ${DIM}${out}${RESET}`);
  } catch {
    console.log(`  ${FAIL} ${cmd} not found  ${DIM}— ${purpose}${RESET}`);
  }
}

