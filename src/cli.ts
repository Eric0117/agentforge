#!/usr/bin/env node
import { runAddAgent } from "./add-agent.js";
import { runAddSkill } from "./add-skill.js";
import { AGENT_IDS } from "./agents/index.js";
import type { AgentId } from "./agents/types.js";
import { runDoctor } from "./doctor.js";
import { runEnter } from "./enter.js";
import { runInit } from "./init.js";
import { runRename } from "./rename.js";
import { runListSkills } from "./list-skills.js";
import { runRemoveAgent } from "./remove-agent.js";
import { runRemoveSkill } from "./remove-skill.js";
import { runSyncSkills } from "./sync-skills.js";

const HELP = `agentforge — multi-repo workspace bootstrapper for Claude Code, Cursor, and OpenAI Codex CLI

Usage:

  Workspace setup
  ───────────────
  agentforge init [path]                       Bootstrap a workspace (creates agentforge/,
        [--force | --force-skills | --force-claude]   anvil/, artifacts/, and per-agent
        [--yes] [--lang en|ko|ja]                     skill directories).
        [--agent claude,cursor,codex | --agent all]

  agentforge add-agent [agents] [path]         Add Claude / Cursor / Codex to an existing
        [--force | --force-skills | --force-claude]   workspace.
        [--yes] [--lang en|ko|ja]

  agentforge remove-agent <agent> [path]       Uninstall an agent's skill directory.
        [--yes]

  Skills
  ──────
  agentforge list-skills [path]                Show every skill installed in the workspace.

  agentforge add-skill [path]                  Author a new master skill (with optional
        [--from <file>] [--no-edit] [--yes]    starter from --from <file>) and install it
                                               to every agent.

  agentforge remove-skill <name> [path]        Remove a skill from master + every agent.
        [--yes]

  agentforge sync-skills [path]                Propagate master skill edits in
        [--force-claude]                       agentforge/skills/ to every agent.
                                               Backs up existing files to .bak.

  Features
  ────────
  agentforge enter [slug]                      cd into a feature worktree (anvil/<slug>/)
                                               and launch \`claude\` there. No args lists
                                               active features.

  agentforge rename <old-slug> <new-slug>      Rename a feature: moves the worktrees,
        [--yes] [--force]                      renames any branch named <old-slug>,
                                               rewrites slug references in CLAUDE.md.
                                               Refuses dirty worktrees without --force.

  Diagnostics
  ───────────
  agentforge doctor [path]                     Check the workspace for misconfiguration.

  agentforge help                              Show this message.
  agentforge --help

Notes:
  • Workspaces have a master skills folder at <workspace>/agentforge/skills/ and a
    config file at <workspace>/agentforge/config.json. Edits to master files are
    propagated to every installed agent by \`sync-skills\`.
  • Existing per-agent files are preserved by default; --force* variants back up
    the previous content to .bak before overwriting.
  • Skills are triggered by natural language inside your AI session — you don't run
    them via this CLI. See <workspace>/CLAUDE.md (or AGENTS.md / .cursor/rules/CLAUDE.mdc)
    for the trigger phrases.
`;

