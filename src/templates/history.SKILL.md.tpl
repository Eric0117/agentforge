---
name: agentforge-history
description: Queries past features in the workspace — searches every artifacts/<YYYYMMDD>/<slug>/ for retrospectives, decisions, PR/commit pointers, and Claude session transcripts, plus in-progress features under anvil/. Triggers when the user asks about earlier work, like "how did we handle X last time?", "which feature added Y?", "find that PR about Z", "show me past features touching a specific repo", "what did we decide about A previously?". Read-only.
---

# agentforge-history

When the user has a question about something done before — a past decision, a
shipped PR, a feature that touched a particular repo — this skill scans the
workspace's accumulated history and answers with grounded references (file paths,
commit hashes, PR URLs) instead of guesses.

**Read-only.** Reports only; never modifies anything.

## When to apply

Trigger phrases:
- "How did we handle `<X>` last time?"
- "Which feature added `<Y>`?"
- "Find that PR about `<Z>`."
- "Show me past features that touched `<repo>`."
- "What did we decide about `<topic>`?"
- "Pull up retros from the last three months."
- "Anything similar to this we've done before?"

If the question is clearly about live code or current work, route to `project-router`
or `feature-start` instead. Use this skill specifically for **looking back**.

## Data sources

Finished features live under `artifacts/<YYYYMMDD>/<slug>/` (the close date is the
first directory). All of these files may be present per feature:

| Source | What it gives you |
|---|---|
| `artifacts/<YYYYMMDD>/<slug>/CLAUDE.md` | Original feature description, repos in scope, start date |
| `artifacts/<YYYYMMDD>/<slug>/RETRO.md` | What was asked, decisions, what was built, lessons |
| `artifacts/<YYYYMMDD>/<slug>/refs.json` | Per-repo `{branch, head, merged_into, pr}` pointers |
| `artifacts/<YYYYMMDD>/<slug>/plans/*.md` | Plan files captured during the work |
| `artifacts/<YYYYMMDD>/<slug>/sessions/*.jsonl` | Full Claude Code transcripts (large; query last) |
| `agentforge/log.jsonl` | Append-only activity log (start / archive / PR events) |

In-progress features (not yet archived) live under `anvil/<slug>/` with their
`CLAUDE.md` describing scope; the rest of the artifacts only exist after
`feature-retro` runs. Don't confuse the two: `anvil/` = active, `artifacts/` = done.

A feature folder may not have all of the above files — older features may
pre-date some fields. Handle missing files gracefully.

## How to do it

### Step 1 — Enumerate features

Walk both archive and in-progress:

```bash
ls -1 artifacts/ 2>/dev/null       # YYYYMMDD directories of close dates
ls -1 anvil/ 2>/dev/null         # in-progress features (no archive yet)
```

For archive, recurse one more level: `artifacts/<YYYYMMDD>/<slug>/`.

For each feature directory, capture:
- the slug (last directory component)
- the **close date** for archived features (the `YYYYMMDD` parent directory)
- the **start date** parsed from the slug's `YYMMDD-` prefix
- the original description (first heading in `CLAUDE.md`)
- the in-scope repos (from `CLAUDE.md` or `refs.json`)
- whether the feature is closed (lives in `artifacts/`) or in-progress (lives in
  `anvil/`)

Sorting:
- Archive features: by close date (parent directory), newest first.
- In-progress features: by slug `YYMMDD-` prefix, newest first.

Skip directories that aren't features (no `CLAUDE.md`).

### Step 2 — Narrow by the user's question

Extract intent + keywords from the question. Then filter:

- **By keyword** — grep `CLAUDE.md`, `RETRO.md`, plan files for the terms. Skip
  `sessions/` directories on this pass (they're large; query them only after
  the answer needs more depth).
- **By repo** — match against the `Repos in scope:` list / `refs.json` repos.
- **By date window** — when the user says "last 3 months", "this quarter",
  "since the deploy migration", filter on the `YYYYMMDD` archive parent dir
  (close date) or the `YYMMDD` slug prefix (start date), depending on which
  the user meant.
- **By PR / commit** — if the user mentions a PR number or partial commit hash,
  grep every `refs.json` for it.

Rank candidates by signal strength (keyword hit count, recency, repo match).

### Step 3 — Compose the answer

Lead with the **most relevant feature**. For each match, include just enough to
let the user open the right file next:

```markdown
## 260418-feat-retry-logic  (closed 2026-05-09, ~3 weeks ago)
*Retry logic refactor across services*  ·  scope: backend-api, admin-web

**Decisions** (from RETRO.md):
- Retry policy enforced at the API layer, not the client (so all callers behave consistently).
- Kept the old endpoint, added v2 alongside for a deprecation window.

**Built** (from refs.json):
- backend-api: branch `260418-feat-retry-logic`, head `abc1234`, merged into `main` — PR acme/backend-api#412
- admin-web:   branch `260418-feat-retry-logic`, head `def5678`, merged into `main` — PR acme/admin-web#88

**More**: open `artifacts/20260509/260418-feat-retry-logic/RETRO.md` for the full
retro; session transcripts are under `sessions/`.
```

If multiple features match strongly, list the top 3–5 in this format. Don't dump
every feature — narrow to ones that actually answer the question.

If there's one clear match and the user asked something specific (e.g. "what was
the rationale?"), **answer the specific question** by quoting the relevant lines
from RETRO.md, then point to the file for the rest. Don't paraphrase invisibly —
quote the source so the user can verify.

### Step 4 — Drill into sessions (only if needed)

`artifacts/<YYYYMMDD>/<slug>/sessions/*.jsonl` files are large (each line is a
message). Only open
them when:
- The RETRO doesn't have the answer the user is looking for.
- The user explicitly asks for the original conversation ("what exactly did I ask
  back then?").

When you do, grep the jsonl for the keyword first; only read the surrounding
messages for context.

## Cross-feature questions

For "anything similar we've done?" or "show me patterns":

1. Pull the user's current intent or current diff (if they're in a worktree).
2. Search across **all** RETROs for similar problem statements / decisions.
3. Group the matches and surface the recurring themes (e.g. "we've tackled cache
   invalidation 3 times — each retro chose a slightly different invalidation
   scope; here's the contrast").

Be explicit when you're synthesizing across multiple features vs. quoting one.

## Rules

- **Always cite the source file.** Every claim should be traceable to a path the
  user can open: `artifacts/<YYYYMMDD>/<slug>/RETRO.md:L42` or `refs.json` etc.
- **Don't fabricate decisions or PR numbers.** If the source data doesn't contain
  it, say so.
- **Respect privacy.** Old session transcripts may contain incidentally pasted
  alerts with customer identifiers. Apply the same redaction conventions as the
  `agentforge-incident-context` skill if you find any (Bearer tokens, JWTs,
  emails, etc.) before echoing them.
- **Sessions are heavy.** Never open all of them in bulk. Always go RETRO/plans
  first, then drop into sessions only for specific lookups.
- **Read-only.** This skill never edits a RETRO, plan, refs.json, or log entry.
  If the user wants to correct an old record, they edit the file themselves.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
