import * as readline from "node:readline/promises";

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Simple y/N prompt. Non-TTY → returns `def`. */
export async function confirm(
  message: string,
  def = false,
): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const hint = def ? "[Y/n]" : "[y/N]";
  const ans = await rl.question(
    `${CYAN}?${RESET} ${message} ${DIM}${hint}${RESET} `,
  );
  rl.close();
  const t = ans.trim().toLowerCase();
  if (t === "") return def;
  return t === "y" || t === "yes";
}
