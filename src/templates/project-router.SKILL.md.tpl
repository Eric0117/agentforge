---
name: agentforge-project-router
description: Routes a user's question or request to the right repository in a multi-repo workspace under repos/<name>/. Triggers when the user asks about code, files, or behavior of "the backend", "the admin", a specific repo name, or any other project-scoped query from the workspace root.
---

# project-router

This workspace is a multi-repo layout (several repos live under `repos/<name>/`).
When the user asks a question about code or project behavior, **first decide which repo
to look at**, then answer.

## When to apply

Apply this skill when any of the following is true:
- The user asks about code, a function, a file, or how an API behaves.
- The user wants to understand the structure or behavior of a specific project.
- The user asks for a fix or change (unless it's clearly starting a new feature — in
  that case, use the `feature-start` skill instead).

Apply this only when the user is at the workspace **root** (the directory that contains
`repos/` and `anvil/`) or somewhere under it. If the user has already opened Claude inside
a specific `repos/<name>/` or `anvil/<slug>/`, just work there — don't re-route.

## How to do it

1. **List the repos** — run `ls repos/` to see what's available right now. Do not cache
   this; the user may add or remove repos at any time.
2. **Extract hints** from the question:
   - Direct folder name mentions (`backend-api`, `admin-web`, ...).
   - Natural-language aliases ("the backend API" → `backend-api`, "the admin" →
     `admin-web`, "the mobile app" → `mobile-app`, "the worker" → `worker-service`, etc.).
   - Domain cues — infer from repo purpose based on what each repo actually contains.
3. **Branch on match count**:
   - **Single match**: `cd` into `repos/<name>/` and proceed there.
   - **Multiple / ambiguous**: show the candidate repos and ask the user to pick. Do not
     pick one arbitrarily.
   - **No match**: list all repos under `repos/` and ask "Which project did you mean?"
4. **Cross-repo questions**: if the question clearly spans multiple repos (e.g. "where the
   API and admin connect"), look at all relevant repos together instead of routing into
   just one.

## Rules

- `repos/<name>/` is **read / explore only**. Do not edit code in `repos/`. If a change is
  needed, suggest using the `feature-start` skill to create a feature worktree first.
- If the user is already inside `anvil/<slug>/`, stay in that feature's worktree. Do not
  fall back to `repos/`.
- Repos are discovered via `ls repos/` every time. There is no metadata file to consult.
- **If a `anvil/<slug>/CLAUDE.md` references a repo whose worktree directory is
  missing**, treat the metadata as stale. Tell the user which repo is listed but
  absent — do not silently route into a non-existent worktree.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
