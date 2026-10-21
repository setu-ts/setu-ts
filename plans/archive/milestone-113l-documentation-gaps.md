# Milestone 113l — Documentation That Does Not Match the Code, or Is Missing (docs)

> **Status:** Implemented and verified; PR pending. Branch: `docs/m113l-documentation-gaps` (a
> **docs** letter — ROADMAP "Milestone 113" table — so one `docs/…` branch, not `feat/…`). `develop`
> and `main` are protected; all work stays on this one branch until it merges via a single PR.

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

The real-scheduler integration test also requires the generated test dependency in
`packages/idempotency-plugin/package.json` and its importer entry in `pnpm-lock.yaml`. These are
test-only bookkeeping; no runtime dependency is added.

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

### Source checks and tests, by row

All source paths below were read in this worktree. No package source was edited. The docs describe
the implementation, including limits; they do not repair the out-of-scope source defects in §9.

| Row   | Source / evidence checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Test added or existing assertion cited                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V9-6  | `packages/telemetry-plugin/src/tracing/tracer.ts:436-489`, `src/exporters/console-exporter.ts`, `src/exporters/otlp-exporter.ts`, `src/instrumentation/instrumentation-registry.ts:156-177`, `src/tracing/context-manager.ts`; all ten optional peers checked in the package's `package.json`. Node absent-peer measurement below.                                                                                                                                                                                                          | Added `packages/telemetry-plugin/test/integration/missing-peers.test.ts`: the injected loader error propagates unchanged through registration/start. It does not pretend to test real import resolution. Existing `packages/telemetry-plugin/test/unit/instrumentation-registry.test.ts:183-215` pins no-throw instrumentation loader failures.                  |
| V9-7  | `git show v0.8.0:packages/cli/src/templates/project-files.ts` emits caret pins. Current `projectFiles()` run below emits the exact Workers pair. Both edits remain inside the 0.9.0 history block.                                                                                                                                                                                                                                                                                                                                          | Existing `packages/cli/test/e2e/workers-install-e2e.test.ts:58-104` exercises the generated manifest's registry resolution; docs/version gate checks historical text. Not rerun as an extra suite here.                                                                                                                                                          |
| V9-10 | `packages/config-plugin/src/services/env-loader.ts` and `src/services/load-config.ts:79-99` distinguish absent from unreadable paths. `packages/cli/src/schematics/test-harness.ts:49-65` supplies the runner imports. All three runner commands measured below. The NestJS comparison retains its own `ConfigModule` API; `envFileOptional` is added only to the Setu-TS example.                                                                                                                                                          | Guide compiler inventory updated (+2 TypeScript, +4 shell fences). Added compile-only `bun:test` shim matching the existing std shims. Existing `packages/config-plugin/test/unit/load-config.test.ts:233-260` pins absent-file skipping and unreadable-file rejection; retained without a redundant test.                                                       |
| V9-24 | `packages/localization-plugin/src/middleware/locale-middleware.ts:111-128`, `src/routes/catalogue-route.ts:139-143`, `packages/exceptions/src/middleware/error-handler.ts:7`. `docs/localization.md` contains no repeated error-header claim; `PUBLIC_API.md` already qualifies it correctly.                                                                                                                                                                                                                                               | Extended `packages/localization-plugin/test/integration/headers.test.ts` with a non-throwing `respondWithError` route refusal and a handler that must never run. Retained the existing thrown-error assertion at `headers.test.ts:113-118` (formerly line 94).                                                                                                   |
| V9-29 | The reviewed plan §1 supplies the X73 0.9.0 measurements: at `maxWorkers: 3`, 20 ms samples, Node peaks/over-bound samples `4/1 5/1 4/1 4/1 4/1 3/0`; Bun `3/0 4/1 5/1 3/0 5/3 3/0`; Deno `3/0 4/1 4/1 4/1 3/0 3/0`. The original smoke scratch file is not tracked in this worktree; the original samples are preserved here. The CPU-bound-timeout measurement remains explicitly Deno-only.                                                                                                                                              | No new test: supplied measurement prose, not a new runtime guarantee.                                                                                                                                                                                                                                                                                            |
| V9-51 | Read every `IRepository` method in `packages/database-plugin/src/interfaces/index.ts:73-171`, options/page in `src/query/find-options.ts:29-110`, delegation/refusals in `src/repositories/base-repository.ts:64-250`, cursor/offset refusal in `src/query/query-builder.ts:84-103`, conditional validation in `packages/common/src/services/write-precondition.ts:95-155`, and missing-update rejection in `src/adapters/memory/memory-adapter.ts:846-859`.                                                                                | Two new ungated fences type-checked with scratch `tsc -p` below; backend limits cross-linked rather than duplicated.                                                                                                                                                                                                                                             |
| V9-52 | `packages/audit-plugin/src/storage/audit-record.ts:95-150` for columns, JSON text, numeric timestamp, sorting/limit; `src/storage/database-audit.ts:36-79` for default table, equality pushdown and in-memory inclusive dates. `src/interfaces/index.ts:119-122` for the client port.                                                                                                                                                                                                                                                       | Added `test/integration/read-trail.test.ts`: plugin write → recording client → separate `DatabaseAuditStorage.query`, including JSON text, timestamp, equality pushdown and immutable readback. README fence count +1.                                                                                                                                           |
| V9-53 | `packages/health-plugin/src/services/health-service.ts:236-300`; real `/ready` measurement below.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Existing `packages/health-plugin/test/unit/health-service.test.ts:218-236` pins self-only liveness, `:263-276` self exclusion, `:315-325` empty readiness, `:488-558` concurrent/deadline aggregation, `:408-454` invalid-result failure. No redundant test added.                                                                                               |
| V9-54 | `packages/openapi-plugin/src/generators/openapi-generator.ts:524-525,793-794`: exact exclusion snapshot; `packages/common/src/http.ts:468-471`: no route override. `packages/decorator-plugin/src/decorators/openapi.ts:71-72` stores the dead option; `src/plugin/decorator-plugin.ts:606-628` never copies it to schema. Real generator/SDK measurement below.                                                                                                                                                                            | Existing `packages/openapi-plugin/test/unit/openapi-generator.test.ts:76-99` pins derived operation ids, `:713-735` excludes registered router patterns. `packages/sdk/test/unit/openapi-codegen.test.ts:139` pins identifier conversion. No new OpenAPI fence.                                                                                                  |
| V9-55 | `packages/localization-plugin/src/format/format.ts:97-109`, `src/format/types.ts:31-38`: only locale defaults plus timeZone, no per-placeholder format options.                                                                                                                                                                                                                                                                                                                                                                             | One new compiling `Intl` preformatting fence; package count +1.                                                                                                                                                                                                                                                                                                  |
| V9-56 | `packages/common/src/services/tenancy.ts:30-42,118-126`, `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts`, auth priority in `packages/auth-plugin/src/plugin/auth-plugin.ts:92`, locale priority in `packages/localization-plugin/src/plugin/localization-plugin.ts:31`. Auth/tenancy app measured below.                                                                                                                                                                                                                | New resolver fence; package count +1. Existing `packages/multi-tenancy-plugin/test/integration/tenant-binding-order.test.ts:89-176` pins late resolution's session-binding check (uses fake auth); real AuthPlugin probe supplies the requested additional measurement.                                                                                          |
| V9-57 | `packages/config-plugin/src/services/load-config.ts:61-99`, `src/plugin/config-plugin.ts`, `src/options.ts:104`: load once, register `instance` verbatim.                                                                                                                                                                                                                                                                                                                                                                                   | New compiling construction-time snapshot fence; count +1.                                                                                                                                                                                                                                                                                                        |
| V9-58 | `packages/kernel/src/application/application.ts:105-117`: plugins and diagnostics are the two factory options.                                                                                                                                                                                                                                                                                                                                                                                                                              | Existing diagnostic fence retained; corrected options table is prose.                                                                                                                                                                                                                                                                                            |
| V9-59 | All nine methods read from `packages/auth-plugin/src/stores/totp-store.ts:60-345`, including `MemoryTotpStore`'s refusal count (`stored count + 1`, not stored) and preservation of claimed steps.                                                                                                                                                                                                                                                                                                                                          | Existing `packages/auth-plugin/test/unit/memory-totp-store.test.ts:20-144,146-211` pins stage/confirm, concurrent claims, lockout and recovery-code consumption. No new semantics or source edits.                                                                                                                                                               |
| V9-69 | Owning README sections linked from deployment guidance: database migration ledger/readiness, messaging transactional outbox/inbox promise and retention, tier-C idempotency guarantee, audit row shape, session/cache stores and brokers. `packages/database-plugin/src/migrations/migration-readiness.ts` confirms the opt-in ledger check.                                                                                                                                                                                                | Documentation guidance; no new behavior/test.                                                                                                                                                                                                                                                                                                                    |
| V9-72 | All four optional SDK package names checked in `packages/storage-plugin/package.json`; loaders read in `src/providers/{s3,gcs,azure}-provider.ts`. Only-client-s3 startup measured below.                                                                                                                                                                                                                                                                                                                                                   | Existing loaders retained; real Node startup probe names the missing presigner.                                                                                                                                                                                                                                                                                  |
| V9-73 | `packages/idempotency-plugin/src/within/transactional-runtime.ts:210-218`, `src/interfaces/index.ts:96-124`, scheduler's Workers refusal in `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:157`.                                                                                                                                                                                                                                                                                                                                 | Existing `packages/idempotency-plugin/test/integration/within-plugin.test.ts:378-390` covers the refusal with a fake store; added `readme-tier-c.test.ts` exercises the actual database store with/without the real `SchedulerPlugin`.                                                                                                                           |
| V9-74 | Read `packages/common/src/services/idempotency.ts:353-372,421-440`, `packages/database-plugin/src/idempotency/database-idempotency-store.ts:183-193`, `packages/messaging-plugin/src/interfaces/index.ts:1204-1235`, `packages/common/src/services/outbox.ts:175-198`, `packages/idempotency-plugin/src/ingress/{idempotent-ingress,ingress-behavior}.ts`, `packages/common/src/services/queue.ts:131-141` and `packages/queue-plugin/src/interfaces/index.ts:391`. Headers are explicitly an illustrative protocol, not a third-party API. | Added `test/webhooks-guide.test.ts`, compiling and executing the actual first guide fence against real kernel/database/tier-C services: valid raw-byte signature succeeds, replay writes no second business row, bad/stale signatures refuse before `within`, invalid key refuses before `within`. Three guide fences registered in GUIDES and pinned inventory. |
| V9-77 | `packages/secrets-plugin/src/providers/env-provider.ts:21-23,41-48,79-81`; config snapshot loading above; `packages/runtime/src/plugin/runtime-plugin.ts:55-79`, `src/adapters/workers/cf-runtime.ts:52-72` for explicit string bindings. Node/Deno/Bun env measurements below.                                                                                                                                                                                                                                                             | New Workers fence passed one-off scratch type-check (README stays ungated).                                                                                                                                                                                                                                                                                      |
| V9-78 | `packages/cli/src/workspace/compose.ts:78-82,262-320`, `src/workspace/runtime-profile.ts:201-219`; standalone `projectFiles()` output measured below. No production container build claimed.                                                                                                                                                                                                                                                                                                                                                | Existing scaffold implementation retained; generated package manifest/output measured rather than guessing from the repository Dockerfile.                                                                                                                                                                                                                       |

