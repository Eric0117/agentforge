---
name: agentforge-incident-context
description: First-responder context for a production incident in a multi-repo workspace. Given a clue from an alert — error message, stack trace line, HTTP path, metric name, exception class, or timestamp — searches every repo in the workspace for matching code, identifies recent merged PRs that touched it, names the last committers, traces the call path, and returns a single briefing optimized for "I just got paged, what changed?". Triggers on "incident context", "got an alert about X", "production error", "what changed recently around X", "page-out for …". Read-only.
---

# incident-context

Optimized for the moment an alert fires. Instead of grepping six repos one by one,
this skill takes the alert's clue, walks the whole workspace, and returns a single
briefing: where the keyword lives, what changed there recently, who touched it last,
and what to look at next.

**Read-only.** Reports only; never modifies code.

## When to apply

Trigger phrases:
- "Incident context for `<keyword>`."
- "Got an alert about `<X>` — what could be causing it?"
- "Production error: `<stack trace line>`."
- "What changed recently around `<symbol or path>`?"
- "Page-out — please pull context."

If the user's clue is overly generic (`null`, `error`, `failed`), ask for a more
specific signal (the surrounding class name, a unique substring of the error message,
the HTTP path) before searching — false positives at 4am help nobody.

## Redact secrets from the clue (do this FIRST, before any analysis)

Alert payloads pasted by an on-call engineer commonly contain tokens, customer
identifiers, or credentials. Before you echo, log, or quote any part of the clue
back to the user — and before any of it lands in your output — scrub it.

**Pattern checks to apply** (regex-level, conservative):

