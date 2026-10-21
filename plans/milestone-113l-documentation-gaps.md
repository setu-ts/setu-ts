# Milestone 113l — Documentation That Does Not Match the Code, or Is Missing (docs)

> **Status:** Planning. Branch: `docs/m113l-documentation-gaps` (a **docs** letter — ROADMAP
> "Milestone 113" table — so one `docs/…` branch, not `feat/…`). `develop` and `main` are protected;
> all work stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Twenty rows from the `v0.9.0` smoke programme (`smoke/DEFECTS.md`) where the code is correct and a
reader following the documentation still ends up wrong, or finds nothing. The letter changes **no
package `src/`** — asserted as a command (§7). It adds tests only where a corrected sentence states
a behaviour no existing test pins (the M90h rule: a claim the fence compiler cannot see is pinned by
a test that runs the documented composition).

- **In scope** (one deliverable per row; content decided in §3):
  - **V9-6** telemetry: name the optional `@opentelemetry/*` peers per feature, and what happens on
    Node when one is missing.
  - **V9-7** upgrade guide 0.9.0: the Deno step's search pattern, and the Workers pins.
  - **V9-10** getting-started: `envFilePath` is not optional as written; a Node and a Bun testing
    path beside the Deno one. (The `npm:zod` half shipped in M113j.)
  - **V9-24** localization: which error responses carry `Content-Language`.
  - **V9-29** worker-pool: thread overshoot at a hand-over, measured on all three runtimes.
  - **V9-51** database: a repository-surface section.
  - **V9-52** audit: the `DatabaseAuditStorage` row shape and how an owner reads the trail.
  - **V9-53** health: what `/ready` runs.
  - **V9-54** openapi: `exclude` is exact and read once; no per-route `operationId`.
  - **V9-55** localization formatter: no currency or date-style option.
  - **V9-56** multi-tenancy: tenant from the signed-in principal; `ITenantRepository`'s limits.
  - **V9-57** config + kernel: configuration a plugin needs at construction.
  - **V9-58** kernel: the "takes one option" sentence.
  - **V9-59** auth: the `ITotpStore` per-method contract.
  - **V9-69** backup and restore guidance.
  - **V9-72** storage: each provider's peer packages.
  - **V9-73** idempotency: the tier-C example needs a scheduler.
  - **V9-74** inbound-webhook guide.
  - **V9-77** secrets: a `.env` secret is invisible to `EnvProvider`.
  - **V9-78** deployment: the Node image and standalone projects.
