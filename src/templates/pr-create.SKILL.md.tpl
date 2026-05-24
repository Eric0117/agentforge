---
name: agentforge-pr-create
description: Opens pull requests for a feature whose work lives across multiple repo worktrees. Walks the anvil/<slug>/ directory, detects which repos have commits ahead of their base branch, lets the user multi-select which ones to PR, then opens one PR per repo via gh CLI. Titles and bodies are drafted from anvil/<slug>/CLAUDE.md (feature description) plus each repo's diff stat and commit log. Adds cross-references between the PRs so reviewers see the bundle. Triggers on "open PRs for this feature", "make PRs", "ship it", "create the PRs". Never force-pushes; never merges.
---

# agentforge-pr-create

A feature in this workspace can live across several worktrees (`anvil/<slug>/<repo>/`).
GitHub PRs are repo-scoped, so this skill opens **one PR per repo that actually has
changes**, drafts each PR from the feature's shared description, and stitches them
together with cross-references.

**This skill creates PRs (an externally visible action).** Always confirm with the user
before pushing or opening anything.

## When to apply

Trigger phrases:
- "Open PRs for this feature."
- "Make the PRs."
- "Create PRs for the worktrees."
- "Ship it."
- "Time to open PRs."

If the user is mid-implementation, this is the wrong skill — point them to keep
working and come back when the feature is ready for review.

## Concurrency lock

Before opening or editing PRs, take the workspace lock so another session doesn't
race with this one:

```bash
LOCK="anvil/<slug>/.agentforge.lock"
if [ -f "$LOCK" ]; then
  cat "$LOCK"
  # → another session is opening PRs for this feature. Stop and tell the user.
fi
printf 'pid=%s\nstarted=%s\nskill=agentforge-pr-create\n' \
  "$$" "$(date -u +%FT%TZ)" > "$LOCK"
```

Release on success and on every failure path.

## Preconditions

- `gh` CLI authenticated (`gh auth status`). If not, surface a clear error and stop.
- Each target worktree has a remote configured (`git -C <worktree> remote get-url
  origin`). If not, tell the user and skip that repo.
- The user is somewhere under an agentforge workspace — `repos/` and `anvil/` are
  visible from cwd by walking up.

## Step 1 — Identify the feature

Resolve which `anvil/<slug>/` we're working with:

- If cwd is `…/anvil/<slug>/…`, use that `<slug>`.
- If cwd is the workspace root, list `anvil/*/` and ask the user to pick.
- Read `anvil/<slug>/CLAUDE.md` to get the feature description + originally-intended
  repo list. (Created by `agentforge-feature-start`.) If it's missing, ask the user
  for a one-line description.

## Step 2 — Detect repos with actual changes

For each subdirectory of `anvil/<slug>/` that contains a `.git` (or is a worktree):

```bash
# what's the base branch?
git -C anvil/<slug>/<repo> rev-parse --abbrev-ref @{upstream} 2>/dev/null
# fallback: origin/main or origin/master
```

For each candidate worktree, compute:

```bash
git -C anvil/<slug>/<repo> rev-list --count <base>..HEAD     # commits ahead
git -C anvil/<slug>/<repo> status --porcelain                # uncommitted changes
```

Build a candidate set:
- **Includes**: repos with `commits-ahead > 0`.
- **Excludes** with a note: repos with no commits ahead (nothing to PR), repos with
  uncommitted changes (warn the user but offer to include after they commit), repos
  without a remote.
- **Includes with warning**: if HEAD is behind the base branch, suggest rebasing first.

Show the candidate set as a table:

```
anvil/feat-search-ranking/
  ✓ backend-api   3 commits ahead   (will PR)
  ✓ admin-web     1 commit ahead    (will PR)
  ⚠ worker-service     2 uncommitted     (skipped — commit first?)
  ✗ mobile-app   0 commits ahead   (nothing to PR)
```

## Step 3 — Let the user pick

Present the includable repos as a **multi-select**, with all of them pre-checked.
Never assume — the user may want to PR only a subset (e.g. open backend first, follow
with frontend later).

If a structured multi-select is available, use it. Otherwise accept a list of names
or numbers.

## Step 4 — Push branches (if needed)

For each chosen worktree, ensure the branch is on the remote:

```bash
git -C anvil/<slug>/<repo> rev-parse --abbrev-ref HEAD       # branch name
git -C anvil/<slug>/<repo> push -u origin <branch>           # publish if needed
```

**Never use `--force` or `--force-with-lease`.** If the remote has diverging commits,
stop and ask the user. They may have an open PR on the same branch already.

## Step 4.5 — Check for an existing PR template

Before drafting the body, check whether each repo ships a PR template:

```bash
for path in \
  repos/<repo>/.github/PULL_REQUEST_TEMPLATE.md \
  repos/<repo>/.github/pull_request_template.md \
  repos/<repo>/PULL_REQUEST_TEMPLATE.md \
  repos/<repo>/docs/PULL_REQUEST_TEMPLATE.md; do
  [ -f "$path" ] && echo "$path"
done
```

