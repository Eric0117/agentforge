---
name: agentforge-feature-retro
description: Wraps up a finished feature in a multi-repo workspace. Writes a retrospective and supporting artifacts (Claude Code session logs, plan files, branch/PR refs) into artifacts/<YYYYMMDD>/<slug>/, removes the now-stale git worktrees from anvil/<slug>/, and deletes the empty anvil/<slug>/ directory so anvil/ only ever contains in-progress work. Triggers when the user signals a feature is done — e.g. "we're done", "feature is complete", "let's wrap this up", "write a retro", "archive this work".
---

# feature-retro

Closes the loop on a finished feature. Conceptually three things happen, in order:

1. Capture everything worth keeping (retro, sessions, plans, git refs) into
   `artifacts/<YYYYMMDD>/<slug>/`.
2. Remove the git worktrees the feature used.
3. Delete the now-empty `anvil/<slug>/` directory.

After this, `anvil/` only contains in-progress work, and `artifacts/` holds the
permanent record of every finished feature, grouped by completion date.

## When to apply

Apply this skill when the user signals a feature is **done** or wants to wrap up:
- "We're done with this feature."
- "Let's wrap this up / close this out."
- "Write a retro / recap."
- "Archive this work."

Only run this inside a feature worktree (the user's cwd should be under
`anvil/<slug>/`). If the user is at the workspace root, ask which feature to retro on
(show `ls anvil/`).

## Concurrency lock

Before any destructive action, take the workspace lock:

```bash
LOCK="anvil/<slug>/.agentforge.lock"
if [ -f "$LOCK" ]; then
  cat "$LOCK"
  # → another session is working on this feature. Stop and tell the user.
fi
printf 'pid=%s\nstarted=%s\nskill=agentforge-feature-retro\n' \
  "$$" "$(date -u +%FT%TZ)" > "$LOCK"
```

Release on success and every failure path.

## How to do it

### 1. Establish the feature context

- Confirm cwd is under `anvil/<slug>/` — capture the `<slug>`.
- Read `anvil/<slug>/CLAUDE.md` (created by `feature-start`) to get the original
  feature description and list of repos in scope.
- **Validate the listed repos against reality.** For each repo claimed in
  `Repos in scope:`, verify the worktree exists at `anvil/<slug>/<repo>/`. If any
  are missing (user moved or deleted them manually), report the mismatch and let
  the user decide whether to archive only what's present, or fix the discrepancy
  first.
- Compute today's date in UTC as `YYYYMMDD`:
  ```bash
  TODAY=$(date -u +%Y%m%d)
  ARCHIVE_DIR="artifacts/${TODAY}/<slug>"
  ```
  If `artifacts/<TODAY>/<slug>/` already exists, ask the user whether to overwrite
  (a previous retro attempt for the same feature on the same day).

### 2. Create the archive directory

```bash
mkdir -p artifacts/<YYYYMMDD>/<slug>/sessions
mkdir -p artifacts/<YYYYMMDD>/<slug>/plans
```

### 3. Capture Claude Code session logs

Claude Code stores transcripts at:

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

`<encoded-cwd>` is the absolute path of the directory where `claude` was launched,
with `/` replaced by `-` and prefixed with `-`. Example:

```
launched in: /Users/alice/work/anvil/260418-feat-retry-logic
encoded:     -Users-alice-work-anvil-260418-feat-retry-logic
```

Steps:
1. Compute the encoded path for `anvil/<slug>/` (absolute path, slashes → hyphens).
2. List `~/.claude/projects/<encoded>/*.jsonl`.
3. Copy each matching `.jsonl` into `artifacts/<YYYYMMDD>/<slug>/sessions/`.
4. If the directory does not exist, tell the user — they may have started Claude
   from a different cwd. Offer to take a path argument from them.

### 4. Capture plan files

Plan files live at `~/.claude/plans/*.md`. Plans aren't scoped to a feature, so:
1. List all plan files (most recently modified first).
2. Show candidates (with mtime + first heading) and ask which belong to this feature.
   Default selection: most recently modified.
