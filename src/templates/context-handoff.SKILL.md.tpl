---
name: agentforge-context-handoff
description: Packages a feature's current state into a single handoff document so another developer (or future-self) can pick up without context loss. Gathers per-worktree git state, open PRs and their review state, unaddressed comments, pending plan items, recent decisions, recently touched files, open TODOs and questions. Writes anvil/<slug>/HANDOFF.md. Optionally posts the same summary as a comment on each related PR — only with explicit user confirmation. Never modifies CLAUDE.md, never pushes commits. Triggers on "hand this off", "휴가 가니 정리해줘", "leave notes for next session", "다음 사람한테 넘길 패키지", "package this up".
---

# context-handoff

Packages the current state of a feature into a single document — `HANDOFF.md` —
so another developer (or future-you, three weeks from now) can resume without
having to reconstruct context from git, PR threads, and memory.

Read-mostly: writes one new file in the feature directory and, only with
explicit confirmation, posts the same summary as a comment on each related PR.
Never touches existing CLAUDE.md, never pushes commits, never modifies code.

## When to apply

Trigger phrases:
- "Hand this off." / "Package this up."
- "Leave notes for next session."
- "휴가 가니 정리해줘." / "다음 사람한테 넘길 패키지."
- "I'm switching pairs — write a handoff."

Also a good fit before a long pause (vacation, parental leave, sprint
boundary), or before genuinely handing the feature to a different developer.

## Resolve scope

The handoff is **always per-feature**. Resolve the slug from cwd:

- `…/anvil/<slug>/` (or anywhere inside it) → that feature.
- Workspace root, no obvious context → ask the user for the slug, or list
  active features (`ls anvil/`).

If the named slug has no `anvil/<slug>/` directory, stop and tell the user —
either the feature was already wrapped up (check `artifacts/`) or the slug is
wrong.

## Step 1 — Gather feature metadata

Read `anvil/<slug>/CLAUDE.md`:
- Feature description (the heading + first paragraph)
- `Started:` / `Expanded:` dates
- `Repos in scope:` list with per-repo branch names

If `anvil/<slug>/PLAN.md` exists (from `feature-plan` or hand-written), read
its pending items.

## Step 2 — Per-worktree state

For each repo in scope (`ls -d anvil/<slug>/*/`):

```bash
branch=$(git -C anvil/<slug>/<repo> rev-parse --abbrev-ref HEAD)
base=$(git -C anvil/<slug>/<repo> symbolic-ref --quiet refs/remotes/origin/HEAD \
        | sed 's@^refs/remotes/origin/@@')

# Recent commits on this branch (since base)
git -C anvil/<slug>/<repo> log --oneline "origin/$base..HEAD" | head -20

# Working-tree state — uncommitted work is the most important thing to flag
git -C anvil/<slug>/<repo> status --porcelain

# Unpushed commits
git -C anvil/<slug>/<repo> log @{u}..HEAD --oneline 2>/dev/null

# Files recently touched (signal for "where I left off")
git -C anvil/<slug>/<repo> diff --name-only "origin/$base"...HEAD
git -C anvil/<slug>/<repo> diff --name-only        # unstaged
git -C anvil/<slug>/<repo> diff --cached --name-only  # staged
```

Capture per repo:
- branch + base
- # of commits ahead of base
- dirty? (uncommitted changes — itemize files)
- unpushed? (local commits not on remote)
- last commit message + date (a one-line "where I was")

## Step 3 — Open PRs and their state

For each repo's branch, look up the PR:

```bash
gh -R <owner>/<repo> pr list --head "$branch" --state open \
  --json number,url,isDraft,mergeStateStatus,statusCheckRollup,reviews,reviewRequests
```

If a PR exists, also pull:

```bash
gh -R <owner>/<repo> pr view <num> --json title,body,comments,reviewDecision
gh api repos/<owner>/<repo>/pulls/<num>/comments    # inline review threads
```

For each PR, capture:
- number + URL + draft/ready
- CI status (failing / pending / green)
- review state (approved / changes-requested / pending)
- **unaddressed comments**: review threads where the last reply is from a
  reviewer and not the author, and the thread is not marked resolved. These are
  the most important things for the next person to handle.

