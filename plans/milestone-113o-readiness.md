# Milestone 113o — Schema-aware and stale-cache readiness (`@setu-ts/database-plugin`, `@setu-ts/cli`, `@setu-ts/service-discovery-plugin`)

> **Status:** Planning. Branch: `feat/m113o-readiness`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`/ready` must say "this replica can serve" and nothing else. Two indicators get it wrong in opposite
directions. The database indicator measures reachability only, so `/ready` answers 200 over a
database missing a migration, with no application tables, or after a restore that lost them (V9-68,
X44) — and the generated migration runner records nothing it ran, so there is no state to compare
against. The service-discovery indicator reports `degraded` while a warm cache is still serving
every request, so a shared discovery-backend blip fails `/ready` on every replica at once and drains
a working fleet. This milestone adds a migration ledger the generated runner writes, an opt-in
database readiness check against the expected migration set, and moves the discovery warm-cache case
to `up` with the condition in `data`.

- **In scope:** an exported migration ledger over the repository surface (`database-plugin`); an
  opt-in `readiness.migrations` option on every `DatabasePlugin` arm that the existing `database`
  indicator reads; the generated `src/migrations/run.ts` booting the app, handing each migration the
  database, and reading/writing the ledger; a `MIGRATION_NAMES` export in the generated barrel and a
  one-line `generate migration` hint naming the readiness option; the discovery indicator's
  warm-cache mapping.