### Measurements (commands and observed outcomes)

All manual measurement material lives under `.tmp/m113l/` and is removed after the gates. Toolchain
readings: `node --version` → `v24.18.0`; `pnpm --version` → `12.11.2`; `bun --version` → `1.4.2`;
`deno --version` → `2.9.6`.

1. **Absent telemetry SDK / S3 presigner on Node.** `node .tmp/m113l/build.mjs` bundled the real
   kernel/runtime/telemetry/storage source into `.tmp/m113l/probe.mjs` with esbuild, leaving
   `@opentelemetry/*` and cloud SDKs external. This removes the source package's development-only
   peer resolution without modifying any source or installed dependency. No OTel peers were in that
   bundle's resolution tree.
   - `node .tmp/m113l/probe.mjs telemetry` →
     `OptionalDependencyUnavailableError: Optional dependency '@opentelemetry/sdk-trace-base' could not be loaded. Install it in the application, or choose an option that does not need it on this runtime.`
   - Linked only `packages/storage-plugin/node_modules/@aws-sdk/client-s3` into the probe's
     `node_modules/@aws-sdk/client-s3` (manifest checked: `@aws-sdk/client-s3` `3.1149.0`);
     `node .tmp/m113l/probe.mjs s3` →
     `OptionalDependencyUnavailableError: Optional dependency '@aws-sdk/s3-request-presigner' could not be loaded. Install it in the application, or choose an option that does not need it on this runtime.`
   - Both commands exited 0 because the probe caught and printed the expected startup rejection; a
     successful startup would set exit 1.
