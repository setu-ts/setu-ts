# Milestone 52c — D1 and the `common` data-access promotion

> **Status:** Planning. Branch: `feat/m52c-d1-database-adapter`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Ship Cloudflare D1 as a first-class database backend. The blocker is a contract decision rather than
effort: the seam a backend actually implements is `IDatabaseAdapter`, declared **inside**
`packages/database-plugin` and never exported, while `common` ships only the lifecycle-shaped
`IOrmAdapter` (`connect`/`disconnect`/`isReady`/`beginTransaction`). A backend living in another
package therefore cannot be written at all without that package importing `database-plugin`, which
AI_GUIDELINES §2.2/§3.3 forbid. This milestone promotes the data-access port into `common`, opens
`DatabasePlugin`'s closed adapter switch with a `'custom'` arm, and implements `D1Adapter` in
`packages/cloudflare-plugin` over the `ID1Database` facade M52 already ships.

- **In scope:** the `common` promotion (`IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`,
  `NormalizedQuery`, `OrderDirection`); a `'custom'` arm on `DatabasePlugin` plus the deletion of
  the concrete-class casts that made the switch closed; `D1Adapter` + its SQL builder + its data
  sources; reconciling `ITransaction` with D1's batch-only atomicity; doc deliverables C1–C5.
- **NOT this milestone:** migrations (a wrangler CLI concern; `IDatabaseAdapter` deliberately
  carries no `migrate()` — M10 plan deviation §2). Durable Objects — M52d. Example applications —
  M37. Registering D1 through a `CloudflarePlugin` option arm — declined in §3.7, not deferred.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                            | Verified surface / fact                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IOrmAdapter`                             | `packages/common/src/services/database.ts:33-54`                              | Lifecycle only: `connect`, `disconnect`, `isReady`, `beginTransaction(): Promise<ITransaction>`. Carries no data access — the M10 miss, re-verified.                                       |
| `ITransaction`                            | `packages/common/src/services/database.ts:16-25`                              | `commit(): Promise<void>`, `rollback(): Promise<void>`. Nothing else.                                                                                                                      |
| `common` barrel database row              | `packages/common/src/index.ts:136`                                            | Exports exactly `IOrmAdapter`, `ITransaction` from `./services/database.ts`.                                                                                                               |
| `IDatabaseAdapter` (internal)             | `packages/database-plugin/src/adapters/adapter.ts:51-71`                      | `IOrmAdapter` + `beginTransaction(): Promise<IAdapterTransaction>` + `rawQuery<T>(sql, params?)`. **Has no non-transactional `createDataSource`** — the gap this plan closes.              |
| `IAdapterTransaction`                     | `packages/database-plugin/src/adapters/adapter.ts:27-35`                      | `ITransaction` + `createDataSource(entity: string): DataSource`.                                                                                                                           |
| `DataSource`                              | `packages/database-plugin/src/repositories/base-repository.ts:23-39`          | `findAll(NormalizedQuery)`, `findById`, `create`, `update`, `delete`, `count`. Exported from the barrel; named without the `IXxx` prefix §10.4 requires.                                   |
| `NormalizedQuery`                         | `packages/database-plugin/src/query/query-builder.ts:14-25`                   | `where`, `orderBy`, `limit` (`-1` = unlimited), `offset`, `select` — all `readonly`, all required.                                                                                         |
| `NormalizedQuery` is unexported           | `packages/database-plugin/src/index.ts` (grep: absent)                        | Not in the barrel, and not in `interfaces/index.ts`. The **exported** `DataSource.findAll` parameter is therefore unnameable by a consumer — a latent public-API defect (C2).              |
| `createAdapter`                           | `packages/database-plugin/src/plugin/database-plugin.ts:139-152`              | Closed `switch` over `'prisma' \| 'drizzle' \| 'memory'`, `default` falling through to `MemoryAdapter`. No external arm.                                                                   |
| `createDataSourceFactory`                 | `packages/database-plugin/src/plugin/database-plugin.ts:161-181`              | Second closed switch; **casts the adapter to each concrete class** (`adapter as PrismaAdapter`) to reach `createDataSourceForEntity`. This is the real reason the switch is closed.        |
| `DatabaseService` adapter reads           | `packages/database-plugin/src/services/database-service.ts:84,89,107,120,127` | Reads exactly `beginTransaction()`, `txn.createDataSource(entity)`, `rawQuery`, `isReady()`, `disconnect()`. Plus the injected `_createDataSource`.                                        |
| `DatabaseService.query` guard             | `packages/database-plugin/src/services/database-service.ts:103-108`           | Throws when `_adapterType === 'memory'`; every other type delegates to `adapter.rawQuery`. A `'custom'` arm reaches `rawQuery` unchanged.                                                  |
| `PrismaAdapter.createDataSourceForEntity` | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:227-232`      | Public method on an exported class; §9.2 governs it, so it is deprecated rather than renamed.                                                                                              |
| `MemoryAdapter`                           | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:68`           | Declares `implements IOrmAdapter`, not `IDatabaseAdapter`; satisfies the latter structurally (it has `rawQuery` at :403). Has **no** `createDataSource` method.                            |
| `createMemoryDataSource`                  | `packages/database-plugin/src/services/database-service.ts:202-216`           | Lives in the service file, not on the adapter — which is why the plugin needed the memory cast.                                                                                            |
| `ID1Database`                             | `packages/cloudflare-plugin/src/bindings/facades.ts:223-242`                  | `prepare(query): ID1PreparedStatement` and `batch<T>(statements): Promise<readonly D1Result<T>[]>`. No `exec`, no `withSession`.                                                           |
| `ID1PreparedStatement`                    | `packages/cloudflare-plugin/src/bindings/facades.ts:169-198`                  | `bind(...values)` (returns a statement), `all<T>()`, `first<T>()`, `run<T>()`.                                                                                                             |
| `D1Result`                                | `packages/cloudflare-plugin/src/bindings/facades.ts:206-211`                  | Declares **only** `results: readonly T[]` and `success: boolean`. **No `meta`** — so `changes` / `last_row_id` are unreachable without widening the facade (see §3.5).                     |
| `KvSessionStore`                          | `packages/cloudflare-plugin/src/stores/kv-session-store.ts:32-58`             | The app-constructed precedent: exported from `cloudflare-plugin`, handed to another plugin's options because that option is read before any application exists.                            |
| `CloudflareUnsupportedError`              | `packages/cloudflare-plugin/src/errors.ts:70-80`                              | `constructor(message: string)`, `name` overridden. Reusable — no new error class needed.                                                                                                   |
| `createCapabilityToken`                   | `packages/common/src/tokens.ts`                                               | Lowercase kebab-case with dot namespacing; colons illegal. **No new token this milestone** — D1 registers under the existing `CAPABILITIES.DATABASE`.                                      |
| `rest-starter` database arm               | `packages/starters/rest-starter/src/options.ts:111`, `src/app.ts:55`          | Declares `database?: DatabasePluginOptions` and passes it straight through. A union-shaped option type flows through unchanged.                                                            |
| D1: no interactive transactions           | Cloudflare D1 docs (`/d1/worker-api/d1-database/`) + platform error text      | `BEGIN TRANSACTION` is rejected: _"To execute a transaction, please use the state.storage.transaction() … APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements."_             |
| D1: `batch()` atomicity                   | Cloudflare D1 docs (`/d1/worker-api/d1-database/`)                            | _"Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence."_ |
| D1: `RETURNING` supported                 | Cloudflare D1 docs (`/d1/sql-api/sql-statements/`)                            | `INSERT INTO … VALUES (?1, ?2) RETURNING *` combined with `.bind()` and `.first()` is documented. This is how a write reads its own persisted row back.                                    |
| D1: bound-parameter cap                   | Cloudflare D1 docs (`/d1/platform/limits/`)                                   | **Maximum bound parameters per query: 100.** Also 100 columns per table, 100 KB per SQL statement, 30 s per query.                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                       | Doc deliverable (same PR)                                                                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:879` documents a Unit-of-Work example calling `inventoryRepo.decrement(productId, qty)`. `IRepository` (`interfaces/index.ts:21-86`) has no `decrement` — the documented example cannot compile.           | The committed `IRepository` surface wins; the example is wrong. No `decrement` is added — nothing in the framework reads one, and inventing it to match prose is dead surface. | Rewrite the PUBLIC_API Unit-of-Work example to use `update()`, so every call in it exists.                                            |
| C2 | The barrel exports `DataSource` (`index.ts:32`) whose `findAll` parameter is `NormalizedQuery`, which the barrel does **not** export. A consumer can implement the interface structurally but cannot annotate against it. | Promoting `NormalizedQuery` to `common` fixes this at the root rather than adding a second barrel export. `database-plugin` re-exports it so both import paths name one type.  | PUBLIC_API `common` Database row gains the promoted types; `database-plugin` Exports section gains `NormalizedQuery` / `IDataSource`. |
| C3 | ROADMAP M52c deliverable says "An **external**-adapter arm"; the repo's two precedents for the same shape (M31 flags, M50 discovery) both name the arm `'custom'`.                                                        | `'custom'`, matching the in-repo precedents. ROADMAP prose was descriptive, not a literal name.                                                                                | ROADMAP M52c scope line updated to name the arm `'custom'`.                                                                           |
| C4 | `facades.ts:216-219` says a first-class `IDatabase` backend "is M52c, because the seam … is not a committed `common` port" — true when written, false once this milestone lands.                                          | Update the JSDoc; the escape-hatch framing is retired now that `D1Adapter` exists.                                                                                             | `ID1Database` JSDoc points at `D1Adapter` instead of describing the gap.                                                              |
| C5 | ROADMAP Progress row `52c` is `⬜` and CLAUDE.md lists M52c as "planned, not started"; "Next milestone" points at M52c.                                                                                                   | Flip both in this PR (the mandated status rule), pointing "Next milestone" at M52d / M37.                                                                                      | ROADMAP row `52c` → `✅`; CLAUDE.md status entry + "Next milestone" line.                                                             |