- **NOT this milestone:**
  - Any behaviour change. If a row turns out to need one (a claim that cannot be made true by
    rewording), Codex stops and reports; it is recorded as a new `fix/…` item, not done here.
  - Generated-output text in `packages/cli/src` (V9-77's `cli` half, the scaffold README) — that is
    a `src` change; recorded in §9 as unowned.
  - Closing the `smoke/DEFECTS.md` rows — rows close only on a re-run against a newly published
    version.

## 1. Contracts verified from SOURCE (not names)

Checked on `develop` at `419f76b7`.

| Reference                       | Source (file:line)                                                                                      | Verified surface / fact                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.8.0 CLI pins                  | `git show v0.8.0:packages/cli/src/templates/project-files.ts:41,865`                                    | `RANGE = '^${VERSION}'`; Deno imports `jsr:@setu-ts/<pkg>@^0.8.0`; `add.ts:319,323` and `devtool.ts:73` also caret. V9-7's "exact `@0.8.0`" is NOT what the CLI emitted (§2 C1).                                                              |
| 0.8.0 Workers pins              | `git show v0.8.0:…/project-files.ts:1197,1199`                                                          | `wrangler: '^4.0.0'`, `@cloudflare/workers-types: '^4.20250109.0'`.                                                                                                                                                                           |
| current Workers pins            | `packages/cli/src/templates/project-files.ts:1675-1676`                                                 | `wrangler: '~4.148.0'`, `@cloudflare/workers-types: '^5.20261006.1'`; `@types/node` added only with an npm build.                                                                                                                             |
| upgrade guide Workers step      | `docs/upgrading.md:861-865`                                                                             | Already says "pin as a fresh scaffold does" with no versions; the Deno step at `:447` says `@^0.8.0`.                                                                                                                                         |
| getting-started Config/testing  | `docs/getting-started.md:125-219`                                                                       | `zod` already bare (M113j). `envFilePath: '.env'` commented "Optional"; testing is `deno add` + `@std/*` + `deno test` only.                                                                                                                  |
| `envFileOptional`               | `packages/config-plugin/src/options.ts`; CLAUDE.md M67                                                  | Absent path skipped only when `envFileOptional: true`; default throws.                                                                                                                                                                        |
| generated Node/Bun test runners | `packages/cli/src/templates/project-files.ts:1561-1567`; `schematics/test-harness.ts:49,59`             | Node: `tsx --test` with `node:test` + `node:assert`; Bun: `bun test` with `bun:test`.                                                                                                                                                         |
| locale `Content-Language`       | `packages/localization-plugin/src/middleware/locale-middleware.ts:111-128`                              | Written after `next()` resolves, from the final supported locale, unless already set. No `try`/`finally`: a THROWN error skips it; a refusal written without throwing (responder short-circuit) gets it.                                      |
| catalogue 404                   | `…/routes/catalogue-route.ts:139-143`                                                                   | `respondWithError(…404…)` and `return` — a non-throwing refusal, so it carries `Content-Language`. README `:141-142` says an error response gets none.                                                                                        |
| formatter                       | `packages/localization-plugin/src/format/format.ts:97,109`                                              | `new Intl.NumberFormat(locale)` and `new Intl.DateTimeFormat(locale, { timeZone? })` — no per-placeholder options; `FormatOptions` (`format/types.ts:31-38`) carries only `timeZone`.                                                         |
| worker-pool README              | `packages/worker-pool-plugin/README.md:171-177`                                                         | Says the bound counts slots not threads; measures only Deno timeouts; "Node and Bun were not measured".                                                                                                                                       |
| X73 measurement                 | `smoke/X67-X73-FINDINGS.md` X73 step 1                                                                  | Hand-over overshoot, peak/samples over bound (20 ms sampling): Node `4/1 5/1 4/1 4/1 4/1 3/0`, Bun `3/0 4/1 5/1 3/0 5/3 3/0`, Deno `3/0 4/1 4/1 4/1 3/0 3/0` at `maxWorkers: 3`; each overshoot 1–3 samples.                                  |
| `IRepository`                   | `packages/database-plugin/src/interfaces/index.ts:73-171`                                               | `findById`, `findAll`, `findOne`, `create`, `update`, `delete`, `updateWhere?`, `deleteWhere?`, `exists`, `count`, `findPage`.                                                                                                                |
| `FindOptions` / `Page`          | `packages/database-plugin/src/query/find-options.ts:29-110`                                             | `where`, `filter`, `orderBy`, `limit`, `offset`, `select`, `cursor` (offset+cursor refused); `PageOptions = FindOptions`; `Page { rows, nextCursor: string \| null }`; `CountOptions { where, filter }`.                                      |
| `WritePrecondition`             | `packages/common/src/services/write-precondition.ts:16`                                                 | `Readonly<Record<string, string \| number>>`.                                                                                                                                                                                                 |
| audit row                       | `packages/audit-plugin/src/storage/audit-record.ts:95-108`                                              | Columns `id, timestamp, action, resource, resource_id, user_id, result, before, after, metadata`; the last three JSON strings or `null`.                                                                                                      |
| audit read path                 | `packages/audit-plugin/src/storage/database-audit.ts:27,51`; `interfaces/index.ts:119-122`              | Storage classes are exported with `query(criteria?)`; `IAuditDbClient` is `insert` + `select`; `IAuditLogger` has no read. README `:62` already says write-only.                                                                              |
| `/ready` selection              | `packages/health-plugin/src/services/health-service.ts:236-300`                                         | `checkReady` runs every indicator except `self`, concurrently, each under the per-indicator deadline; timeout → `down`/`timeout`, throw → `down`/`error`, invalid result → `down`/`invalid-result`.                                           |
| openapi `exclude`               | `packages/openapi-plugin/src/generators/openapi-generator.ts:278-296,368,511`                           | A `ReadonlySet` built at construction; exact match on the resolved pattern.                                                                                                                                                                   |
| `RouteSchema` OpenAPI fields    | `packages/common/src/http.ts:468-471`                                                                   | `tags`, `summary` — no `operationId`.                                                                                                                                                                                                         |
| `ITenantRepository`             | `packages/common/src/services/tenancy.ts:30-42`                                                         | `findAll()`, `findById`, `find(filter)`, `create`, `update`, `delete` — no paging, ordering or expression filter.                                                                                                                             |
| `loadConfig` / `instance`       | `packages/config-plugin/src/index.ts:20`; `services/load-config.ts:61`; `options.ts:104`                | `loadConfig(runtime, options)` loads once; `ConfigPlugin({ instance })` registers that snapshot verbatim.                                                                                                                                     |
| kernel options sentence         | `packages/kernel/README.md:106`                                                                         | "takes one option" while `:41-77` documents `diagnostics`.                                                                                                                                                                                    |
| `ITotpStore`                    | `packages/auth-plugin/src/stores/totp-store.ts:60-134`                                                  | `getEnrolment`, `stageSecret`, `confirmSecret`, `deleteEnrolment`, `claimStep`, `reserveAttempt`, `clearAttempts`, `saveRecoveryCodes` (`:144`), `consumeRecoveryCode` (named in README `:810-812`). README states atomicity in one sentence. |
| S3 / GCS / Azure loaders        | `packages/storage-plugin/src/providers/s3-provider.ts:254-262`; `package.json` peers                    | S3 loads `@aws-sdk/client-s3` then `@aws-sdk/s3-request-presigner`, each failure an `OptionalDependencyUnavailableError` (M113d); peers `@google-cloud/storage@^7`, `@azure/storage-blob@^12`.                                                |
| telemetry peers                 | `packages/telemetry-plugin/package.json`; `tracing/tracer.ts:439-456`; `exporters/*.ts`                 | Ten optional peers; missing SDK packages throw `OptionalDependencyUnavailableError`. What `register()` then does on Node is NOT established here — measured in §3.1.                                                                          |
| idempotency purge               | `packages/idempotency-plugin/src/within/transactional-runtime.ts:210-218`; `interfaces/index.ts:96-124` | `purge.schedule` defaults `true`; without `CAPABILITIES.SCHEDULER` `onInit` throws `IdempotencyConfigurationError`. `schedule: false` means a manual `purgeTransactional()`.                                                                  |
| `IRequest` body                 | `packages/common/src/http.ts:128,134`                                                                   | `text()`, `bytes()` exist.                                                                                                                                                                                                                    |
| ungated READMEs                 | `test/package-readme-fence-compiler.test.ts:189-192`                                                    | database, openapi and secrets READMEs are on the `UNGATED` list: their fences are NOT compiled by any gate.                                                                                                                                   |
| tenant middleware priority      | `packages/multi-tenancy-plugin/src/interfaces/index.ts:151-152`                                         | `middlewarePriority` (default `40`); passive auth runs at 300 (`auth-plugin.ts:92`).                                                                                                                                                          |
| `ITenantResolver`               | `packages/common/src/services/tenancy.ts:118-126`                                                       | `resolve(request: IRequest): Promise<Option<ITenant>>` — reads `request.user` once auth has run.                                                                                                                                              |
| `errorHandler` position         | `packages/exceptions/src/middleware/error-handler.ts:7`                                                 | Registered as the outermost middleware (lowest priority number), so a throw from inside priority 45 reaches it after the locale middleware has unwound.                                                                                       |
| `createRuntimeServices`         | `packages/runtime/src/index.ts:23`                                                                      | Exported.                                                                                                                                                                                                                                     |
| `purgeTransactional`            | `packages/idempotency-plugin/src/service/*.ts:100`                                                      | Exists; throws without the `transactional` option.                                                                                                                                                                                            |
| deployment guide                | `docs/deployment.md:441-540`                                                                            | The scaffolded-project section describes the workspace and the Deno image.                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                 | Resolution (picked side)                                                                                                                                     | Doc deliverable (same PR)                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| C1  | V9-7 says CLI-generated 0.8.0 projects pin exact `@0.8.0`; the 0.8.0 CLI source emits `^0.8.0` everywhere (§1).          | Source wins: the register's premise is wrong for CLI output. The guide is still reworded to match any range, since hand-pinned projects exist (X26's suite). | `docs/upgrading.md` Deno step; plan §3.2 records the finding. |
| C2  | Localization README `:141-142` "an error response gets none" vs the catalogue route's `404` carrying `Content-Language`. | Code wins (it is the right behaviour: the refusal is a localized response).                                                                                  | Localization README, `PUBLIC_API.md` if it repeats the claim. |
| C3  | Kernel README `:106` "takes one option" vs `diagnostics` documented `:41-77`.                                            | Code wins: two options.                                                                                                                                      | Kernel README options table.                                  |
| C4  | getting-started's "Optional" comment on `envFilePath` vs the plugin throwing on a missing file.                          | Code wins.                                                                                                                                                   | `docs/getting-started.md`.                                    |

