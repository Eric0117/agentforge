import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pickAgents } from "./agent-prompt.js";
import { readMasterDir } from "./agents/io.js";
import { AGENTS, getAgent } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import {
  masterDir,
  readConfig,
  upsertConfig,
} from "./agentforge-config.js";
import { pickLanguage } from "./lang-prompt.js";
import { SKILLS, type Lang } from "./skills-data.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type AddAgentOptions = {
  agents?: AgentId[];
  pathArg?: string;
  lang?: Lang;
  yes: boolean;
  forceSkills: boolean;
  forceClaude: boolean;
};

export async function runAddAgent(opts: AddAgentOptions): Promise<void> {
  const root = resolve(opts.pathArg ?? process.cwd());

  if (!isAgentforgeWorkspace(root)) {
    process.stderr.write(
      `\n${YELLOW}⚠${RESET} Not an agentforge workspace yet.\n` +
        `  ${DIM}${root}${RESET}\n\n` +
        `  Run ${CYAN}agentforge init${RESET} here first to set one up.\n\n`,
    );
    process.exit(1);
  }

  // master must exist before we can install adapters from it
  if (!existsSync(masterDir(root))) {
    process.stderr.write(
      `\n${YELLOW}⚠${RESET} No master skills directory at ${DIM}${masterDir(root)}${RESET}\n\n` +
        `  Run ${CYAN}agentforge init${RESET} here first to set up the workspace.\n\n`,
    );
    process.exit(1);
  }

  const cfg = readConfig(root);

  // If user passed --lang and it conflicts with what's already written into
  // master files, we'd silently produce a mixed-lang workspace (new agent's
  // CLAUDE.md/.cursorrules/AGENTS.md in --lang, but the actual skill files
  // copied from master in the original lang). Refuse and point at the
  // re-init path.
  if (opts.lang && cfg?.lang && opts.lang !== cfg.lang) {
    process.stderr.write(
      `\n${YELLOW}⚠${RESET} workspace was initialized with ${BOLD}lang=${cfg.lang}${RESET}, ` +
        `you passed ${BOLD}--lang ${opts.lang}${RESET}.\n\n` +
        `  Master skills are already in ${cfg.lang} — mixing langs would produce inconsistent output.\n` +
        `  To switch the whole workspace to ${opts.lang}: ${CYAN}agentforge init ${root} --lang ${opts.lang} --force-skills${RESET}\n` +
        `  To keep ${cfg.lang}: drop the ${CYAN}--lang${RESET} flag.\n\n`,
    );
    process.exit(1);
  }

  const installed = new Set<AgentId>(
    cfg?.agents ?? Array.from(detectInstalledAgentsFallback(root)),
  );
  const lang = await resolveLanguage(opts, cfg?.lang);
  const agentsToAdd = await resolveAgentList(opts, installed, lang, root);

  if (agentsToAdd.length === 0) {
    console.log(`${YELLOW}no agents selected — nothing to do.${RESET}`);
    return;
  }

  const { skills: masterSkills, skipped } = readMasterDir(masterDir(root));
  if (skipped.length > 0) {
    for (const sk of skipped) {
      console.log(`  ${DIM}skipped master file ${sk.file} — ${sk.reason}${RESET}`);
    }
  }

  console.log("");
  console.log(`${BOLD}${GREEN}+${RESET} adding agents to ${CYAN}${root}${RESET}`);
  console.log("");

  for (const id of agentsToAdd) {
    const adapter = getAgent(id);
    console.log(`${BOLD}${CYAN}▸ ${adapter.label}${RESET}`);
    adapter.install({
      root,
      masterSkills,
      skillCatalog: SKILLS.slice(),
      lang,
      forceSkills: opts.forceSkills,
      forceClaude: opts.forceClaude,
    });
    console.log("");
  }

  // update config.agents (union)
  upsertConfig(root, { agents: [...installed, ...agentsToAdd] });

  printNextSteps(root, agentsToAdd);
}

async function resolveLanguage(
  opts: AddAgentOptions,
  configLang: Lang | undefined,
): Promise<Lang> {
  if (opts.lang) return opts.lang;
  if (configLang) return configLang; // honor what's already in config
  if (opts.yes) return "en";
  return pickLanguage();
}

async function resolveAgentList(
  opts: AddAgentOptions,
  installed: Set<AgentId>,
  lang: Lang,
  root: string,
): Promise<AgentId[]> {
  if (opts.agents && opts.agents.length > 0) {
    const dup = opts.agents.filter((id) => installed.has(id));
    if (dup.length > 0) {
      console.log(
        `${DIM}  note: already installed → skipping: ${dup.join(", ")}${RESET}`,
      );
    }
    return opts.agents.filter((id) => !installed.has(id));
  }

  if (opts.yes) {
    const remaining = AGENTS.map((a) => a.id).filter(
      (id) => !installed.has(id),
    ) as AgentId[];
    if (remaining.length === 0) {
      console.log(
        `${YELLOW}all known agents are already installed in ${root}.${RESET}`,
      );
    }
    return remaining;
  }

  if (installed.size === AGENTS.length) {
    console.log(
      `${YELLOW}all known agents are already installed in ${root}.${RESET}`,
    );
    return [];
  }
  return pickAgents(lang, {
    disabled: installed,
    headerLabel: "Agents to add",
  });
}

/** fallback when config.json doesn't exist yet — same logic as before */
function detectInstalledAgentsFallback(root: string): Set<AgentId> {
  const installed = new Set<AgentId>();
  if (
    existsSync(join(root, ".claude/skills")) ||
    existsSync(join(root, "CLAUDE.md"))
  )
    installed.add("claude");
  if (
    existsSync(join(root, ".cursor/rules")) ||
    existsSync(join(root, ".cursorrules"))
  )
    installed.add("cursor");
  if (
    existsSync(join(root, ".agents/skills")) ||
    existsSync(join(root, "AGENTS.md"))
  )
    installed.add("codex");
  return installed;
}

function isAgentforgeWorkspace(root: string): boolean {
  const markers = [
    "agentforge",
    "repos",
    "anvil",
    "artifacts",
    ".claude",
    ".cursor",
    ".agents",
    "CLAUDE.md",
    "AGENTS.md",
    ".cursorrules",
  ];
  return markers.some((m) => existsSync(join(root, m)));
}

function printNextSteps(root: string, agentIds: AgentId[]) {
  const labels = agentIds
    .map((id) => AGENTS.find((a) => a.id === id)?.label ?? id)
    .join(", ");
  console.log(
    `${BOLD}${GREEN}✓${RESET} added: ${labels}  ${DIM}(in ${root})${RESET}`,
  );
  console.log("");
}
