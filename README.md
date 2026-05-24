# agentforge

<p align="center">
  <img src="https://github.com/user-attachments/assets/68277906-3c7f-442e-a68d-2ab2631698ab" width="720" alt="agentforge" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentforge"><img src="https://img.shields.io/npm/v/agentforge.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/agentforge"><img src="https://img.shields.io/npm/dm/agentforge.svg?style=flat-square" alt="npm downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/agentforge.svg?style=flat-square" alt="license" /></a>
  <img src="https://img.shields.io/node/v/agentforge.svg?style=flat-square" alt="node" />
</p>

> Multi-repo workspace bootstrapper for **Claude Code**, **Cursor**, and **OpenAI Codex CLI**.

`agentforge` turns a directory into an AI-aware workspace where one feature can span several repos in parallel, without losing track of which session is doing what. It scaffolds skill files for each supported AI CLI, manages per-feature git worktrees, and ships a handful of CLI commands for renaming features, entering background sessions, and keeping the master skill set in sync across agents.

It does **not** ship its own AI runtime — bring your own Claude Code / Cursor / Codex CLI.

---

## Why

Working across several repos at once is painful with a single AI agent:

- Your session is rooted in one repo, but the change touches three.
- You lose context when you switch terminals to a different repo.
- Parallel features step on each other's branches.
- "How did we solve this last time?" disappears the moment a PR is merged.

agentforge gives you a flat directory layout where every feature has its own per-repo git worktrees, every AI agent gets the same set of skills (in the same language), and finished work is archived with enough metadata to be queried later.

---

## Quick start

```bash
# Install
npm install -g agentforge

# Bootstrap a workspace — interactive prompts walk you through
# language (en / ko / ja) and which agents to install (Claude / Cursor / Codex)
mkdir my-workspace && cd my-workspace
agentforge init
```

<p align="center">
  <img src="https://github.com/user-attachments/assets/0eb690b2-afaf-475e-85f2-5ef33a99b118" width="720" alt="agentforge init — interactive prompts" />
</p>

```bash
# Clone your repos into repos/
git clone https://github.com/your-org/backend-api.git repos/backend-api
git clone https://github.com/your-org/admin-web.git repos/admin-web

# Start working — open the AI CLI of your choice from the workspace root
claude        # or: cursor . / codex
```

> Prefer non-interactive? `agentforge init . --agent all --lang en --yes` skips every prompt.

From inside the session, describe what you want in natural language. agentforge skills pick the right action — no command memorization needed:

> "Let's start a new feature: tighten the rate limit"

→ `agentforge-feature-start` proposes a slug, asks which repos are in scope, creates worktrees under `anvil/<slug>/<repo>/`, and (in Claude Code) dispatches a background session you can switch to with `←`.

---

## Directory layout

```
my-workspace/
├── repos/                       # main branch of each repo (read-only / explore)
│   ├── backend-api/
│   └── admin-web/
├── anvil/                       # IN-PROGRESS features only
│   └── <slug>/                  # e.g. 260524-feat-rate-limit
│       ├── backend-api/         # git worktree on a feature branch
│       ├── admin-web/           # git worktree on a feature branch
│       └── CLAUDE.md            # feature description + context + repo list
├── artifacts/                   # closed features, by completion date
│   └── 20260524/
│       └── <slug>/
│           ├── CLAUDE.md        # moved here at retro time
│           ├── RETRO.md         # retrospective
│           ├── refs.json        # per-repo branch / HEAD / PR pointers
│           ├── plans/           # plan files
│           └── sessions/        # AI session transcripts
├── agentforge/                  # workspace metadata
│   ├── config.json              # which agents, which language
│   ├── skills/                  # master skill files (single source of truth)
│   └── log.jsonl                # append-only activity log
└── .claude/skills/              # per-agent skill copies (auto-generated)
    .cursor/rules/
    .agents/skills/              # codex
```

The filesystem is the source of truth — there is no separate metadata file to drift. `ls anvil/` shows what's in flight; `ls artifacts/` shows what's done.

---

## How a feature flows

| Step | What you say | Skill that fires |
|---|---|---|
| 1. Question / explore | "Where is the auth handler in the backend API?" | `agentforge-project-router` |
| 2. Discover something to change | "Let's fix this — start a feature" | `agentforge-feature-start` |
| 3. (Optional) plan the work | "How should we split this?" | (any agent — plan it together) |
| 4. Implement | (regular coding in the dispatched session) | — |
| 5. Check blast radius before merging | "Where else is `X` used?" | `agentforge-cross-repo-impact` |
| 6. Pre-merge ops sanity check | "Anything ops needs before I ship?" | `agentforge-pre-deploy-check` |
| 7. Open PRs for the feature | "Open PRs for this feature" | `agentforge-pr-create` |
| 8. Plan the merge / deploy order | "Which PR first?" | `agentforge-release-coordinate` |
| 9. Audit review comments | "What do we need to fix from the review?" | `agentforge-pr-review-analyze` |
| 10. Hand off mid-flight (optional) | "I'm going on vacation — package this up" | `agentforge-context-handoff` |
| 11. Close the feature | "We're done — write a retro" | `agentforge-feature-retro` |