3. Copy chosen plans into `artifacts/<YYYYMMDD>/<slug>/plans/`.

### 5. Capture git refs (branch / HEAD / PR per repo)

Source code is **not** copied into the archive — each repo's git history already
contains the feature branch + any merged PR. We only preserve the pointers needed
to navigate back to the exact commits.

For each worktree under `anvil/<slug>/<repo>/`, capture (BEFORE the worktree is
removed in step 7):

```bash
HEAD=$(git -C anvil/<slug>/<repo> rev-parse HEAD)
MAIN=$(  # base branch detection — see feature-start
  git -C repos/<repo> symbolic-ref --quiet refs/remotes/origin/HEAD \
    | sed 's@^refs/remotes/origin/@@'
)
if git -C repos/<repo> merge-base --is-ancestor <slug> "$MAIN" 2>/dev/null; then
  MERGED_INTO="$MAIN"
else
  MERGED_INTO=null
fi
PR_URL=$(gh -R <owner>/<repo> pr view <slug> --json url --jq .url 2>/dev/null || echo "")
```

After processing every repo, write `artifacts/<YYYYMMDD>/<slug>/refs.json`:

```jsonc
[
  {
    "repo": "backend-api",
    "branch": "260418-feat-retry-logic",
    "head": "abc1234...",
    "merged_into": "main",
    "pr": "https://github.com/acme/backend-api/pull/412"
  },
  {
    "repo": "admin-web",
    "branch": "260418-feat-retry-logic",
    "head": "def4567...",
    "merged_into": null,
    "pr": "https://github.com/acme/admin-web/pull/88"
  }
]
```

### 6. Write the retrospective

**Language**: the section headings below (`What we set out to do`, `Requirements`,
etc.) stay in English so the structure is consistent across features. The prose
inside each section is written in the workspace's output language — see the
"Output language" instruction at the bottom of this file. Code, commands, file
paths, and English proper nouns stay as-is.

Write `artifacts/<YYYYMMDD>/<slug>/RETRO.md`:

```markdown
# Retrospective: <feature description>

- Slug: `<slug>`
- Started: <YYYY-MM-DD>          # from CLAUDE.md or YYMMDD slug prefix
- Closed:  <YYYY-MM-DD>          # today
- Repos in scope: <repo list>

## What we set out to do
<1–3 sentences. The original ask, in the user's words if possible.>

## Requirements
<Bullets — explicit asks + things that emerged mid-stream.>

## Key decisions and trade-offs
<For each significant decision: what was chosen, alternatives considered, why this
one won. Pull from plan files and from places in the transcript where the user
pushed back or redirected.>

## What was built
<Concrete outcomes per repo. Include `git log --oneline <slug>` and
`git diff --stat <base>..<slug>` outputs.>

## Open items / follow-ups
<Deferred items, TODOs left in code, scope cuts. Be honest about partial work.>

## Lessons / things to remember
<Non-obvious insights that future-you would want to know.>

## Archived artifacts
- sessions/  (<N> Claude session transcripts)
- plans/     (<N> plan files)
- refs.json  (per-repo branch / HEAD / PR pointers)
```

Also **move `anvil/<slug>/CLAUDE.md` into `artifacts/<YYYYMMDD>/<slug>/CLAUDE.md`**
so the feature metadata travels with the archive.

### 7. Tear down worktrees

For each `anvil/<slug>/<repo>/` worktree, **first capture the actual branch**
from the worktree's HEAD — `feature-start` lets each repo follow its own
branch-naming convention, so the branch name may differ from the slug:

```bash
branch=$(git -C anvil/<slug>/<repo> rev-parse --abbrev-ref HEAD)
```

Capture this before `worktree remove`; once the worktree is gone, looking it up
from `repos/<repo>` alone is awkward.

Then run safety checks **before** removal:

1. **Uncommitted changes** — `git -C anvil/<slug>/<repo> status --porcelain`. If
   non-empty, stop and tell the user what's dirty. Default: skip removal, offer
   to commit / stash / discard first.
