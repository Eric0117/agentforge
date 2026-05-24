import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import {
  masterDir,
  requireWorkspace,
  setAgents,
} from "./agentforge-config.js";
import { confirm } from "./confirm.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type RemoveAgentOptions = {
  agent: AgentId;
  pathArg?: string;
  yes: boolean;
};

/** files / directories owned by each agent at workspace root */
const AGENT_ARTIFACTS: Record<AgentId, string[]> = {
  claude: [".claude/skills", "CLAUDE.md"],
  cursor: [".cursor/rules", ".cursorrules"],
  codex: [".agents/skills", "AGENTS.md"],
};

export async function runRemoveAgent(
  opts: RemoveAgentOptions,
): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());
  const cfg = requireWorkspace(root);

  const adapter = AGENTS.find((a) => a.id === opts.agent);
  if (!adapter) {
    const valid = AGENTS.map((a) => a.id).join(", ");
    process.stderr.write(
      `\n${RED}✗${RESET} Unknown agent: "${opts.agent}"\n\n  Valid options: ${CYAN}${valid}${RESET}\n\n`,
    );
    process.exit(1);
  }

  // master is preserved — only this agent's per-agent files are removed.
  const paths = AGENT_ARTIFACTS[opts.agent]
    .map((rel) => ({ rel, abs: join(root, rel) }))
    .filter((p) => existsSync(p.abs));

  if (paths.length === 0) {
    console.log(
      `${YELLOW}${adapter.label} has no artifacts in ${root} — nothing to remove.${RESET}`,
    );
    // still update config in case it's listed
    if (cfg.agents.includes(opts.agent)) {
      setAgents(
        root,
        cfg.agents.filter((id) => id !== opts.agent),
      );
      console.log(`${DIM}  config.agents updated.${RESET}`);
    }
    return;
  }

  console.log(
    `${BOLD}Removing ${adapter.label}${RESET} from ${CYAN}${root}${RESET}`,
  );
  console.log(`  ${DIM}files to delete:${RESET}`);
  for (const p of paths) console.log(`    - ${p.rel}`);
  console.log("");
  console.log(`  ${DIM}master skills (agentforge/skills/) are kept.${RESET}`);
  console.log("");

  const ok = opts.yes || (await confirm(`Proceed?`, false));
  if (!ok) {
    console.log(`${YELLOW}aborted.${RESET}`);
    return;
  }

  for (const p of paths) {
    rmSync(p.abs, { recursive: true, force: true });
    console.log(`${GREEN}-${RESET} removed: ${p.rel}`);
  }

  setAgents(
    root,
    cfg.agents.filter((id) => id !== opts.agent),
  );
  console.log(`${DIM}  config.agents updated.${RESET}`);

  // dummy reference to silence "masterDir unused" if it ever becomes so
  void masterDir;

  console.log("");
  console.log(
    `${BOLD}${GREEN}✓${RESET} ${adapter.label} removed.`,
  );
}
