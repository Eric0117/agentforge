import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import type { AgentAdapter, AgentId } from "./types.js";

export const AGENTS: readonly AgentAdapter[] = [
  ClaudeAdapter,
  CursorAdapter,
  CodexAdapter,
] as const;

export const AGENT_IDS: readonly AgentId[] = AGENTS.map(
  (a) => a.id,
) as readonly AgentId[];

export function getAgent(id: AgentId): AgentAdapter {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown agent id: ${id}`);
  return a;
}

export type { AgentAdapter, AgentId, InstallParams } from "./types.js";
