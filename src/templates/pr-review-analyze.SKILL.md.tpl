---
name: agentforge-pr-review-analyze
description: Audits the review comments on a pull request — pulls every inline thread, top-level review body, and PR comment, verifies each against the live code, classifies impact, traces the call path, notes test coverage, and returns a prioritized action list. Triggers when the user says things like "audit the PR comments", "go through the review feedback", "what do we need to fix from the review", "summarize the review comments". Runs analysis only; never edits code.
---

# pr-review-analyze

Pulls every review comment on a PR, verifies each one against the actual code, and gives
back a prioritized action list grouped by impact.

**This skill never edits code.** Analysis only. The user applies fixes separately.

## When to apply

The user is asking for a review of the review comments themselves — e.g.:
- "Audit the PR comments."
- "Go through the review feedback and tell me what to do."
- "Summarize the reviewer's comments."
- "What's left to address from the review?"

If the user instead asks to *apply* a specific fix, do not trigger this skill — just edit
the code as asked.

## Preconditions

- `gh` CLI installed and authenticated (`gh auth status`). If not, surface a clear
  message and stop.
- The cwd has access to the code the PR was opened against (so you can read the actual
  files at `path:line`).

## Rate limits

`gh` commands hit the GitHub API. For a large PR with hundreds of comments + threads,
calls can pile up and trigger:

```
gh: API rate limit exceeded for user
```

If you see that:
1. Report it to the user verbatim along with the reset time (`gh api rate_limit`
   shows it).
2. **Do not retry in a tight loop.** Suggest waiting or using a PAT with higher
   limits.
3. If you got partial data before the limit, analyze what you have and tell the user
   which comments are unanalyzed (so they know the report is incomplete).

## Resolving the PR

1. **Determine the working repo from cwd** (using the agentforge workspace layout when
   present):
   - `…/anvil/<slug>/<repo>/` → single repo; analyze the PR for this repo.
   - `…/anvil/<slug>/` → multiple worktrees may live here. `ls` the subdirs and ask the
     user which one to analyze.
   - `…/repos/<name>/` → this repo's currently-checked-out branch.
   - Anywhere else → use cwd as-is.
2. **PR number**:
   - If the user gave one, use it.
   - Otherwise `gh pr view --json number,title,url,headRefName,baseRefName` for the
     current branch. If none, tell the user and stop.
3. Capture `owner`, `repo`, and PR number via `gh repo view --json owner,name`.

## Pulling comments

Fetch all three classes of comments, then merge:

```bash
# (a) inline review comments (attached to specific lines — the main signal)
gh api repos/{owner}/{repo}/pulls/{num}/comments --paginate

# (b) review bodies + states (APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED)
gh api repos/{owner}/{repo}/pulls/{num}/reviews --paginate

# (c) general PR conversation comments
gh api repos/{owner}/{repo}/issues/{num}/comments --paginate
```

For `isResolved` / `isOutdated` flags (REST API does not expose these), use GraphQL:

```bash
gh api graphql -f query='
query($owner:String!, $repo:String!, $num:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$num) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first:20) {
            nodes { databaseId author{login} body path line }
          }
        }
      }
    }
  }
}' -f owner=<owner> -f repo=<repo> -F num=<num>
```

Always use `--paginate` — large PRs blow past 30 comments per page.

## Grouping

- Group by **review thread** (`in_reply_to_id`) so the conversation is preserved.
- Label threads:
  - `✅ Resolved` if `isResolved` — still analyze but deprioritize.
  - `⚠️ Outdated` if `isOutdated` — code at that line may have changed; **re-read the
    current file** before judging.
  - `self` if the comment author matches the PR author.
- Skip pure `APPROVED` review bodies that contain only LGTM/praise. If an `APPROVED`
  review body still contains a code remark, treat it as a comment.

## Detect the language(s)

Before tracing call paths, infer the languages in play from the PR's changed files:

```bash
gh pr view {num} --json files --jq '.files[].path' | sed -E 's/.*\.//' | sort -u
```

Pick search idioms per language for call-site tracing:

| Language | Definition pattern | Caller search |
|---|---|---|
| TypeScript/JavaScript | `function X` / `const X = ` / `class X` / `export …` | `\bX\(` and `import {.*X.*}` |
| Kotlin/Java | `fun X` / `X(…)` / `class X` | `\.X\(` and `import …\.X` |
| Python | `def X` / `class X` | `\bX\(` and `from .* import .*X` |
| Go | `func X` / `func (\w+) X` | `\.X\(` |
| Rust | `fn X` / `impl …` | `::X(` / `\.X\(` |

For other languages, fall back to: identify the symbol name, grep for it across the
repo, filter to plausible call sites.

## Per-comment analysis (the 4 axes)

For each thread (or standalone comment), fill all four — leave none empty.

### (1) Verify against the live code

- Open `path:line` with Read.
- Confirm the issue actually exists in the current code (not just in the review's
  snapshot).
- For Outdated comments, explicitly state "already addressed" or "still present".
- Classify the comment's intent:
  - 🐛 Bug — concrete defect
  - ⚠️ Latent issue — fails under specific conditions
  - 💡 Improvement — works, but a better option exists
  - ❓ Question — clarifying intent
  - 🎨 Style — naming, formatting, idioms

### (2) Impact (5 levels)

Pick one and justify it in one line.

