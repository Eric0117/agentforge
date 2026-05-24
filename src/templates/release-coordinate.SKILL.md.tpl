---
name: agentforge-release-coordinate
description: Plans the merge / deploy order for a feature that spans multiple repos. Reads each worktree's diff, identifies cross-repo dependencies (new APIs, exported types, contract files, message-queue schemas), builds a dependency graph, and outputs a step-by-step merge order with per-step preconditions (CI green, prior merge confirmed) and post-merge wait conditions (CI, deploy, downstream healthcheck) — plus a reverse-order rollback playbook. Read-only. Never auto-merges, never pushes. Triggers on "release this feature", "ship this", "which PR to merge first", "merge order", "deploy order", "어느 PR 먼저 머지".
---

# release-coordinate

`pre-deploy-check` answers *"is this ready to ship?"*. This skill answers
*"once it's ready, in what order do I merge and deploy?"* for a feature that
spans several repos.

The output is an ordered checklist the user executes manually — never
auto-merges, never pushes, never bypasses CI.

## When to apply

Trigger phrases:
- "Release this feature." / "Ship this."
- "Which PR to merge first?"
- "Merge order?" / "Deploy order?"
- "Coordinate the rollout."
- "어느 PR 먼저 머지해야 해?"

Apply once every PR for the feature is open and ready (or close to ready). Don't
apply mid-development — the dependency graph is meaningless until the diffs are
stable.

## Resolve scope

Resolve which feature you're coordinating from cwd:

- `…/anvil/<slug>/` (or anywhere inside it) → that feature.
- Workspace root, no obvious context → ask the user for the slug or list active
  features (`ls anvil/`).

The slug determines which worktrees and which PRs are in scope:

```bash
# in-scope repos for this feature
ls -d anvil/<slug>/*/ | xargs -n1 basename
```

If the feature's `CLAUDE.md` lists a repo whose worktree directory is missing,
flag it and ask the user whether to include it (the PR may exist even though the
worktree is gone — e.g. someone already started teardown).

## Step 1 — Capture each repo's state

For each in-scope `anvil/<slug>/<repo>/`:

```bash
branch=$(git -C anvil/<slug>/<repo> rev-parse --abbrev-ref HEAD)
base=$(git -C anvil/<slug>/<repo> symbolic-ref --quiet refs/remotes/origin/HEAD \
        | sed 's@^refs/remotes/origin/@@')
# diff stat — high-signal summary
git -C anvil/<slug>/<repo> diff --stat "origin/$base"...HEAD
# changed file list — used for dependency analysis below
git -C anvil/<slug>/<repo> diff --name-status "origin/$base"...HEAD
```

Then find the PR (head branch comes from the worktree's HEAD, **not** from the
slug — branches may differ per repo):

```bash
gh -R <owner>/<repo> pr list --head "$branch" --state open \
  --json number,url,isDraft,mergeStateStatus,statusCheckRollup,reviews,baseRefName
```

If no PR exists for a worktree → list it as "PR not opened yet" and continue.

Collect into a table:

```
repo            branch                        PR     CI         reviews       state
backend-api     feature/<TICKET>-<topic>      #1234  ✓ green    ✓ approved    ready
admin-web       feat/<TICKET>                 #567   ✗ failing  · pending     blocked
worker-service  <slug>                        —      —          —             no PR yet
```

## Step 2 — Cross-repo dependency analysis

For each pair of in-scope repos, determine whether one depends on the other for
this feature. Look at the diff, not the codebase as a whole — only changes in
this feature matter for ordering.

**Signals that imply "merge A before B":**

1. **Library/package consumer**: repo B's `package.json` / `go.mod` /
   `pyproject.toml` / `Gemfile` adds or bumps a package published by repo A,
   referencing a version that includes A's new code. → merge A, publish, then B.
2. **HTTP / RPC contract**: repo B adds a call to an endpoint that repo A's diff
   introduces. Detect by greping B's new code for URL fragments / SDK methods
   that appear new in A's diff. → A must be deployed before B's code runs.
