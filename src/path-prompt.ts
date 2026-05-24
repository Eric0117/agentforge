import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as readline from "node:readline/promises";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Suffix that should appear after the current buffer as a ghost-text hint. */
function findSuggestion(buffer: string): string {
  if (buffer.length === 0) return "";
  const expanded = expandTilde(buffer);

  let dir: string;
  let prefix: string;
  if (expanded.endsWith("/")) {
    dir = expanded;
    prefix = "";
  } else {
    const d = dirname(expanded);
    dir = d === "" ? "." : d;
    prefix = basename(expanded);
  }

  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return "";
  }
  if (names.length === 0) return "";

  if (expanded.endsWith("/")) {
    return `${names[0]}/`;
  }

  const first = names[0];
  if (first.toLowerCase() === prefix.toLowerCase()) {
    return "/";
  }
  return `${first.slice(prefix.length)}/`;
}

async function promptPathTTY(
  message: string,
  initial: string,
): Promise<string> {
  process.stdout.write(
    `${CYAN}?${RESET} ${BOLD}${message}${RESET} ${DIM}(→ or Tab to accept · Enter to confirm)${RESET}\n`,
  );

  const PROMPT = `${DIM}›${RESET} `;
  let buffer = initial;

  const render = () => {
    const suggestion = findSuggestion(buffer);
    process.stdout.write(
      `\r\x1b[K${PROMPT}${buffer}${DIM}${suggestion}${RESET}`,
    );
    if (suggestion.length > 0) {
      process.stdout.write(`\x1b[${suggestion.length}D`);
    }
  };

  return new Promise<string>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const acceptSuggestion = () => {
      const sug = findSuggestion(buffer);
      if (sug) buffer += sug;
    };

    const onData = (chunk: string) => {
      // Whole-chunk escape sequences (arrow keys, function keys, etc.)
      if (chunk === "\x1b[C") {
        acceptSuggestion();
        render();
        return;
      }
      if (chunk.startsWith("\x1b")) {
        // ignore other escapes (left/up/down arrows, etc.)
        return;
      }

      for (const ch of chunk) {
        if (ch === "\x03") {
          // Ctrl+C
          cleanup();
          process.stdout.write(`\n${DIM}aborted.${RESET}\n`);
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          // commit final line with no ghost text
          process.stdout.write(`\r\x1b[K${PROMPT}${buffer}\n`);
          const val = buffer.trim();
          const final = val === "" ? initial : val;
          const resolved = expandTilde(final);
          process.stdout.write(`  ${GREEN}✔${RESET} ${DIM}${resolved}${RESET}\n`);
          resolve(resolved);
          return;
        }
        if (ch === "\t") {
          acceptSuggestion();
          render();
          continue;
        }
        if (ch === "\x7f" || ch === "\x08") {
          // Backspace / Delete
          buffer = buffer.slice(0, -1);
          render();
          continue;
        }
        if (ch >= " ") {
          buffer += ch;
          render();
          continue;
        }
        // ignore other control chars
      }
    };

    stdin.on("data", onData);
    render();
  });
}

async function promptPathFallback(
  message: string,
  initial: string,
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = await rl.question(`${BOLD}${message}${RESET} `);
  rl.close();
  const v = ans.trim();
  return expandTilde(v === "" ? initial : v);
}

export async function promptPath(
  message: string,
  initial: string,
): Promise<string> {
  if (!process.stdin.isTTY) {
    return promptPathFallback(message, initial);
  }
  return promptPathTTY(message, initial);
}
