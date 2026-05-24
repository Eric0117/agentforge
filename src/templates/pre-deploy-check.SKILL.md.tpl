---
name: agentforge-pre-deploy-check
description: Right before merging or deploying a feature worktree, scans the diff for non-code changes that ops or infra needs to handle — DB schema / migrations, environment variables, cache keys (Redis etc.), message-queue topics or event schemas, dependency bumps, Dockerfile / k8s / Helm / Terraform changes, feature flags, new HTTP endpoints, scheduled jobs. Surfaces gaps (e.g. entity changed but no migration), proposes a deploy order, and notes rollback caveats. Triggers on "pre-deploy check", "deploy readiness", "anything ops needs before I ship this?", "ready to merge?". Read-only.
---

# pre-deploy-check

The last sanity gate before merging or deploying a feature worktree. Code gets reviewed
in PRs, but the things alongside it — migrations, env vars, cache keys, message
contracts, infra files — often slip through and cause incidents after deploy. This
skill walks the diff and surfaces those.

**Read-only.** Reports only; never modifies code.

## When to apply

Trigger phrases:
- "Pre-deploy check."
- "Anything ops needs before I ship this?"
- "Ready to merge?"
- "Deploy readiness."
- "Did I miss any config / migration / env change?"

Apply once the user has finished the implementation and is approaching merge — not in
the middle of active development.

## Resolve scope

The skill needs a clear before/after to diff against. Resolve scope from cwd:

- `…/anvil/<slug>/<repo>/` → one worktree, one repo.
- `…/anvil/<slug>/` → walk every `<repo>/` subdirectory and check each.
- `…/repos/<name>/` → that repo's currently checked-out branch.
- Anywhere else with a git repo → use cwd; ask the user for the base branch if it's not
  obviously `main` / `master` / `develop`.

For the **base branch**, in order of preference: `origin/main`, `origin/master`,
`origin/develop`. Confirm with the user if none is obvious.

Capture the diff for each repo in scope:

```bash
git -C <repo> diff --name-status <base>...HEAD       # changed file list
git -C <repo> diff <base>...HEAD                     # full hunks (read in chunks)
```

## Categorized checks

Run each category against the diff. For each category, output one of:
✅ no concern · ⚠️ heads-up · ❌ action required.

**Stack coverage**: this checklist spans backend, frontend, mobile, and
infrastructure concerns. Not every category applies to every workspace:
- A pure frontend repo will usually skip **A. DB schema**, **C. Cache keys**
  (server-side), **D. Message queues**, **I. Cron**.
- A pure backend repo will usually skip frontend-specific bundle / asset
  checks (folded into **E. Dependencies** / **F. Infra** here).
- Mobile app repos focus mostly on **E. Dependencies**, **G. Feature flags**,
  **H. HTTP API surface** (from the consumer side), and platform-specific
  config (Info.plist, AndroidManifest) — covered under **F. Infra**.

If a category has no matching diff signal in this workspace, mark it ✅ and
move on rather than warning.

### A. Database schema / entities

Look for changes in files matching ORM / schema conventions:

| Framework | Entity / model files | Migration dir conventions |
|---|---|---|
| JPA / Hibernate (Kotlin/Java) | `@Entity` annotated classes | `src/main/resources/db/migration/V*.sql` (Flyway), Liquibase changelogs |
| TypeORM | classes with `@Entity()` | `migrations/*.ts` (`Migration1700...`) |
| Prisma | `schema.prisma` | `prisma/migrations/*/migration.sql` |
| Sequelize | `models/*.ts|js` | `migrations/*-*.js` |
| Django | `models.py` | `*/migrations/00*.py` |
| SQLAlchemy / Alembic | declarative model classes | `alembic/versions/*.py` |
| Knex | model usage | `knex/migrations/*.js` |
| GORM | structs with `gorm:` tags | hand-rolled SQL migrations |

For each entity / model change:
1. Identify what changed: field added / removed / type changed / nullable flipped /
   index added / unique constraint changed / FK added.
2. **Match to a migration file in the same diff.** If the entity changed but no
   migration shows up → ❌ "Entity changed without migration".
3. Check the migration for production safety:
   - Adding a `NOT NULL` column without default on a large table → ❌ blocking on
     write traffic.
   - Renaming a column → ⚠️ readers/writers must be deployed in the right order.
   - Dropping a column or table → ❌ irreversible; flag for explicit confirmation.
   - Adding an index on a hot table → ⚠️ may need `CONCURRENTLY` / online-DDL tooling.
4. Note rollback story: is the migration reversible? Most "drop column" migrations are
   not.

### B. Environment variables

Find references to env vars in the diff. Patterns by language:

- TS/JS: `process.env.X` / `import.meta.env.X`
- Java/Kotlin: `System.getenv("X")` / `@Value("${X}")` / `${X}` in `application*.yml`
- Python: `os.getenv("X")` / `os.environ["X"]` / Pydantic `BaseSettings` fields
- Go: `os.Getenv("X")` / `viper.GetString("X")`
- Rust: `std::env::var("X")` / `dotenv` macros

For each env var newly **referenced** in the diff:

0. **Filter out dev-only references** to avoid false positives. Look at the
   surrounding context (a few lines before / after the hit):
   - Inside a `process.env.NODE_ENV === 'development'` / `if dev:` /
     `@Profile("local")` / `getenv("APP_ENV") == "test"` style branch → dev-only.
   - In `*.test.*` / `*.spec.*` / `__tests__/` / `test/` / `tests/` directory →
     test-only.
   - In a documentation block or commented-out code → ignore.
   Mark these `✓ dev/test-only` and do not flag them as missing in production
   templates.

1. Check whether the corresponding key is also added to one of the template files in
   the same repo:
   - `.env.example`, `.env.sample`, `.env.template`
   - `application.yml` / `application.properties` (Spring)
   - `config/*.yml`
   - Helm `values.yaml`, K8s ConfigMap/Secret manifests, `kustomization.yaml`
   - Terraform `*.tf` (for cloud env injection)
2. If referenced but missing from any template / sample → ❌ "New env var X has no
   template entry".
3. If a key was **removed** from code but still present in templates → ⚠️ "Dead env
   var X still in templates".
4. Sensitive-looking values (matches `*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD`)
   must go to secret storage (Vault / AWS SSM / k8s Secret), not plain ConfigMap →
   ⚠️ flag if it appears to live in a non-secret location.

### C. Cache keys (Redis / Memcached / in-process)

Look for cache key construction patterns in the diff:

- `redis.get|set|del|expire|hget|...` calls
- `redisson` / `lettuce` / `spring-data-redis` patterns
- Generic cache APIs: `cache.set`, `Cache.put`, `@Cacheable("name")`
- Memcached: `memcache.get|set`

For each cache touch in the diff:
1. **Key format change** (string template, prefix, separator) → ❌ "Existing cache
   entries with the old key are now orphaned and the read path will miss." Action:
   schedule cache invalidation or backfill before / after deploy.