If a template exists, **use it as the skeleton** and fill the agentforge-generated
content into matching sections (look for headings like `## What`, `## Why`, `## How`,
`## Test plan`, `### Description`). If a section exists in the template but the
generator has no content for it, leave that section's placeholder untouched. **Do
not strip checklists** the template ships — they may be required by branch
protection or review automation.

If no template exists, use the body template in the next step.

### Language of the PR title and body

**Write prose (the `What`, `Why`, `How`, `Test plan` sections, `Changes` bullets,
PR-template prose fields) in the workspace's output language** — see the
"Output language" instruction at the bottom of this file. The PR will be read by
teammates who share that workspace, so the natural-language sections follow
that language.

Keep the following in their original form regardless of language:
- Conventional Commits type/scope prefix (`feat:`, `fix(api):`, ...)
- code identifiers, commands, file paths, branch names, commit SHAs
- proper nouns (gh, GitHub, Kafka, Redis, etc.)
- the "Cross-repo" links

For example, a Korean workspace produces titles like
`feat: 새로운 기능 추가` and bodies in Korean prose, while a Japanese workspace
produces `feat: 新機能を追加` and Japanese prose. An English workspace produces
English throughout.

## Step 5 — Draft titles and bodies

For each chosen repo, prepare a PR draft. Re-use these inputs:

- **Feature description** — first heading / first paragraph of `anvil/<slug>/CLAUDE.md`.
- **This repo's diff stat** — `git -C <worktree> diff --stat <base>...HEAD`.
- **This repo's commit log** — `git -C <worktree> log --oneline <base>..HEAD`.
- **Conventional Commits hints** — derive a `type(scope):` prefix from the diff
  (`feat`, `fix`, `refactor`, `chore`, `docs`) and from any module-like directory name
  that dominates the changes.

### Title

```
<type>(<scope>): <one-line summary derived from feature description>
```

Examples:
- `feat(api): add new endpoint`
- `fix(worker): handle empty payloads`
- `refactor(ui): extract shared form components`

Keep titles under 72 chars. If the feature description is too long, summarize.

### Body template

```markdown
## What

<2–4 sentence summary distilled from anvil/<slug>/CLAUDE.md.>

## Why

<1–2 sentences on the motivation — pull from the "Why" line in the feature CLAUDE.md
if present, otherwise leave a placeholder for the user to fill in.>

## How

<bullet list summarizing the commits and the diff stat for THIS repo only.>

## Test plan

- [ ] <derived from the changes; if there are new tests in the diff, list them>
- [ ] <if there are no tests, leave an unchecked todo for the user>

## Cross-repo

This PR is part of feature **`<slug>`**. Sibling PRs:
- {placeholder for org/repo#NUM — filled in once all PRs are created}

---

🤖 Drafted by `agentforge-pr-create`. Edit freely before requesting reviews.
```