Note repos with no PR yet — that's a follow-up item.

## Step 4 — Decisions, TODOs, open questions

Extract from sources in this order:

1. `anvil/<slug>/CLAUDE.md` — any free-text decisions the user wrote.
2. `anvil/<slug>/PLAN.md` — pending plan items (unchecked boxes).
3. Recent commits with subjects like `chore:`, `fixup!`, `WIP:` — flag these
   as "needs cleanup before merge."
4. `git -C anvil/<slug>/<repo> diff "origin/$base"...HEAD | grep -E '^\+.*(TODO|FIXME|XXX)'`
   — TODOs the user introduced in this feature.
5. The most recent Claude Code session transcript for this feature (under
   `~/.claude/projects/.../*.jsonl` matching this workspace), if accessible —
   skim the last summary block for "next steps" / "blocked on" phrases. Don't
   re-read the entire session.

If extraction yields nothing concrete, leave the section as
"(no explicit open questions captured — ask the original author)."

## Step 5 — Write HANDOFF.md

Write to `anvil/<slug>/HANDOFF.md` (overwrite if it exists; back up the old one
to `HANDOFF.md.bak` first). Structure:

```markdown
# Handoff: <slug>

> Generated <YYYY-MM-DD HH:MM> by agentforge-context-handoff.
> This file is informational. Source of truth is git + the open PRs.

## Feature

<one-paragraph description from CLAUDE.md>

Started <date>. <N> repo(s) in scope.

## State at handoff time

| Repo | Branch | PR | CI | Reviews | Dirty? | Unpushed? |
|---|---|---|---|---|---|---|
| <repo-1> | <branch-1> | #<N> | <icon> | <state> | <yes/no> | <yes/no> |
| ... |

## What's done

- <repo-1>: <N> commits ahead — <high-level summary of what the diff does>
- <repo-2>: ...

## What's pending

### Unaddressed review comments
- <repo-1> #<N>: <comment thread summary + file:line + reviewer> → <link>
- ...

### Open questions
- <extracted question 1>
- ...

### TODO markers introduced in this feature
- <file:line>: <TODO text> (<repo>)
- ...

### Plan items not yet done
- [ ] <item from PLAN.md>
- ...

## Where to look next

- <repo-1>/<file>:<line> — most recently edited; <last commit message>
- ...

## How to resume

1. `cd anvil/<slug>/` and start a session (`claude` or your CLI).
2. Read this file first.
3. Read each open PR's unaddressed comments.
4. Run `agentforge-feature-resume` (if available) for an AI briefing.
```

After writing, print the path and a one-line summary to the user.

## Step 6 — (Optional) PR comments

Ask the user explicitly: "Post a handoff summary as a comment on each open PR?
(default: no)"

Only on "yes":

```bash
# Summarize for PR audience (different from the full HANDOFF.md — shorter,
# focused on what reviewers need to know to keep the PR moving)
gh -R <owner>/<repo> pr comment <num> --body "<summary>"
```

The PR comment should include:
- "Handoff posted on <date>" + link to `anvil/<slug>/HANDOFF.md` path (relative)
- A short list of "what's pending on this PR specifically"
- Who the next person to contact is, if known

**Never post comments without explicit user confirmation** — comments are
visible to teammates and can confuse them if posted prematurely.

## Rules

- **Read-only on existing files** — never edit `CLAUDE.md`, `PLAN.md`, code, or
  PR descriptions. Only write the new `HANDOFF.md`.
- **No git push, no PR merge, no PR review.**
- **PR comments only with explicit confirmation.**
- **Back up before overwrite** — if `HANDOFF.md` exists, move it to
  `HANDOFF.md.bak` first (don't silently overwrite).
- **Branch names from worktrees, not slug** — per-repo branches may differ.
- **Dirty worktrees are the #1 thing to flag** — uncommitted work is invisible
  to anyone but the original author; the handoff exists primarily to surface
  this.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