## 3. Design decisions

Every factual sentence below about runtime behaviour is cited in §1, or else it is **measured** by
the implementer and the command recorded in §12. Every third-party name (npm package, CLI flag, env
var) must be checked against `node_modules/.pnpm/<pkg>/**/*.d.ts`, the package's `package.json`, or
a real run — never written from memory.

### 3.1 V9-6 — telemetry peers

- **Decision:** replace "lazily imported via bare specifiers" with an **Installation** table: one
  row per feature (`exporter: 'console'`, `exporter: 'otlp'`, `contextPropagation`, each
  `instrumentations` key — `fetch` loads `@opentelemetry/instrumentation-undici`) naming the exact
  peer packages that feature loads, read from the loaders in `src/`, plus one `npm install` line for
  the common OTLP setup. State the failure mode from source: a missing
  `@opentelemetry/sdk-trace-base`, `resources` or `api` makes `register()` throw
  `OptionalDependencyUnavailableError` (`tracing/tracer.ts:436-456`), so `app.start()` rejects
  naming the package — it does NOT degrade to noop. Confirm once on Node by starting an app with
  `exporter: 'console'` in a throwaway directory without the peers, and quote the message. A missing
  instrumentation package stays a logged no-op (README already says so; confirm from source).
- **Why:** the reader is never told to install anything; the failure mode was never driven.
- **Test home:** `packages/telemetry-plugin/test/integration/missing-peers.test.ts`, only if no test
  already asserts it: inject `tracerProviderFactory` (`telemetry-plugin.ts:236-237`) rejecting with
  `OptionalDependencyUnavailableError('@opentelemetry/sdk-trace-base')` and assert `app.start()`
  rejects with it. The test proves propagation through `register()`, not the import itself — say so
  in its comment.