2. **Unpushed commits** — `git -C anvil/<slug>/<repo> log @{u}.. --oneline 2>/dev/null`.
   If non-empty and the branch has an upstream, warn — removing the worktree
   keeps the local branch but its commits aren't on the remote. Ask before
   continuing.
3. **Unmerged branch** — `git -C repos/<repo> merge-base --is-ancestor "$branch" <main>`.
   If not merged, this is fine for archiving (the branch survives `worktree
   remove`) but tell the user, and confirm before deleting the branch in the
   optional cleanup step.

For each worktree that passes (or that the user confirms despite warnings):

```bash
git -C repos/<repo> worktree remove ../../anvil/<slug>/<repo>
```

Optionally also delete the local branch (only with explicit user confirmation;
never force-delete unmerged branches without asking):

```bash
git -C repos/<repo> branch -d "$branch"     # safe — refuses if unmerged
```

### 8. Delete the empty anvil/<slug>/ directory

After every worktree is removed and `CLAUDE.md` has been moved to the archive,
`anvil/<slug>/` should be empty (or contain only the lock file). Remove it:

```bash
rm -f anvil/<slug>/.agentforge.lock      # release the lock
rmdir anvil/<slug>                       # fails if anything else is in there
```

**If `rmdir` fails because something else is still inside** — stop and report it.
Do not `rm -rf` the directory; that would risk losing user files we didn't
account for. Tell the user what's in there and let them decide.

### 9. Hand off

Tell the user what was archived and what (if anything) was kept:

```
✓ Feature `<slug>` closed.
  artifacts/<YYYYMMDD>/<slug>/RETRO.md
  artifacts/<YYYYMMDD>/<slug>/sessions/  (<N> sessions)
  artifacts/<YYYYMMDD>/<slug>/plans/     (<N> plans)
  artifacts/<YYYYMMDD>/<slug>/refs.json  (<N> repo refs)
  artifacts/<YYYYMMDD>/<slug>/CLAUDE.md  (feature metadata)

Worktrees removed:
  ✓ backend-api  (branch deleted)
  ✓ admin-web    (branch kept on user request)

anvil/<slug>/ removed.
```

If any worktree was skipped (uncommitted / unpushed), say so and explain how to
resume after the user resolves it.

## Activity log

After each successful step (archive directory created, worktree removed, branch
deleted), append a JSONL line to `<workspace>/agentforge/log.jsonl`:

```bash
mkdir -p <workspace>/agentforge
printf '%s\n' "$(jq -nc \
  --arg ts "$(date -u +%FT%TZ)" \
  --arg skill agentforge-feature-retro \
  --arg slug '<slug>' \
  --arg action '<archived|worktree-removed|branch-deleted|anvil-pruned>' \
  --arg repo '<repo>' \
  --arg archive 'artifacts/<YYYYMMDD>/<slug>' \
  '{ts:$ts, skill:$skill, slug:$slug, action:$action, repo:$repo, archive:$archive}')" \
  >> <workspace>/agentforge/log.jsonl
```

When writing RETRO.md, include a **Timeline** section built from this log file
filtered by the current slug — it gives a chronological audit trail of the feature.

## Rules

- **Never `rm -rf anvil/<slug>/`** — use `rmdir` only, so unexpected user files are
  never silently destroyed.
- **Capture refs BEFORE removing worktrees** — once the worktree is gone, you
  can't query its HEAD anymore.
- **Move `CLAUDE.md` to the archive, don't copy** — there should be exactly one
  copy of the feature metadata; it now lives in `artifacts/<YYYYMMDD>/<slug>/`.
- **artifacts/<YYYYMMDD>/<slug>/ is the permanent record.** Once created, it should
  never be modified by other skills (only by manual user edits or a deliberate
  re-run of feature-retro).
- **Ask before overwriting an existing archive entry** — a same-day re-run is
  sometimes intentional but often a mistake.
- **If anything fails partway through**, leave the archive partially written and
  the worktrees intact. Do not roll back the archive (it's recoverable info).
  Tell the user what succeeded and what didn't.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