## 3. Design decisions

### 3.1 What gets promoted into `common`, and at what width

- **Decision:** promote the port **as-is in shape** (`IDatabaseAdapter extends IOrmAdapter`), plus
  **one addition**: a non-transactional `createDataSource(entity: string): IDataSource`. The
  promoted set is `IDatabaseAdapter`, `IAdapterTransaction`, `IDataSource`, `NormalizedQuery`,
  `OrderDirection`. The internal `packages/database-plugin/src/adapters/adapter.ts` is **deleted**
  and its six importers repoint at `@hono-enterprise/common`, so exactly one definition exists.
- **Why:** every member is load-bearing, verified at §1 against `DatabaseService`'s actual reads —
  `rawQuery` backs the committed `IDatabaseService.query()`,
  `beginTransaction(): IAdapterTransaction` backs `transaction()`, lifecycle backs
  `isHealthy()`/`close()`. Narrowing any of them would leave a committed service method unservable
  by an external backend. The `createDataSource` addition is what makes the promotion useful at all:
  without it the plugin can only reach a data source by casting to a concrete adapter class (§1,
  `createDataSourceFactory`), which is precisely what keeps the switch closed. `IDataSource` takes
  the `IXxx` prefix §10.4 requires; `DataSource` survives as a deprecated alias (§9.2) since it is
  already published.
