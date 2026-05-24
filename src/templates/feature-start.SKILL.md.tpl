---
name: agentforge-feature-start
description: Starts a new feature in a multi-repo workspace, or adds repos to an existing one. Summarizes the feature into a kebab-case slug, suggests which repos it likely touches by grepping repos/* for keywords, asks the user to confirm via multi-select, and creates git worktrees under anvil/<slug>/<repo>/. Re-runnable — calling it again with an existing slug switches to "additive" mode and only adds the newly chosen repos. Triggers when the user says things like "let's start a new feature", "I want to build X", "add repo Y to feature Z", or otherwise signals starting or expanding a unit of work.
---

# feature-start

Bootstraps a new feature by laying down git worktrees so the user can work across one
or more repos in parallel without disturbing their main checkouts. Re-runnable: calling
it again with the same slug extends the existing feature instead of starting over.

## When to apply

Apply this skill when the user signals the **start of new work** or wants to **extend
an existing feature** with another repo:

- "Let's start a new feature."
- "I'm going to build X."
- "Let's begin work on Y."
- "Cut a new branch for Z."
- "Add repo `d` to `feat-search-ranking` too."
- "Also include the admin side in this feature."

Plain questions or exploration go to `project-router`. Only apply here when scope is
being opened or expanded.

## Concurrency lock

Before any destructive action, take a workspace-level lock so two concurrent sessions
don't fight over the same feature:

```bash
LOCK="anvil/<slug>/.agentforge.lock"
if [ -f "$LOCK" ]; then
  cat "$LOCK"   # shows pid + started-at written by the other session
  # → tell the user another session is working on this feature and stop.
else
  mkdir -p "$(dirname "$LOCK")"
  printf 'pid=%s\nstarted=%s\nskill=agentforge-feature-start\n' \
    "$$" "$(date -u +%FT%TZ)" > "$LOCK"
fi
```

Release the lock on success **and** on every failure path (`trap` or explicit
removal). If a stale lock exists (older than ~30 min with no live pid), report it to
the user and ask whether to override.

## Mode detection

Before anything else, decide which mode you're in by checking the slug:

- **New mode** — the user is describing a brand-new piece of work, and no
  `anvil/<slug>/` directory exists yet for it.
- **Additive mode** — the user named an existing feature slug (or you derived the same
  slug from the description and `anvil/<slug>/` already exists). In this mode, do not
  re-derive the slug, do not overwrite `CLAUDE.md` — extend.

To detect additive mode:
1. Walk up from cwd to find the workspace root (the directory containing `repos/` and
   `anvil/`).
2. If the user named a slug, check `test -d anvil/<slug>/`. If yes → additive mode.
3. Otherwise derive a fresh slug from the description (see Step 1) and check the same
   way. Match → additive. No match → new mode.

**Validate the metadata against reality.** In additive mode, read
`anvil/<slug>/CLAUDE.md` to learn which repos are listed as in-scope, then **verify
each one still has a worktree under `anvil/<slug>/<repo>/`**. If a listed repo's
directory is missing, treat it as "no longer present" — drop it from the locked set,
report the discrepancy to the user, and offer to update CLAUDE.md to reflect the
current state.

## How to do it

### Step 0 — Suggest which repos this feature likely touches

Before asking the user, run a light grep across `repos/*` using keywords from the
feature description. Goal: pre-check the repos that obviously contain related code, so
the user just confirms instead of guessing.

Process:
1. Extract searchable tokens from the feature description: drop stop-words, keep nouns
   and identifier-like phrases. Example: "Improve the search ranking" →
   `[search, ranking, improve]`.
2. For each `repos/<name>/`, run a fast case-insensitive search restricted to source
   files (exclude `node_modules`, `dist`, `build`, `.git`, lock files):
   ```bash
   git -C repos/<name> grep -li -E '<token1>|<token2>|<token3>' \
       -- ':!*.lock' ':!node_modules' ':!dist' ':!build' \
       | head -5
   ```
   Or fall back to `grep -rli` if not a git repo.
3. Score each repo by hit count. **Pre-check repos with at least one hit.**
4. **Always include all repos in the multi-select** — the pre-check is a *suggestion*,
   not a filter. The user may know about a repo that grep missed (e.g. a new module
   being added from scratch).

Tell the user what you found, briefly:
```
Searched repos/ for: search, ranking, improve
  ✓ backend-api  (12 files match)
  ✓ admin-web    (4 files match)
  ✓ worker-service    (1 file matches)
  · mobile-app  (no matches)
```

In **additive mode**, restrict the search to repos NOT already in the feature, so the
suggestion is about what to add.

### Step 1 — Get / confirm the slug

**New mode:** derive a kebab-case slug from the description.

The slug has three parts: `<YYMMDD>-<kind>-<core>`.

**Date prefix** — today in `YYMMDD` form (e.g. `260523` for 2026-05-23). This
makes `ls anvil/` naturally sort by start date.

```bash
date -u +%y%m%d
```

**Kind prefix** — infer from the user's wording. This is what distinguishes a
new feature from a bug fix or refactor in the directory listing and in
`artifacts/` history:

| Kind     | Trigger words (en / ko)                                                                  |
|----------|-------------------------------------------------------------------------------------------|
| `feat`   | "feature", "add", "implement", "introduce", "support", "build" / "추가", "구현", "기능", "도입" |
| `fix`    | "bug", "fix", "broken", "incorrect", "wrong", "regression" / "버그", "오류", "고치", "픽스", "잘못" |
| `refactor` | "refactor", "cleanup", "rewrite", "simplify", "reorganize" / "리팩터", "정리", "단순화", "재구성" |
| `chore`  | "chore", "bump", "deps", "tooling", "ci", "config", "format" / "버전 업", "의존성", "툴링", "설정" |

If the wording is ambiguous (e.g. "let's start a new one" with no other
context), default to `feat` and confirm with the user when showing the slug.

**Core** — the kebab-case body. Lowercase ASCII letters, digits, hyphens only.
Up to 8 words. Capture the core meaning, drop filler words.

Examples (assuming today is 2026-05-23):
- "Improve the search ranking" → `260523-feat-search-ranking`
- "Tighten the rate limit" → `260523-feat-rate-limit-tighten`
- "Fix the search ranking regression" → `260523-fix-search-ranking`
- "Refactor the rate limit module" → `260523-refactor-rate-limit`
- "Bump axios across all repos" → `260523-chore-axios-bump`

Show the slug back to the user and **get explicit confirmation** (or a corrected
slug — the user can change the kind too if you guessed wrong). The slug is used
for the worktree directory; per-repo branch names are decided separately in
Step 3.5 and may follow each repo's own convention.

**Additive mode:** the slug is the existing one — skip this step. Read
`anvil/<slug>/CLAUDE.md` to learn the original description and which repos are
already in scope.

### Step 2 — Multi-select repos

Run `ls repos/` to list the workspace's repos. Present them to the user as a
multi-select with the Step 0 suggestions **pre-checked**:

```
Which repos does this feature touch? (suggestions pre-checked)
[x] backend-api    ← matched 12 files for the keywords
[x] admin-web      ← matched 4 files
[x] worker-service      ← matched 1 file
[ ] mobile-app    (no matches, include if you know it's involved)
```

**In additive mode**, also indicate which repos are already in the feature — show them
as `(already in feature)` and **disabled** (informational only). The user picks only
from the rest:

```
feat-search-ranking — Repos in scope:
[*] backend-api    (already in feature)
[ ] mobile-app
[ ] admin-web      ← matched 4 files for "search, ranking, improve"
[x] worker-service      ← matched 1 file
```

If your environment supports a structured multi-select, use it. Otherwise accept names
or numbers. **The pre-check is a suggestion; the user is still in control.**

### Step 3 — Pre-flight check (per chosen repo)

Before touching any repo, run a quick state check on each one. This catches the case
where `repos/<repo>` is on an unexpected branch or has in-progress work, so the new
worktree starts from a deliberate base.

For each chosen repo, gather:

1. **Base branch** — try in order, pick the first that exists:
   ```bash
   # default branch from origin
   git -C repos/<repo> symbolic-ref --quiet refs/remotes/origin/HEAD \
     | sed 's@^refs/remotes/origin/@@'
   # fallback: a local branch named main / master / develop / trunk
   git -C repos/<repo> show-ref --verify --quiet refs/heads/main && echo main
   git -C repos/<repo> show-ref --verify --quiet refs/heads/master && echo master
   git -C repos/<repo> show-ref --verify --quiet refs/heads/develop && echo develop
   ```
   If none found → ask the user which branch to base off.

2. **Current branch** (or detached HEAD):
   ```bash
   git -C repos/<repo> symbolic-ref --short HEAD 2>/dev/null \
     || echo "(detached at $(git -C repos/<repo> rev-parse --short HEAD))"
   ```

3. **Working-tree state**:
   ```bash
   git -C repos/<repo> status --porcelain
   ```
   Non-empty = uncommitted changes (staged + unstaged + untracked).

Present a state report to the user:

```
Pre-flight:

repos/a
  base    = origin/main
  current = feat-other            ⚠ not on base
  working = 3 uncommitted files
repos/d
  base    = origin/main
  current = main                  ✓
  working = clean
repos/e
  base    = origin/main
  current = main                  ✓
  working = 5 staged files        ⚠ uncommitted (will be preserved)
```

**Ask the user to confirm before proceeding** if any repo has a warning:
- Different current branch → "the new worktree will start from `origin/<base>`,
  not from your current branch. OK?"
- Detached HEAD → same prompt, plus a heads-up that the current commit isn't on a
  branch.
- Uncommitted changes → "these stay in `repos/<repo>` untouched; only the new
  worktree is affected. Proceed?"

If the user says no for a repo, drop it from the set (do not auto-substitute).

### Step 3.5 — Detect branch naming convention (per repo)

Different repos may use different branch naming conventions — one team writes
`feat/<COMPONENT>-<YYMMDD>-<topic>`, another writes `feature/<TICKET>`. Before
creating worktrees, sample each repo's recent branches, identify the dominant
template, and propose a branch name. The user confirms or edits per repo.

For each chosen repo (in **additive mode**, only the newly added ones):

**1. Sample recent branches:**

```bash
git -C repos/<repo> for-each-ref \
  --sort=-committerdate --count=30 \
  --format='%(refname:short)' \
  refs/heads refs/remotes/origin \
  | sed 's|^origin/||' \
  | grep -vE '^(HEAD|main|master|develop|trunk)$' \
  | grep -vE '^(release|hotfix)/' \
  | awk '!seen[$0]++' \
  | head -15
```

`awk '!seen[$0]++'` dedups local vs remote while preserving committer-date order.

**2. Analyze the template.** Read the samples and identify, as an LLM:
- **prefix namespace** — `feature/`, `feat/`, `bugfix/`, a username, or none
- **ticket / component tokens** — e.g. `<PROJ>-<CORE>`, `<PROJ>-1234`, `JIRA-42`.
  Note both the format (component code vs Jira number) and its position.
- **date component** — `YYMMDD`, `YYYY-MM-DD`, `YYYYMMDD`, or none
- **separator** — `-`, `_`, or mixed
- **topic charset** — if ≥1 sample's topic part contains non-ASCII (Korean, etc.),
  allow non-ASCII in the proposed topic; otherwise ASCII kebab only
- **component ordering** — derive the dominant order, e.g.
  `<prefix>/<TICKET>-<YYMMDD>-<topic>`

Do **not** brute-force this with a rigid regex — orderings vary by team. Read the
samples as a human would. If samples are inconsistent (< 60% follow any one
template) or there are < 3 usable samples, fall back to the workspace default
`<slug>` as the branch name and tell the user "couldn't detect a clear pattern for
this repo, using `<slug>` as the branch name."

**3. Propose a branch.** Fill the template:
- `{date}` → today's date in the detected format (the same UTC date used in the
  slug)
- `{topic}` → the feature's kebab core (the slug minus its `<YYMMDD>-feat-`
  prefix). Preserve non-ASCII if the samples have it; otherwise ASCII-kebab.
- `{TICKET}` → ask the user: "ticket / component for `<repo>`? (or `skip`)". If
  the user types `skip`, omit the segment cleanly (collapse adjacent separators
  so you don't end up with `feature/--topic`).

**4. Show + confirm per repo.** For each repo, print the samples and the
proposal, then let the user accept (Enter), type a replacement, or `default`:

```
<repo> — recent branches (last 15):
  feature/<PROJ-CORE>-<YYMMDD>-<topic-a>
  feature/<PROJ-WEB>-<YYMMDD>-<topic-b>
  feature/<PROJ-API>-<YYMMDD>-<topic-c>
  ...

Detected pattern: feature/{TICKET}-{YYMMDD}-{topic}

Ticket / component for <repo>? (or `skip`)
> <TICKET>

Proposed branch: feature/<TICKET>-<YYMMDD>-<topic>
[Enter to accept · type to override · `default` for <slug>]
>
```

**5. Record** the final branch per repo in an in-memory map
`branches: { <repo>: <branch>, ... }`. Step 4 reads `<branch[repo]>` from it;
Step 5 (CLAUDE.md) and the activity log record it.

A user-edited branch may coincide with the workspace `<slug>` — that's fine. There
is no constraint that per-repo branches must differ from the slug.

### Step 4 — Create worktrees (for newly chosen repos only)

For each chosen repo *that isn't already a worktree* under `anvil/<slug>/`, use the
detected base **explicitly** — never trust the current HEAD of `repos/<repo>`:

```bash
# 1. fetch latest base. Capture the result — do NOT silently swallow failures.
if git -C repos/<repo> fetch origin <base> --quiet; then
  fetched=ok
else
  fetched=failed
fi

# 2. create the worktree from origin/<base> if fetch worked,
#    otherwise from the local <base>. The branch name comes from Step 3.5's
#    per-repo map (branches[<repo>]); fall back to <slug> if Step 3.5 was
#    skipped (e.g. additive mode where this repo was already in place).
if [ "$fetched" = ok ]; then
  git -C repos/<repo> worktree add ../../anvil/<slug>/<repo> -b <branch[repo]> origin/<base>
else
  # Tell the user the remote is unreachable and ASK before continuing
  # ("worktree will be based on local <base> which may be stale — proceed?")
  git -C repos/<repo> worktree add ../../anvil/<slug>/<repo> -b <branch[repo]> <base>
fi
```

If the user declines the stale base, skip this repo (don't substitute silently).

If the repo has no `origin` remote at all, base off the local branch and tell the
user that's what happened.

**Conflict handling:**
- If a branch named `<branch[repo]>` already exists on the repo, ask the user:
  reuse the existing branch (drop the `-b` flag and use the branch directly) /
  edit the proposed branch name / abort. Loop back to Step 3.5's confirm prompt
  if they want to edit.
- If `anvil/<slug>/<repo>/` already exists but isn't a worktree for the chosen
  branch, ask before doing anything destructive.
- In additive mode, repos already mapped to `anvil/<slug>/<repo>/` are silently
  skipped — they're not a conflict, they're the current state.

Report success or failure per repo with the chosen branch and base:
```
✓ backend-api    → anvil/<slug>/backend-api
    branch: feature/<TICKET>-<YYMMDD>-<topic>   (from origin/main)
✓ admin-web      → anvil/<slug>/admin-web
    branch: feat/<TICKET>                       (from origin/main)
✓ worker-service → anvil/<slug>/worker-service
    branch: <slug>                              (from origin/main; pattern detection fell back to slug)
```

### Partial failure handling

If `git worktree add` fails for some repos (auth, disk, conflict, etc.):

1. **Do not silently continue as if all succeeded.** List succeeded vs failed:
   ```
   ✓ a   created
   ✗ d   failed: <git error message>
   ✓ e   created
   ```
2. **Only write CLAUDE.md / update the in-scope list with the repos that actually
   succeeded.** Failed repos must not appear there.
3. Tell the user how to retry: `agentforge-feature-start d` (additive mode will add
   only d if a and e are already in place).
4. Release the lock before returning.

### Step 5 — Write / update the feature CLAUDE.md

**New mode** — create `anvil/<slug>/CLAUDE.md`:

```markdown
# Feature: <original description>

- Slug: `<slug>`
- Started: <YYYY-MM-DD>
- Repos in scope:
  - `<repo1>` → `anvil/<slug>/<repo1>/` · branch `<branch1>`
  - `<repo2>` → `anvil/<slug>/<repo2>/` · branch `<branch2>`

## Context

<5–10 line summary of anything explored / learned / decided in the current
session BEFORE the user pivoted to "let's start a feature". Examples of what to
capture:
- What was the user originally asking about (the exploration prompt)?
- Which files / functions / endpoints did we look at?
- What was the discovery that triggered making this a feature
  (e.g. "found that retry count is hardcoded to 5 in foo.ts:42 — that's the bug")?
- Any hypotheses / decisions already made (e.g. "decision: bump retry to 10
  with backoff, do NOT touch the failover path")?

If there was no meaningful exploration before this skill ran (user said
"start a feature" cold), write `(none — feature started cold)` and skip the
list.>

Work on this feature happens here (`anvil/<slug>/`). Run `claude` from this directory
to work across all the worktrees above in a single session.

> Note: branch names per repo follow each repo's own naming convention (detected at
> feature-start time). They may differ from the slug. Downstream skills
> (`pr-create`, `feature-retro`) read the actual branch from each worktree's HEAD,
> so this metadata is informational — git is the source of truth.
```

The `## Context` section is what carries forward what you (the parent session)
already know. The dispatched background session auto-loads this CLAUDE.md, so
the new session starts with the context instead of asking the user to re-explain.

**Be conservative in what you capture.** Five to ten lines. Don't paste full
file contents or transcripts — link to file paths with line numbers and let
the next session read for itself.

**Additive mode** — read the existing `CLAUDE.md`, then **update** it without losing
the original description or other user edits:
- Append newly added repos to the `Repos in scope:` list with their branch names
  (preserve order: existing first, then new). Do not touch the branch line of
  existing entries.
- Add a `- Expanded: <YYYY-MM-DD>` line under the metadata block if not already there
  for today.
- Do not rewrite the description or any free-text the user has added.
- If new exploration happened in this session before deciding to expand the
  feature, **append** to the existing `## Context` section under a sub-heading
  like `### Update <YYYY-MM-DD>` with a 2–5 line note about what was learned
  and why this repo is being added. Never rewrite earlier Context entries.

### Step 6 — Hand off (auto-dispatch when possible)

After worktrees are created, get the user into the new `anvil/<slug>/` directory
with as little friction as possible. The right hand-off depends on which CLI the
user is running this skill in — detect and branch.

**New mode only.** In additive mode the user already has a session for the feature;
skip the dispatch and just report what was added.

#### Detect the CLI

Use a single, durable signal: is `claude` on PATH?

```bash
if command -v claude >/dev/null 2>&1; then echo claude; else echo other; fi
```

Treat the result as a proxy for "the user is running Claude Code". Cursor and Codex
CLI users typically don't have `claude` on PATH; if they do (mixed install), the
dispatch below still works and just sits idle as a parallel option — harmless.

#### Branch A — `claude` is available (Claude Code users)

Dispatch a background Claude Code session whose working directory is the new
worktree. The user, still in the parent session, can press `←` on an empty prompt
to open Agent View and jump straight into it.

```bash
( cd anvil/<slug> && claude --bg --name "<slug>" "ready" )
```

Notes:
- `claude --bg` requires a prompt; `"ready"` is an innocuous placeholder so the
  session boots and idles waiting for the user.
- `--name "<slug>"` makes it easy to identify in Agent View.
- The subshell `( ... )` keeps the parent session's cwd unchanged.
- If `claude --bg` exits non-zero (older build without `--bg`, etc.), report the
  error and fall through to Branch B — do not retry.

Then report:

```
✓ Worktrees ready. Dispatched a background Claude session in anvil/<slug>/.

  → Press ← (left arrow) on an empty prompt here to open Agent View,
    then pick the session named "<slug>".

  Fallback if Agent View isn't available:
    cd anvil/<slug>/ && claude
```

#### Branch B — `claude` is not available (Cursor / Codex CLI / other)

Do **not** try to dispatch anything. Just tell the user where to point their tool:

```
✓ Worktrees ready. Open your editor / CLI on:

    anvil/<slug>/

  In Cursor:        File → Open Folder… → anvil/<slug>/
  In Codex CLI:     cd anvil/<slug>/ && codex
  In a terminal:    cd anvil/<slug>/ && <your-CLI>
```

Pick the one line that matches the user's setup if you know it from
`agentforge/config.json`'s `agents:` list; otherwise show all three.

#### Additive mode (both branches)

Before reporting success, check the parent session's cwd against the feature
root:

```bash
case "$PWD" in
  */anvil/<slug>)            cwd_state=at-root ;;
  */anvil/<slug>/*/*)        cwd_state=deeper ;;
  */anvil/<slug>/*)          cwd_state=in-subrepo ;;
  *)                         cwd_state=outside ;;
esac
```

If `cwd_state` is `at-root`, the newly added worktrees appear as siblings and
are visible to the current session — nothing extra to do:

```
✓ Added <N> repo(s) to feature `<slug>`:
  - <repo-1>
  - <repo-2>

The feature now spans: <repo-A>, <repo-B>, <repo-1>, <repo-2>.
Continue in your existing anvil/<slug>/ session.
```

If `cwd_state` is `in-subrepo` (the session is inside one specific repo's
worktree like `anvil/<slug>/<old-repo>/`), the newly added worktrees are
siblings of cwd, not visible from this session's working directory. In **Branch
A** (Claude available), dispatch a fresh background session at the feature root
so the user can switch to it via Agent View:

```bash
( cd anvil/<slug> && claude --bg --name "<slug>" "expanded — read CLAUDE.md and the Context section, then wait for instructions" )
```

Then report:

```
✓ Added <N> repo(s) to feature `<slug>`:
  - <repo-1>
  - <repo-2>

You're inside anvil/<slug>/<old-repo>/, but the new worktrees were added as
siblings under anvil/<slug>/. To work with all of them in one session:

  → Press ← (left arrow) on an empty prompt here, then pick the session
    named "<slug>" in Agent View (just dispatched at the feature root).

  Fallback:
    cd anvil/<slug>/ && claude
```

In **Branch B** (no `claude` on PATH), skip the dispatch and instead instruct:

```
✓ Added <N> repo(s) to feature `<slug>`:
  - <repo-1>
  - <repo-2>

You're inside anvil/<slug>/<old-repo>/. The new worktrees were added as
siblings — close this session and reopen at anvil/<slug>/ to see all
worktrees together:

  cd anvil/<slug>/ && <your-CLI>
```

If `cwd_state` is `outside` (unusual — user ran the skill from somewhere not in
the feature), just report success and let them navigate themselves.

Do **not** start a foreground `claude`/`cursor`/`codex` from inside this skill —
that would block the current session. Background dispatch is only safe for
Branch A (`claude --bg`), and only in new mode.

## Rules

- Always run `git worktree add` from inside the canonical repo (`repos/<name>/`),
  never from `anvil/`.
- **Always pass an explicit base** to `git worktree add` (e.g. `origin/main`). Do not
  rely on the current HEAD of `repos/<repo>` — the user may be mid-work on another
  branch there.
- **Never touch `repos/<repo>`'s working tree.** Uncommitted changes there stay where
  they are. Only the new worktree is created.
- If the slug feels off, re-confirm with the user before creating any worktree.
  Worktrees are cheap to make but annoying to clean up.
- Never assume a feature spans every repo. Ask, then act.
- **Step 0's pre-check is a hint, not a decision.** Always show all repos and let the
  user override.
- **In additive mode, never touch existing worktrees or branches.** Only add new ones.
- **In additive mode, never overwrite the feature CLAUDE.md.** Append / update in
  place.

## Activity log

After each successful destructive action (worktree created, CLAUDE.md updated),
append a JSONL line to `<workspace>/agentforge/log.jsonl`:

```bash
mkdir -p <workspace>/agentforge
printf '%s\n' "$(jq -nc \
  --arg ts "$(date -u +%FT%TZ)" \
  --arg skill agentforge-feature-start \
  --arg slug '<slug>' \
  --arg action '<created|added|noop>' \
  --arg repos '<repo-list-comma-separated>' \
  --arg branches '<repo1>=<branch1>,<repo2>=<branch2>' \
  '{ts:$ts, skill:$skill, slug:$slug, action:$action, repos:$repos, branches:$branches}')" \
  >> <workspace>/agentforge/log.jsonl
```

If `jq` is unavailable, append a hand-built JSON line. This log is consumed by
`agentforge-feature-retro` to enrich the RETRO.md timeline.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
