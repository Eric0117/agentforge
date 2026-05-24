import { join } from "node:path";
import { ensureDir, renderTemplate, writeRendered } from "./io.js";
import type { AgentAdapter, InstallParams } from "./types.js";

export const ClaudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  outputSummary: ".claude/skills/ + CLAUDE.md",
  details: {
    en: [
      "Writes `.claude/skills/<skill-id>/SKILL.md` for each master skill and a root `CLAUDE.md` guide.",
      "",
      "Auto-loaded by Claude Code from this workspace. The frontmatter `description` of each skill is what triggers it on matching natural-language prompts — strongest auto-matching of the three.",
    ].join("\n"),
    ko: [
      "각 마스터 스킬을 `.claude/skills/<skill-id>/SKILL.md` 로, 워크스페이스 가이드를 `CLAUDE.md` 로 작성합니다.",
      "",
      "Claude Code 가 자동 로드. 각 스킬의 frontmatter `description` 이 자연어 요청에 자동 매칭됩니다 — 셋 중 가장 강한 자동 발동.",
    ].join("\n"),
    ja: [
      "各マスタースキルを `.claude/skills/<skill-id>/SKILL.md` に、ワークスペースガイドを `CLAUDE.md` に書き出します。",
      "",
      "Claude Code が自動的に読み込みます。各スキルの frontmatter `description` が自然言語のリクエストに自動マッチします — 三つの中で最も強い自動発動。",
    ].join("\n"),
  },

  install(params: InstallParams): void {
    const { root, masterSkills, forceSkills, forceClaude } = params;

    ensureDir(join(root, ".claude/skills"), ".claude/skills");
    for (const s of masterSkills) {
      ensureDir(join(root, ".claude/skills", s.id), `.claude/skills/${s.id}`);
    }

    // root guide
    const claudeMd = renderGuide(params);
    writeRendered(join(root, "CLAUDE.md"), "CLAUDE.md", claudeMd, forceClaude);

    // each skill — master raw content is already language-substituted; write as-is.
    for (const s of masterSkills) {
      const destRel = `.claude/skills/${s.id}/SKILL.md`;
      writeRendered(join(root, destRel), destRel, s.raw, forceSkills);
    }
  },
};

/**
 * Workspace guide for Claude Code, rendered from the package template
 * (separate from master skills).
 */
function renderGuide(params: InstallParams): string {
  return renderTemplate("CLAUDE.md.tpl", params.lang);
}
