import { join } from "node:path";
import { ensureDir, renderTemplate, writeRendered } from "./io.js";
import type { AgentAdapter, InstallParams, MasterSkill } from "./types.js";

/**
 * Convert a master skill into a standalone Codex skill file:
 *   - drop YAML frontmatter
 *   - top heading is `# <skill-id>`
 *   - second paragraph is the original description as plain text
 *   - then the body, untouched
 */
function skillToCodex(skill: MasterSkill): string {
  const description = skill.frontmatter["description"] ?? "";
  return `# ${skill.id}\n\n${description}\n\n${skill.body}`;
}

/**
 * Build AGENTS.md = workspace guide (from CLAUDE.md.tpl) + a Skills section that
 * lists each master skill with its short description and reference path.
 */
function buildAgentsMd(
  guideBody: string,
  skills: MasterSkill[],
): string {
  const skillsSection = [
    "## Skills",
    "",
    "This workspace ships skill briefs under `.agents/skills/`. When a user request",
    "matches a skill's purpose, load and follow that file. The skills:",
    "",
    ...skills.map(
      (s) =>
        `- **${s.id}** — ${s.frontmatter["description"] ?? ""}\n  See \`.agents/skills/${s.id}.md\`.`,
    ),
    "",
    "Auto-discovery on this layout is best-effort. If a skill doesn't trigger,",
    "say \"use the <skill-id> skill\" to invoke it explicitly.",
  ].join("\n");

  return [guideBody.trimEnd(), "", skillsSection, ""].join("\n");
}

export const CodexAdapter: AgentAdapter = {
  id: "codex",
  label: "OpenAI Codex CLI",
  outputSummary: ".agents/skills/ + AGENTS.md",
  details: {
    en: [
      "Writes `.agents/skills/<skill-id>.md` per master skill and a root `AGENTS.md` guide that lists each skill (description + reference path).",
      "",
      "Codex auto-loads AGENTS.md from the workspace root. From there it discovers the skill briefs by reference. Auto-matching is best-effort — say \"use the <skill-id> skill\" if a trigger phrase doesn't catch.",
    ].join("\n"),
    ko: [
      "각 마스터 스킬을 `.agents/skills/<skill-id>.md` 로, 워크스페이스 가이드를 `AGENTS.md` 로 작성 (가이드에 각 스킬 description + reference path 나열).",
      "",
      "Codex 가 AGENTS.md 를 워크스페이스 루트에서 자동 로드. 거기서 referenced 파일들을 발견하는 흐름. 자동 매칭은 best-effort — 발동 안 되면 \"use the <skill-id> skill\" 식으로 명시.",
    ].join("\n"),
    ja: [
      "各マスタースキルを `.agents/skills/<skill-id>.md` に、ワークスペースガイドを `AGENTS.md` に書き出します (ガイドに各スキルの description + reference path を列挙)。",
      "",
      "Codex は AGENTS.md をワークスペースルートから自動ロード。そこから referenced ファイルを発見する流れ。自動マッチングは best-effort — 発動しない場合は「use the <skill-id> skill」と明示。",
    ].join("\n"),
  },

  install(params: InstallParams): void {
    const { root, masterSkills, lang, forceSkills, forceClaude } = params;

    ensureDir(join(root, ".agents/skills"), ".agents/skills");

    // 1) per-skill files
    for (const s of masterSkills) {
      const codexSkill = skillToCodex(s);
      const destRel = `.agents/skills/${s.id}.md`;
      writeRendered(join(root, destRel), destRel, codexSkill, forceSkills);
    }

    // 2) AGENTS.md guide with Skills directory
    const guideBody = renderTemplate("CLAUDE.md.tpl", lang);
    const content = buildAgentsMd(guideBody, masterSkills);
    writeRendered(join(root, "AGENTS.md"), "AGENTS.md", content, forceClaude);
  },
};