2. **Getting-started runners.** `node .tmp/m113l/setup-measurements.mjs` copied each actual guide
   test fence into its own project. Node/Bun used local ESM bundles of the worktree's
   testing/runtime packages behind normal `@setu-ts/*` package exports; Node's `tsx` executable was
   linked from the installed `tsx` `4.23.15` package. Deno used
   `npm install -D @setu-ts/testing@0.9.0 @setu-ts/runtime@0.9.0` (exit 0, added 4/changed 2
   packages), and std import-map entries `jsr:@std/testing@1.0.17/bdd`, `jsr:@std/expect@1.0.17`
   resolved in the real run.
   - In `runner-node`: `npx tsx --test test/app.test.ts` → tests 1, pass 1, fail 0; exit 0.
   - In `runner-bun`: `bun test` → 1 pass, 0 fail, 2 expect calls; exit 0.
   - In `runner-deno`: `deno test --allow-env` → 1 passed (1 step), 0 failed; exit 0.
   - Initial harness extraction selected an earlier Running Application subsection for Bun/Deno; it
     was corrected to scope extraction to Testing Your Application. Those failures were probe setup
     defects, not successful recipe runs. The results above are from the corrected extraction.
3. **Environment secrets.** `node .tmp/m113l/build-more.mjs` bundled the real `loadConfig`,
   `createRuntimeServices`, and `EnvProvider`. The probe loads `.env` through config and asks for
   `database/password` with prefix `M113L_`; `.env` holds an innocuous sentinel in
   `M113L_DATABASE_PASSWORD`. Only equality booleans are printed. In `.tmp/m113l/env`:
   - `node env.mjs` → `{"config":true,"secret":false}`; exit 0.
   - `node ../../../packages/cli/node_modules/tsx/dist/cli.mjs --env-file=.env env.mjs` →
     `{"config":true,"secret":true}`; exit 0.
   - The same with `--env-file-if-exists=.env` → both true; exit 0.
   - With `--env-file-if-exists=absent.env` → `absent.env not found. Continuing without it.` and
     `{"config":true,"secret":false}`; exit 0.
   - `bun env.mjs` → both true without an env flag; exit 0.
   - `deno run --allow-env --allow-read --env-file=.env env.mjs` → both true; exit 0. The command
     paths invoke the same installed `tsx` CLI that `npx tsx` selects in a project.