### 3.2 V9-7 — upgrade guide 0.9.0

- **Decision:** Deno step: "Replace each `jsr:@setu-ts/<pkg>@…` import, whatever its range, with
  `npm:@setu-ts/<pkg>@^0.9.0`", and give a search pattern that matches both `@^0.8.0` and `@0.8.0`.
  Workers bullet (`:861-865`): name the exact pins a fresh 0.9.0 scaffold writes —
  `"wrangler": "~4.148.0"` and `"@cloudflare/workers-types": "^5.20261006.1"` — and the ERESOLVE
  symptom. Keep both inside the existing `version:history` blocks.
- **Why:** C1; the Workers step is unfollowable without the versions.
- **Test home:** none new; `check:docs` (version gates) covers the section.

### 3.3 V9-10 — getting-started

- **Decision:** the Config snippet passes `envFileOptional: true` and its comment says what it does
  (a missing file is skipped; a file that exists but is unreadable still throws). Apply the same to
  `docs/migration-nestjs.md:497,529`, which repeats `envFilePath: '.env'`. "Testing Your
  Application" gets three runtime sub-sections with one shared test body, matching the harness the
  CLI generates (`schematics/test-harness.ts:49,59`): **Node**
  (`npm install -D @setu-ts/testing tsx`, `node:test` + `import assert from 'node:assert'`, run with
  `npx tsx --test test/app.test.ts`), **Bun** (`bun add -d @setu-ts/testing`, `bun:test`,
  `bun test`), **Deno** (existing). Each run command is executed once by the implementer against a
  throwaway project and recorded in §12.
- **Fence infrastructure:** the snippet tsconfig (`test/fixtures/snippets/tsconfig.json`) has
  `types: ["node","deno"]` and no `bun:test` declarations, and `fence-engine.ts:30` refuses to mark
  an `@setu-ts/`-importing fence external. Add a minimal `bun:test` declaration shim beside the
  existing `@std/*` shims (`describe`, `it`, `expect` with the matchers the fence uses) and its
  `paths` entry, so the Bun fence compiles.
- **Why:** the guide's first test only works on one of three runtimes (C4 for the comment).
- **Test home:** `test/guide-fence-compiler.test.ts` — `docs/getting-started.md`'s expected
  inventory and the corpus total.

### 3.4 V9-24 — localization `Content-Language`

- **Decision:** rewrite README `:141-142`: the middleware writes `Content-Language` after `next()`
  resolves, so a refusal written without throwing _inside_ priority 45 — a guard's `401`/`403`, a
  route middleware calling `respondWithError`, the catalogue route's `404` — carries the request's
  locale; a thrown error carries none provided `errorHandler` is registered outside priority 45, as
  its own docs instruct (`error-handler.ts:7` — an instruction, not enforced); a refusal written
  before priority 45 (the required-tenant rejection at 40) also carries none. Check
  `docs/localization.md` for repeats. `PUBLIC_API.md:15365` is already correct — no change there.
- **Why:** C2.
- **Test home:** the thrown half is pinned at
  `localization-plugin/test/integration/headers.test.ts:94` (cite it). Add the non-throwing half to
  that file: a route middleware calling `respondWithError` answers with
  `Content-Language: <locale>`.

### 3.5 V9-29 — worker-pool thread overshoot