You don't have to remember the skill names — they're triggered by natural language, in English / 한국어 / 日本語.

---

## Skills

All skills live in `agentforge/skills/` (master) and are auto-propagated to every installed agent (`.claude/skills/`, `.cursor/rules/`, `.agents/skills/`) by `agentforge sync-skills`.

| Skill | What it does |
|---|---|
| `agentforge-project-router` | Routes a natural-language question to the right `repos/<name>/`. |
| `agentforge-feature-start` | Creates per-repo git worktrees for a new feature; re-runnable to add repos to an existing one. Detects per-repo branch-naming conventions from history. |
| `agentforge-cross-repo-impact` | Traces the blast radius of a change across every repo in the workspace. |
| `agentforge-pre-deploy-check` | Surfaces non-code changes (migrations, env vars, cache keys, queue contracts, infra files) that ops needs to handle before merge. Read-only. |
| `agentforge-pr-create` | Opens one PR per repo for a feature; cross-links the PRs. Never force-pushes, never merges. |
| `agentforge-pr-review-analyze` | Pulls every review thread, verifies each against the live code, returns a prioritized action list. |
| `agentforge-release-coordinate` | Plans the multi-repo merge / deploy order with preconditions, wait conditions, and a reverse-order rollback playbook. Read-only. |
| `agentforge-context-handoff` | Packages a feature's current state into `HANDOFF.md` so another developer (or future-you) can pick up without context loss. |
| `agentforge-feature-retro` | Closes a feature: writes the retrospective, archives session logs and PR refs into `artifacts/`, removes worktrees, cleans up. |
| `agentforge-incident-context` | First-responder context for a production page: searches every repo for the alert clue, names recent committers, traces the call path. Read-only. |
| `agentforge-history` | Queries past features — "how did we handle X last time?", "which feature added Y?", with grounded file / commit / PR references. Read-only. |

Every skill that modifies state asks before destructive operations and writes activity to `agentforge/log.jsonl`.

You can also add **your own** skills (`agentforge add-skill`) — they get propagated to every agent the same way.

---

## CLI reference

```
agentforge init [path]                       # bootstrap a workspace
agentforge add-agent [agents] [path]         # add Claude / Cursor / Codex to an existing workspace
agentforge remove-agent <agent> [path]
agentforge list-skills [path]                # show all installed skills
agentforge add-skill [path]                  # author a new skill
agentforge remove-skill <name> [path]
agentforge sync-skills [path]                # propagate master skill edits to every agent
agentforge enter [slug]                      # cd into a feature worktree + launch claude
agentforge rename <old-slug> <new-slug>      # rename a feature (worktrees, branch, CLAUDE.md)
agentforge doctor [path]                     # diagnose a workspace
agentforge help
```

Flags:
- `--force` — overwrite per-agent files (always backs up to `.bak` first).
- `--yes` — non-interactive; assume yes on confirmation prompts.
- `--lang en|ko|ja` — language for skill bodies.
- `--agent claude,cursor,codex` or `--agent all` — which agents to scaffold for.

---

## Multi-agent support

agentforge writes the same skill set into the file layout each AI CLI expects:

| Agent | Skill location | Workspace guide |
|---|---|---|
| **Claude Code** | `.claude/skills/<id>/SKILL.md` | `CLAUDE.md` |
| **Cursor** | `.cursor/rules/<id>.mdc` | `.cursor/rules/CLAUDE.mdc` |
| **OpenAI Codex CLI** | `.agents/skills/<id>.md` | `AGENTS.md` |

Edit a file in `agentforge/skills/` and run `agentforge sync-skills` — every agent picks up the change with the previous version backed up to `.bak`.

---

## Internationalization

Skills are stored as templates with a `{{OUTPUT_LANGUAGE_INSTRUCTION}}` placeholder. The workspace's `agentforge/config.json` `lang` field decides which language is baked in at install time (`en` / `ko` / `ja`). Switch languages by re-running `agentforge init --force-skills --lang <code>` — your master files in `agentforge/skills/` are preserved.

---

## Requirements

- Node.js ≥ 18
- `git` ≥ 2.20 (for `git worktree`)
- `gh` (GitHub CLI) — only for PR-related skills (`pr-create`, `pr-review-analyze`, `release-coordinate`)
- The AI CLI of your choice (Claude Code, Cursor, or Codex CLI) — for skill invocation
- Optional: `jq` — speeds up the activity log writer; the skills fall back to hand-built JSON if missing

---

## Conventions

- `repos/<name>/` is **read-only** — no code edits there. Use `agentforge-feature-start` to spawn a worktree.
- One feature = one slug = one directory under `anvil/` (and later `artifacts/<date>/`).
- Slug format: `<YYMMDD>-<kind>-<core>` where `<kind>` is `feat` / `fix` / `refactor` / `chore`.
- Branch names per repo follow each repo's own convention, detected from recent branches at feature-start time. They may differ from the slug.
- `anvil/` only contains in-progress work. Completed features move to `artifacts/<YYYYMMDD>/<slug>/`.

---

## License

MIT.