4. **Health, tenancy and naming.** `node .tmp/m113l/measure.mjs` (real source bundle, created by
   `build-more.mjs`) → exit 0:
   - RuntimePlugin + HealthPlugin, `GET /ready` → 200,
     `{"status":"up","timestamp":"2026-10-21T20:47:12.590Z","checks":{}}`.
   - AuthPlugin with its `apiKey.validate` callback accepting the probe credential and a resolver
     reading `request.user.claims.tenantId` at 310 → `GET /tenant` 200,
     `{"user":"u1","tenant":"acme"}`. Without the credential → 400 (required tenant missing).
   - Real `OpenApiGenerator.generate` for `GET /api/v1/invoices` → `get-api-v1-invoices`;
     `generateOpenApiClient(spec).includes('getApiV1Invoices')` → true. The initial probe
     incorrectly imported the internal ApiKeyStrategy through the barrel; the final probe used the
     public `apiKey` option. No nonexistent export appears in the documentation.
5. **Generated manifests / standalone output.** `node .tmp/m113l/scaffold-measure.ts` invokes
   `projectFiles('probe', runtime, resolveHost(getTemplate('rest'), runtime))`, writes the resulting
   `package.json` for inspection, and prints its devDependencies. Workers → `wrangler: '~4.148.0'`,
   `@cloudflare/workers-types: '^5.20261006.1'`; Node → `tsx: '^4.20.0'`, `@types/node: '^24.0.0'`.
   Both standalone file lists contain no Dockerfile, compose or k8s path (`deployment files []`).
   Exit 0. Third-party names/pins were checked against these generated manifests, not recalled.