- **Compatibility:** adding a member to a port is breaking for **implementors**. The port has never
  existed in `common` and the internal one was never exported, so there can be no out-of-repo
  implementor; the three in-repo implementors are updated in this milestone. Subclasses of the
  exported adapter classes are unaffected — a class gaining a method breaks nothing.
- **Test home:** `packages/database-plugin/test/unit/adapter-contract.test.ts` asserts all three
  shipped adapters satisfy the promoted `IDatabaseAdapter` with **no cast**, which is the property
  the deleted switch used to violate.

### 3.2 Opening `DatabasePlugin.createAdapter`

- **Decision:** `DatabaseAdapterType` gains `'custom'`, and `DatabasePluginOptions` becomes a union
  **discriminated on `type`**: the `'custom'` arm requires `adapter: IDatabaseAdapter`; the three
  built-in arms keep today's optional `type`/`name`/`options` shape. `createDataSourceFactory` is
  **deleted** — the plugin now calls `adapter.createDataSource(entity)` for every arm.
- **Why:** the union makes a `'custom'` registration with no adapter a **compile** error rather than
  a startup throw (the M30 `ChannelConfig` / M50 `DiscoveryProviderOptions` precedent). Deleting the
  factory removes three concrete-class casts and is the change that actually opens the seam; leaving
  it while adding an arm would produce a `'custom'` adapter that type-checks and then falls through
  `default:` to the Drizzle cast. The built-in arms keep `type` optional so every existing call site
  (including `rest-starter`, §1) compiles byte-identically.
- **`name` and `options` on the custom arm:** kept, so `logQueries` wraps a custom adapter's data
  sources through the same single `wrapDataSource` path, and so a D1 database can register under
  `database.<name>` alongside another backend.
- **Test home:** `test/unit/database-plugin-custom-arm.test.ts` (registration + token derivation +
  `logQueries` reaching a custom adapter), and `test/integration/custom-adapter-app.test.ts` (a real
  kernel app resolving `CAPABILITIES.DATABASE` backed by a custom adapter).

### 3.3 Reconciling `ITransaction` with D1's batch-only atomicity

- **Decision:** **deferred batch.** `beginTransaction()` returns a handle that buffers every write
  as a prepared statement; `commit()` flushes the whole buffer as **one** `db.batch([...])` call;
  `rollback()` discards the buffer and issues no statement. Reads inside the transaction execute
  immediately against committed state and **do not** observe the transaction's own buffered writes.
  A second `commit()`/`rollback()` on a finalized handle throws `Transaction already finalized`,
  matching `MemoryAdapter`'s committed behavior. An empty buffer commits without calling `batch()`.
