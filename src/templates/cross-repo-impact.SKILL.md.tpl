---
name: agentforge-cross-repo-impact
description: Traces the blast radius of a change across every repo in the workspace. Given a symbol (function, class, type, API endpoint, env var, config key) or the current worktree's diff, finds all the places in other repos that depend on it, classifies each usage (call site / import / HTTP caller / string reference), and flags breaking-change risks. Triggers on "what's the impact of this change?", "where else is X used?", "if I rename this, what breaks?", "blast radius of …", "any callers in other repos?".
---

# cross-repo-impact

This is the multi-repo workspace's blast-radius tool. When the user changes something in
one repo, this skill finds every other repo in the workspace that touches it and
reports the impact, grouped by repo and by usage kind.

**Read-only.** This skill never modifies code.

## When to apply

Trigger on questions like:
- "What's the impact of this change?"
- "Where else is `<symbol>` used?"
- "If I rename / change the signature of `<symbol>`, what breaks?"
- "Blast radius of removing endpoint `/v1/things`?"
- "Anything in admin-web that calls this?"

If the user is mid-implementation and asks "before I touch this, who uses it?" — that's
this skill.

## Locate the workspace

This skill needs the workspace layout (`repos/` and possibly `anvil/<slug>/`). Walk up
from cwd until you find a directory containing `repos/`. If no such directory is found,
tell the user: "Not inside an agentforge workspace — falling back to current repo only,"
and proceed with cwd as the single search target.

The source repo (where the change lives) is determined from cwd:
- `…/anvil/<slug>/<repo>/` → source = that `<repo>`; search the **other** `repos/*`
  (and other `anvil/<slug>/*` worktrees) for usages.
- `…/repos/<name>/` → source = `<name>`; search the other `repos/*`.
- Elsewhere → ask the user which repo is the source.

The search set is every `repos/<other>/` plus every `anvil/<other-slug>/<other-repo>/`
the user wants included (default: just `repos/*` to avoid duplicate hits from sibling
worktrees of the same repo).

## Determine what to analyze

Two modes:

### Mode A — user names a target

The user gives one or more of:
- A symbol name (`doSomething`, `User`, `SomeType`)
- An HTTP endpoint (`POST /v1/things`, `/api/users/:id`)
- A config / env key (`KAFKA_BROKER_URL`, `feature.search-ranking.enabled`)
- A message / event name (`ItemCreated`, `something.changed`)

Use this verbatim.

### Mode B — auto from worktree diff

If the user says "what does this change touch?" without naming a target, derive
candidates from the current diff:

```bash
git -C <source-repo> diff --unified=0 <main-branch>...HEAD
```

Extract candidate targets:
- **Function / method renames or signature changes** — look for hunks where a `def`,
  `function`, `fun`, `func` line was modified.
- **Newly exported / removed symbols** — look for changes in `export`, `pub`, public
  visibility.
- **HTTP route changes** — look for hunks containing route decorators / annotations
  (`@RequestMapping`, `@Get(`, `app.get(`, `@router.get`, Gin/Fiber/Express patterns).
- **Removed env / config keys** — look for `process.env.X`, `System.getenv("X")`,
  `os.getenv("X")`, `viper.GetString("X")` patterns that disappeared.
- **Type / schema changes** — modified `interface`, `type`, `class`, `data class`,
  `struct`, proto fields.

Show the user the candidate list and ask them to pick which ones to analyze. Don't
silently analyze everything — the diff may contain noise.

## Detect languages per target repo

For each repo in the search set, sample a few source files to infer language(s):

```bash
find <repo> -maxdepth 3 -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.kt' \
  -o -name '*.java' -o -name '*.py' -o -name '*.go' -o -name '*.rs' \
  -o -name '*.rb' -o -name '*.php' \) 2>/dev/null | head -10
```

Per-language search idioms (use whichever applies):

| Language | Call / use patterns |
|---|---|
| TypeScript / JavaScript | `\bX\(` , `import {[^}]*X[^}]*}` , `from ['"][^'"]*['"]` |
| Kotlin / Java | `\.X\(` , `import .*\.X` |
| Python | `\bX\(` , `from .* import .*X` , `import .*X` |
| Go | `\.X\(` , `X\(` (after dot-less import) |
| Rust | `::X\(` , `\.X\(` , `use .*::X` |
| Ruby | `\.X\b` , `X\(` |
| PHP | `->X\(` , `::X\(` , `use .*\\X` |

For HTTP endpoints, search for the literal path in any source/config file (route
strings are usually written as-is in client code), not just the framework idiom. For
config / env keys, grep the literal key name.

## Standard exclusions (apply to every grep / search in this skill)

Always exclude these from any code search to avoid noise + speed up big repos:

```
:!node_modules :!dist :!build :!target :!.next :!.nuxt :!.venv :!__pycache__
:!*.lock :!package-lock.json :!yarn.lock :!pnpm-lock.yaml :!Cargo.lock
:!*.min.js :!*.bundle.js :!coverage :!.git :!vendor
```