6. **Ungated README type-check.** `node .tmp/m113l/ungated.mjs` extracted only NEW TypeScript fences
   compared with HEAD: database pagination, database conditional update, secrets Workers
   composition. No TypeScript fence was added to OpenAPI.
   `pnpm exec tsc --noEmit -p .tmp/m113l/tsconfig.json` (extends
   `../../test/fixtures/snippets/tsconfig.json`, with those three files) → exit 0, no diagnostics.
   The snippets and config are removed with the scratch projects.

### Verification

**V9-78 source qualification.** The plan's blanket "no Compose file" statement is true of the
default standalone scaffold, not of every configured standalone template. Reading
`packages/cli/src/commands/new.ts:399-448,567-581` found its broker/queue overlay. From
`.tmp/m113l`,
`node --import ../../scripts/lib/source-register.ts ../../packages/cli/src/bin.ts new broker-probe --template microservice --runtime node --broker redis --dry-run`
exited 0 and printed `would create .../broker-probe/docker/compose.yaml`. The first probe with
`--template rest` exited 2 because that template registers no messaging wiring; it named
`--template microservice` as the remedy. The docs now distinguish the default standalone case from
this backing-service Compose exception. This is a documentation qualification, not a source change
or a new deployment feature, so no row needs a source fix.

The first tooling run exposed generated-manifest drift from the new real-scheduler test's import:
three tests failed on that same `packages/idempotency-plugin/package.json` drift (1,367 passed).
`node scripts/node-manifests.ts --write` added only the scheduler workspace devDependency;
`pnpm install --lockfile-only --offline --ignore-scripts` updated only its importer link and
exited 0. `node scripts/node-manifests.ts --check` then exited 0. No package source changed.

The first docs-gate run found four documentation-only findings (historical `@since` labels and
package-page relative links). The introduction-version history is now a separate marked table,
leaving the live method contracts outside the marker; package cross-links use absolute repository
URLs. The full docs gate then passed with 108 Markdown files, zero findings, 1,973 verified tags, 52
packages' changelog coverage, and API JSDoc lint at the existing 237-diagnostic baseline.

Additional third-party surface check: installed TypeScript `lib.es5.d.ts:4473-4474,4525` declares
the `Intl` style/currency/timeZone options, `lib.es2020.intl.d.ts:292` declares `dateStyle`, and
`lib.dom.d.ts:36310` declares `SubtleCrypto.verify`. The env probe was also run with the guide's
additional `--allow-net` grant:
`deno run --allow-env --allow-read --allow-net --env-file=.env env.mjs` → both config and secret
true, exit 0.

Final gates ran sequentially (no two test suites at once):