- **Why:** D1 rejects `BEGIN TRANSACTION` outright with a platform error naming the alternative
  (§1), so an imperative bridge is impossible — unlike Prisma, where M10 could hold a callback open
  with two deferreds. `batch()` **is** a real SQL transaction with real rollback (§1), so buffering
  and flushing preserves the one guarantee a transaction exists for. Refusing `beginTransaction()`
  with a throw was rejected: it would make the committed `IDatabaseService.transaction()`
  permanently unusable on D1 while the platform does in fact offer atomicity.
- **The cost, stated rather than hidden:** no read-your-own-writes inside a transaction. This is a
  documented semantic deviation in the `D1Adapter` JSDoc, in the package README, and in PUBLIC_API,
  and it is pinned by a test that asserts the stale read explicitly — so the behavior is a decision
  under test, not an accident.
- **Writes still return their row:** `update()` and `delete()` **read first** at call time to
  establish existence (so `update` can honor its committed `@throws if the entity does not exist`
  and `delete` its `Promise<boolean>`), then buffer the mutation and return the locally merged row.
  Both reads see committed state, consistent with the rule above.
- **`create()` inside a transaction requires the primary key.** A deferred `INSERT` cannot report an
  auto-generated key back to a caller that awaits `create()` before the flush. Rather than return a
  row whose id is missing, or invent a client-side UUID that would be the wrong type for an
  `INTEGER` key, the adapter **throws** a `CloudflareUnsupportedError` naming the entity and the
  constraint. Outside a transaction `create()` uses `RETURNING *` and returns the real persisted
  row, generated columns included. This is the "an interface method an implementation cannot support
  gets a documented, tested throw, not silence" rule applied at method granularity.
- **Test home:** `test/unit/d1-transaction.test.ts` — one batch call carrying every buffered
  statement in order; rollback issuing nothing; the stale-read assertion; the finalized-handle
  throw; the empty-buffer no-op; the keyless-`create` throw. Plus
  `test/integration/d1-database.test.ts` driving `db.transaction(...)` through the real
  `DatabaseService`.

### 3.4 SQL generation and identifier safety

- **Decision:** a pure, dependency-free `d1-sql.ts` builds every statement. Values are **always**
  bound (`?1`, `?2`, …), never interpolated. Identifiers (table, column, primary key) cannot be
  bound, so each is validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` and then double-quoted with the
  SQLite escape (`"` → `""`); a rejected identifier throws a `CloudflareUnsupportedError` naming the
  offending value.
- **Why:** entity names, `where` keys, `orderBy` keys and `select` entries reach the adapter from
  application code and, on a `where` built from a query string, potentially from a request. An
  allowlist plus quoting is the only safe construction, and validating at build time gives one place
  to test it. §13.1 makes this mandatory rather than defensive.
- **Test home:** `test/unit/d1-sql.test.ts` — generated text asserted verbatim for each verb, plus a
  rejection case per identifier position (table, column, order key, select key).

### 3.5 The 100-bound-parameter cap

- **Decision:** every builder counts the parameters it emits and throws a
  `CloudflareUnsupportedError` naming the count, the limit, and the statement kind when it would
  exceed **100**.
- **Why:** it is a documented hard platform limit (§1). Left unchecked, a wide `INSERT` or a large
  `where` produces a D1 runtime error whose text points at the SQL rather than at the caller's
  query. Failing in the builder names the actual cause. The cap is a module constant, not a literal
  repeated per verb (§11.2).
- **`D1Result.meta` is deliberately NOT added.** The facade declares only `results` and `success`
  (§1). `delete` uses `DELETE … RETURNING <pk>` and `update` uses `UPDATE … RETURNING *`, so row
  counts come from `results.length` and the facade stays exactly as M52 committed it. Widening a
  published type to read `meta.changes` would buy nothing the `RETURNING` form does not already
  give.
- **Test home:** `test/unit/d1-sql.test.ts` — a 101-column insert and a 101-key `where` each throw;
  a 100-parameter statement is accepted.

### 3.6 Entity → table and primary-key mapping

- **Decision:** by default an entity name maps to a table of the **same name** and a primary key of
  `'id'`. `D1AdapterOptions.tables` optionally overrides both per entity:
  `{ User: { table: 'users', primaryKey: 'user_id' } }`.
- **Why:** SQL applications name their own tables, and the entity name is the only thing
  `getRepository('User')` supplies. A verbatim default keeps the zero-config path working; the map
  covers the near-universal `User` → `users` case without a naming convention the adapter would have
  to guess. Both fields are read on a real path (the SQL builder reads `table`; `findById`/`update`/
  `delete` read `primaryKey`), so neither is dead surface.
- **Test home:** `test/unit/d1-adapter.test.ts` asserts a mapped entity produces `"users"` and binds
  against `"user_id"`, and that an unmapped entity falls back to both defaults.