- **Decision:** add to the sizing paragraph: at a hand-over the terminated thread and its
  replacement are briefly alive together, so OS threads can briefly exceed `maxWorkers` by 1–2 for
  20–60 ms on Node, Bun and Deno (not at every hand-over — some sampled runs showed none) (X73's
  figures, cited as measured on 0.9.0 with 20 ms sampling). Keep the Deno-timeout paragraph; replace
  "Node and Bun were not measured" with the precise scope: the timed-out-CPU-bound-thread
  measurement was taken on Deno only.
- **Why:** a reader sizing for memory needs the overshoot.
- **Test home:** none (measurement prose, sourced).

### 3.6 V9-51 — database repository surface

- **Decision:** a new `## The repository surface` section near Usage: a method table (signature,
  return, the not-found / refusal behaviour per method, `@since`), `FindOptions`/`PageOptions`/
  `CountOptions` field tables, `Page`, `WritePrecondition`, and a short `findPage` loop and
  `updateWhere` example (both compiling). Every refusal named must be one `BaseRepository` or the
  adapters actually throw, cited by file:line in §12. Cross-link the existing per-backend "cannot
  do" tables instead of repeating them.
- **Why:** the most-used surface is documented only in typings.
- **Test home:** the database README is UNGATED (§1), and promoting it would require every existing
  fence in a 1,500-line README to compile — out of scope (§9). So each NEW fence is type-checked
  once by the implementer: copy it into a scratch file under the worktree's `.tmp/`, run
  `tsc --noEmit` against the workspace, record the command and exit status in §12, delete the
  scratch file. The same applies to every new fence in the openapi and secrets READMEs. Use
  `tsc --noEmit -p` over a scratch tsconfig extending `test/fixtures/snippets/tsconfig.json`, which
  carries the workspace `paths`.

### 3.7 V9-52 — audit row shape and read path

- **Decision:** add the `DatabaseAuditStorage` column table with a PostgreSQL DDL example and the
  `table` default `'audit_logs'`. Types follow `fromAuditRow` (`audit-record.ts:130-150`):
  `before`/`after`/`metadata` must be **`text`** — a `jsonb` column comes back as an object and
  reads as `undefined`; `timestamp` is epoch milliseconds, so **`bigint`**. Add
  `## Reading the trail`: `IAuditLogger` has no read; an owner constructs the exported storage class
  over the same client and table and calls `query(criteria)`. State from `database-audit.ts:51-79`
  exactly what it does: only equality fields reach `select`, `from`/`to` are filtered in memory over
  every matched row, there is no offset or paging, and `limit` keeps the newest N in ascending
  order. For a large trail, query the table directly. A compiling fence.
- **Why:** an owner-facing trail needs a reader nothing documents.
- **Test home:** fence compiler count; plus one test writing through the plugin over a recording
  fake `IAuditDbClient` and reading back through `DatabaseAuditStorage.query()` — unless an existing
  test already does this round trip (cite it).

### 3.8 V9-53 — `/ready`

- **Decision:** extend "What `degraded` means" with a precise list: `/ready` runs every registered
  indicator except `self`, concurrently, each bounded by `indicatorTimeoutMs`; a timeout, a throw or
  an invalid result counts as `down`; 200 only when every one is `up`; with no indicator but `self`,
  it answers 200 (measure). `/live` runs only `self`.
- **Test home:** none new if `health-service` tests already assert the `self` exclusion (cite);
  otherwise one unit test.

### 3.9 V9-54 — openapi

- **Decision:** state: `exclude` is an exact match on the resolved pattern, read once when the
  plugin is constructed; there is no prefix or glob form (exclude a group by `excludeOwners` or by
  listing paths). The operation id is always derived — `GET /api/v1/invoices` becomes
  `get-api-v1-invoices`, and the SDK names it `getApiV1Invoices` (measure with the real generator
  and quote it). Programmatic routes have no `operationId` field (`RouteSchema` carries
  `tags`/`summary` only), and the decorator `@ApiOperation({ operationId })` is accepted but
  **ignored**: `decorator-plugin` stores it (`decorators/openapi.ts:71-72`) but never copies it into
  the route schema. Document that in the openapi README, the decorator-plugin README's
  `@ApiOperation` entry and `PUBLIC_API.md:13332`; the dead option itself is a `src` fix recorded in
  §9.
- **Test home:** none new (cite the existing operation-id tests).

### 3.10 V9-55 — formatter limits

- **Decision:** add to `## Formatting`: numbers use `Intl.NumberFormat(locale)` defaults and dates
  `Intl.DateTimeFormat(locale)` defaults plus the configured `timeZone`; there is no currency,
  percent, `dateStyle` or per-placeholder option — format such a value with `Intl` yourself and pass
  the string. One compiling fence.