| Command                                                                                                | Exit | Result                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run check:plan`                                                                                  | 0    | Canonical plan structure passed before archival                                                                             |
| `pnpm run fmt`                                                                                         | 0    | Full repository formatting, including native fixture formatting                                                             |
| `pnpm run fmt:check`                                                                                   | 0    | Formatting passed                                                                                                           |
| `pnpm run lint`                                                                                        | 0    | ESLint passed                                                                                                               |
| `pnpm run check`                                                                                       | 0    | Source and test type checking passed                                                                                        |
| `pnpm run check:docs`                                                                                  | 0    | Full documentation chain passed; final deployment qualification also passed `node scripts/check-docs.ts` with zero findings |
| `pnpm run test:tooling`                                                                                | 0    | 80 files, 1,370 tests passed                                                                                                |
| `pnpm test:coverage telemetry-plugin localization-plugin audit-plugin idempotency-plugin --no-tooling` | 0    | Every per-file branch/function/line threshold passed                                                                        |
| `pnpm exec tsc --noEmit -p .tmp/m113l/tsconfig.json`                                                   | 0    | All three new ungated TypeScript fences passed                                                                              |
| `node scripts/node-manifests.ts --check`                                                               | 0    | 231 generated files agree                                                                                                   |

The branch, unstaged and staged `packages/*/src` name-only diffs are empty. No package source was
edited, so there is no changed-source forbidden-construct grep target; searching the new tests for
`as any`, `@ts-ignore`, `new Function` and `eval(` found none. No options, capability tokens or
public API symbols were added. The webhook transform is exercised with signed raw bytes and rejected
bad/stale signatures; audit writes are read back through the public storage reader. Publish gates
were not run: this is the plan's docs/test-only gate set and the user explicitly requires an
uncommitted tree. No commit, push or PR was made.

Coverage backend guards remain explicit skips, not real-backend proof: telemetry-plugin: 349 passed,
0 skipped; localization-plugin: 155 passed, 0 skipped; audit-plugin: 122 passed, 0 skipped;
idempotency-plugin: 306 passed, 45 skipped. Read the full ANSI-stripped table below: 70 measured
files, minimum branch 90.0%, function 92.85%, line 93.1%. No source file is below 90% in any
required dimension. No stopped rows; V9-78's source-backed default-scaffold qualification is
recorded above. Manual measurement projects, bundles, snippets and logs under `.tmp/m113l/` are
deleted after recording this evidence; the plan is archived only after final formatting and boundary
checks.

| File                                                                      | Branch % | Function % | Line % |
| ------------------------------------------------------------------------- | -------- | ---------- | ------ |
| packages/telemetry-plugin/src/index.ts                                    | 100      | 100        | 100    |
| packages/telemetry-plugin/src/version.ts                                  | 100      | 100        | 100    |
| packages/telemetry-plugin/src/attributes/sanitize-url.ts                  | 100      | 100        | 100    |
| packages/telemetry-plugin/src/diagnostics/diagnostic-span-processor.ts    | 93.75    | 100        | 98.3   |
| packages/telemetry-plugin/src/diagnostics/span-observation-collector.ts   | 95.53    | 100        | 95.96  |
| packages/telemetry-plugin/src/exporters/console-exporter.ts               | 100      | 100        | 100    |
| packages/telemetry-plugin/src/exporters/otlp-exporter.ts                  | 100      | 100        | 100    |
| packages/telemetry-plugin/src/instrumentation/database-instrumentation.ts | 100      | 100        | 100    |
| packages/telemetry-plugin/src/instrumentation/http-instrumentation.ts     | 100      | 100        | 100    |
| packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts | 90       | 100        | 100    |
| packages/telemetry-plugin/src/instrumentation/queue-instrumentation.ts    | 100      | 100        | 100    |
| packages/telemetry-plugin/src/interfaces/index.ts                         | 100      | 100        | 100    |
| packages/telemetry-plugin/src/middleware/telemetry-middleware.ts          | 90       | 100        | 100    |
| packages/telemetry-plugin/src/plugin/telemetry-plugin.ts                  | 96.92    | 100        | 98.59  |
| packages/telemetry-plugin/src/services/span-processor-factory.ts          | 100      | 100        | 100    |
| packages/telemetry-plugin/src/services/telemetry-service.ts               | 95       | 100        | 100    |
| packages/telemetry-plugin/src/tracing/context-manager.ts                  | 100      | 100        | 100    |
| packages/telemetry-plugin/src/tracing/trace-flags.ts                      | 100      | 100        | 100    |
| packages/telemetry-plugin/src/tracing/tracer.ts                           | 98.76    | 100        | 97.14  |
| packages/localization-plugin/src/errors.ts                                | 100      | 100        | 100    |
| packages/localization-plugin/src/index.ts                                 | 100      | 100        | 100    |
| packages/localization-plugin/src/version.ts                               | 100      | 100        | 100    |
| packages/localization-plugin/src/catalogue/validate.ts                    | 100      | 100        | 100    |
| packages/localization-plugin/src/format/format.ts                         | 100      | 100        | 100    |
| packages/localization-plugin/src/format/index.ts                          | 100      | 100        | 100    |
| packages/localization-plugin/src/format/negotiate.ts                      | 100      | 100        | 100    |
| packages/localization-plugin/src/format/types.ts                          | 100      | 100        | 100    |
| packages/localization-plugin/src/interfaces/index.ts                      | 100      | 100        | 100    |
| packages/localization-plugin/src/middleware/locale-middleware.ts          | 100      | 100        | 100    |
| packages/localization-plugin/src/plugin/localization-plugin.ts            | 100      | 100        | 100    |
| packages/localization-plugin/src/routes/catalogue-route.ts                | 100      | 100        | 100    |
| packages/localization-plugin/src/service/localizer.ts                     | 100      | 100        | 100    |
| packages/audit-plugin/src/index.ts                                        | 100      | 100        | 100    |
| packages/audit-plugin/src/version.ts                                      | 100      | 100        | 100    |
| packages/audit-plugin/src/interfaces/index.ts                             | 100      | 100        | 100    |
| packages/audit-plugin/src/plugin/audit-plugin.ts                          | 92.3     | 100        | 96.36  |
| packages/audit-plugin/src/services/audit-service.ts                       | 100      | 100        | 100    |
| packages/audit-plugin/src/storage/audit-record.ts                         | 97.56    | 100        | 94.87  |
| packages/audit-plugin/src/storage/database-audit.ts                       | 100      | 100        | 100    |
| packages/audit-plugin/src/storage/file-audit.ts                           | 95       | 100        | 96.07  |
| packages/audit-plugin/src/storage/log-audit.ts                            | 100      | 100        | 100    |
| packages/audit-plugin/src/storage/memory-audit.ts                         | 100      | 100        | 100    |
| packages/idempotency-plugin/src/constants.ts                              | 100      | 100        | 100    |
| packages/idempotency-plugin/src/errors.ts                                 | 100      | 100        | 100    |
| packages/idempotency-plugin/src/index.ts                                  | 100      | 100        | 100    |
| packages/idempotency-plugin/src/version.ts                                | 100      | 100        | 100    |
| packages/idempotency-plugin/src/core/error-kind.ts                        | 100      | 100        | 100    |
| packages/idempotency-plugin/src/core/fingerprint.ts                       | 96       | 100        | 98.21  |
| packages/idempotency-plugin/src/core/hash.ts                              | 100      | 100        | 100    |
| packages/idempotency-plugin/src/core/key.ts                               | 100      | 100        | 100    |
| packages/idempotency-plugin/src/core/options.ts                           | 94.83    | 100        | 93.1   |
| packages/idempotency-plugin/src/core/record.ts                            | 91.66    | 100        | 96.11  |
| packages/idempotency-plugin/src/core/safe-log.ts                          | 100      | 100        | 100    |
| packages/idempotency-plugin/src/health/indicator.ts                       | 100      | 100        | 100    |
| packages/idempotency-plugin/src/ingress/idempotent-ingress.ts             | 100      | 100        | 100    |
| packages/idempotency-plugin/src/ingress/ingress-behavior.ts               | 96.49    | 100        | 98.57  |
| packages/idempotency-plugin/src/interfaces/index.ts                       | 100      | 100        | 100    |
| packages/idempotency-plugin/src/middleware/http-middleware.ts             | 97.14    | 100        | 98.96  |
| packages/idempotency-plugin/src/middleware/idempotent.ts                  | 92.85    | 100        | 100    |
| packages/idempotency-plugin/src/plugin/idempotency-plugin.ts              | 100      | 100        | 100    |
| packages/idempotency-plugin/src/service/idempotency-service.ts            | 100      | 100        | 100    |
| packages/idempotency-plugin/src/stores/memory-store.ts                    | 93.42    | 92.85      | 96.93  |
| packages/idempotency-plugin/src/stores/redis-client.ts                    | 100      | 100        | 100    |
| packages/idempotency-plugin/src/stores/redis-scripts.ts                   | 100      | 100        | 100    |
| packages/idempotency-plugin/src/stores/redis-store.ts                     | 100      | 100        | 100    |
| packages/idempotency-plugin/src/stores/resolve-store.ts                   | 100      | 100        | 100    |
| packages/idempotency-plugin/src/within/result-codec.ts                    | 100      | 100        | 100    |
| packages/idempotency-plugin/src/within/transactional-runtime.ts           | 97.5     | 100        | 98.36  |
| packages/idempotency-plugin/src/within/within-options.ts                  | 100      | 100        | 100    |
| packages/idempotency-plugin/src/within/within.ts                          | 100      | 100        | 100    |

### Review fixes: published documentation citations and audit reader

Removed milestone-added repository-source locations, line numbers and internal-plan references from
published guides, package READMEs and PUBLIC_API. Claims and reader-facing documentation links
remain; pre-existing citations were left alone. Source checks and measurements above remain the
implementation evidence. The webhook raw-body claim also cites
`packages/common/src/http.ts:128-134`; the already-recorded idempotency source range includes its
ingress options at `packages/common/src/services/idempotency.ts:309-344`. Database precondition
field/value restrictions follow `packages/common/src/services/write-precondition.ts:95-155`.

The audit reader fence now registers the plugin with `app.register(...)` over `myDbClient`, then
declares `readTrail(client)` separately and returns query entries. Both use `audit_logs` and the
same injected client facade. Fence counts stay unchanged: audit README four, webhook guide three.
The existing plugin-write/storage-reader integration test remains applicable.

Review revalidation ran the requested commands sequentially. `pnpm run fmt`, `pnpm run fmt:check`,
`pnpm run lint`, and `pnpm run check` each exited 0. `pnpm run check:docs` exited 1: its Markdown
scan passed (108 files, 3066 link targets, zero findings), then the prose-assertion subprocesses
returned incomplete batches, including the unchanged numeric assertions in
`.roo/rules-code-review/01-review-only.md:78-89`. The remaining commands in that `&&` chain
therefore did not run. No sandbox guards were changed.

A minimal subprocess-capture measurement, independent of documentation content:

```bash
node -e "const r = require('node:child_process').spawnSync(process.execPath, ['-e', 'console.log(42)'], { encoding: 'utf8' }); console.log(JSON.stringify({ status: r.status, error: r.error?.code, stdout: r.stdout, stderr: r.stderr }));"
```

Observed output: `{"status":0,"error":"EPERM","stdout":"","stderr":""}`.
`node .tmp/m113l-review/sandbox-probe.mjs`, using the actual `buildProgram` and `run` helpers,
likewise returned `{"code":0,"stdout":"","stderr":""}` for the expression `1 + 1`. This does not
verify the prose claims in this environment.

`pnpm run test:tooling` passed all three package-README fence tests, including the audit fence, and
`test/webhooks-guide.test.ts` passed. It also recorded failures in subprocess-based checks, then
stalled without further output; it was interrupted after more than ten minutes (exit 130). The
guide-fence compiler had not reported a result. A bounded, stop-on-first-failure retry,
`timeout 180s pnpm run test:tooling --bail=1`, exited 1 after 4.71 seconds: 26 tests passed, one
failed and eight were skipped. The failure was `scripts/codemods/deno-lint-ignore-to-eslint.test.ts`
→ `lists tracked sources when no file is named`: `Error: spawnSync git EPERM`.
`pnpm exec vitest --help` confirmed `--bail <number>` stops execution at the given failure count.
This retry is a failing diagnostic run, not a full-suite pass.

After the review edits, `pnpm run fmt`, `pnpm run fmt:check`, `pnpm run lint`, and `pnpm run check`
again exited 0. The requested added-line citation grep produced no output; the corresponding
deleted-line check also found no pre-existing source citations removed. The untracked webhook guide
was checked separately and contains no source/internal-plan citations. Committed, staged and
unstaged package-source diff checks were all empty. Review scratch files were removed after
recording this evidence.
