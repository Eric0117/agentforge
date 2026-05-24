# agentforge — CLI source

This repo is the **source code** for the `agentforge` npm package — the multi-repo
workspace bootstrapper for Claude Code, Cursor, and OpenAI Codex CLI. End-user
documentation lives in [`README.md`](./README.md); this file is the developer
guide for working on the CLI itself (especially with Claude Code).

> Do **not** put service-domain identifiers (real repo names, ticket prefixes,
> branch names, feature descriptions) in any file under this repo. Use generic
> placeholders (`backend-api`, `<TICKET>`, `<topic>`). Skill template files are
> shipped to every user — leaks propagate.

## Layout

```
src/
├── cli.ts                    # entry: argv parsing, command dispatch, help text
├── init.ts                   # `agentforge init`
├── add-agent.ts              # `agentforge add-agent`
├── remove-agent.ts
├── add-skill.ts
├── remove-skill.ts
├── list-skills.ts
├── sync-skills.ts            # propagate master skills to every installed agent
├── enter.ts                  # `agentforge enter <slug>` — cd + launch claude
├── rename.ts                 # `agentforge rename <old> <new>` — rename a feature
├── doctor.ts                 # workspace health checks
│
├── skills-data.ts            # SKILLS[] — id, multilingual title/description,
│                             # template filename, per-agent destination paths
│
├── agentforge-config.ts      # workspace config (agentforge/config.json) reader/writer
│
├── agents/                   # per-agent adapters
│   ├── index.ts              # AGENT_IDS, getAgent()
│   ├── types.ts              # AgentId, MasterSkill, AgentAdapter
│   ├── io.ts                 # shared file ops: ensureDir, renderTemplate,
│   │                         #   writeRendered (with .bak backup), readMasterDir
│   ├── claude.ts             # → .claude/skills/<id>/SKILL.md + CLAUDE.md
│   ├── cursor.ts             # → .cursor/rules/<id>.mdc + .cursor/rules/CLAUDE.mdc
│   └── codex.ts              # → .agents/skills/<id>.md + AGENTS.md
│
├── templates/                # SKILL bodies — the source of truth
│   ├── CLAUDE.md.tpl         # the per-workspace guide that init drops
│   ├── project-router.SKILL.md.tpl
│   ├── feature-start.SKILL.md.tpl
│   ├── feature-retro.SKILL.md.tpl
│   ├── pr-create.SKILL.md.tpl
│   ├── pr-review-analyze.SKILL.md.tpl
│   ├── pre-deploy-check.SKILL.md.tpl
│   ├── cross-repo-impact.SKILL.md.tpl
│   ├── incident-context.SKILL.md.tpl
│   ├── history.SKILL.md.tpl
│   ├── release-coordinate.SKILL.md.tpl
│   └── context-handoff.SKILL.md.tpl
│
├── confirm.ts / lang-prompt.ts / path-prompt.ts / skill-prompt.ts / agent-prompt.ts
│                             # small interactive prompt helpers (built on `prompts`)
└── logo.ts                   # ASCII logo for init

scripts/
└── copy-templates.mjs        # build step: copies src/templates/ → dist/templates/

dist/                         # tsc output + copied templates (gitignored)
README.md                     # end-user docs
package.json                  # bin: { agentforge: dist/cli.js }
```

## Build & run

```bash
npm install           # one-time
npm run build         # tsc + copy templates + chmod +x dist/cli.js
npm run dev           # tsc --watch (for fast iteration on .ts; doesn't re-copy templates)
```

To test changes locally:

```bash
npm link              # makes the global `agentforge` point to this repo's dist/
                      # (re-run after first publish + global install elsewhere)

# Test in a scratch workspace
mkdir /tmp/wf-test && cd /tmp/wf-test
agentforge init . --agent claude --lang en --yes
ls .claude/skills/    # should list every skill
```

When done testing, `rm -rf /tmp/wf-test`.

## Adding or editing a skill

The flow is:

1. **Edit** (or create) `src/templates/<id>.SKILL.md.tpl`. The frontmatter `name:`
   must match the filename (without the `.SKILL.md.tpl` extension, prefixed with
   `agentforge-`).
2. **Register** in `src/skills-data.ts` if new — add a `SkillSpec` with:
   - `id` (kebab-case, must start with letter)
   - multilingual `description` (one short line per lang — used by `list-skills`)
   - multilingual `details` (multi-line — used by Cursor's `description` field)
   - `template` filename (must exist in `src/templates/`)
   - `destDir` / `destFile` (Claude-style path used for sorting/lookup)
3. **Build**: `npm run build`.
4. **Test** in a scratch workspace (see above).

Template body conventions:
- End every template with `## Output language\n\n{{OUTPUT_LANGUAGE_INSTRUCTION}}`
  — the placeholder gets replaced with the lang-appropriate instruction during
  `renderTemplate` (`src/agents/io.ts`).
- Use generic placeholders for examples (`backend-api`, `<TICKET>`, `<topic>`).
  Never use real repo names, ticket prefixes, or domain terms — these ship to
  every user.
- Read-only skills must say so prominently in both the description and the body.

## Adding a CLI command

1. Create `src/<name>.ts` exporting `runX(opts)`.
2. Import + wire in `src/cli.ts`:
   - Add to `HELP` text (kept in category groups).
   - Add a `case "<name>":` in the dispatch switch.
   - Add the command name to the `known` list at the bottom (for the
     "did you mean" suggester).
3. If the command needs flags not already parsed in `parseArgs`, add them there.
4. Build and test.

Conventions:
- Walk upward from cwd to find the workspace root (look for
  `agentforge/config.json`). See `findWorkspaceRoot` in `src/enter.ts` or
  `src/rename.ts`.
- For destructive commands, refuse on dirty state unless `--force`, and require
  `--yes` (or a confirmation prompt) before acting.
- Append actions to `agentforge/log.jsonl` so they show up in `feature-retro`'s
  timeline.
- Use the existing ANSI color helpers (`\x1b[36m` cyan, `\x1b[32m` green, etc.)
  — see any of the command files for the constants.

## Agent adapters

Each agent has its own file in `src/agents/` exporting an `AgentAdapter` with:

- `id`, `label` — for the `--agent` flag and progress logs
- `install({ root, masterSkills, skillCatalog, lang, forceSkills, forceClaude })`
  — writes the skill files and the workspace guide for this agent
- `uninstall({ root })` — removes the agent's directories

To add a new agent (e.g. Aider), drop a file in `src/agents/<id>.ts`, register
it in `src/agents/index.ts` (`AGENTS` map + `AGENT_IDS`), and add the literal to
the `AgentId` union in `src/agents/types.ts`. The rest (init, sync-skills,
add-agent, remove-agent) wires through automatically.

## Memory

This workspace has a memory entry — **never embed user service-domain info in
markdown**. The full rule lives in
`~/.claude/projects/-Users-seunghwan-Documents-agentforge/memory/feedback_no_service_domain_in_md.md`
and applies to every file under this repo: README, skill templates, examples,
even one-off scratch text. Use only generic placeholders.

## Publish

```bash
npm view agentforge          # confirm version / name availability
npm whoami                   # confirm npm login
npm publish --access public  # `prepublishOnly` runs npm run build first
```

`package.json` ships only `dist/`, `README.md`, `LICENSE`. Everything else is
gitignored or excluded by the `files` whitelist.