### 3.11 V9-56 — multi-tenancy

- **Decision:** a `## Tenant from the signed-in principal` section with a compiling fence: a custom
  `ITenantResolver` whose `resolve(request)` reads `request.user`, registered with
  `middlewarePriority` above 300 so it runs after passive authentication; link the session README's
  tenant-binding paragraph (`session-plugin/README.md:183-190`). State the cost: everything between
  40 and that priority that reads `request.tenant` sees none — localization's `tenantLocale` at 45
  (`localization-plugin.ts:31`) and any cache, rate-limit or feature-flag read in that band. A
  sentence after the `ITenantRepository` description: no paging, ordering or expression filter; use
  `IDatabaseService` repositories with the tenant column for those. Drive the recipe once through a
  real kernel app (auth + tenancy) and record it in §12.

### 3.12 V9-57 + V9-58 — construction-time configuration, kernel options

- **Decision:** config README `## Configuration a plugin needs at construction`: a plugin option is
  read when the factory is called, before `ConfigPlugin` loads `.env`; use
  `loadConfig(createRuntimeServices(), { envFilePath, envFileOptional })`, read the values, pass
  them to the factories, then `ConfigPlugin({ instance })`. A compiling fence. Kernel README:
  options table gains `diagnostics` and the sentence says two options, linking the config section.

### 3.13 V9-59 — `ITotpStore`

- **Decision:** a per-method table in the auth README covering all nine methods (including
  `saveRecoveryCodes`, `totp-store.ts:144`): method, what it must do atomically, the return contract
  (when `true`/`false`), and the race it closes. Content read from `totp-store.ts` JSDoc and
  `MemoryTotpStore`; no invented semantics.

### 3.14 V9-69 — backup and restore

- **Decision:** a `## Backup and restore` section in `docs/deployment.md`: which framework state
  lives in the database (application tables, the migration ledger, outbox/inbox/idempotency/audit
  tables where configured) versus elsewhere (sessions and caches in Redis, broker queues); that the
  framework ships no backup tool and the database's own tools apply; after a restore, `/ready`
  reports a missing migration only when `DatabasePlugin({ readiness: { migrations } })` is set
  (M113o). Qualified consequences: restored outbox rows republish at least once and are
  de-duplicated only by consumers that use the inbox and whose markers survived the same restore;
  tier-C idempotency records written after the backup are lost, so a client or provider re-send can
  re-run that work. Every claim cites the owning README section.

### 3.15 V9-72 — storage peers

- **Decision:** an Installation table per provider: `'s3'`/`'b2'` → `@aws-sdk/client-s3` **and**
  `@aws-sdk/s3-request-presigner`; `'gcs'` → `@google-cloud/storage`; `'azure'` →
  `@azure/storage-blob`; memory/local → none. State that a missing one fails startup with
  `OptionalDependencyUnavailableError` naming the package (confirm by running with only `client-s3`
  installed on Node, and quote the message).

### 3.16 V9-73 — idempotency tier-C example

- **Decision:** the README example registers `SchedulerPlugin()` beside it, and a sentence names the
  alternative `purge: { schedule: false }` with a manual `purgeTransactional()` — mandatory on
  Workers, where `SchedulerPlugin` throws (`scheduler-plugin.ts:157`); call it from a Cron Trigger.
- **Test home:** fence compiler count; one integration test booting the README composition minus the
  scheduler (expect `IdempotencyConfigurationError`) and with it (boots) — unless one exists.

### 3.17 V9-74 — inbound webhooks

