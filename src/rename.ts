import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configPath, requireWorkspace } from "./agentforge-config.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export type RenameOptions = {
  oldSlug?: string;
  newSlug?: string;
  pathArg?: string;
  force: boolean;
  yes: boolean;
};

export async function runRename(opts: RenameOptions): Promise<void> {
  if (!opts.oldSlug || !opts.newSlug) {
    fail(
      `usage: ${CYAN}agentforge rename <old-slug> <new-slug>${RESET}\n`,
    );
  }
  if (opts.oldSlug === opts.newSlug) {
    fail(`old and new slug are the same: ${opts.oldSlug}\n`);
  }
  if (!SLUG_RE.test(opts.newSlug)) {
    fail(
      `invalid new slug: ${opts.newSlug}\n  must match /^[a-z0-9][a-z0-9-]*$/ (lowercase, digits, hyphens; start with letter/digit)\n`,
    );
  }

  const root = findWorkspaceRoot(opts.pathArg ?? process.cwd());
  if (!root) {
    fail(
      `Not inside an agentforge workspace (looked for ${CYAN}agentforge/config.json${RESET} upward from cwd).\n`,
    );
  }
  // Make sure config is valid — also gives a friendly error if not initialized.
  requireWorkspace(root);

  const oldDir = join(root, "anvil", opts.oldSlug);
  const newDir = join(root, "anvil", opts.newSlug);

  if (!existsSync(oldDir) || !statSync(oldDir).isDirectory()) {
    fail(
      `feature not found: ${CYAN}${opts.oldSlug}${RESET}\n  expected: ${oldDir}\n`,
    );
  }
  if (existsSync(newDir)) {
    fail(
      `target already exists: ${CYAN}${opts.newSlug}${RESET}\n  ${newDir}\n  Pick a different new slug.\n`,
    );
  }

  // Discover worktrees inside the feature
  const repos = readdirSync(oldDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  console.log(
    `${BOLD}${CYAN}▸${RESET} renaming feature ${CYAN}${opts.oldSlug}${RESET} → ${CYAN}${opts.newSlug}${RESET}`,
  );
  console.log(`  ${DIM}root: ${root}${RESET}`);
  console.log(`  ${DIM}worktrees: ${repos.length}${RESET}`);
  console.log("");

  // Pre-flight: for each worktree, find canonical repo + check dirty
  type Plan = {
    repo: string;
    canonical: string;     // repos/<repo>
    currentBranch: string;
    dirty: boolean;
    renameBranch: boolean; // only if currentBranch === oldSlug
  };
  const plan: Plan[] = [];
  for (const repo of repos) {
    const wt = join(oldDir, repo);
    let currentBranch = "";
    let dirty = false;
    try {
      currentBranch = execGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    } catch {
      console.log(
        `  ${YELLOW}skip:${RESET} ${repo} — not a git worktree (or git unavailable)`,
      );
      continue;
    }
    try {
      const status = execGit(wt, ["status", "--porcelain"]);
      dirty = status.trim().length > 0;
    } catch {
      // treat unreadable as dirty for safety
      dirty = true;
    }
    const canonical = resolveCanonical(root, repo, wt);
    plan.push({
      repo,
      canonical,
      currentBranch,
      dirty,
      renameBranch: currentBranch === opts.oldSlug,
    });
    console.log(
      `  ${repo}  ${DIM}branch=${currentBranch}${RESET}` +
        (dirty ? `  ${YELLOW}(dirty)${RESET}` : "") +
        (currentBranch === opts.oldSlug
          ? `  ${DIM}→ branch will be renamed to ${opts.newSlug}${RESET}`
          : `  ${DIM}→ branch stays (per-repo convention)${RESET}`),
    );
  }
  console.log("");

  // Refuse on dirty unless --force
  const dirtyRepos = plan.filter((p) => p.dirty);
  if (dirtyRepos.length > 0 && !opts.force) {
    fail(
      `${dirtyRepos.length} worktree(s) have uncommitted changes:\n` +
        dirtyRepos.map((p) => `  - ${p.repo}`).join("\n") +
        `\n\nCommit/stash first, or pass ${CYAN}--force${RESET} to proceed anyway.\n`,
    );
  }

  // Confirm before destructive action unless --yes
  if (!opts.yes) {
    console.log(
      `${YELLOW}!${RESET} This will:\n` +
        `  • move ${plan.length} worktree dir(s) anvil/${opts.oldSlug}/… → anvil/${opts.newSlug}/…\n` +
        `  • rename ${plan.filter((p) => p.renameBranch).length} branch(es) named "${opts.oldSlug}" to "${opts.newSlug}"\n` +
        `  • move anvil/${opts.oldSlug}/CLAUDE.md → anvil/${opts.newSlug}/CLAUDE.md (and rewrite slug references inside)\n` +
        `  • delete the now-empty anvil/${opts.oldSlug}/\n` +
        `\nRe-run with ${CYAN}--yes${RESET} to proceed.\n`,
    );
    process.exit(0);
  }

  // Create the new feature dir
  mkdirSync(newDir, { recursive: true });

  // Move each worktree
  for (const p of plan) {
    const fromWt = join(oldDir, p.repo);
    const toWt = join(newDir, p.repo);
    try {
      execGit(p.canonical, ["worktree", "move", fromWt, toWt]);
      console.log(
        `${GREEN}+${RESET} moved worktree: anvil/${opts.oldSlug}/${p.repo} → anvil/${opts.newSlug}/${p.repo}`,
      );
    } catch (err) {
      fail(
        `failed to move worktree for ${p.repo}: ${(err as Error).message}\n` +
          `  Some worktrees may have already moved — inspect anvil/ and re-run after cleanup.\n`,
      );
    }
    if (p.renameBranch) {
      try {
        execGit(toWt, ["branch", "-m", opts.oldSlug, opts.newSlug]);
        console.log(
          `${GREEN}+${RESET} renamed branch: ${p.repo} ${opts.oldSlug} → ${opts.newSlug}`,
        );
      } catch (err) {
        console.log(
          `${YELLOW}!${RESET} branch rename failed for ${p.repo}: ${(err as Error).message} (continuing)`,
        );
      }
    }
  }

  // Move CLAUDE.md + rewrite slug references inside
  const oldClaudeMd = join(oldDir, "CLAUDE.md");
  const newClaudeMd = join(newDir, "CLAUDE.md");
  if (existsSync(oldClaudeMd)) {
    let body = readFileSync(oldClaudeMd, "utf8");
    body = body.split(opts.oldSlug).join(opts.newSlug);
    writeFileSync(newClaudeMd, body);
    unlinkSync(oldClaudeMd);
    console.log(
      `${GREEN}+${RESET} moved CLAUDE.md (and rewrote ${opts.oldSlug} → ${opts.newSlug} inside)`,
    );
  }

  // Move any other top-level files (HANDOFF.md, PLAN.md, etc.) and remove the
  // lock file
  for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
    const src = join(oldDir, entry.name);
    if (entry.name === ".agentforge.lock") {
      try {
        unlinkSync(src);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (entry.isFile()) {
      const dst = join(newDir, entry.name);
      let content = readFileSync(src, "utf8");
      content = content.split(opts.oldSlug).join(opts.newSlug);
      writeFileSync(dst, content);
      unlinkSync(src);
      console.log(`${GREEN}+${RESET} moved ${entry.name}`);
    }
  }

  // Remove old dir if now empty
  try {
    rmdirSync(oldDir);
    console.log(`${GREEN}+${RESET} removed empty anvil/${opts.oldSlug}/`);
  } catch (err) {
    console.log(
      `${YELLOW}!${RESET} could not remove anvil/${opts.oldSlug}/ — inspect manually: ${(err as Error).message}`,
    );
  }

  // Append to activity log
  appendLog(root, {
    skill: "agentforge-rename",
    action: "renamed",
    oldSlug: opts.oldSlug,
    newSlug: opts.newSlug,
    repos: plan.map((p) => p.repo).join(","),
  });

  console.log("");
  console.log(`${BOLD}${GREEN}✓${RESET} rename complete`);
  console.log(`  ${DIM}next: cd anvil/${opts.newSlug}/${RESET}`);
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function resolveCanonical(root: string, repo: string, worktree: string): string {
  // Prefer repos/<repo> if it exists; otherwise ask git for the main worktree
  const candidate = join(root, "repos", repo);
  if (existsSync(candidate)) return candidate;
  try {
    const out = execGit(worktree, ["worktree", "list", "--porcelain"]);
    // The first "worktree <path>" line is the main worktree
    const m = out.match(/^worktree (.+)$/m);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return candidate; // best-effort; git worktree move will error if wrong
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

function appendLog(
  root: string,
  fields: Record<string, string>,
): void {
  const logPath = join(root, "agentforge", "log.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    ...fields,
  };
  try {
    writeFileSync(logPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
  } catch {
    /* non-fatal */
  }
}

function fail(msg: string): never {
  process.stderr.write(`\n${RED}✗${RESET} ${msg}\n`);
  process.exit(1);
}