type Args = {
  command?: string;
  positional: string[];
  forceSkills: boolean;
  forceClaude: boolean;
  yes: boolean;
  help: boolean;
  lang?: "en" | "ko" | "ja";
  agents?: AgentId[];
  fromFile?: string;
  noEdit: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    positional: [],
    forceSkills: false,
    forceClaude: false,
    yes: false,
    help: false,
    noEdit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") {
      out.forceSkills = true;
      out.forceClaude = true;
    } else if (a === "--force-skills") out.forceSkills = true;
    else if (a === "--force-claude") out.forceClaude = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--lang") {
      const v = argv[++i];
      if (v === "en" || v === "ko" || v === "ja") out.lang = v;
      else {
        process.stderr.write(`invalid --lang value: ${v} (use en | ko | ja)\n`);
        process.exit(1);
      }
    } else if (a.startsWith("--lang=")) {
      const v = a.slice("--lang=".length);
      if (v === "en" || v === "ko" || v === "ja") out.lang = v;
      else {
        process.stderr.write(`invalid --lang value: ${v} (use en | ko | ja)\n`);
        process.exit(1);
      }
    } else if (a === "--agent") {
      const v = argv[++i];
      if (out.agents !== undefined) {
        process.stderr.write(
          `\nerror: --agent specified more than once. Combine them: \`--agent claude,cursor,codex\` or \`--agent all\`.\n\n`,
        );
        process.exit(1);
      }
      out.agents = parseAgents(v);
    } else if (a.startsWith("--agent=")) {
      if (out.agents !== undefined) {
        process.stderr.write(
          `\nerror: --agent specified more than once. Combine them: \`--agent claude,cursor,codex\` or \`--agent all\`.\n\n`,
        );
        process.exit(1);
      }
      out.agents = parseAgents(a.slice("--agent=".length));
    } else if (a === "--from") {
      out.fromFile = argv[++i];
    } else if (a.startsWith("--from=")) {
      out.fromFile = a.slice("--from=".length);
    } else if (a === "--no-edit") {
      out.noEdit = true;
    } else if (a.startsWith("--") || /^-[a-zA-Z]/.test(a)) {
      // Unknown flag — refuse instead of silently treating as positional.
      // Without this, `init --bogus /tmp/x` would resolve("--bogus") as the
      // workspace path and produce a baffling error downstream.
      const known = [
        "--force",
        "--force-skills",
        "--force-claude",
        "--yes",
        "--help",
        "--lang",
        "--agent",
        "--from",
        "--no-edit",
        "-f",
        "-y",
        "-h",
      ];
      const guess = nearestCommand(a, known);
      let msg = `\nerror: unknown flag: ${a}\n`;
      if (guess) msg += `\nDid you mean: \x1b[36m${guess}\x1b[0m?\n`;
      msg += `\n`;
      process.stderr.write(msg);
      process.exit(1);
    } else if (!out.command) {
      out.command = a;
    } else {
      // Reject empty-string positional args — they're almost always an unset
      // shell var (`agentforge init "$WS"` with WS unset) and would silently
      // collapse to cwd through resolve("").
      if (a === "") {
        process.stderr.write(
          `\nerror: empty positional argument. Did you mean to expand a shell variable that wasn't set?\n\n`,
        );
        process.exit(1);
      }
      out.positional.push(a);
    }
  }
  return out;
}

function looksLikeAgentSpec(s: string): boolean {
  if (s === "all") return true;
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length === 0) return false;
  return parts.every((p) => (AGENT_IDS as readonly string[]).includes(p));
}