- **Decision:** a new guide `docs/webhooks.md`, linked from `docs/README.md`, added to `GUIDES` in
  `test/fixtures/snippets/fence-engine.ts:83-97` and to `EXPECTED_INVENTORY` and the corpus total in
  `test/guide-fence-compiler.test.ts`. Content:
  1. **Verify before any work**: HMAC over the **raw bytes** (`ctx.request.bytes()` before any JSON
     parse or validation middleware) with `crypto.subtle.verify` (constant time), plus a **timestamp
     tolerance** (the provider's signed timestamp within a window, e.g. 5 minutes), so a captured
     request cannot be replayed after the idempotency record expires. Never log the secret or the
     signature.
  2. **De-duplicate with tier C** (`within`) keyed on the provider's event id. `scope` is required
     and normally authenticated identity (`common/src/services/idempotency.ts:353-372`); a webhook
     has none, so use a fixed per-provider string (e.g. `'webhook:stripe'`) and say why. `key` must
     be 1–255 chars of 0x21–0x7E without `"`; refuse an event id outside that before calling
     `within`. A concurrent duplicate can reject with a retryable `409` before the winner commits
     (`:427-428`) — a non-2xx, so the provider retries, which is correct. Say why tier C rather than
     tier B: `idempotent()` answers a concurrent pair `[200, 409]` and does not commit with the
     business write.
  3. **Side effects, two arms.** (a) An integration event: `outbox.write(uow, …)` inside `within`'s
     `fn`, which receives the unit of work (`database-idempotency-store.ts:187-193`) — valid only
     when the idempotency and outbox stores are on the same database. (b) A queue job: the M107
     outbox does not target `IQueue`, so enqueue **after** commit, on every accepted delivery
     including a replay, and make the job itself idempotent (guard it with `idempotentIngress`, read
     from source).
  4. Answer `2xx` quickly; heavy work goes to (3).

  Every API named must exist, with signatures read from source.

- **Why:** X40 had to derive all of this (`smoke/v0.9.0/x39-x44/x40/FINDINGS.md`).
- **Test home:** `test/webhooks-guide.test.ts` (root tests import `@setu-ts/*`, as
  `worker-startup-behavior.test.ts` does): a valid signature is handled once, a duplicate is
  de-duplicated, a bad or stale signature is refused before any write.

### 3.18 V9-77 — secrets and `.env`

- **Decision:** secrets README: `EnvProvider` reads the process environment through the runtime
  (state its name-to-key mapping — prefix and `toEnvKey` — from `providers/env-provider.ts`), and
  `ConfigPlugin`'s `.env` loads into the config store only, so a secret in `.env` is not visible to
  it. Remedies, each **measured**: Node — `--env-file`/`--env-file-if-exists` passed through `tsx`;
  Deno — `--env-file`; Bun — loads `.env` into the process environment itself (confirm). On Workers
  `EnvProvider` sees only the `vars` passed into the runtime
  (`runtime/src/adapters/workers/cf-runtime.ts:52,72`) — say how secrets reach it, read from that
  source, rather than implying `wrangler secret put` alone suffices.

### 3.19 V9-78 — deployment guide

- **Decision:** the scaffolded-project section covers the Node image a workspace generates by
  default (describe it from `packages/cli/src/workspace/compose.ts`, the only Dockerfile source),
  keeps the Deno subsection, and adds "A standalone project": `setu new` without `--workspace` emits
  no Dockerfile, Compose file or manifest; point to `setu new --workspace` / `setu adopt`, or to the
  repository's `docker/Dockerfile` pattern as a starting point.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none.

| Exported symbol | Kind | Consumer / real code path that READS it                                      |
| --------------- | ---- | ---------------------------------------------------------------------------- |
| None (checked)  | —    | Docs letter: no `src/index.ts` changes; §7 asserts no `packages/*/src` diff. |

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation) |
| -------------- | -------- | ----------------------------- |
| None (checked) | —        | No option added or changed.   |

## 5. Implementation files

| File                                                                                                               | Purpose                                 |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `packages/telemetry-plugin/README.md`                                                                              | §3.1                                    |
| `docs/upgrading.md`                                                                                                | §3.2                                    |
| `docs/getting-started.md`, `docs/migration-nestjs.md`, `test/fixtures/snippets/` (`bun:test` shim + tsconfig path) | §3.3                                    |
| `packages/localization-plugin/README.md`                                                                           | §3.4, §3.10                             |
| `packages/worker-pool-plugin/README.md`                                                                            | §3.5                                    |
| `packages/database-plugin/README.md`                                                                               | §3.6                                    |
| `packages/audit-plugin/README.md`                                                                                  | §3.7                                    |
| `packages/health-plugin/README.md`                                                                                 | §3.8                                    |
| `packages/openapi-plugin/README.md`, `packages/decorator-plugin/README.md`                                         | §3.9                                    |
| `packages/multi-tenancy-plugin/README.md`                                                                          | §3.11                                   |
| `packages/config-plugin/README.md`, `packages/kernel/README.md`                                                    | §3.12                                   |
| `packages/auth-plugin/README.md`                                                                                   | §3.13                                   |
| `docs/deployment.md`                                                                                               | §3.14, §3.19                            |
| `packages/storage-plugin/README.md`                                                                                | §3.15                                   |
| `packages/idempotency-plugin/README.md`                                                                            | §3.16                                   |
| `docs/webhooks.md` (new), `docs/README.md`, `test/fixtures/snippets/fence-engine.ts` (`GUIDES`)                    | §3.17                                   |
| `packages/secrets-plugin/README.md`                                                                                | §3.18                                   |
| `PUBLIC_API.md`                                                                                                    | any section repeating a corrected claim |
| `CHANGELOG.md` (`Unreleased` → `### Fixed`)                                                                        | one entry                               |
| `ROADMAP.md` (113l row + section), `CLAUDE.md`                                                                     | status flip                             |