### 3.7 Where `D1Adapter` lives and how an application wires it

- **Decision:** `D1Adapter` ships in `packages/cloudflare-plugin`, is **constructed by the
  application** from its `ID1Database` binding, and is handed to
  `DatabasePlugin({ type: 'custom', adapter })`. `CloudflarePlugin` gains **no** `d1` option arm.
- **Why:** this is the `KvSessionStore` precedent verbatim (§1) — `DatabasePlugin`'s options are
  read when the plugin is **constructed**, which happens before any application exists, so an
  adapter published in the service registry could never reach it. A `CloudflarePlugin` arm would
  additionally have to construct a `DatabaseService` to register `CAPABILITIES.DATABASE`, and that
  class lives in `database-plugin` — a plugin importing a plugin, which §2.2/§3.3 forbid. Injecting
  the binding directly also keeps `D1Adapter` unit-testable with a fake `ID1Database` and free of
  any `cloudflare:workers` import, consistent with the whole package.
- **Test home:** `test/integration/d1-database.test.ts` boots a real kernel app with
  `DatabasePlugin({ type: 'custom', adapter: new D1Adapter(fakeD1) })` and drives the repository
  surface end to end.

### 3.8 `connect` / `disconnect` / `isReady` against a binding that has no connection

- **Decision:** `connect()` marks the adapter ready, `disconnect()` marks it not ready, `isReady()`
  reports that flag. Every data-access method throws when not ready, naming `connect()`.
- **Why:** a D1 binding is already live; there is no pool to open. The flag is not ceremony — the
  plugin calls `connect()` during `register()` and `close()` during `onClose`, and the `database`
  health indicator reads `isReady()` (§1, `database-plugin.ts:115-121`), so without the flag a
  closed application would keep reporting `up` and keep serving queries after shutdown.
- **Test home:** `test/unit/d1-adapter.test.ts` — a query before `connect()` and after
  `disconnect()` each throw; `isReady()` tracks both transitions.

### 3.9 `logQueries` and the single query-logging implementation

- **Decision:** no logging is added to `D1Adapter`. It flows through
  `DatabaseService.wrapDataSource` like every other adapter.
- **Why:** the service already owns the **single** logging wrapper for both service-level and
  UoW-scoped data sources (`database-service.ts:140-185`). A second implementation inside the
  adapter would be the "one capability, one implementation" split the checklist names.
- **Test home:** `test/unit/database-plugin-custom-arm.test.ts` drives a custom adapter with
  `options: { logQueries: true }` and asserts the debug records arrive.

## 4. Exported surface — every symbol names its consumer

### `packages/common` (`src/index.ts`)