function parseAgents(value: string | undefined): AgentId[] {
  if (!value) {
    process.stderr.write(
      `--agent requires a value (claude | cursor | codex | all)\n`,
    );
    process.exit(1);
  }
  if (value === "all") return AGENT_IDS.slice();
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = new Set<string>(AGENT_IDS);
  const bad = ids.filter((id) => !valid.has(id));
  if (bad.length > 0 || ids.length === 0) {
    process.stderr.write(
      `invalid --agent value(s): ${bad.join(", ") || value} (use claude | cursor | codex | all)\n`,
    );
    process.exit(1);
  }
  return Array.from(new Set(ids)) as AgentId[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command || args.command === "help") {
    process.stdout.write(HELP);
    process.exit(args.help || args.command === "help" ? 0 : 1);
  }

  switch (args.command) {
    case "init":
      await runInit({
        pathArg: args.positional[0],
        forceSkills: args.forceSkills,
        forceClaude: args.forceClaude,
        yes: args.yes,
        lang: args.lang,
        agents: args.agents,
      });
      return;

    case "add-agent": {
      // [agents] [path]: first positional may be agents spec or path
      let agents = args.agents;
      let pathArg: string | undefined;
      const [p0, p1] = args.positional;
      if (p0 != null) {
        if (looksLikeAgentSpec(p0)) {
          if (!agents) agents = parseAgents(p0);
          if (p1 != null) pathArg = p1;
        } else {
          pathArg = p0;
        }
      }
      await runAddAgent({
        agents,
        pathArg,
        forceSkills: args.forceSkills,
        forceClaude: args.forceClaude,
        yes: args.yes,
        lang: args.lang,
      });
      return;
    }

    case "remove-agent": {
      const [p0, p1] = args.positional;
      if (!p0 || !(AGENT_IDS as readonly string[]).includes(p0)) {
        process.stderr.write(
          `usage: agentforge remove-agent <claude|cursor|codex> [path]\n`,
        );
        process.exit(1);
      }
      await runRemoveAgent({
        agent: p0 as AgentId,
        pathArg: p1,
        yes: args.yes,
      });
      return;
    }

    case "list-skills":
      await runListSkills({ pathArg: args.positional[0] });
      return;

    case "add-skill":
      await runAddSkill({
        pathArg: args.positional[0],
        fromFile: args.fromFile,
        noEdit: args.noEdit,
        yes: args.yes,
      });
      return;

    case "remove-skill": {
      const [name, pathArg] = args.positional;
      if (!name) {
        process.stderr.write(`usage: agentforge remove-skill <name> [path]\n`);
        process.exit(1);
      }
      await runRemoveSkill({ name, pathArg, yes: args.yes });
      return;
    }

    case "sync-skills":
      await runSyncSkills({
        pathArg: args.positional[0],
        forceSkills: args.forceSkills,
        forceClaude: args.forceClaude,
      });
      return;

    case "doctor":
      await runDoctor({ pathArg: args.positional[0] });
      return;

    case "enter":
      await runEnter({ slug: args.positional[0] });
      return;

    case "rename":
      await runRename({
        oldSlug: args.positional[0],
        newSlug: args.positional[1],
        yes: args.yes,
        force: args.forceSkills || args.forceClaude,
      });
      return;
  }

  const known = [
    "init",
    "add-agent",
    "remove-agent",
    "list-skills",
    "add-skill",
    "remove-skill",
    "sync-skills",
    "enter",
    "rename",
    "doctor",
    "help",
  ];
  const guess = nearestCommand(args.command!, known);
  let msg = `unknown command: ${args.command}\n`;
  if (guess) msg += `\nDid you mean: \x1b[36m${guess}\x1b[0m?\n`;
  msg += `\nRun \x1b[36magentforge help\x1b[0m for the full command list.\n`;
  process.stderr.write(msg);
  process.exit(1);
}

function nearestCommand(input: string, known: string[]): string | null {
  let best: { cmd: string; dist: number } | null = null;
  for (const cmd of known) {
    const d = levenshtein(input.toLowerCase(), cmd);
    if (best === null || d < best.dist) best = { cmd, dist: d };
  }
  // Only suggest if reasonably close — 3 edits or 40% of length.
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(input.length * 0.4));
  return best.dist <= threshold ? best.cmd : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1).fill(0).map((_, i) => i);
  const cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // readConfig throws "failed to read .../config.json: ..." — reframe.
  if (msg.startsWith("failed to read ") && msg.includes("config.json")) {
    process.stderr.write(
      `\n\x1b[31m✗\x1b[0m \x1b[1magentforge/config.json is invalid.\x1b[0m\n  \x1b[2m${msg.slice("failed to read ".length)}\x1b[0m\n\n` +
        `  Fix the file directly, or re-create the workspace with \x1b[36magentforge init <path> --force\x1b[0m\n` +
        `  (existing files are backed up to .bak before overwriting).\n\n`,
    );
  } else {
    console.error(`\nerror: ${msg}`);
  }
  process.exit(1);
});