No `src/` file.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No `src/` file changes, so the per-file bar is unchanged. Tests added (each only if no existing test
already asserts the behaviour — cite it in §12 instead):

| Test file                                                                         | Covers     | Key assertions                                                                     |
| --------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| `packages/telemetry-plugin/test/integration/missing-peers.test.ts`                | §3.1       | documented outcome when an SDK peer is absent                                      |
| `packages/localization-plugin/test/integration/headers.test.ts` (extended)        | §3.4       | responder refusal inside 45: header present (thrown half already at `:94`)         |
| `packages/audit-plugin/test/integration/read-trail.test.ts`                       | §3.7       | written entry read back through `DatabaseAuditStorage.query()`                     |
| `packages/idempotency-plugin/test/integration/readme-tier-c.test.ts`              | §3.16      | without scheduler: `IdempotencyConfigurationError`; with: starts                   |
| `test/webhooks-guide.test.ts`                                                     | §3.17      | valid signature handled once, duplicate de-duplicated, bad/stale signature refused |
| `test/guide-fence-compiler.test.ts`, `test/package-readme-fence-compiler.test.ts` | all fences | counts updated; every new fence compiles                                           |

## 7. Verification gates

```bash
git branch --show-current     # docs/m113l-documentation-gaps
pnpm run check:plan
git diff --name-only origin/develop...HEAD -- 'packages/*/src'   # MUST be empty
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling
pnpm test:coverage telemetry-plugin localization-plugin audit-plugin idempotency-plugin --no-tooling
```

## 8. Risks & mitigations

- An implementer writes a third-party flag or package name from memory (opencode did, M113g) → §3
  requires every such name checked against installed typings or a run, recorded in §12.
- A corrected sentence states behaviour the code does not have → each behavioural claim is cited
  (§1), or else measured and recorded; review re-reads every new sentence against source.
- A `version:history` marker shields live guidance (the v0.3.0 lesson) → the V9-7 edits stay inside
  the 0.9.0 history block; nothing live is added under a marker.
- Fence counts drift → the two fence-compiler tests fail loudly; update counts in the same commit.

## 9. Out of scope

- The scaffold's generated README/`.env.example` telling the reader that `.env` is config-only
  (V9-77's `cli` half) — a `packages/cli/src` change; unowned, recorded for a `fix/…` branch.
- `@ApiOperation({ operationId })` is stored and never read (found in plan review) — a
  `decorator-plugin` `src` fix; recorded for a `fix/…` branch, documented as ignored here.
- Making `EnvProvider` read `ConfigPlugin`'s store — a behaviour change; not proposed.
- An `operationId` override on `RouteSchema` or a prefix form of `exclude` (V9-54) — features, not
  documentation; unowned.
- Closing `smoke/DEFECTS.md` rows — after a published re-run.
- Promoting the database, openapi or secrets README from `UNGATED` to the gated fence set — every
  existing fence would have to compile; unowned.

## 10. Design security review

Docs letter; two deliverables give security guidance and are reviewed for correctness in code
review: the webhook guide (§3.17 — signature over raw bytes, constant-time verify, refuse before any
work, no secret in logs) and the secrets `.env` note (§3.18 — never recommend committing `.env`;
`.dev.vars` stays gitignored). No committed-tree security audit is required: no trust boundary moves
in code.

## 11. Plan review

One round, fresh-context Claude agent, 2026-10-22, before implementation: 17 findings, all folded
in. Majors: the webhook guide's side-effect rule contradicted X40 (the outbox does not target
`IQueue`); `within`'s required `scope`, key grammar and concurrent `409` were unspecified, and the
signature rule lacked a replay window; `@ApiOperation({ operationId })` is a dead option the docs
must name; the audit DDL needs `text`/`bigint` (a `jsonb` column reads back as `undefined`) and
`query()`'s in-memory filtering must be stated; the Bun fence could not compile without a `bun:test`
shim; and resolving the tenant above 300 hides it from everything in 40–300. Minors:
`Content-Language` scoping and the existing `headers.test.ts:94`, `saveRecoveryCodes`, the Workers
case for tier-C purge and for `EnvProvider`, restore qualifications, `GUIDES` registration,
`compose.ts` as the Dockerfile source, the telemetry test's seam, X73's "can briefly", the
`migration-nestjs.md` repeat, and the scratch tsconfig.

## 12. Implementation notes

Measurement commands and outcomes for every §3 "measure" item, and citations for every "skip if an
existing test asserts it", are recorded here by the implementer.
