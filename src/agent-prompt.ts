import { AGENTS } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import type { Lang } from "./skills-data.js";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const STRIKE = "\x1b[9m";
const NOSTRIKE = "\x1b[29m";
const RESET = "\x1b[0m";

export type PickAgentsOptions = {
  /** ids that are already installed — shown with a strikethrough lock, not toggleable */
  disabled?: ReadonlySet<AgentId>;
  /** header shown above the list (defaults to "Agents to set up") */
  headerLabel?: string;
  /** when true, Enter is rejected if nothing is selected (init flow) */
  requireAtLeastOne?: boolean;
};

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

async function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk: Buffer | string) => {
      resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
  });
}

export async function pickAgents(
  lang: Lang,
  options: PickAgentsOptions = {},
): Promise<AgentId[]> {
  const disabled = options.disabled ?? new Set<AgentId>();
  const headerLabel = options.headerLabel ?? "Agents to set up";

  if (!process.stdin.isTTY) {
    // safe non-TTY default: pick claude if it's not already installed,
    // otherwise nothing (caller decides what to do with an empty pick)
    return disabled.has("claude") ? [] : ["claude"];
  }

  let cursor = 0;
  // default selection: claude (if not already installed)
  const selected = new Set<AgentId>(
    disabled.has("claude") ? [] : ["claude"],
  );
  let view: "list" | "details" = "list";
  let lastLineCount = 0;
  let errorMessage = ""; // shown when Enter is pressed with nothing selected (when required)

  const HEADER_LIST = `${CYAN}?${RESET} ${BOLD}${headerLabel}${RESET}  ${DIM}↑↓ move · space toggle · → details · enter confirm${RESET}`;
  const headerDetails = (label: string, idx: number, total: number) =>
    `${CYAN}?${RESET} ${BOLD}${label}${RESET}  ${DIM}(${idx}/${total})   ↑↓ next · ← back${RESET}`;

  const renderList = (): string => {
    const lines: string[] = [HEADER_LIST, ""];
    for (let i = 0; i < AGENTS.length; i++) {
      const item = AGENTS[i];
      const isLocked = disabled.has(item.id);
      const isSel = selected.has(item.id);
      const isCur = i === cursor;
      const prefix = isCur ? `${CYAN}❯${RESET}` : " ";
      if (isLocked) {
        const marker = `${DIM}🔒${RESET}`;
        const title = `${DIM}${STRIKE}${item.label}${NOSTRIKE}${RESET}`;
        const tag = `${DIM}(already installed)${RESET}`;
        lines.push(`${prefix} ${marker} ${title}  ${tag}`);
        continue;
      }
      const marker = isSel ? `${GREEN}◉${RESET}` : `${DIM}◯${RESET}`;
      const title = isCur ? `${CYAN}${item.label}${RESET}` : item.label;
      lines.push(`${prefix} ${marker}  ${title}`);
    }
    if (errorMessage) {
      lines.push("");
      lines.push(`  ${YELLOW}⚠${RESET} ${errorMessage}`);
    }
    return lines.join("\n") + "\n";
  };

  const renderDetails = (): string => {
    const item = AGENTS[cursor];
    const isSel = selected.has(item.id);
    const status = isSel
      ? `${GREEN}◉ selected${RESET}`
      : `${DIM}◯ not selected${RESET}`;
    const width = Math.min((process.stdout.columns || 80) - 4, 78);
    const bar = `${DIM}${"─".repeat(width)}${RESET}`;
    const lines: string[] = [
      headerDetails(item.label, cursor + 1, AGENTS.length),
      `  ${bar}`,
      "",
    ];
    for (const w of wrap(item.details[lang], width - 2)) {
      lines.push(`  ${w}`);
    }
    lines.push("");
    lines.push(
      `  ${status}    ${DIM}space toggle · enter confirm${RESET}`,
    );
    return lines.join("\n") + "\n";
  };

  const clear = () => {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A\x1b[J`);
    }
  };

  const render = () => {
    clear();
    const text = view === "list" ? renderList() : renderDetails();
    process.stdout.write(text);
    lastLineCount = text.split("\n").length - 1;
  };

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?25l"); // hide cursor

  const cleanup = (clearUi: boolean) => {
    process.stdout.write("\x1b[?25h");
    stdin.setRawMode(false);
    stdin.pause();
    if (clearUi) clear();
  };

  render();

  try {
    while (true) {
      const chunk = await readKey();
      if (chunk === "\x1b[A") {
        cursor = (cursor - 1 + AGENTS.length) % AGENTS.length;
        render();
        continue;
      }
      if (chunk === "\x1b[B") {
        cursor = (cursor + 1) % AGENTS.length;
        render();
        continue;
      }
      if (chunk === "\x1b[C") {
        if (view === "list") {
          view = "details";
          render();
        }
        continue;
      }
      if (chunk === "\x1b[D" || chunk === "\x1b") {
        if (view === "details") {
          view = "list";
          render();
        }
        continue;
      }
      if (chunk.startsWith("\x1b")) continue;

      for (const ch of chunk) {
        if (ch === "\x03") {
          cleanup(true);
          process.stdout.write(`${YELLOW}aborted.${RESET}\n`);
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          if (selected.size === 0 && options.requireAtLeastOne) {
            errorMessage = "Select at least one agent before continuing.";
            render();
            continue;
          }
          cleanup(true);
          const picked = AGENTS.filter((a) => selected.has(a.id));
          const summary =
            picked.length > 0
              ? picked.map((p) => p.label).join(", ")
              : `${DIM}none${RESET}`;
          process.stdout.write(
            `${CYAN}?${RESET} ${BOLD}${headerLabel}${RESET}  ${DIM}›${RESET} ${summary}\n`,
          );
          return picked.map((p) => p.id);
        }
        if (ch === " ") {
          // clear any prior "select at least one" warning once they interact
          errorMessage = "";
          const item = AGENTS[cursor];
          if (disabled.has(item.id)) continue;
          if (selected.has(item.id)) selected.delete(item.id);
          else selected.add(item.id);
          render();
          continue;
        }
        if (ch === "a") {
          errorMessage = "";
          for (const a of AGENTS) {
            if (!disabled.has(a.id)) selected.add(a.id);
          }
          render();
          continue;
        }
        if (ch === "n") {
          // clearing all is allowed; if requireAtLeastOne, Enter will surface the warning.
          selected.clear();
          render();
          continue;
        }
      }
    }
  } catch (err) {
    cleanup(true);
    throw err;
  }
}