With `git grep`, pass them as pathspec exclusions:
```bash
git -C <repo> grep -nE '<pattern>' \
  -- ':!node_modules' ':!dist' ':!build' ':!target' ':!.next' \
     ':!*.lock' ':!coverage' ':!vendor'
```

With plain `grep -r`, use `--exclude-dir=` / `--exclude=` repeatedly. If the user has
a `.gitignore`, prefer `git grep` (which already honors it).

## Search & classify

For each (target, target-repo) pair, run the searches and classify each hit into one
of these kinds:

| Kind | Signal |
|---|---|
| 📞 **Call site** | symbol invoked: `X(...)` |
| 📥 **Import** | imported but not yet shown to be called in the surrounding hunk |
| 🌐 **HTTP caller** | code that opens the URL (axios/fetch/http client) targeting the endpoint string |
| 🔤 **String reference** | literal name appears in a log message, config, schema |
| 🧩 **Type usage** | the changed type appears in a signature, declaration, or generic parameter |
| 📜 **Schema / proto** | reference in a `.proto`, OpenAPI, JSON schema, SQL migration |
| 🧪 **Test reference** | hit is inside a test file (`*test*` , `__tests__`, etc.) |

Test hits are reported separately because they signal regression coverage rather than
production risk.

## Breaking-change assessment

For each target, decide what kind of change it is and what that means for callers:

| Change kind | Effect on call sites |
|---|---|
| **Renamed** | All non-test call sites break — they need updating. |
| **Removed** | Hard break for all kinds. Highest urgency. |
| **Signature changed** (params added / removed / reordered / typed) | Call sites with the old shape break. Required vs optional parameters matter — note the difference. |
| **Return type changed** | Callers consuming the return value need updating. |
| **Behavior changed (same signature)** | Compiler / type checker won't catch it. Manual review per call site. |
| **New symbol** | No callers can break yet, but document it for discoverability. |
| **Endpoint URL changed** | HTTP callers using the old path break. Headers / methods matter too. |
| **Env / config key renamed** | Deployments need re-configuring before code roll-out. Mention deployment ordering. |

Note the trickiest case: **behavior changed, signature unchanged**. Static search can
list call sites, but the caller code still compiles. Flag this explicitly so the user
knows manual review is needed.

## Output format

```markdown
# Cross-repo impact: <target description>

> Source: `<source-repo>` (from `<cwd>`)
> Change kind: <renamed / removed / signature / behavior / new / endpoint / config>
> Search set: 3 repos (`admin-web`, `worker-service`, `mobile-app`)

---

## 💥 Breaking call sites

### `admin-web` — 4 hits

| File | Line | Kind | Snippet |
|---|---|---|---|
| `src/pages/things.tsx` | 42 | 📞 Call site | `doSomething(id)` |
| `src/api/things.ts` | 11 | 📥 Import | `import { doSomething } from '@/api'` |
| `src/components/SomeButton.tsx` | 88 | 📞 Call site | `await doSomething(...)` |
| `src/__tests__.test.ts` | 19 | 🧪 Test | `doSomething(mockInput)` |

### `mobile-app` — 1 hit

| File | Line | Kind | Snippet |
|---|---|---|---|
| `src/handlers/things.kt` | 102 | 📞 Call site | `someClient.doSomething(...)` |

---

## ⚠️ Same-signature behavior changes

If applicable, list call sites that won't be caught by the compiler but may behave
differently. Same table layout.

---

## ✅ Safe references (no action needed)

Things that match the symbol name but are unrelated (different scope, comment, log
string). Keep this list short — only include hits that the user might worry about.

---

## Summary

- `admin-web`: 3 production + 1 test → must update before merge
- `mobile-app`: 1 production → must update before merge
- `worker-service`: no hits

Suggested next steps:
1. Update `admin-web` first (largest blast radius).
2. Coordinate deploy ordering: backend-api before clients.
3. Add a deprecation shim if you can't update all clients in one go.
```

Group by repo, then by file. Always include the snippet (one line). Don't truncate
file paths.

## Rules

- **Never edit code.** Report only.
- **Don't claim a hit is broken without seeing it.** When the snippet alone is
  ambiguous (e.g. the symbol name is a common word), open the file and confirm scope.
- **Respect the workspace boundary.** Only search `repos/*` (and explicitly-included
  worktrees). Don't escape into the user's home directory or unrelated dirs.
- **Distinguish production vs test hits.** Both matter, but test hits are coverage
  signal, not regression risk.
- **Acknowledge unknowns.** If a language in the workspace isn't in the table above,
  fall back to a plain symbol-name grep and tell the user the analysis is best-effort.
- **Common names need extra care.** A symbol called `get` or `update` will match
  noise — narrow the search using import paths or enclosing scope before reporting.
- **Don't truncate.** If there are too many hits, summarize counts per file but still
  list every file.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
