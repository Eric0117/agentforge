import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMasterDir } from "./agents/io.js";
import { AGENTS } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import { masterDir, requireWorkspace } from "./agentforge-config.js";
import { SKILLS } from "./skills-data.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const AGENT_SKILL_PATHS: Record<AgentId, (root: string, id: string) => string> =
  {
    claude: (root, id) => join(root, ".claude/skills", id, "SKILL.md"),
    cursor: (root, id) => join(root, ".cursor/rules", `${id}.mdc`),
    codex: (root, id) => join(root, ".agents/skills", `${id}.md`),
  };

const AGENT_SKILL_DIRS: Record<AgentId, (root: string) => string> = {
  claude: (root) => join(root, ".claude/skills"),
  cursor: (root) => join(root, ".cursor/rules"),
  codex: (root) => join(root, ".agents/skills"),
};

export type ListSkillsOptions = { pathArg?: string };

export async function runListSkills(opts: ListSkillsOptions): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());
  const cfg = requireWorkspace(root);

  if (!existsSync(masterDir(root))) {
    process.stderr.write(
      `\n${YELLOW}⚠${RESET} No master skills directory at ${DIM}${masterDir(root)}${RESET}\n\n` +
        `  Run ${CYAN}agentforge init${RESET} here first to set up the workspace.\n\n`,
    );
    process.exit(1);
  }

  const { skills, skipped, warnings } = readMasterDir(masterDir(root));
  const stdSet = new Set(SKILLS.map((s) => s.id));

  console.log(
    `${BOLD}Skills in${RESET} ${CYAN}${root}${RESET}  ${DIM}(lang: ${cfg.lang}, agents: ${cfg.agents.join(", ")})${RESET}`,
  );
  console.log("");

  // header
  console.log(
    `  ${DIM}${"id".padEnd(34)}  ${"kind".padEnd(8)}  ${cfg.agents
      .map((id) => (AGENTS.find((a) => a.id === id)?.label ?? id).padEnd(18))
      .join("")}description${RESET}`,
  );
  console.log(
    `  ${DIM}${"-".repeat(34)}  ${"-".repeat(8)}  ${cfg.agents
      .map(() => "-".repeat(18))
      .join("")}${"-".repeat(40)}${RESET}`,
  );

  // body — track drift while we go
  let driftCount = 0;
  for (const s of skills) {
    const kindLabel = stdSet.has(s.id)
      ? `${DIM}standard${RESET}`
      : `${GREEN}custom${RESET}  `;
    const desc = (s.frontmatter["description"] ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 80);

    const cells = cfg.agents.map((id) => {
      const present = existsSync(AGENT_SKILL_PATHS[id](root, s.id));
      if (!present) driftCount++;
      return (present ? `${GREEN}✓${RESET}` : `${YELLOW}·${RESET}`).padEnd(
        18 + 9, // ANSI bytes pad
      );
    });
    console.log(
      `  ${s.id.padEnd(34)}  ${kindLabel}  ${cells.join("")}${desc}`,
    );
  }

  // drift hint
  if (driftCount > 0) {
    console.log("");
    console.log(
      `${YELLOW}⚠${RESET} ${driftCount} skill cell(s) not yet propagated — run ${CYAN}agentforge sync-skills${RESET} to bring all agents in sync.`,
    );
  }

  // warnings on master files (e.g. name/filename mismatch, placeholder body)
  if (warnings.length > 0) {
    console.log("");
    console.log(`${YELLOW}⚠ master file warnings:${RESET}`);
    for (const w of warnings) {
      console.log(`  ${DIM}-${RESET} ${w.file}: ${w.warning}`);
    }
  }

  // skipped master files (couldn't load)
  if (skipped.length > 0) {
    console.log("");
    console.log(`${RED}✗ invalid master files (skipped — not propagated):${RESET}`);
    for (const sk of skipped) {
      console.log(`  ${DIM}-${RESET} ${sk.file}: ${sk.reason}`);
    }
  }

  // orphan detection — adapter files without a backing master.
  const orphans = detectOrphans(root, cfg.agents, new Set(skills.map((s) => s.id)));
  if (orphans.length > 0) {
    console.log("");
    console.log(
      `${YELLOW}⚠ orphan adapter files (no matching master skill):${RESET}`,
    );
    for (const o of orphans) {
      console.log(`  ${DIM}-${RESET} ${o.agent}: ${o.id}  ${DIM}(${o.path})${RESET}`);
    }
    console.log(
      `  ${DIM}→ create a master file at agentforge/skills/<id>.md, or remove via \`agentforge remove-skill <id>\`.${RESET}`,
    );
  }

  console.log("");
}

function detectOrphans(
  root: string,
  agents: AgentId[],
  masterIds: Set<string>,
): Array<{ agent: AgentId; id: string; path: string }> {
  const out: Array<{ agent: AgentId; id: string; path: string }> = [];
  for (const agent of agents) {
    const dir = AGENT_SKILL_DIRS[agent](root);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      let id: string | null = null;
      if (agent === "claude" && e.isDirectory()) id = e.name;
      else if (agent === "cursor" && e.isFile() && e.name.endsWith(".mdc"))
        id = e.name.slice(0, -4);
      else if (agent === "codex" && e.isFile() && e.name.endsWith(".md"))
        id = e.name.slice(0, -3);
      if (!id) continue;
      if (!masterIds.has(id)) {
        out.push({
          agent,
          id,
          path: `${dir.slice(root.length + 1)}/${e.name}`,
        });
      }
    }
  }
  return out;
}
