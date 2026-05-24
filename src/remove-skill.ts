import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMasterDir } from "./agents/io.js";
import { getAgent } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import { masterDir, requireWorkspace } from "./agentforge-config.js";
import { confirm } from "./confirm.js";
import { SKILLS } from "./skills-data.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const AGENT_SKILL_TARGETS: Record<
  AgentId,
  (root: string, id: string) => { path: string; isDir: boolean }
> = {
  claude: (root, id) => ({
    path: join(root, ".claude/skills", id),
    isDir: true,
  }),
  cursor: (root, id) => ({
    path: join(root, ".cursor/rules", `${id}.mdc`),
    isDir: false,
  }),
  codex: (root, id) => ({
    path: join(root, ".agents/skills", `${id}.md`),
    isDir: false,
  }),
};

export type RemoveSkillOptions = {
  name: string;
  pathArg?: string;
  yes: boolean;
};

export async function runRemoveSkill(
  opts: RemoveSkillOptions,
): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());
  const cfg = requireWorkspace(root);

  const masterPath = join(masterDir(root), `${opts.name}.md`);
  if (!existsSync(masterPath)) {
    process.stderr.write(
      `\n${RED}✗${RESET} No master skill named "${opts.name}".\n  ${DIM}${masterPath}${RESET}\n\n` +
        `  Run ${CYAN}agentforge list-skills${RESET} to see what's available.\n\n`,
    );
    process.exit(1);
  }

  // collect agent artifacts to remove
  const targets: Array<{ rel: string; abs: string; isDir: boolean }> = [];
  for (const id of cfg.agents) {
    const t = AGENT_SKILL_TARGETS[id](root, opts.name);
    if (existsSync(t.path)) {
      targets.push({ rel: t.path.slice(root.length + 1), abs: t.path, isDir: t.isDir });
    }
  }

  const isStandard = SKILLS.some((s) => s.id === opts.name);

  console.log(
    `${BOLD}Removing skill${RESET} ${CYAN}${opts.name}${RESET} from ${CYAN}${root}${RESET}`,
  );
  if (isStandard) {
    console.log(
      `  ${YELLOW}note:${RESET} this is a standard agentforge skill. Re-init or \`add-skill --from\` will restore it.`,
    );
  }
  console.log(`  ${DIM}files to delete:${RESET}`);
  console.log(`    - agentforge/skills/${opts.name}.md  ${DIM}(master)${RESET}`);
  for (const t of targets) console.log(`    - ${t.rel}`);
  console.log("");

  const ok = opts.yes || (await confirm("Proceed?", false));
  if (!ok) {
    console.log(`${YELLOW}aborted.${RESET}`);
    return;
  }

  // delete master first; then re-sync per-agent index files (AGENTS.md) by
  // re-running the install for each agent on the remaining master skills.
  unlinkSync(masterPath);
  console.log(`${GREEN}-${RESET} removed: agentforge/skills/${opts.name}.md`);

  for (const t of targets) {
    if (t.isDir) rmSync(t.abs, { recursive: true, force: true });
    else unlinkSync(t.abs);
    console.log(`${GREEN}-${RESET} removed: ${t.rel}`);
  }

  // Re-run each agent's install with the remaining master skills so that
  // index sections (e.g. AGENTS.md Skills) reflect the deletion.
  const { skills: remaining } = readMasterDir(masterDir(root));
  for (const id of cfg.agents) {
    const adapter = getAgent(id);
    adapter.install({
      root,
      masterSkills: remaining,
      skillCatalog: SKILLS.slice(),
      lang: cfg.lang,
      forceSkills: true,
      forceClaude: true, // re-emit root guides to refresh indexes
    });
  }

  console.log("");
  console.log(`${BOLD}${GREEN}✓${RESET} removed skill: ${opts.name}`);
}