| Level | Meaning | Examples |
|---|---|---|
| 🔴 Critical | Direct outage | Null-deref, data integrity, transaction leak, security, infinite loop |
| 🟠 High | Clear runtime bug | Wrong response under condition X, missing validation, race condition |
| 🟡 Medium | Latent risk / perf | N+1, inefficient query, missing error handling (log-only) |
| 🟢 Low | Readability / idiom | Naming, formatting, minor refactor |
| 💬 Discussion | Not a change request | Pure question, info sharing |

### (3) Call path

- Identify the enclosing function/method.
- Grep for call sites using the language-appropriate idiom from the table above.
- Describe its role in the call chain in generic terms:
  *entry point → orchestration → domain logic → persistence*.
- Show the chain when meaningful, e.g.
  `FooController.doSomething → FooService.doSomething → FooRepository.findById`.
- If the symbol has many callers (50+), show the principal entry points and "+N other
  call sites".
- **Async entry points** matter — flag them separately. Look for things like:
  - **Backend**: queue / stream listeners (`@KafkaListener`, `@RabbitListener`,
    SQS / Pub/Sub consumer), background tasks (`@Async`, `@Scheduled`, cron,
    BullMQ worker, Celery task, Sidekiq job), webhook handlers
  - **Frontend (web)**: `useEffect` cleanup paths, Service Workers,
    `requestIdleCallback`, RxJS subscriptions, IntersectionObserver callbacks
  - **Mobile**: background tasks (iOS `BGTask`, Android `WorkManager`),
    notification handlers, deeplink intent receivers
  These often run outside a request's transaction / MDC / React render context,
  which can change the impact assessment. Re-evaluate the impact level once an
  async entry is found.

### (4) Resolution

- Concrete fix: ideally a small before/after snippet.
- If the reviewer suggested a specific fix, decide whether to follow it or propose an
  alternative — and why.
- Trade off impact vs. effort. A small comment with Critical impact still ranks first.
- If the conclusion is "already fixed" or "no change needed", state the reason
  explicitly.

### Bonus axis: test coverage

For each finding, check whether the touched code is covered by tests:

- Look for sibling test files by convention:
  - `*.test.ts` / `*.spec.ts` / `__tests__/`
  - `*_test.go`
  - `test_*.py` / `*_test.py`
  - `*Test.kt` / `*Test.java` / `src/test/`
  - `tests/` directories
- If no test references the symbol, mark `🧪 No coverage` — this raises regression risk
  and may bump the impact level up by one.
- If a test exists but does not exercise the failing path, note `🧪 Partial`.

## Output format

Render to chat as Markdown. Group by impact (🔴 → 💬).

```markdown
# PR #{num} — Review Audit

> **{title}**
> {url}
> Inline: {N} · Review bodies: {M} · General: {K} · Resolved: {L} · Outdated: {O}
> Languages: TypeScript, Kotlin

---

## 🔴 Critical

### 1. `path/to/file.ext:42` — @reviewer
> Comment body, quoted verbatim.

- **📍 Location**: `ClassOrModule.symbol` (domain logic)
- **🔎 Verified**: Issue still present in the current code. {one-line analysis}
- **📞 Call path**: `Controller.foo → Service.bar → this`. 4 call sites total. ⚡ Also reached via Kafka listener `SomeConsumer.onMessage` — no surrounding transaction.
- **🧪 Coverage**: No test reference (🧪 No coverage) — regression risk.
- **💡 Resolution**:
  ```diff
  - before
  + after
  ```

---

## 🟠 High

### 2. …

## 🟡 Medium
## 🟢 Low
## 💬 Discussion

---

## Priority summary

| # | Impact | Location | One-liner | Coverage | Resolved |
|---|---|---|---|---|---|
| 1 | 🔴 Critical | file.ext:42 | NPE on empty list | ❌ | ❌ |
| 2 | 🟠 High | other.ext:88 | Missing transaction | ✅ | ❌ |

### Same-function clusters

- `Foo.bar` — items #2, #4, #7 (three reviewers flagged the same function)

## Next actions

- **Fix in this PR**: #1, #2
- **Split into a follow-up PR**: #5, #7
- **Reply only (no code change)**: #6, #8
```

Every numbered item must include all five lines (location / verified / call path /
coverage / resolution). Do not skip any.

## Saving to a file (optional)

Default is chat output only. If the user asks to save:

- Inside an agentforge worktree (`…/anvil/<slug>/…`): write to
  `anvil/<slug>/pr-reviews/pr-{num}-{repo}.md`.
- Otherwise: write to `docs/pr-reviews/pr-{num}.md` relative to cwd (create the
  directory if missing).

## Handling large PRs

If there are 30+ threads, ask the user upfront:
> "There are {N} threads. Want me to start with Critical/High only and continue on
> request?"

If they say yes, deliver only those tiers first, then continue in batches.

## Rules

- **Read the code, don't trust the comment**: always open `path:line` and confirm
  before judging.
- **Outdated comments**: re-read the current file; the comment's snapshot may be
  stale. State explicitly whether the issue still exists.
- **Self-comments**: the PR author may leave intentional TODOs/notes. Label them
  `(self)` and analyze as usual.
- **Approved bodies**: skip if pure praise; analyze if they contain code remarks.
- **No secret leakage**: if a comment contains a token, password, or internal URL,
  do not echo it verbatim — redact it as `[REDACTED]`.
- **No code changes**: this skill is read-only. If the user wants a fix, they will
  ask separately.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