- **NOT this milestone:** concurrent-runner locking (two `run.ts` processes at once — documented as
  "run one migration job", no lock; a portable lock is a scheduler-plugin concern and nothing asks
  for it yet); automatic DDL for the ledger table on SQL backends (the M107 outbox precedent — the
  application owns its schema); a `setu db:migrate` command (still no plugin registers CLI commands
  — `seams/registry.ts:22-36` stays true); wiring `readiness.migrations` into `setu.config.ts`
  automatically (opt-in by the ROADMAP's own words; the CLI prints the line instead).

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                                                                               | Verified surface / fact                                                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDatabaseService`                    | `packages/database-plugin/src/interfaces/index.ts:211`                                                                           | Lives in `database-plugin`, NOT `common`. `getRepository<Entity, Id>(entity)`, `transaction`, `query`, `migrate()` (throws 501 on every adapter), `isHealthy()`, `close()`.                                                                                                  |
| `IRepository`                         | `packages/database-plugin/src/interfaces/index.ts:73`                                                                            | `findById`, `findAll(options?)`, `findOne`, `create`, `update`, `delete`, `exists`, `count`, `findPage`; optional `updateWhere?`/`deleteWhere?`. Enough for a ledger: `create` + `findAll` + `delete`.                                                                       |
| `DatabaseConnectionOptions`           | `packages/database-plugin/src/interfaces/index.ts:327`                                                                           | The base every `DatabasePluginOptions` arm extends (`name?`, `options?`). Adding `readiness?` here reaches every arm, including `'custom'`, with no union change.                                                                                                            |
| `database` health indicator           | `packages/database-plugin/src/plugin/database-plugin.ts:194`                                                                     | Registered under the connection token. Lifecycle gate (`service.isClosed`) → `down`; cached bounded `probe()` (5 s TTL, 2 s bound via `createCachedProbe`); reachability probe for adapters that carry one; saturation logic (M101a). Returns `{ status, data }`.            |
| `createCachedProbe`                   | `packages/common` (used at `database-plugin.ts:165`)                                                                             | `{ probe, ttlMs, timeoutMs, hrtime, setTimer, clearTimer, fallback? }` — the M70c helper every indicator uses; the ledger read reuses it.                                                                                                                                    |
| Outbox store bridge (shape precedent) | `packages/database-plugin/src/outbox/database-outbox-store.ts:514`                                                               | `createDatabaseOutboxStore({ entity?, database? })` resolving `CAPABILITIES.DATABASE` / `database.<name>`; SQL DDL shipped as `test/fixtures/outbox-{postgres,sqlite}.sql`. The ledger follows the entity-name and DDL-fixture conventions, not the factory form (see §3.1). |
| Generated migration schematic         | `packages/cli/src/schematics/migration.ts`                                                                                       | Emits `<stamp>-<kebab>.ts` exporting `migration: Migration` with zero-arg `up()`/`down()`, a managed barrel `index.ts` exporting `MIGRATIONS: { name, migration }[]`, and a managed `run.ts` that applies all with no ledger (comment states why).                           |
| Migration scanner                     | `packages/cli/src/utils/migration-scanner.ts`                                                                                    | `MIGRATIONS_DIR = 'src/migrations'`; names match `^\d{14}-[a-z0-9-]+\.ts$`; `index.ts`/`run.ts` excluded.                                                                                                                                                                    |
| No CLI command registration           | `packages/cli/src/seams/registry.ts:22-36`                                                                                       | Nothing registers `setu db:migrate`; the runner is project-local and no config imports it. Stays true.                                                                                                                                                                       |
| `generate` command logging            | `packages/cli/src/commands/generate.ts:499,518`                                                                                  | `deps.log(...)` prints each outcome; the hint uses the same channel.                                                                                                                                                                                                         |
| Generated `createApp`                 | `packages/cli/src/devtool/planner.ts:131` and the template renderers                                                             | Every scaffold exports `createApp` from `setu.config.ts`; full-stack's may return a promise, so the runner `await`s it. `start()` with no port runs init/bootstrap and binds nothing (M34b).                                                                                 |
| Memory duplicate `create`             | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:253`                                                             | A duplicate primary key rejects with `DuplicateKeyError`. Other adapters are measured during implementation (§3.1).                                                                                                                                                          |
| DynamoDB unkeyed read                 | `packages/database-plugin/src/adapters/dynamo/dynamo-access-path.ts:85`                                                          | No eligible key equality falls back to a `Scan`, so the ledger's unkeyed `findAll` is served, not refused.                                                                                                                                                                   |
| Workers `createApp(env)`              | `packages/cli/src/app-loader.ts:72,321`                                                                                          | A Workers factory needs the platform bindings; the CLI passes an inert proxy for discovery, which reaches no D1 table.                                                                                                                                                       |
| Existing `degraded` assertions        | `service-discovery-plugin/test/unit/plugin/health-indicator.test.ts:116,129`; `test/integration/plugin-registration.test.ts:187` | Three assertions pin today's warm-cache `degraded`; §3.6 changes them deliberately.                                                                                                                                                                                          |
| Discovery indicator                   | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:100-123`                                               | `!everResolved && !reachable` → `down`; `degraded \|\| (everResolved && !reachable)` → `degraded`; else `up`. `data` already carries `degraded`, `reachable`, `everResolved`.                                                                                                |
| `/ready` vs `/health`                 | `packages/health-plugin/README.md:138-139`                                                                                       | `/ready` 200 only when every indicator is `up`; `/health` 200 for `up`/`degraded`, 503 for `down`; `/live` always 200 (M113b).                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                             | Resolution (picked side)                                                                                    | Doc deliverable (same PR)                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| C1  | The generated `run.ts` header and `migration.ts` JSDoc say the runner "keeps NO record of what has already run … that needs a table, which needs a schema".                                          | Superseded: the ledger needs one application-owned table (documented DDL), not a schema the runner creates. | Rewrite the runner header and the schematic module JSDoc; database-plugin README "Migrations". |
| C2  | The service-discovery README (lines 240 and 247, and line 301's "stale-cache `degraded` semantics remain unchanged") and PUBLIC_API (line 11637) describe a warm-cache backend outage as `degraded`. | `up` with `data.degraded: true` (§3.6).                                                                     | service-discovery README, PUBLIC_API service-discovery section, CHANGELOG.                     |

## 3. Design decisions

### 3.1 The ledger is a class over the repository surface, not a capability

- **Decision:** `database-plugin` exports
  `createMigrationLedger(database: IDatabaseService, options?: MigrationLedgerOptions): IMigrationLedger`,
  with
  `IMigrationLedger { applied(): Promise<readonly string[]>; record(name: string, appliedAt: string): Promise<void>; remove(name: string): Promise<void> }`.
  Rows are `{ id: <migration name>, appliedAt: <ISO-8601 string> }` in entity `setu_migrations` by
  default (`MIGRATION_LEDGER_ENTITY`). The caller supplies `appliedAt`: the generated runner passes
  `new Date().toISOString()` — project code, so the framework's no-`Date.now()` rule does not bind
  it — and the ledger itself reads no clock. No capability token: the runner and the indicator both
  hold the `IDatabaseService` already.
- **Why:** a token would need a provider plugin, and the two consumers already have the service. The
  repository surface works on every adapter, so one implementation covers all eight data sources.
- **Validation:** `entity` non-empty string, else `TypeError` at the call. `record` of a name
  already present rejects with whatever the adapter's `create` rejects with — `DuplicateKeyError`
  where the adapter classifies a unique violation (memory verified; the implementation records the
  per-adapter answer it measures rather than this plan asserting it). It means a second runner
  raced, and is documented as such. `remove` of an absent name resolves (idempotent down).
- **Read bound:** `applied()` reads `findAll({ select: ['id'], limit: 10_001 })`; more than 10 000
  rows rejects with `MigrationLedgerError` (`reason: 'oversized'`), never a silent truncation.
- **Test home:** `test/unit/migration-ledger.test.ts`.

### 3.2 Backend support

- **Decision:** every built-in adapter is supported through the repository surface. SQL backends
  (Prisma, Drizzle, D1) need the application to create the table; the DDL ships as
  `test/fixtures/migration-ledger-postgres.sql` and `-sqlite.sql` and is printed in the README.
  Drizzle additionally needs the table in `drizzleTables` with an `id` column. MongoDB, DynamoDB
  (partition key `id`), Cosmos (partition path `/id`), Bigtable and Memory need no DDL, but
  DynamoDB, Cosmos and Bigtable need the `setu_migrations` entity in their adapter's entity mapping,
  the same as any other entity; the README names each. **Memory is process-local**: a ledger written
  by a separate `run.ts` process is gone when it exits, so on the memory adapter the readiness check
  holds only when migrations run in the serving process (the integration test does exactly that).
  Documented, not refused, because migrating in-process at startup is a legitimate use.
- **Why:** the M107 outbox precedent — the framework never runs DDL.
- **Test home:** `migration-ledger.test.ts` (memory); `migration-ledger-postgres.test.ts` (guarded
  real PostgreSQL via Drizzle, `ignore:` when `DATABASE_URL` is absent, the M107 env).

### 3.3 Database readiness option

- **Decision:**
  `DatabaseConnectionOptions.readiness?: { readonly migrations: readonly string[]; readonly ledgerEntity?: string }`.
  Absent, the indicator is byte-identical to today. Present, after the existing
  lifecycle/reachability logic yields `up` or `degraded`, the indicator reads the ledger through its
  own `createCachedProbe` (5 s TTL, 2 s bound, `fallback: 'unreadable'`) and:
  - ledger unreadable (read rejected, timed out, oversized) → `down`,
    `data.migrations: { state: 'unreadable' }` — no tables, a failed restore, or a missing ledger
    table all land here;
  - any expected name absent from the ledger → `degraded` (out of rotation, `/health` still 200 so a
    deploy waiting on its migration job does not page),
    `data.migrations: { state: 'pending', pending: <count> }`;
  - otherwise unchanged status, `data.migrations: { state: 'current', applied: <count> }`, plus
    `unknown: <count>` when the ledger holds names this build does not list — that is the OLD
    replicas of a rolling deploy after the NEW version migrated, and they must stay ready, so it
    never changes the status.
  - An already-`down` result from the existing logic is returned unchanged without reading the
    ledger.
- **Validation at construction:** `migrations` must be an array of unique non-empty strings, at most
  10 000; `ledgerEntity` a non-empty string. A violation throws `TypeError` naming the option, never
  echoing a value.
- **Counts, never names, go in `data`** (the M113f minimization rule: counts are enough to act on,
  and `details: false` is the default anyway).
- **Test home:** `test/unit/migration-readiness.test.ts` (fake ledger rows, every branch above, the
  cache and the bound); `test/integration/migration-readiness.test.ts` (real kernel app +
  `HealthPlugin`, memory adapter: `/ready` 503 → run the ledger writes → 200; `/health` 200 while
  pending).

### 3.4 The generated runner writes the ledger

- **Decision:** `run.ts` (managed, rewritten on every `generate migration`) becomes:
  - `export interface MigrationContext { readonly database: IDatabaseService }` and
    `Migration.up(context)` / `down(context)` — existing zero-arg migrations stay assignable (fewer
    parameters).
  - `export async function runMigrations(direction, { database, ledger })`: `up` applies, oldest
    first, only names absent from `ledger.applied()`, calling
    `ledger.record(name, new Date().toISOString())` after each success; `down` reverses, newest
    first, only names present, calling `ledger.remove(name)` after each. A failure stops the run,
    rethrown with the migration named (unchanged). The ledger row is written AFTER the migration,
    outside any transaction, because DDL is non-transactional on several backends — documented: a
    crash between the two re-runs that migration, so migrations should be idempotent.
  - The entry point, inside the existing main-module guard, loads `../../setu.config.ts` with a
    dynamic `await import()`, so a project module importing `runMigrations` does not load the whole
    application. It `await`s `createApp()` with no arguments (valid on every socket target — the
    generated smoke test calls it that way), `start()`s it with no port, resolves
    `CAPABILITIES.DATABASE` as `IDatabaseService`, builds the ledger with the default entity, runs,
    and `stop()`s in `finally`. A project whose database is a named connection calls `runMigrations`
    from its own module with that connection; the runner header says so.
  - **Cloudflare Workers:** the factory needs the platform's bindings, which a `tsx` process does
    not have (`app-loader.ts` passes an inert proxy that reaches no D1 table). The Workers runner
    therefore emits `runMigrations` and the types but NO entry block; its header says to call
    `runMigrations` from code that holds the bindings, or to use `wrangler d1 migrations`. Asserted
    by the schematic unit test for that target.
- **Barrel:** `index.ts` also exports `MIGRATION_NAMES: readonly string[]`, so
  `DatabasePlugin({ readiness: { migrations: MIGRATION_NAMES } })` imports one constant.
- **Hint:** after a successful `generate migration`, `deps.log` prints one line: add
  `readiness: { migrations: MIGRATION_NAMES }` from `./src/migrations/index.ts` to
  `DatabasePlugin(...)` and create the `setu_migrations` table (README link). Printed every time
  (cheap; the command cannot tell whether the config already has it without parsing it).
- **Breaking for generated output:** a project's own module calling `runMigrations('up')` must now
  pass `{ database, ledger }` — CHANGELOG migration note.
- **Test home:** `packages/cli/test/unit/schematics/migration.test.ts` (emitted text, both
  runtimes); the M63 scaffold-runs e2e gains a step generating two migrations in a `rest` project
  and driving `runMigrations` twice in one script over one started app (the second call must apply
  nothing), then asserting that app's `/ready` with the readiness option wired. A separate process
  would see an empty memory ledger (§3.2).

### 3.5 Ledger entity name agreement

- **Decision:** one exported constant `MIGRATION_LEDGER_ENTITY = 'setu_migrations'` is the default
  of both `createMigrationLedger` and `readiness.ledgerEntity`; the generated runner uses the
  default. A project that overrides one must override both — documented in the option's JSDoc.
- **Test home:** `migration-readiness.test.ts` (a ledger written with the default is read by a
  readiness check with no `ledgerEntity`).

### 3.6 Discovery warm-cache outage reports `up`

- **Decision:** the indicator becomes: never resolved and unreachable → `down` (unchanged);
  otherwise `up`. `data` keeps `degraded`, `reachable` and `everResolved` exactly as today, so the
  condition stays visible and alertable. The case that changes is "has resolved before, backend now
  unreachable or serving stale" — previously `degraded`, which drained every replica on a shared
  backend failure while each still served from cache.
- **Why:** M113b's rule (`degraded` means "take this replica out of rotation"); a shared-dependency
  blip is not a per-replica fault.
- **Test home:** `packages/service-discovery-plugin/test/unit/plugin/health-indicator.test.ts` (the
  three states; the assertions at `:116` and `:129` change from `degraded` to `up` with
  `data.degraded: true`) and `test/integration/plugin-registration.test.ts:167` (renamed and updated
  the same way).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `none` for the published packages (the new option is optional and the
new exports are additions). Breaking in behaviour: the discovery indicator reports `up` where it
reported `degraded`, and the generated `runMigrations` signature changes — both in the CHANGELOG;
ships in minor `0.10.0`.

| Exported symbol            | Kind     | Consumer / real code path that READS it                                                |
| -------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `createMigrationLedger`    | function | The generated `run.ts`; the database indicator's readiness read (same implementation). |
| `IMigrationLedger`         | type     | The generated `run.ts` (`runMigrations` parameter).                                    |
| `MigrationLedgerOptions`   | type     | `createMigrationLedger`'s parameter.                                                   |
| `MIGRATION_LEDGER_ENTITY`  | constant | Default of both the ledger and `readiness.ledgerEntity`.                               |
| `MigrationLedgerError`     | class    | Thrown by `applied()` when oversized; the indicator maps it to `unreadable`.           |
| `DatabaseReadinessOptions` | type     | `DatabaseConnectionOptions.readiness`.                                                 |

### 4.1 Options — every option names its consumer

| Option                          | Consumer                                    | Behavior (per implementation)                                  |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `readiness.migrations`          | `database` indicator (`database-plugin.ts`) | Expected names; same on every adapter (repository surface).    |
| `readiness.ledgerEntity`        | `database` indicator                        | Entity the indicator reads; default `MIGRATION_LEDGER_ENTITY`. |
| `MigrationLedgerOptions.entity` | `createMigrationLedger`                     | Entity the ledger reads and writes; same default.              |

## 5. Implementation files

| File                                                                       | Purpose                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/database-plugin/src/index.ts`                                    | Barrel exports for §4.                                          |
| `packages/database-plugin/src/migrations/migration-ledger.ts`              | `createMigrationLedger`, constant, error.                       |
| `packages/database-plugin/src/migrations/migration-readiness.ts`           | Option validation and the indicator's ledger evaluation.        |
| `packages/database-plugin/src/interfaces/index.ts`                         | `readiness?` on `DatabaseConnectionOptions`; types.             |
| `packages/database-plugin/src/plugin/database-plugin.ts`                   | Validate at construction; call the evaluation in the indicator. |
| `packages/cli/src/schematics/migration.ts`                                 | New runner, barrel `MIGRATION_NAMES`, updated JSDoc.            |
| `packages/cli/src/commands/generate.ts`                                    | The readiness hint after `generate migration`.                  |
| `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts` | Indicator mapping (§3.6).                                       |

Documentation, same PR: `packages/database-plugin/README.md` (a "Migrations and readiness" section
with the per-backend ledger DDL and entity mapping, and the memory caveat); `PUBLIC_API.md` (the six
exports and `readiness`); the service-discovery README and PUBLIC_API (C2); `CHANGELOG.md`
`Unreleased` (the ledger, the readiness option, the discovery status change, and the generated
`runMigrations` signature change with migration text); `docs/upgrading.md` (the `runMigrations` call
change); `ROADMAP.md` (the M113o section and progress row); and the SQL DDL fixtures
`test/fixtures/migration-ledger-{postgres,sqlite}.sql`.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                      | src covered                      | Key assertions                                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `database-plugin/test/unit/migration-ledger.test.ts`                           | `migration-ledger.ts`            | record/applied/remove round trip on memory; duplicate record rejects; remove absent resolves; oversized rejects; bad entity throws.    |
| `database-plugin/test/unit/migration-readiness.test.ts`                        | `migration-readiness.ts`         | each §3.3 branch; validation refusals without echo; cache (one read per TTL) and bound (hung read → `down`); default entity agreement. |
| `database-plugin/test/integration/migration-readiness.test.ts`                 | `database-plugin.ts` (indicator) | real app: `/ready` 503 pending → 200 current; `/health` 200 while pending; unknown names keep 200; absent option byte-identical data.  |
| `database-plugin/test/integration/migration-ledger-postgres.test.ts` (guarded) | `migration-ledger.ts`            | real PostgreSQL via Drizzle with the shipped DDL; a missing table reads `unreadable`.                                                  |
| `database-plugin/test/unit/barrel-exports.test.ts` (extend)                    | `index.ts`                       | the six exports present.                                                                                                               |
| `cli/test/unit/schematics/migration.test.ts` (extend)                          | `migration.ts`                   | runner skips applied, records after success, down removes newest first; barrel `MIGRATION_NAMES`; both runtime entries.                |
| `cli/test/unit/commands/generate.test.ts` (extend)                             | `generate.ts`                    | the hint printed after `generate migration`, not after other schematics.                                                               |
| `cli/test/e2e/scaffold-runs-e2e.test.ts` (extend)                              | generated output                 | two migrations, run twice (second applies nothing), `/ready` reflects the ledger; generated files pass fmt/lint/check.                 |
| `service-discovery-plugin/test/unit/plugin/health-indicator.test.ts` (update)  | `service-discovery-plugin.ts`    | never-resolved+unreachable `down`; resolved+unreachable `up` with `degraded`/`reachable` data; healthy `up`.                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113o-readiness
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm test
pnpm test:coverage database-plugin cli service-discovery-plugin
NODE_OPTIONS=--dns-result-order=ipv4first pnpm run check:docs
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

## 8. Risks & mitigations

- A rolling deploy marks old replicas unready once the new version migrates → unknown applied names
  never change the status (§3.3); tested.
- A deploy waiting on its migration job pages on `/health` → pending is `degraded`, not `down`.
- The runner booting the whole app (brokers, discovery) to reach the database → documented; the same
  cost `setu` plugin-command discovery already pays (M34b).
- Two runners at once both apply a migration → documented "run one migration job"; the second
  `record` rejects with `DuplicateKeyError`, so the race is visible rather than silent.
- Ledger table missing on SQL → `down` with `state: 'unreadable'`, and the README gives the DDL.

## 9. Out of scope

- A portable migration lock — no milestone owns it yet; nothing has asked.
- `setu db:migrate` — needs CLI command registration from a plugin, which does not exist.
- Rewriting `setu.config.ts` to add the readiness option — the opt-in stays a printed line.
