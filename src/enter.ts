import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configPath } from "./agentforge-config.js";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type EnterOptions = {
  slug?: string;
};

export async function runEnter(opts: EnterOptions): Promise<void> {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) {
    process.stderr.write(
      `\n${YELLOW}⚠${RESET} Not inside an agentforge workspace.\n` +
        `  ${DIM}cwd: ${process.cwd()}${RESET}\n\n` +
        `  Run ${CYAN}agentforge enter${RESET} from a workspace directory (one containing ${CYAN}agentforge/config.json${RESET}).\n\n`,
    );
    process.exit(1);
  }

  const anvilDir = join(root, "anvil");
  const features = listFeatures(anvilDir);

  if (!opts.slug) {
    if (features.length === 0) {
      process.stderr.write(
        `\n${YELLOW}⚠${RESET} No active features in ${DIM}${anvilDir}${RESET}.\n\n` +
          `  Start one with ${CYAN}claude${RESET} → "let's start a new feature".\n\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `\nusage: ${CYAN}agentforge enter <slug>${RESET}\n\nActive features:\n` +
        features.map((f) => `  ${CYAN}${f}${RESET}`).join("\n") +
        `\n\n`,
    );
    process.exit(1);
  }

  const target = join(anvilDir, opts.slug);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    process.stderr.write(
      `\n${RED}✗${RESET} Feature not found: ${CYAN}${opts.slug}${RESET}\n` +
        `  ${DIM}expected: ${target}${RESET}\n\n`,
    );
    if (features.length > 0) {
      process.stderr.write(
        `Active features:\n` +
          features.map((f) => `  ${CYAN}${f}${RESET}`).join("\n") +
          `\n\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `${DIM}→ ${target}${RESET}\n${DIM}→ launching claude…${RESET}\n`,
  );

  const child = spawn("claude", [], { cwd: target, stdio: "inherit" });
  child.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      process.stderr.write(
        `\n${RED}✗${RESET} ${CYAN}claude${RESET} command not found on PATH.\n\n` +
          `  Install Claude Code: ${CYAN}https://claude.com/claude-code${RESET}\n\n`,
      );
    } else {
      process.stderr.write(`\n${RED}✗${RESET} failed to launch claude: ${e.message}\n\n`);
    }
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(configPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function listFeatures(anvilDir: string): string[] {
  if (!existsSync(anvilDir)) return [];
  try {
    return readdirSync(anvilDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