Show each draft to the user **before opening**. Let them edit titles or bodies in
place (offer a "looks good / let me edit X" prompt per PR or "edit all in chat
first").

## Step 6 — Open the PRs

For each approved draft, run:

```bash
gh pr create \
  --repo <owner>/<repo> \
  --base <base-branch> \
  --head <branch> \
  --title "<title>" \
  --body  "<body>" \
  --draft   # only if the user explicitly asked for drafts
```

Capture the returned URL and the PR number for each repo.

If a PR for the same branch already exists, do **not** create a new one. Instead:
- Tell the user "PR #N already exists for this branch on `<repo>`."
- Offer to update its title / body (`gh pr edit`) — only with explicit confirmation.

## Step 7 — Cross-link the PRs (including pre-existing ones)

After every PR is created or located, gather **the full set of sibling PRs for this
slug** — that includes:

- PRs you just created in this run.
- PRs that already existed for the same head branch (a previous run, or a
  teammate's PR). Discover them per repo. The head branch is **whatever the
  worktree's HEAD points to**, not necessarily the slug — `feature-start` lets
  each repo follow its own branch-naming convention, so resolve it from git:
  ```bash
  branch=$(git -C anvil/<slug>/<repo> rev-parse --abbrev-ref HEAD)
  gh -R <owner>/<repo> pr list --head "$branch" --state open \
    --json number,url,headRefName,baseRefName
  ```
  If multiple PRs share the head branch, the most recent open one is the canonical
  sibling for that repo.

Build a single sibling list `[<owner1>/<repo1>#<num1>, <owner2>/<repo2>#<num2>, ...]`,
then patch the `## Cross-repo` section of **every PR in the list**, not just the new
ones. This ensures that PRs opened earlier (when the feature only spanned a subset of
repos) get their cross-repo section updated to reflect the full current set.

For each sibling:

```bash
# fetch current body
gh pr view <num> --repo <owner>/<repo> --json body --jq .body > /tmp/body.md

# replace (or insert) the "## Cross-repo" section, then:
gh pr edit <num> --repo <owner>/<repo> --body-file /tmp/updated.md
```

Replacement rules for the Cross-repo block:
- Identify the existing `## Cross-repo` heading and replace everything from that
  heading to the next `## ` (or end of file) with the new block.
- If no `## Cross-repo` heading exists, append the new block to the end.
- The block lists *other* siblings (not the PR itself). For PR `A`, the block lists
  `B, C, ...` etc.
- Do not touch the rest of the body. Preserve user edits exactly.

This is the same flow for both first-time PR creation and later re-runs when a new
repo is added to the feature (via `agentforge-feature-start` in additive mode and
`agentforge-pr-create` re-run): every PR's Cross-repo section ends up reflecting the
current full set.

## Step 8 — Report back (partial-failure aware)

PR creation can partially fail (auth, branch protection, network). Report
**explicitly per repo** with status: created / edited / skipped / failed.

```
Feature `feat-search-ranking`:

  ✓ backend-api  → https://github.com/acme/backend-api/pull/412    (created)
  ✓ admin-web    → https://github.com/acme/admin-web/pull/88       (created)
  ✗ worker-service    failed: branch protection requires checks to pass first
  ⏭ mobile-app  skipped: no commits ahead

Cross-repo section patched on: backend-api#412, admin-web#88
Cross-repo section NOT patched on: worker-service (PR not created)
```

For failures:
- State the underlying error verbatim (the gh stderr line).
- **Do not roll back successful PRs.** They're already public — that's the user's
  call. Tell the user the retry path: re-run `agentforge-pr-create` and only the
  failed/skipped repos will be candidates.
- The Cross-repo patch in Step 7 should still run for the PRs that did get created,
  but exclude the failed ones from the sibling list (they don't exist).

## Step 9 — PR summary

After all PRs are open (or even just one), print a single copy-paste-ready summary
block. **Strictly about the PRs themselves** — no greetings, no "please review", no
reviewer mentions, no deadlines, no addressing of any audience. Just the PRs.

Output format — plain text, portable to any chat or doc tool, wrapped in a fenced
code block so the user can copy verbatim:

````
```
[<slug>]

<repo-1> · #<num>
<pr-url>
What: <one-line summary of the change, from the PR title/body>
Why: <one-line motivation, from the PR body's "Why" section if present>
Changes:
  - <bullet 1 — a meaningful change, not noise>
  - <bullet 2>
  - <bullet 3>
Diff: <N> files · +<added> / -<removed>

<repo-2> · #<num>
<pr-url>
What: ...
Why: ...
Changes:
  - ...
Diff: ...
```
````

Notes for the body:
- **Labels (`What:`, `Why:`, `Changes:`, `Diff:`) stay in English** so the block
  format is recognizable across teams. The **values after the colons are written
  in the workspace's output language** — the same prose language used in the PR
  body itself (Korean for a Korean workspace, etc.).
- **Pull `What` / `Why` from the PR body you just generated**, not from raw commit
  messages. Strip markdown headings and trim to one sentence.
- **`Changes:` is 2–5 bullets max.** Group related commits; skip cosmetic or merge
  commits. Each bullet should make sense to someone who has not seen the diff.
- **`Diff:` numbers** come from `git -C <worktree> diff --shortstat <base>...HEAD`.
- Repos appear in the order the user selected them.
- Keep it plain text — no emoji decorations, no Slack/markdown-specific syntax. The
  user may be pasting into chat, a doc, a ticket, anywhere.

Print this block in the chat after the "Report back" output. Do not save it to a
file unless the user asks.

Tone check before printing: read your draft once and remove any phrasing that **asks**
for something or **addresses** the reader (e.g. "please review", "FYI", "let me
know"). The block must read as a pure status object describing the PRs.

## Rules

- **Always confirm before pushing or creating.** PRs are externally visible. Show
  drafts; require explicit "yes" before `gh pr create`.
- **Never force-push.** If push fails because the remote has diverging commits, stop
  and report. Let the user decide how to reconcile.
- **Never auto-merge.** This skill only opens PRs. Reviewing and merging stays with
  the user.
- **Never bypass branch protection.** If a base branch requires checks or specific
  labels, just open the PR — don't try to game the rules.
- **Respect existing PRs.** If a PR already exists on the same head branch, edit
  (with permission) instead of recreating.
- **One repo with no changes is not an error.** Just skip it silently with a note.
- **Match each PR body to that repo's diff** — do not paste the cross-repo summary as
  if everything happened in one repo. Each PR reads as standalone first, then with
  cross-references.
- **Conventional Commits is a hint, not a rule.** If the repo doesn't use them, drop
  the prefix and use a plain title.

## Activity log

After each successful PR action (created, edited, cross-link patched), append a
JSONL line to `<workspace>/agentforge/log.jsonl`:

```bash
mkdir -p <workspace>/agentforge
printf '%s\n' "$(jq -nc \
  --arg ts "$(date -u +%FT%TZ)" \
  --arg skill agentforge-pr-create \
  --arg slug '<slug>' \
  --arg action '<created|edited|cross-linked>' \
  --arg repo '<repo>' \
  --arg pr '<pr-url-or-number>' \
  '{ts:$ts, skill:$skill, slug:$slug, action:$action, repo:$repo, pr:$pr}')" \
  >> <workspace>/agentforge/log.jsonl
```

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