| Exported symbol       | Kind      | Consumer / real code path that READS it                                                                                                                              |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDatabaseAdapter`    | interface | `DatabaseService` constructor parameter; `DatabasePlugin.createAdapter` return type; implemented by `D1Adapter`, `MemoryAdapter`, `PrismaAdapter`, `DrizzleAdapter`. |
| `IAdapterTransaction` | interface | `DatabaseService.transaction()` reads `txn.createDataSource`; returned by all four adapters' `beginTransaction()`.                                                   |
| `IDataSource`         | interface | `BaseRepository` constructor parameter; every adapter's `createDataSource` return type; `wrapDataSource` argument and return.                                        |
| `NormalizedQuery`     | interface | `IDataSource.findAll` parameter; produced by `normalizeQuery`; consumed by `D1SqlBuilder.select` and the memory/Prisma/Drizzle sources.                              |
| `OrderDirection`      | type      | `NormalizedQuery.orderBy` values; `FindOptions.orderBy`; read by the D1 `ORDER BY` builder and `applyOrderBy`.                                                       |

### `packages/database-plugin` (`src/index.ts`)

| Exported symbol         | Kind             | Consumer / real code path that READS it                                                                               |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IDataSource`           | re-exported type | Re-export of the `common` type so both import paths name one type; read by anyone implementing an adapter (C2's fix). |
| `NormalizedQuery`       | re-exported type | Same; makes the already-exported `DataSource.findAll` parameter nameable.                                             |
| `IDatabaseAdapter`      | re-exported type | What a `type: 'custom'` caller must satisfy — read by `D1Adapter`'s `implements` clause.                              |
| `IAdapterTransaction`   | re-exported type | Returned by a custom adapter's `beginTransaction`.                                                                    |
| `DataSource`            | deprecated alias | Already published (`index.ts:32`); kept per §9.2, now an alias of `IDataSource`.                                      |
| `DatabaseAdapterType`   | widened type     | Gains `'custom'`; read by `createAdapter` and by the `DatabaseService.query` memory guard.                            |
| `DatabasePluginOptions` | widened type     | Now a union; read by `DatabasePlugin()` and passed through by `rest-starter`.                                         |

### `packages/cloudflare-plugin` (`src/index.ts`)

| Exported symbol    | Kind      | Consumer / real code path that READS it                                                                              |
| ------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `D1Adapter`        | class     | Constructed by the application, passed to `DatabasePlugin({ type: 'custom', adapter })`; `DatabaseService` calls it. |
| `D1AdapterOptions` | interface | The `D1Adapter` constructor's second parameter.                                                                      |
| `D1EntityMapping`  | interface | The value type of `D1AdapterOptions.tables`; read by the adapter's table/primary-key resolution on every operation.  |

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                                     | Behavior (per implementation)                                                                                                 |
| ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DatabasePluginOptions.type: 'custom'`   | `createAdapter`                              | Selects the custom arm; the adapter is used verbatim, no construction.                                                        |
| `DatabasePluginOptions.adapter` (custom) | `createAdapter`                              | Required by the union on the `'custom'` arm — absence is a compile error. Returned as-is, then `connect()`ed by `register()`. |
| `D1AdapterOptions.tables`                | `D1Adapter.resolveMapping` → the SQL builder | Per-entity `{ table, primaryKey }` override. Absent entity → table = entity name, primary key = `'id'`.                       |
| `D1EntityMapping.table`                  | every builder call (`FROM`/`INTO`/`UPDATE`)  | The physical table name; validated as an identifier before quoting.                                                           |
| `D1EntityMapping.primaryKey`             | `findById`, `update`, `delete`, `create`     | The key column for `WHERE <pk> = ?` and for the in-transaction `create` presence check.                                       |

## 5. Implementation files

| File                                                               | Purpose                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/services/database.ts`                         | **Modified.** Adds `OrderDirection`, `NormalizedQuery`, `IDataSource`, `IAdapterTransaction`, `IDatabaseAdapter` beside the existing `IOrmAdapter`/`ITransaction`. |
| `packages/common/src/index.ts`                                     | **Modified.** Barrel row for the five promoted types.                                                                                                              |
| `packages/database-plugin/src/adapters/adapter.ts`                 | **Deleted.** Its two interfaces now live in `common`; six importers repoint.                                                                                       |
| `packages/database-plugin/src/query/find-options.ts`               | **Modified.** `OrderDirection` re-exported from `common` instead of declared.                                                                                      |
| `packages/database-plugin/src/query/query-builder.ts`              | **Modified.** `NormalizedQuery` re-exported from `common`; the normalize/apply helpers are unchanged.                                                              |
| `packages/database-plugin/src/repositories/base-repository.ts`     | **Modified.** `DataSource` becomes a deprecated alias of the promoted `IDataSource`.                                                                               |
| `packages/database-plugin/src/interfaces/index.ts`                 | **Modified.** `DatabaseAdapterType` gains `'custom'`; `DatabasePluginOptions` becomes a discriminated union.                                                       |
| `packages/database-plugin/src/plugin/database-plugin.ts`           | **Modified.** `createAdapter` gains the custom arm; `createDataSourceFactory` deleted in favour of `adapter.createDataSource`.                                     |
| `packages/database-plugin/src/adapters/memory/memory-adapter.ts`   | **Modified.** Declares `implements IDatabaseAdapter` and gains `createDataSource(entity)`.                                                                         |
| `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts`   | **Modified.** Gains `createDataSource(entity)`; `createDataSourceForEntity` deprecated, delegating.                                                                |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts` | **Modified.** Same two changes as Prisma.                                                                                                                          |
| `packages/database-plugin/src/services/database-service.ts`        | **Modified.** Imports the port from `common`; `createMemoryDataSource` moves onto the memory adapter and is re-exported here.                                      |
| `packages/database-plugin/src/index.ts`                            | **Modified.** Re-exports the promoted types.                                                                                                                       |
| `packages/cloudflare-plugin/src/database/d1-sql.ts`                | **New.** Pure SQL construction: identifier validation/quoting, parameter counting, one builder per verb.                                                           |
| `packages/cloudflare-plugin/src/database/d1-data-source.ts`        | **New.** `IDataSource` over `ID1Database` (direct), and the buffered transaction data source.                                                                      |
| `packages/cloudflare-plugin/src/database/d1-adapter.ts`            | **New.** `D1Adapter` + `D1AdapterOptions` + `D1EntityMapping`; lifecycle, `rawQuery`, `beginTransaction`, `createDataSource`.                                      |
| `packages/cloudflare-plugin/src/index.ts`                          | **Modified.** Exports the three new symbols.                                                                                                                       |
| `packages/cloudflare-plugin/src/bindings/facades.ts`               | **Modified.** `ID1Database` JSDoc updated (C4). No shape change.                                                                                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                               | src covered                                                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloudflare-plugin/test/unit/d1-sql.test.ts`                   | `src/database/d1-sql.ts`                                            | Verbatim SQL for select (with/without `where`/`orderBy`/`limit`/`offset`/`select`), insert, update, delete, count; `?N` numbering and bound-value order; identifier rejection at each of the four positions; the 100-parameter cap accepted at 100 and thrown at 101. |
| `packages/cloudflare-plugin/test/unit/d1-data-source.test.ts`           | `src/database/d1-data-source.ts`                                    | Against a fake `ID1Database`: `findAll` returns `results`; `findById` maps a missing row to `null`; `create` reads back the `RETURNING *` row; `update` throws when `RETURNING` is empty; `delete` maps empty results to `false`; `count` reads the aggregate column. |
| `packages/cloudflare-plugin/test/unit/d1-adapter.test.ts`               | `src/database/d1-adapter.ts`                                        | Lifecycle flag transitions (§3.8) and the throw before `connect()`; `rawQuery` binds positionally; table/primary-key mapping and its defaults (§3.6); `createDataSource` returns a working source.                                                                    |
| `packages/cloudflare-plugin/test/unit/d1-transaction.test.ts`           | `src/database/d1-data-source.ts`, `src/database/d1-adapter.ts`      | One `batch()` carrying every buffered statement in order; `rollback()` calls neither `batch()` nor `run()`; the stale-read assertion (§3.3); finalized-handle throw; empty-buffer commit skips `batch()`; keyless in-transaction `create` throws.                     |
| `packages/cloudflare-plugin/test/integration/d1-database.test.ts`       | all three new files, through `DatabasePlugin`                       | A real kernel app: `create` → `findById` **reads the write back**; `findAll` with `where`+`orderBy`+`limit`; `update`; `delete`; `count`; `db.transaction(...)` committing one batch and rolling back on a thrown callback.                                           |
| `packages/database-plugin/test/unit/adapter-contract.test.ts`           | `src/adapters/*/…-adapter.ts` (the promoted-port conformance)       | Each shipped adapter is assigned to an `IDatabaseAdapter`-typed binding **with no cast** (§3.1), and `createDataSource` returns a source honoring `IDataSource`.                                                                                                      |
| `packages/database-plugin/test/unit/database-plugin-custom-arm.test.ts` | `src/plugin/database-plugin.ts`                                     | `type: 'custom'` uses the supplied adapter verbatim and `connect()`s it; `name` derives `database.<name>`; `logQueries: true` routes a custom adapter's calls through `wrapDataSource` (§3.9); the three built-in arms still resolve.                                 |
| `packages/database-plugin/test/integration/custom-adapter-app.test.ts`  | `src/plugin/database-plugin.ts`, `src/services/database-service.ts` | A kernel app resolving `CAPABILITIES.DATABASE` backed by a recording custom adapter; `query()` reaches `rawQuery`; the health indicator reads `isReady()`; `onClose` reaches `disconnect()`.                                                                          |
| Existing `database-plugin` + `cloudflare-plugin` suites                 | every modified file                                                 | Must stay green unchanged — they are the regression evidence that the promotion and the switch deletion are behavior-preserving for the three built-in adapters.                                                                                                      |

**External dependency:** none. `D1Adapter` is driven entirely through the injected `ID1Database`
facade and imports nothing from npm, so §12.2's guarded real-import test does not apply — the same
position `service-discovery-plugin` reached in M50, where inject-or-lazy collapsed to inject-only.
The real-path obligation is met instead by the integration test driving a running kernel app and
reading every write back (the M10 no-op-implementation rule).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m52c-d1-database-adapter, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Additionally, because this milestone changes a `common` contract three packages implement:

```bash
grep -rn "adapters/adapter.ts" packages/            # must be empty — the file is deleted
grep -rn "new Function\|eval(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/cloudflare-plugin/src packages/database-plugin/src packages/common/src
```

## 8. Risks & mitigations

- **The promotion silently changes behavior for the three built-in adapters.** Mitigation: the
  existing `database-plugin` suites are not rewritten; they must pass unmodified. Any edit needed to
  make an old test pass is treated as evidence of a behavior change, not as test maintenance.
- **Deleting `createDataSourceFactory` moves memory's data-source construction.**
  `createMemoryDataSource` currently lives in the service file and calls `adapter.getStore(...)` to
  pre-initialize. Mitigation: the function moves onto `MemoryAdapter.createDataSource` with the same
  body and is still re-exported from its old location, so the published name keeps working and the
  pre-initialization is preserved.
- **A fake `ID1Database` can make a wrong SQL string pass.** Mitigation: `d1-sql.ts` is pure and its
  output is asserted **verbatim** rather than through the fake, so the SQL is pinned independently
  of how the fake interprets it.
- **The stale-read semantics inside a transaction could surprise an application.** Mitigation: it is
  a named design decision (§3.3), asserted by a dedicated test, and documented in three places
  (adapter JSDoc, package README, PUBLIC_API) rather than left to discovery.
- **Not verified against live D1.** CI holds no Cloudflare account, matching M52/M52b. Mitigation:
  every SQL string is asserted verbatim against the documented D1 dialect, and the platform facts
  the design rests on are cited from current docs in §1. This limitation is stated in the PR and in
  the package README rather than implied.

## 8b. Deviations from this plan, recorded during implementation

Each of these differs from what §1–§7 said. None was discovered by a gate; all came from writing the
code or the tests.

1. **`adapters/adapter.ts` had 13 importers, not the "six" §3.1 claimed** — 4 under `src/`, 9 under
   `test/`. The test files were repointed at `@hono-enterprise/common`; only the import line changed
   in each, no assertion was touched, so they remain the regression evidence §8 relies on.

2. **Three new exported option types, not the one §4 listed.** Making `DatabasePluginOptions` a
   discriminated union needed named arms to carry their own JSDoc: `BuiltInDatabaseOptions`,
   `CustomDatabaseOptions` and the shared `DatabaseConnectionOptions`. All three are in the
   PUBLIC_API Exports table added this milestone — M52b shipped `WorkersQueueArm` without one, and
   review caught it.

3. **A defect in the new code, found by the tests: methods typed `Promise<T>` that threw
   synchronously.** The buffered data source's `findAll`/`findById`/`create`/`count` and
   `D1Adapter.beginTransaction` all validated before returning a promise, so a caller using
   `.catch()` rather than `await` was bypassed entirely. This is the M52b `createQueueHandler`
   defect class. Every one is now `async`, so a refusal rejects.

4. **A defect already merged on `main`, found by a test double that honors the real contract.**
   `resolveLogger` extracted `logger.debug` into a local and invoked it **detached**. Both loggers
   `logger-plugin` ships implement `debug` via a private `#` field, and a private-field access on an
   unbound method throws `TypeError` — so `logQueries: true` failed on **every** repository call
   whenever a real logger was registered. Every existing test injected a plain-object logger, where
   a detached method works fine. Fixed, with `test/integration/logger-binding-regression.test.ts`
   driving the REAL `ConsoleLogger`; verified to fail without the fix with exactly that `TypeError`.
   `cache-plugin` already carried this regression test for the identical bug.

5. **`DatabaseService.query()`'s synchronous throw was deliberately NOT fixed.** It throws rather
   than rejecting for the memory adapter, while `migrate()` beside it rejects — the same defect
   class as (3). Two committed tests pin the current behavior, and changing it is a behavior change
   outside this milestone's scope, so it is flagged in a JSDoc note and left. Recorded here so the
   inconsistency is a known, owned decision rather than an oversight.

6. **A sixth doc conflict (C6), not in §2.** `ARCHITECTURE.md`'s "Creating a Database Adapter"
   example implemented `createTransaction()` and `migrate()` — neither of which `IOrmAdapter` has
   ever declared (it has `beginTransaction`). Corrected to the promoted `IDatabaseAdapter`.

7. **The test double is a real SQLite engine.** §6 planned a fake `ID1Database`. A scripted fake can
   only prove which calls were made — never that the generated SQL parses, that `RETURNING *` yields
   the persisted row, or that a batch rolls back. `SqliteD1` implements the facade over
   `node:sqlite`, the engine D1 itself runs, so all three are proven; `RecordingD1` remains for
   assertions about what was sent. The plan's `d1-transaction.test.ts` / `d1-adapter.test.ts` split
   was also adjusted: transaction coverage lives entirely in the former.

8. **`D1TransactionBuffer.size` was written and then deleted.** `commit()` reads `drain().length`
   instead, so the getter was dead surface whose JSDoc claimed `commit()` read it — caught by
   chasing the one sub-100% coverage number rather than by any assertion.

## 9. Out of scope

- **Migrations.** A wrangler CLI concern; the promoted port carries no `migrate()`, and
  `DatabaseService.migrate()` keeps its existing rejection.
- **Durable Objects** (`IRealtimeBackplane`, the distributed lock) — M52d.
- **A `d1` option arm on `CloudflarePlugin`** — declined with cause in §3.7, not deferred.
- **Widening `D1Result` with `meta`** — declined with cause in §3.5.
- **A `decrement`-style arithmetic method on `IRepository`** — the C1 example is corrected to use
  `update()`; adding the method would be dead surface no framework code reads.
- **Example applications** using D1 — M37.
