# Multi-Repo Workspace

This directory is an [agentforge](https://github.com/) workspace — a bootstrapped layout
for working across multiple repositories with Claude Code, designed for the case where
one feature spans several repos and several features need to be developed in parallel.

## Directory layout

```
.
├── repos/          # main branch of each repo (read / explore only)
├── anvil/          # per-feature worktrees — ONLY in-progress work
│   └── <slug>/
│       ├── <repo>/         # a worktree of <repo> for this feature
│       └── CLAUDE.md       # feature description + repos in scope
├── artifacts/        # closed features, grouped by completion date
│   └── <YYYYMMDD>/
│       └── <slug>/
│           ├── CLAUDE.md   # original feature metadata (moved here on retro)
│           ├── RETRO.md    # retrospective
│           ├── sessions/   # Claude Code transcripts
│           ├── plans/      # plan files
│           └── refs.json   # per-repo branch + HEAD + PR pointers
├── agentforge/     # workspace metadata + master skills (the single source of truth)
│   ├── config.json
│   ├── skills/
│   └── log.jsonl   # append-only activity log
└── .claude/skills/  .cursor/rules/  .agents/skills/   # per-agent generated files
```

- **`repos/<name>/`** — you `git clone` your repos here yourself. Used for
  read / explore only. Don't edit code here.
- **`anvil/<slug>/<repo>/`** — feature work happens in worktrees. The
  `agentforge-feature-start` skill creates these.
- **`artifacts/<YYYYMMDD>/<slug>/`** — once `feature-retro` closes a feature, the
  worktree is removed and the retrospective + supporting artifacts land here.
  `ls artifacts/` shows every completed feature, newest dates first.
- **`agentforge/skills/<id>.md`** — master copy of every skill. Edit a file here
  and run `agentforge sync-skills` to push the change to every installed agent.

## Installed skills

All skills below are workspace-local (under `.claude/skills/`) and are auto-loaded by
Claude Code when you run `claude` from this directory or any subdirectory. Trigger them
by describing what you want in natural language — you don't have to remember the names.

### Day-to-day

#### Ask a question / explore code
From the workspace root, just describe what you want.
**`agentforge-project-router`** picks the right `repos/<name>/` to look in, or asks you
when ambiguous.

> "Where is the auth handler in the backend API?"
> "What does the admin's user list page do?"

### Feature lifecycle

#### 1. Start a new feature
> "Let's start a new feature: search ranking."

**`agentforge-feature-start`** proposes a kebab-case slug, asks which repos the feature
touches, and creates `git worktree`s under `anvil/<slug>/<repo>/`.

#### 2. Work on the feature
```bash
cd anvil/<slug>/
claude
```
A single session at that path sees all worktrees of the feature at once.

#### 3. Check what a change would break (before touching shared code)
> "Where else is `doSomething` used?" · "Blast radius of removing `/v1/things`?"

**`agentforge-cross-repo-impact`** searches every other `repos/*` for call sites,
imports, HTTP callers, type usages, etc. and flags breaking changes.

#### 4. Pre-deploy sanity check
> "Anything ops needs before I ship this?" · "Pre-deploy check."

**`agentforge-pre-deploy-check`** scans the worktree diff for non-code changes —
DB migrations, env vars, cache keys, message-queue schemas, dependency locks, infra
config, feature flags, API surface, cron jobs — and outputs a checklist + deploy
order.

#### 5. Open PRs for the feature
> "Open PRs for this feature." · "Make the PRs."

**`agentforge-pr-create`** detects which worktrees have commits ahead, lets you
multi-select, then opens one PR per repo via `gh`. Drafts titles + bodies from the
feature's `CLAUDE.md` and the per-repo diff stat, and cross-links the PRs to each
other.

#### 6. Audit review comments
> "Audit the PR comments." · "What do we need to fix from the review?"

**`agentforge-pr-review-analyze`** pulls every review thread, verifies each against the
live code, classifies impact (Critical → Discussion), traces the call path, and notes
test coverage. Returns a prioritized action list.

#### 7. Wrap up a finished feature
> "We're done with this feature." · "Write a retro and clean up."

**`agentforge-feature-retro`**:
1. Creates `artifacts/<YYYYMMDD>/<slug>/` (close-date directory).
2. Copies Claude Code session logs (`~/.claude/projects/.../*.jsonl`) into
   `artifacts/<YYYYMMDD>/<slug>/sessions/`.
3. Copies relevant plan files (`~/.claude/plans/*.md`) into the same archive's
   `plans/`.
4. Captures per-repo branch + HEAD + PR pointers into `refs.json`.
5. Writes `RETRO.md` — what was asked, decided, built, learned.
6. Moves `anvil/<slug>/CLAUDE.md` into the archive directory.
7. Removes each `anvil/<slug>/<repo>/` worktree (only if no dirty / unpushed
   changes), then deletes the now-empty `anvil/<slug>/` directory so `anvil/`
   only contains in-progress features.

### Looking back

#### Recall past features
> "How did we handle the retry logic last time?" · "Which feature touched
> mobile-app for queue config?" · "Find that PR about search rankings."

**`agentforge-history`** searches every `artifacts/<YYYYMMDD>/<slug>/` (RETROs, plan
files, `refs.json` with branch/HEAD/PR pointers) and answers with grounded
references — file paths, commit hashes, PR URLs — so you can verify and dig
deeper. Filters by keyword, repo, date window, or PR/commit. Read-only.

### Operations

#### Incident context (you just got paged)
> "Got an alert about `NullPointerException at Foo.process` — pull context."

**`agentforge-incident-context`** searches every repo for matching code, identifies
recent merged PRs that touched it, names the last committers, traces the call path
(highlighting async entry points), and proposes next steps. Optimized for a 30-second
read.

## Current repos

Run `ls repos/` to see them. agentforge does not maintain a separate metadata file —
the filesystem is the source of truth.
