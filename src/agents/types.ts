import type { I18n, Lang, SkillSpec } from "../skills-data.js";

export type AgentId = "claude" | "cursor" | "codex";

/** A single skill resolved from the workspace master directory. */
export type MasterSkill = {
  id: string;
  /** YAML frontmatter as a flat map (name, description, etc.) */
  frontmatter: Record<string, string>;
  /** Body following the closing `---` */
  body: string;
  /** Full content (frontmatter + body) for adapters that don't need to parse. */
  raw: string;
};

export type InstallParams = {
  root: string;
  /**
   * Master skills loaded from `<workspace>/agentforge/skills/`.
   * Adapters convert these into their own per-agent layout.
   * Already language-substituted at master-write time.
   */
  masterSkills: MasterSkill[];
  /**
   * Catalog of standard skill metadata (i18n description/details).
   * Used to render index sections (e.g. AGENTS.md). May be empty for
   * user-added skills that aren't in the catalog.
   */
  skillCatalog: SkillSpec[];
  lang: Lang;
  forceSkills: boolean;
  forceClaude: boolean; // gates root-level guide (CLAUDE.md / .cursorrules / AGENTS.md)
};

export interface AgentAdapter {
  id: AgentId;
  label: string;
  details: I18n;
  /** Short description of what files this adapter creates, e.g. ".claude/skills/ + CLAUDE.md" */
  outputSummary: string;
  install(params: InstallParams): void;
}
