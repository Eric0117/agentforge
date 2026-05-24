import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readMasterDir } from "./agents/io.js";
import { getAgent } from "./agents/index.js";
import { masterDir, requireWorkspace } from "./agentforge-config.js";
import { SKILLS } from "./skills-data.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type SyncSkillsOptions = {
  pathArg?: string;
  forceSkills: boolean; // when false we still back-up-and-overwrite (sync is propagate-by-design)
  forceClaude: boolean; // pass through for adapters that re-emit root guides
};

export async function runSyncSkills(opts: SyncSkillsOptions): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());

  const cfg = requireWorkspace(root);

  if (!existsSync(masterDir(root))) {
    process.stderr.write(
      `\n${YELLOW}⚠${RESET} No master skills directory at ${DIM}${masterDir(root)}${RESET}\n\n` +
        `  Run ${CYAN}agentforge init${RESET} here first to set up the workspace.\n\n`,
    );
    process.exit(1);
  }

  const { skills: masterSkills, skipped, warnings } = readMasterDir(masterDir(root));
  if (skipped.length > 0) {
    console.log(`${YELLOW}skipped invalid master files:${RESET}`);
    for (const sk of skipped) {
      console.log(`  ${DIM}- ${sk.file}: ${sk.reason}${RESET}`);
    }
    console.log("");
  }
  if (warnings.length > 0) {
    console.log(`${YELLOW}master file warnings:${RESET}`);
    for (const w of warnings) {
      console.log(`  ${DIM}- ${w.file}: ${w.warning}${RESET}`);
    }
    console.log("");
  }

  if (masterSkills.length === 0) {
    console.log(
      `${YELLOW}no valid master skills found — nothing to sync.${RESET}`,
    );
    return;
  }

  console.log(
    `${BOLD}${GREEN}↻${RESET} syncing ${masterSkills.length} skill(s) → ${cfg.agents.length} agent(s) in ${CYAN}${root}${RESET}`,
  );
  console.log("");

  // sync-skills is propagate-by-design: always back up and overwrite. Pass
  // forceSkills=true unconditionally; forceClaude only when explicit.
  for (const id of cfg.agents) {
    const adapter = getAgent(id);
    console.log(`${BOLD}${CYAN}▸ ${adapter.label}${RESET}`);
    adapter.install({
      root,
      masterSkills,
      skillCatalog: SKILLS.slice(),
      lang: cfg.lang,
      forceSkills: true,
      forceClaude: opts.forceClaude,
    });
    console.log("");
  }

  console.log(
    `${BOLD}${GREEN}✓${RESET} sync complete  ${DIM}(skills: ${masterSkills.map((s) => s.id).join(", ")})${RESET}`,
  );
}