| Pattern | Example | Action |
|---|---|---|
| `Bearer\s+[A-Za-z0-9._\-]{20,}` | `Bearer eyJhbGc...` | replace with `Bearer <REDACTED>` |
| `Basic\s+[A-Za-z0-9+/=]{16,}` | `Basic YWRtaW46...` | `Basic <REDACTED>` |
| AWS access key `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` | `<AWS_KEY>` |
| AWS secret `[A-Za-z0-9/+=]{40}` next to a key context | `aws_secret=...` | `<AWS_SECRET>` |
| GitHub PAT `gh[pousr]_[A-Za-z0-9]{36,}` | `ghp_xxxxx` | `<GH_TOKEN>` |
| Slack token `xox[abprs]-[A-Za-z0-9-]+` | `xoxb-...` | `<SLACK_TOKEN>` |
| JWT `eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+` | full JWTs | `<JWT>` |
| Long hex secret `\b[a-f0-9]{32,64}\b` near `key=`/`secret=`/`token=` | hashes/keys | `<SECRET>` |
| Email `[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}` | customer email | `<email>` (only inside log/error text, not from the user's own message) |
| Phone `\+?\d[\d \-]{7,}` near `phone=` / `tel=` | customer phone | `<phone>` |
| Credit card-like `\b(?:\d[ \-]?){13,19}\b` | numeric runs | `<CC>` |

If any pattern matched, **tell the user once**:

```
⚠ Redacted from the clue: 2 tokens, 1 JWT, 1 customer ID
```

Continue analysis with the redacted version. Never include the original values in any
output, file, or subsequent tool call.

## What the user provides

Accept one or more of (the clue can come from any stack — backend, frontend, mobile,
worker, CLI):
- **Error message / exception text**, e.g.
  - JS/TS: `TypeError: Cannot read properties of undefined (reading 'foo')`
  - Java/Kotlin: `NullPointerException at Foo.process`
  - Python: `KeyError: 'foo'` / `AttributeError: 'NoneType' object has no attribute 'bar'`
  - Go: `runtime error: invalid memory address or nil pointer dereference`
  - Swift: `Fatal error: Unexpectedly found nil while unwrapping an Optional value`
- **Stack trace line**, e.g.
  - JS: `at fetchData (src/api/things.ts:42:13)`
  - Kotlin: `at com.example.app.JobRunner.process(JobRunner.kt:88)`
  - Python: `File "src/foo.py", line 142, in process`
  - Go: `src/foo/handler.go:88 +0x4c`
- **HTTP request path** (e.g. `POST /v1/things/<id>`, `GET /api/users/:id`)
- **Symbol name** — function, class, method, component, hook
- **Metric or log key** (e.g. `things.process.failure.count`, `feature.search-ranking.enabled`)
- **Time window** (e.g. "starting 30 min ago", "since yesterday's deploy") — scopes
  the "recent PRs" search.

If a time window is missing, default to **last 7 days** for PR scanning, but tell the
user so they can narrow it.

## Locate the workspace

Walk up from cwd to find a directory containing `repos/`. The search set is every
`repos/<name>/`. If no agentforge workspace is detected, fall back to cwd as the
single repo and say so.

## Normalize the clue

Extract searchable tokens from whatever the user pasted:

- **Stack trace** → pull the fully-qualified type + method + file:line. The file:line
  is the highest-signal anchor; search for the file basename first.
- **Error message** → extract the unique substring (skip framework boilerplate like
  "Exception in thread"). A class name + a noun phrase is usually enough.
- **HTTP path** → keep both the literal path and the path with `:id` style
  placeholders. Search both forms.
- **Metric / log key** → search the literal key as a string.

If multiple anchors are available, search for all of them and intersect results.

## Search every repo

For each `repos/<name>/`:

```bash
# code search for the most specific anchor first
git -C repos/<name> grep -nE "<anchor-regex>" -- ':!*.lock' ':!node_modules' ':!dist' ':!build'
```

Track:
- File paths and line numbers that match.
- The function / method enclosing each match (read a few lines of context).
- Whether the hit is in production code or in a test file (`*test*`, `__tests__`,
  `*_test.go`, `*Test.kt`, etc.) — test hits are usually noise during an incident.

If a repo has zero hits, mention it briefly ("`mobile-app`: no matches"). Don't hide
it — the responder needs to know what was searched.

## Pull recent PRs per repo

For each repo that has matches, find PRs merged in the time window that touched any
of the matching files:

```bash
# PRs merged in window (default: 7d)
gh -R <owner>/<repo> pr list --state merged --search "merged:>=$(date -u -v-7d '+%Y-%m-%d')" --json number,title,url,mergedAt,author,files --limit 50
```

Filter the result to PRs whose `files[]` list intersects the matching file paths.

If `gh` isn't available or the repo has no remote, fall back to git:

```bash
git -C repos/<name> log --merges --since="7 days ago" --pretty='%h %ci %s' -- <matched-files...>
```

For each PR / commit, capture:
- PR number + title + URL (or commit hash + subject)
- Merged-at timestamp
- Author handle
- Which of the matching files it changed (just the count)

**Rank by suspicion**:
1. Merged inside the user's time window (if given) — strongest signal.
2. Merged most recently.
3. Touched the highest-signal file (the one matching the stack trace line).

## Identify the last committers

For each matching file, `git -C <repo> log -1 --format='%an <%ae> %ai' -- <file>` to get
the most recent author. Optionally also list the top 2–3 historical committers
(`git -C <repo> shortlog -sne -- <file> | head -3`) — they're the people who
understand the code best.

## Trace the call path (light)

For the strongest single match (the most specific anchor — usually the stack trace
line), do a one-hop call site search using the language-appropriate idiom:

| Language | Caller pattern |
|---|---|
| TS / JS | `\.X\(` , `\bX\(` |
| Kotlin / Java | `\.X\(` |
| Python | `\bX\(` |
| Go | `\.X\(` |
| Rust | `::X\(` , `\.X\(` |

Show up to 10 call sites grouped by repo. This is enough to know "is this called from
a sync HTTP handler, a Kafka listener, or a cron?" — which often determines blast
radius.

## Output format

Lead with the **most actionable** sections (suspects, recent PRs) and push general
context lower. Make it scannable in 30 seconds.

```markdown
# 🚨 Incident context: <keyword>

> Searched: 4 repos (backend-api, mobile-app, admin-web, worker-service)
> Time window: last 7 days (override by specifying a window)
> Anchors: `Foo.process` · `things.process.failure.count`

---

## 🎯 Primary suspects

### `backend-api` · `Foo.kt:142` — `process()`
- 📞 Reached via:
  - `FooController.handleRequest` (sync HTTP `POST /v1/things/:id`)
  - `SomeConsumer.onMessage` (Kafka, `things.event.requested`)  ⚡ async — no request transaction
- 🕒 Last touched: 2 hours ago by `alice <s@example.com>`
- 📜 Recent PRs touching this file:
  - **#412** "Refactor error handling" — merged 2h ago by @alice
    [link]
  - **#398** "Add `reason` column" — merged 3d ago by @bob [link]

---

## 📜 Recent merged PRs (in window, ranked)

| Repo | PR | When | Author | Matched files | Title |
|---|---|---|---|---|---|
| backend-api | #412 | 2h ago | @alice | 3 | Refactor error handling |
| backend-api | #398 | 3d ago | @bob | 1 | Add `reason` column |
| worker-service   | #71  | 1d ago | @carol     | 1 | Bump webhook version |

---

## 🔍 Other matches (older / lower signal)

- `admin-web` · `src/api/things.ts:18` — display layer; last touched 6 weeks ago.
- `mobile-app`: no matches.

---

## 👥 Who knows this code

- `Foo.kt` — alice (last touch), colleague (most commits), legacy-dev
  (original author)
- `SomeConsumer.kt` — colleague

---

## 📋 Next steps

1. Read **PR #412** diff — it's the most recent change to the suspect file.
2. Check logs for the time window — search by `request_id` and the exception class.
3. Confirm whether the failures are on the sync path or the Kafka consumer (call
   path shows both).
4. If async, confirm transaction / MDC propagation in `SomeConsumer.onMessage`.
5. If you need a wider search, re-run with a longer time window or a broader anchor.
```

Always include "Next steps" — a context dump without a path forward isn't useful at
4am. Limit it to 3–5 concrete actions.

## Rules

- **Workspace-bounded**: only search `repos/*` (and explicitly included worktrees).
  Don't escape to unrelated directories.
- **Don't claim a root cause.** Report what was found and what is most suspicious;
  let the user decide.
- **Distinguish sync vs async entry points.** When a Kafka listener / scheduled job /
  webhook handler is in the call path, flag it — incidents often hide there.
- **Distinguish production vs test hits.** Test hits go to the "other matches"
  section, not the suspects list.
- **Acknowledge silence.** A repo with no hits is information — list it.
- **No data exfiltration.** If a user pastes a stack trace containing customer
  identifiers (emails, account IDs), do not echo those identifiers in your response —
  use placeholders like `<id>`. Redact tokens / passwords if they appear.
- **No edits, ever.** Reporting only.
- **Time-boxed.** The user is under pressure. Aim to deliver the first useful version
  of the briefing fast; offer to drill deeper afterwards.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
