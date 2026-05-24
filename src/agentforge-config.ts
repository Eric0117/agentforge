import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "./agents/types.js";
import type { Lang } from "./skills-data.js";

export const CURRENT_CONFIG_VERSION = 1 as const;

export type WorkspaceConfig = {
  version: 1;
  lang: Lang;
  agents: AgentId[];
};

const CONFIG_PATH = "agentforge/config.json";
export const MASTER_DIR_REL = "agentforge/skills";

export function configPath(root: string): string {
  return join(root, CONFIG_PATH);
}

export function masterDir(root: string): string {
  return join(root, MASTER_DIR_REL);
}

/**
 * Read the workspace config, or print a friendly error and exit if the
 * directory hasn't been initialized as an agentforge workspace.
 */
export function requireWorkspace(root: string): WorkspaceConfig {
  const cfg = readConfig(root);
  if (cfg) return cfg;

  const YELLOW = "\x1b[33m";
  const CYAN = "\x1b[36m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";
  process.stderr.write(
    `\n${YELLOW}⚠${RESET} Not an agentforge workspace yet.\n` +
      `  ${DIM}${root}${RESET}\n\n` +
      `  Run ${CYAN}agentforge init${RESET} here first to set one up.\n\n`,
  );
  process.exit(1);
}

export function readConfig(root: string): WorkspaceConfig | null {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  // Guard against config.json being a directory (or other non-file).
  try {
    if (!statSync(p).isFile()) {
      throw new Error(
        `${p} exists but is not a regular file — remove it and re-run \`agentforge init --force\``,
      );
    }
  } catch (e) {
    throw new Error(`failed to read ${p}: ${(e as Error).message}`);
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<WorkspaceConfig>;
    if (!raw || typeof raw !== "object") return null;
    if (raw.version !== CURRENT_CONFIG_VERSION) {
      // future: migrate
      throw new Error(
        `unsupported agentforge/config.json version: ${raw.version}`,
      );
    }
    const rawLang = raw.lang ?? "en";
    if (rawLang !== "en" && rawLang !== "ko" && rawLang !== "ja") {
      throw new Error(
        `unsupported lang "${rawLang}" — agentforge supports en | ko | ja. Fix \`lang:\` in agentforge/config.json or re-run \`agentforge init --force-skills\`.`,
      );
    }
    const agents = Array.isArray(raw.agents)
      ? (raw.agents.filter(
          (a): a is AgentId => a === "claude" || a === "cursor" || a === "codex",
        ) as AgentId[])
      : [];
    return { version: 1, lang: rawLang, agents };
  } catch (err) {
    throw new Error(`failed to read ${p}: ${(err as Error).message}`);
  }
}

export function writeConfig(root: string, cfg: WorkspaceConfig): void {
  const p = configPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Merge a partial update into the existing config (or create a fresh one). */
export function upsertConfig(
  root: string,
  patch: Partial<WorkspaceConfig>,
): WorkspaceConfig {
  const existing = readConfig(root);
  const next: WorkspaceConfig = existing
    ? {
        version: 1,
        lang: patch.lang ?? existing.lang,
        agents: mergeAgents(existing.agents, patch.agents ?? []),
      }
    : {
        version: 1,
        lang: patch.lang ?? "en",
        agents: patch.agents ?? [],
      };
  writeConfig(root, next);
  return next;
}

/** Replace the agents list outright (used by remove-agent). */
export function setAgents(root: string, agents: AgentId[]): WorkspaceConfig {
  const existing = readConfig(root);
  const next: WorkspaceConfig = {
    version: 1,
    lang: existing?.lang ?? "en",
    agents,
  };
  writeConfig(root, next);
  return next;
}

function mergeAgents(prev: AgentId[], next: AgentId[]): AgentId[] {
  const seen = new Set<AgentId>();
  const out: AgentId[] = [];
  for (const a of [...prev, ...next]) {
    if (!seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}