2. **Value schema change** (what's stored at the key) → ❌ "Old cached values are no
   longer compatible with the new reader." Action: bump key prefix or invalidate.
3. **TTL change** → ⚠️ memory footprint / load pattern may shift.
4. **New cache introduced** → ⚠️ confirm memory headroom and eviction policy.

### D. Message queues / event schemas

Look for queue / topic / event references:

- Kafka: `@KafkaListener`, `KafkaTemplate.send`, topic literals
- RabbitMQ: `@RabbitListener`, `rabbitTemplate.convertAndSend`, exchange/queue names
- SQS: `sqs.sendMessage`, queue URLs / names
- Pub/Sub / EventBridge / NATS: equivalent client calls
- Internal event bus: enum / sealed class additions in event modules

For each:
1. **New topic / queue** → ❌ "Provision required before deploy; consumers must be
   running first."
2. **Renamed topic** → ❌ "Producers and consumers must roll in lockstep; old topic
   may need to be drained."
3. **Event payload schema change** → ❌ check consumer compatibility. Schema registry
   (Confluent, Buf) updates needed?
4. **New consumer** for an existing topic → ⚠️ consumer group / offset reset policy
   to confirm (`earliest` will replay history).

### E. External dependencies / lock files

Look for changes in:
- `package.json` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`
- `build.gradle` / `build.gradle.kts` / `pom.xml`
- `go.mod` / `go.sum`
- `Cargo.toml` / `Cargo.lock`
- `requirements.txt` / `Pipfile.lock` / `poetry.lock` / `uv.lock`
- `composer.json` / `composer.lock`

For each:
1. **Lock file changed but manifest didn't** (or vice versa) → ❌ they're out of sync.
2. **Major version bump** (semver `X.0.0`) → ⚠️ "Read release notes; potential
   breaking changes."
3. **New dependency** → ⚠️ note license / security expectations; flag if from an
   unfamiliar org.
4. **Removed dependency** still imported somewhere → ❌ build will fail.

### F. Infrastructure / deploy config

Look for diffs in:
- `Dockerfile` / `*.dockerfile` / `.dockerignore`
- `docker-compose.yml`
- Kubernetes: `*.yaml` in `k8s/`, `manifests/`, `deploy/`
- Helm: `Chart.yaml`, `values*.yaml`, `templates/*.yaml`
- Terraform: `*.tf`, `*.tfvars`
- Pulumi
- CI: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, `circleci/`

For each:
1. **Base image change** → ⚠️ confirm image registry availability, vulnerability scan.
2. **New port exposed** → ❌ load balancer / security group / service definition may
   need updating.
3. **Resource requests/limits changed** → ⚠️ capacity / autoscaling impact.
4. **New mounted secret** → ❌ secret must exist in cluster before pod schedules.
5. **CI workflow change** → ⚠️ first run may behave unexpectedly; tell the user.

### G. Feature flags

Look for SDK / patterns:
- LaunchDarkly: `ldClient.variation(...)`, `boolVariation(...)`
- Unleash: `unleash.isEnabled("...")`
- GrowthBook: `growthbook.isOn("...")`
- Statsig: `statsig.checkGate("...")`
- Custom in-house flags: any constant matching `FEATURE_*` / `*_FLAG`

For each:
1. **New flag referenced** → ❌ "Flag X must be created in the flag service before
   this rolls out, otherwise the default (typically `false`) governs."
2. **Flag removed from code** → ⚠️ "Stale flag can be archived in the flag service."

### H. HTTP API surface

Look for route / handler changes:
- Spring: `@RequestMapping`, `@GetMapping`, etc.
- Express / Fastify: `app.get('/...', ...)`, `router.post('/...', ...)`
- NestJS: `@Controller`, `@Get`, etc.
- FastAPI: `@app.get`, `@router.post`
- Gin / Echo / Fiber: `r.GET("/...", ...)`
- Rails routes: `config/routes.rb`

For each:
1. **New endpoint** → ⚠️ confirm whether gateway / reverse proxy / API documentation
   (OpenAPI, Postman) needs updating.
2. **Removed endpoint** → ❌ "Clients calling this will 404; coordinate or
   deprecate."
3. **Response shape change** → ⚠️ if not versioned, callers break. Cross-reference
   with `cross-repo-impact` if available.
4. **Auth requirements change** (`@PreAuthorize`, middleware adjustments) → ❌ ensure
   intended; surface plainly.

### I. Scheduled jobs / cron

Look for:
- Spring: `@Scheduled(cron = "...")`
- Quartz: cron expressions
- Node-cron / BullMQ repeating jobs
- Celery beat schedules
- K8s `CronJob` resources

For each:
1. **New job** → ❌ "Confirm cluster timezone, single-instance behavior, monitoring
   wired up."
2. **Schedule change** → ⚠️ load profile changes (e.g. moving a job to peak hours).
3. **Removed job** → ⚠️ outstanding work / cleanup needed.

## Output format

```markdown
# Pre-deploy check: <slug or branch>

> Worktree: `anvil/<slug>/<repo>/`
> Base: `origin/main` (HEAD ahead by N commits)
> Files changed: 42

---

## ❌ Action required

### A. Database — entity changed without migration
- `src/main/.../FooEntity.kt:88` — added `someField` column
- No matching migration in `db/migration/`
- **Action**: create Flyway migration adding the column; default value or NOT NULL?

### B. Env var — `KAFKA_BROKER_SASL_USER` referenced, no template entry
- Added in `KafkaConfig.kt:42`
- Not present in `application.yml` or `helm/values.yaml`
- **Action**: add to Helm secret + chart values; bump to k8s before deploy.

### C. Cache — key format changed for `user:profile:<id>`
- `UserProfileCache.kt:18` now uses `user:profile:v2:<id>`
- Old entries are orphaned
- **Action**: either bump prefix is fine if cache is stale-tolerant; otherwise
  invalidate the `user:profile:*` namespace right after deploy.

---

## ⚠️ Heads-up

### F. Infra — Dockerfile base image bumped to `eclipse-temurin:21-jre-jammy`
- Was `17-jre-jammy`
- Confirm JVM args / GC behavior; image size +120 MB.

### G. Feature flag — new flag `search-ranking-v2`
- `FooController.kt:55`
- **Action**: create the flag in LaunchDarkly with default `false` before merging
  this PR.

---

## ✅ Clean

- E. Dependencies (only patch bumps; lock file in sync)
- D. Message queues (no topic / payload changes)
- H. HTTP API (no public surface changes)
- I. Scheduled jobs (no changes)

---

## Suggested deploy order

1. Apply DB migration (`V42__add_some_field.sql`).
2. Update Helm values + k8s Secret with `KAFKA_BROKER_SASL_USER`.
3. Create `search-ranking-v2` flag in LaunchDarkly (default `false`).
4. Deploy backend.
5. Run cache invalidation for `user:profile:*` (optional if stale-tolerant).
6. Smoke test, then ramp the flag.

## Rollback notes

- DB migration adds a nullable column — safe to leave in place if you roll back code.
- Env var addition has no rollback action (extra env is ignored).
- Cache key bump — rolling back code reads from the old `user:profile:<id>` keys;
  those still exist (we only added a new namespace), so rollback is safe.
- Feature flag — flip to `false` on rollback.
```

Structure the report so the **❌ Action required** section is impossible to miss. Even
if the change is small, include the "Suggested deploy order" section — it's the part
people forget.

## Rules

- **Workspace-aware**: if you're in `anvil/<slug>/`, walk every `<repo>/` subdirectory
  in scope and check each. Don't escape to unrelated repos.
- **Diff-driven**: only check things that actually changed. Don't audit the whole
  codebase.
- **Acknowledge unknowns**: if a framework or pattern isn't recognized, say so
  explicitly — "no env-var references detected by known patterns; double-check
  manually."
- **Never edit**: this skill never writes code, migration files, env templates, or
  config. It reports.
- **Don't invent migrations**: if a migration is missing, say so. Do not write one
  unless the user asks separately.
- **Be specific**: every ❌ / ⚠️ item must point at a file/line in the diff. No vague
  warnings.
- **Mind the deploy order**: a list of risks without an ordering is half a deliverable.
  Always include the "Suggested deploy order" section.

## Output language

{{OUTPUT_LANGUAGE_INSTRUCTION}}