3. **Shared type / schema**: repo A modifies an exported type / OpenAPI schema /
   protobuf / GraphQL SDL, and repo B imports that type or generates client code
   from it. → A must be merged + published / regenerated before B's CI passes.
4. **Message queue producer/consumer**: repo A adds a topic / event schema that
   repo B subscribes to (or vice versa). → producer first if consumer must
   handle the event; consumer first if backward-compatible.
5. **Database schema**: repo A adds a column / table that repo B reads or
   writes. → migration must run before the consumer is deployed.
6. **Feature flag**: repos coordinate via a flag that defaults off. → ship in
   any order, flip the flag last.

**Signals that imply "safe to parallel":**

- Diffs touch disjoint files with no shared imports / endpoints / types /
  schemas.
- Pure internal refactors with no public surface change.

**Ambiguous cases — ASK the user, don't guess.** Output the candidate pairs and
the evidence you found, and let the user confirm direction.

Build a directed graph: edge A → B means "merge A before B." Detect cycles —
they indicate a genuine coordination problem (e.g. two repos depend on each
other's new API). Surface cycles to the user; don't try to break them
automatically.

## Step 3 — Compute order

Topological sort of the graph yields groups of nodes that can merge in parallel
(no dependency between them) and groups that must be sequential.

Output as ordered steps:

```
Step 1 (sequential)
  • backend-api #1234 — adds the new endpoint that admin-web consumes
    preconditions:   CI green, ≥1 approval
    post-merge wait: deploy reaches prod; smoke test passes
Step 2 (parallel)
  • admin-web #567   — calls the new endpoint
  • worker-service #890 — consumes the new event topic
    preconditions:   CI green, ≥1 approval
    post-merge wait: deploy reaches prod
Step 3 (flag flip)
  • toggle feature flag <flag-name> in <config service / dashboard>
```

Annotate each step with:
- **why** it's at this position (which dependency edge created the ordering)
- **preconditions** specific to the user's environment (CI checks, required
  reviewers — read from PR rules if possible, otherwise list the standard set)
- **post-merge wait** condition before the next step (deploy completion,
  downstream healthcheck, integration test)
- **estimated wait** when known (e.g. typical deploy duration from past
  features in `artifacts/`)

## Step 4 — Rollback playbook

Output a **reverse-order rollback plan**. For each step, list:

- **How to revert**: revert PR + redeploy, or feature-flag flip, or DB rollback
  migration if applicable.
- **Order**: strictly reverse of the merge order — last in, first out.
- **Caveats**: irreversible operations (e.g. destructive migration, deleted
  column). Highlight these clearly — "this step cannot be cleanly rolled back
  without data loss; ensure you can roll forward instead."
- **Who to notify**: any downstream that consumed the new API/event/schema
  while the change was live.

## Step 5 — Present and stop

Output the plan as a single markdown report:

```markdown
# Release plan: <slug>

Generated <YYYY-MM-DD HH:MM> from <N> worktrees, <M> open PRs.

## Pre-flight
- <state table from Step 1>
- <any blockers: failing CI, missing reviews, draft PRs>

## Merge order
<step-by-step list from Step 3>

## Rollback (reverse order)
<plan from Step 4>

## Open questions
- <ambiguous dependencies the user must confirm>
- <missing PRs / missing CI signals>
```

**Stop here.** This skill never executes any of the steps. The user reviews and
runs the plan manually (gh CLI, web UI, internal deploy tools — agentforge does
not assume which).

If the user explicitly asks "go ahead and merge the first one" — refuse and
remind them: this skill is the plan, not the executor. Direct them to `gh pr
merge` or their normal merge path.

## Rules

- **Read-only**: no `git push`, no `gh pr merge`, no config changes, no flag
  flips. Plan only.
- **No silent guessing on dependencies**: surface ambiguous edges and ask.
- **Cycles are problems, not puzzles**: report cycles and stop — the user must
  reshape the work (split a PR, add a compatibility shim, etc.).
- **Branch names come from worktrees, not the slug** — each repo's branch may
  follow its own naming convention.
- If a repo has uncommitted changes in its worktree, flag it and ask whether to
  proceed — the plan is meaningless if the diff being analyzed isn't what will
  actually merge.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
