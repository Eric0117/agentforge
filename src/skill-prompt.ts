export type SkillItem = {
  id: string;
  title: string;
  description: string; // short, shown in list
  details: string; // long, shown in details panel
};

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

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

export async function pickSkills(items: SkillItem[]): Promise<string[]> {
  if (!process.stdin.isTTY) {
    return items.map((i) => i.id);
  }

  let cursor = 0;
  const selected = new Set(items.map((i) => i.id));
  let view: "list" | "details" = "list";
  let lastLineCount = 0;

  const HEADER_LIST = `${CYAN}?${RESET} ${BOLD}Skills to install${RESET}  ${DIM}↑↓ move · space toggle · → details · enter confirm${RESET}`;
  const headerDetails = (title: string, idx: number, total: number) =>
    `${CYAN}?${RESET} ${BOLD}${title}${RESET}  ${DIM}(${idx}/${total})   ↑↓ next · ← back${RESET}`;

  const renderList = (): string => {
    const lines: string[] = [HEADER_LIST, ""];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSel = selected.has(item.id);
      const isCur = i === cursor;
      const marker = isSel ? `${GREEN}◉${RESET}` : `${DIM}◯${RESET}`;
      const prefix = isCur ? `${CYAN}❯${RESET}` : " ";
      const title = isCur ? `${CYAN}${item.title}${RESET}` : item.title;
      lines.push(`${prefix} ${marker}  ${title}  ${DIM}— ${item.description}${RESET}`);
    }
    return lines.join("\n") + "\n";
  };

  const renderDetails = (): string => {
    const item = items[cursor];
    const isSel = selected.has(item.id);
    const status = isSel
      ? `${GREEN}◉ selected${RESET}`
      : `${DIM}◯ not selected${RESET}`;
    const width = Math.min((process.stdout.columns || 80) - 4, 78);
    const bar = `${DIM}${"─".repeat(width)}${RESET}`;
    const lines: string[] = [
      headerDetails(item.title, cursor + 1, items.length),
      `  ${bar}`,
      "",
    ];
    for (const w of wrap(item.details, width - 2)) {
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

  // Setup raw mode
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?25l"); // hide cursor

  const cleanup = (clearUi: boolean) => {
    process.stdout.write("\x1b[?25h"); // show cursor
    stdin.setRawMode(false);
    stdin.pause();
    if (clearUi) clear();
  };

  render();

  try {
    while (true) {
      const chunk = await readKey();

      // Whole-chunk escape sequences (arrow keys)
      if (chunk === "\x1b[A") {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        continue;
      }
      if (chunk === "\x1b[B") {
        cursor = (cursor + 1) % items.length;
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
      if (chunk === "\x1b[D") {
        if (view === "details") {
          view = "list";
          render();
        }
        continue;
      }
      if (chunk === "\x1b") {
        // bare ESC
        if (view === "details") {
          view = "list";
          render();
        }
        continue;
      }
      if (chunk.startsWith("\x1b")) {
        continue; // ignore other escapes
      }

      // Per-char
      let handled = false;
      for (const ch of chunk) {
        if (ch === "\x03") {
          // Ctrl+C
          cleanup(true);
          process.stdout.write(`${YELLOW}aborted.${RESET}\n`);
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          cleanup(true);
          const picked = items.filter((i) => selected.has(i.id));
          const summary =
            picked.length > 0
              ? picked.map((p) => p.title).join(", ")
              : `${DIM}none${RESET}`;
          process.stdout.write(
            `${CYAN}?${RESET} ${BOLD}Skills to install${RESET}  ${DIM}›${RESET} ${summary}\n`,
          );
          return picked.map((p) => p.id);
        }
        if (ch === " ") {
          const item = items[cursor];
          if (selected.has(item.id)) selected.delete(item.id);
          else selected.add(item.id);
          render();
          handled = true;
          continue;
        }
        // letters could shortcut a/n: select all / select none
        if (ch === "a") {
          for (const it of items) selected.add(it.id);
          render();
          handled = true;
          continue;
        }
        if (ch === "n") {
          selected.clear();
          render();
          handled = true;
          continue;
        }
      }
      if (!handled) {
        // unknown — re-render in case of partial state
        render();
      }
    }
  } catch (err) {
    cleanup(true);
    throw err;
  }
}
