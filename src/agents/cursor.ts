import { join } from "node:path";
import { ensureDir, renderTemplate, writeRendered } from "./io.js";
import type { AgentAdapter, InstallParams, MasterSkill } from "./types.js";

/**
 * Convert a master skill into a Cursor MDC rule:
 *   - drop `name:` (filename serves as the identifier)
 *   - keep `description:` for Cursor 1.0+ auto-matching on intent
 *   - add `alwaysApply: false` (safe default for older Cursors)
 *   - body unchanged
 */
function skillToMdc(skill: MasterSkill): string {
  const description = skill.frontmatter["description"] ?? "";
  const fmLines = [
    "---",
    `description: ${description}`,
    "alwaysApply: false",
    "---",
    "",
  ];
  return fmLines.join("\n") + skill.body;
}

export const CursorAdapter: AgentAdapter = {
  id: "cursor",
  label: "Cursor",
  outputSummary: ".cursor/rules/ + .cursorrules",
  details: {
    en: [
      "Writes `.cursor/rules/<skill-id>.mdc` per master skill and a root `.cursorrules` guide.",
      "",
      "Each MDC keeps the original description so Cursor 1.0+ can auto-match on intent. `alwaysApply: false` keeps older Cursors safe (rule loads on request, not always).",
    ].join("\n"),
    ko: [
      "각 마스터 스킬을 `.cursor/rules/<skill-id>.mdc` 로, 워크스페이스 가이드를 `.cursorrules` 로 작성합니다.",
      "",
      "MDC 가 원본 description 을 유지하므로 Cursor 1.0+ 이 의도 기반 자동 매칭. `alwaysApply: false` 로 옛 Cursor 에서도 안전 (요청 시에만 로드).",
    ].join("\n"),
    ja: [
      "各マスタースキルを `.cursor/rules/<skill-id>.mdc` に、ワークスペースガイドを `.cursorrules` に書き出します。",
      "",
      "MDC は元の description を保持するため Cursor 1.0+ が意図ベースで自動マッチ。`alwaysApply: false` で古い Cursor でも安全 (要求時のみロード)。",
    ].join("\n"),
  },

  install(params: InstallParams): void {
    const { root, masterSkills, lang, forceSkills, forceClaude } = params;

    ensureDir(join(root, ".cursor/rules"), ".cursor/rules");

    // root guide → .cursorrules (re-use the CLAUDE.md.tpl body)
    writeRendered(
      join(root, ".cursorrules"),
      ".cursorrules",
      renderTemplate("CLAUDE.md.tpl", lang),
      forceClaude,
    );

    // each master skill → .mdc
    for (const s of masterSkills) {
      const mdc = skillToMdc(s);
      const destRel = `.cursor/rules/${s.id}.mdc`;
      writeRendered(join(root, destRel), destRel, mdc, forceSkills);
    }
  },
};
