import type { Lang } from "./skills-data.js";

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

type Option = { value: Lang; label: string; hint: string };

const OPTIONS: Option[] = [
  { value: "en", label: "English", hint: "" },
  { value: "ko", label: "한국어", hint: "Korean" },
  { value: "ja", label: "日本語", hint: "Japanese" },
];

async function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk: Buffer | string) => {
      resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
  });
}

export async function pickLanguage(): Promise<Lang> {
  if (!process.stdin.isTTY) return "en";

  let cursor = 0;
  let lastLineCount = 0;

  const HEADER = `${CYAN}?${RESET} ${BOLD}Language${RESET}  ${DIM}↑↓ move · enter confirm${RESET}`;

  const render = () => {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A\x1b[J`);
    }
    const lines: string[] = [HEADER, ""];
    for (let i = 0; i < OPTIONS.length; i++) {
      const o = OPTIONS[i];
      const prefix = i === cursor ? `${CYAN}❯${RESET}` : " ";
      const label = i === cursor ? `${CYAN}${o.label}${RESET}` : o.label;
      const hint = o.hint ? `  ${DIM}— ${o.hint}${RESET}` : "";
      lines.push(`${prefix}  ${label}${hint}`);
    }
    const text = lines.join("\n") + "\n";
    process.stdout.write(text);
    lastLineCount = text.split("\n").length - 1;
  };

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?25l"); // hide cursor

  const cleanup = (clearUi: boolean) => {
    process.stdout.write("\x1b[?25h"); // show cursor
    stdin.setRawMode(false);
    stdin.pause();
    if (clearUi && lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A\x1b[J`);
    }
  };

  render();

  try {
    while (true) {
      const chunk = await readKey();

      if (chunk === "\x1b[A") {
        cursor = (cursor - 1 + OPTIONS.length) % OPTIONS.length;
        render();
        continue;
      }
      if (chunk === "\x1b[B") {
        cursor = (cursor + 1) % OPTIONS.length;
        render();
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
          const picked = OPTIONS[cursor];
          cleanup(true);
          process.stdout.write(
            `${CYAN}?${RESET} ${BOLD}Language${RESET}  ${DIM}›${RESET} ${picked.label}\n`,
          );
          return picked.value;
        }
      }
    }
  } catch (err) {
    cleanup(true);
    throw err;
  }
}
