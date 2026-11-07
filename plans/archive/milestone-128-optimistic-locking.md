# Milestone 128 — Optimistic locking, and the database plugin under faults (`@setu-ts/database-plugin`)

> **Status:** Complete (archived). Branch: `feat/m128-optimistic-locking`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Two halves in one database-plugin milestone (maintainer decision, 2026-11-01). **Part A** closes the
`0.11.0` smoke group G1: a connection lost during a Drizzle × PostgreSQL transaction must not crash
the process (X94-1, the programme's only High); outage-time driver errors must reach the client as
the 503/504 the pool-timeout path already answers, not a masked 500 (X94-2); errors the caller's own
`transaction()` work throws must not be relabelled as database faults (V11-5); and `getRepository()`
must stop rebuilding its data source on every call (X94-3). **Part B** adds optimistic locking as
one free-function implementation over the existing conditional writes, plus the tenant-path
conditional write it needs. The boundary: database-plugin owns every behaviour; `common` gains two
optional members on each tenant contract; multi-tenancy-plugin only delegates and implements them in
its memory store.

- **In scope:** X94-1, X94-2, V11-5, X94-3; `updateVersioned` / `deleteVersioned`,
  `VersionConflictError`, `EntityNotFoundError`; optional `updateWhere?` / `deleteWhere?` on
  `ITenantDataStore` and `ITenantRepository`, implemented by `DatabaseTenantDataStore`,
  `MemoryTenantDataStore` and `TenantRepository`; docs (`PUBLIC_API.md`, database-plugin and
  multi-tenancy-plugin READMEs, `CHANGELOG.md`, `docs/upgrading.md`).
- **NOT this milestone:** a per-entity version-field declaration in adapter options (ROADMAP M128
  decision 4 — no cross-adapter entity metadata exists); stamping `version: 1` on `create`;
  classification of errors raised through the NATIVE Drizzle query handles (`getDrizzleDatabase` /
  `getDrizzleTransaction`), which are unclassified today in both scopes and stay so (§9); re-mapping
  the pre-existing `ECONNRESET`/`EPIPE`/`MongoNetworkError` → 503 arms (§8, §9); the SQLite fd-climb
  observation from X94 (`smoke/X94-X95-FINDINGS.md`, not a row; §9). Closing the four register rows
  needs a re-run on the next PUBLISHED version (each row's "Re-check after release" in the hand-off
  note) — not this PR.

## 1. Contracts verified from SOURCE (not names)

Read on `develop` at `ece8514b2` (2026-11-01).

| Reference                                      | Source (file:line)                                                                                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pg-pool checkout                               | `node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:335-344`                                                             | `_acquireClient` emits `'connect'` (new client only) then `'acquire'` (every checkout, `:340`), then `client.removeListener('error', idleListener)` (`:344`): a checked-out client carries NO `'error'` listener. `_release` re-adds the idle listener (`:385`). `pool.query` adds its own `once('error')` (`:464`) — which is why a plain query survives and a transaction does not.                                                                                                                                                                                                                                                                                                                                                                  |
| Drizzle node-postgres transaction              | `…/drizzle-orm/node-postgres/session.js:180-193`                                                                                                | `transaction()` on a pool does `await this.client.connect()` (a checked-out `PoolClient`, no listener) and releases in `finally`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| pg client error texts                          | `…/pg@8.23.1/node_modules/pg/lib/client.js:204,767,774`                                                                                         | Exactly `'Connection terminated unexpectedly'` (stream ended, not ending), `'Client has encountered a connection error and is not queryable'`, `'Client was closed and is not queryable'` (both raised before any I/O).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `attachPoolErrorListener`                      | `packages/database-plugin/src/adapters/drizzle/pool-error-listener.ts:11-32`                                                                    | Attaches ONE `'error'` listener to `database.$client` only when the pool has none; warns `'Database pool reported an idle-connection error'` with `describeError`. Called once from `plugin/database-plugin.ts:147-152` for `adapterType === 'drizzle'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DrizzleAdapter.beginTransaction`              | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:448-512`                                                                      | Two-deferred bridge over the APP-supplied `transaction` bridge; scoped sources are `#countingCompletions(createDrizzleDataSourceInner(tx, …))`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `classifyDriverError`                          | `packages/database-plugin/src/errors/classify.ts:142-174`                                                                                       | Internal (not in `src/index.ts`). Structured pass (codes, Mongo label) over the whole cause chain, then fallback (names, pg timeout anchors, SQLite unique anchor). Recognises `57P03`, class `08`, the eight `isConnectionFaultCode` codes, the two pg pool anchors and `'Query read timeout'`; NOT `57P01`/`57P02`, `'Connection terminated unexpectedly'`, the two "not queryable" texts, any Prisma P1xxx/P2024/P2028, mysql2 connection loss, Mongo wait-queue/pool-cleared/not-primary, or `SQLITE_BUSY`. `DriverErrorClass` is internal.                                                                                                                                                                                                        |
| `isConnectionFaultCode`                        | `packages/common/src/errors/connection-fault.ts:8-29`                                                                                           | Eight codes incl. `ECONNREFUSED`, `ECONNRESET`, `EPIPE` → `'unavailable'` (the V11-5 mechanism).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DatabaseUnavailableError`                     | `packages/database-plugin/src/errors.ts:569-588`                                                                                                | 503, served detail `'The database is temporarily unavailable. The request was not applied.'` — a promise that the operation did NOT happen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DatabaseTimeoutError`                         | `packages/database-plugin/src/errors.ts:589-618`                                                                                                | 504, served detail `'The database did not answer in time.'`; documented "the outcome of a write is **unknown**".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DatabaseService.transaction`                  | `packages/database-plugin/src/services/database-service.ts:270-321`                                                                             | `catch` rethrows `classifiedOrOriginal(error, …)` for EVERY error `work` throws (`:319`); commit errors go to `duplicateAtCommitOrOriginal` (`:313`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `classifiedOrOriginal` / `scrubDriverError`    | `database-service.ts:87-115`; `errors/scrub.ts:14-55`                                                                                           | Scrub returns the SAME object when no Drizzle `Failed query:` wrapper or class-22 code is in the chain (identity preserved for a foreign error).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `IUnitOfWork`                                  | `packages/database-plugin/src/interfaces/index.ts:~202`                                                                                         | Public surface is `getRepository` only — no public `commit`/`rollback`, so `work` reaches the database only through wrapped repositories or the native Drizzle handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DatabaseService.getRepository`                | `database-service.ts:261-267`                                                                                                                   | Closed check, then `wrapDataSource(entity, this._createDataSource(entity))` and `new InternalRepo` on every call. `close()` sets `_closed` (`:439-443`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Dynamo access path                             | `adapters/dynamo/dynamo-data-source.ts:128,164,188`                                                                                             | `lastAccessPath` is per data-source state, set at the START of each read and read by the logging wrapper after `await` (`database-service.ts:512,568,648`) — a shared source would race under concurrent reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Drizzle `#countingCompletions`                 | `drizzle-adapter.ts:575-586`                                                                                                                    | Wraps every method; counts into the ADAPTER's `#completedQueries`, so the counter is adapter-level, not per data source — sharing is safe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BaseRepository.updateWhere` / `deleteWhere`   | `packages/database-plugin/src/repositories/base-repository.ts:118-170`                                                                          | `checkWritePrecondition` → `UnsupportedQueryFeatureError('write-precondition')`; absent source member → `UnsupportedQueryFeatureError('conditional-write')`; miss → `null` / `false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `UnsupportedQueryFeatureError`                 | `errors.ts:298-331,105-110`                                                                                                                     | 501 hint for features in `QUERY_SHAPE_FEATURES` (includes `'conditional-write'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `conditionalUpdate` / `conditionalDelete`      | `packages/database-plugin/src/repositories/conditional-write.ts:22-61`                                                                          | Internal; map absent member or the `conditional-write` refusal to `{ outcome: 'unsupported' }` (the tenant store's racy fallback trigger).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `checkWritePrecondition` / `WritePrecondition` | `packages/common/src/index.ts:718-719`; `common/src/services/write-precondition.ts`                                                             | Exported from common; equality map of strings and finite numbers, copies `where` and `data`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DuplicateKeyError`                            | `packages/common/src/errors/duplicate-key.ts:49-77`                                                                                             | Precedent shape: `entity: string \| undefined`, `withHttpStatusHint` 409 `Conflict`, fixed served detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ITenantRepository` / `ITenantDataStore`       | `packages/common/src/services/tenancy.ts:30-43,143-173`                                                                                         | Neither has a conditional member. `update` takes `data: Readonly<Record<string, unknown>>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DatabaseTenantDataStore.update` / `delete`    | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts:260-310`                                                                    | Strips the tenant column from data, `conditionalUpdate(repo, id, { [col]: tenantId }, stripped)`; on `'unsupported'` falls back to a racy check-then-write; post-checks `updated[col] === tenantId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TenantRepository`                             | `packages/multi-tenancy-plugin/src/repositories/tenant-repository.ts:16-46`                                                                     | Internal class; delegates each member to the store with captured tenant id and entity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MemoryTenantDataStore.update` / `delete`      | `packages/multi-tenancy-plugin/src/stores/memory-tenant-store.ts:150-176`                                                                       | Synchronous map read/merge/write (atomic within one call); strips `id`. multi-tenancy-plugin depends on `common` only (`package.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Conformance table                              | `packages/database-plugin/test/fixtures/conditional-sources.ts:40-131`; `test/unit/conditional-write-conformance.test.ts:67-132`                | Eight sources (dynamodb, memory, prisma, drizzle, mongodb, cosmos, bigtable, d1) and a "deferred transaction refuses conditional writes" block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Structural typing                              | probe `scratchpad/tsprobe/p.ts`, `tsc --strict --exactOptionalPropertyTypes`                                                                    | A `VersionedWritable<E, Id>` with method-syntax `updateWhere?(id, where, data: Readonly<Partial<E>>)` accepts both `IRepository<Article>` (`data: Partial<E>`) and `ITenantRepository<Article>` (`data: Readonly<Record<string, unknown>>`), infers `E` from `findById`, and still rejects an unknown data field.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| X94-1 repro                                    | `~/Projects/hono-enterprise-published-smoke/v0.11.0/part21/x94/out/repro/`; workload `x94-drizzle-pg/src/controllers/items.controller.ts:60-80` | `/transfer?hold=4000`: update + create, a 4 s sleep inside the transaction, then two more writes. Kill during the sleep → the client is idle-in-transaction → unhandled `'error'` → exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| X94-2 messages                                 | `part21/x94/out/<cell>/run/app.log` (500 lines, cause chains, 2026-11-01 tally)                                                                 | drizzle-pg: `'Connection terminated unexpectedly'`, `'terminating connection due to administrator command'`; drizzle-my: `'Connection lost: The server closed the connection.'`, `'Server shutdown in progress'`; drizzle-lite: `LibsqlError 'SQLITE_BUSY: database is locked'`; prisma-*: `PrismaClientKnownRequestError` `'Transaction API error: Unable to start a transaction in the given time.'`, pool text `'(pool connections: active=10 idle=0 limit=10)'`, `'Database error. Code: \`57P01\`'`, MySQL `45009`/`45013`/`1053`; mongo: `MongoWaitQueueTimeoutError`, `MongoServerError 'not primary'`, `MongoPoolClearedError`. **The logger drops `code`**, so Prisma/mysql2/libsql/Mongo CODES are not in the evidence — §3.2 measures them. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                               | Doc deliverable (same PR)                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `DatabaseUnavailableError` serves "The request was not applied", yet a connection lost while a statement is in flight (no server verdict) has an unknown outcome, and ROADMAP's X94-2 list puts "Connection terminated unexpectedly" beside the 503 signals.             | The served promise wins. In-flight loss without a server verdict maps to `DatabaseTimeoutError` (504, "outcome unknown"); a server verdict or a refusal before I/O maps to 503 (§3.2). | `PUBLIC_API.md` database-plugin "driver errors" table lists every new anchor with its status and whether a write may have applied; CHANGELOG `Fixed`. |
| C2  | The X94 ROADMAP gate says the X94-1 request "answers 503". With the kill during the hold, the next statement is refused before I/O (`not queryable`) → 503; a kill landing on an in-flight statement yields `57P01` → 503 or `Connection terminated unexpectedly` → 504. | The gate drives the hold shape (kill while idle in transaction), which must answer 503; the in-flight shape is a second case asserting 503 or 504, never 500 and never a crash.        | ROADMAP M128 gate line amended to say so.                                                                                                             |
| C3  | `next-release-framework-gaps.md` gap 2 sketches `deleteVersioned(...): Promise<void>` with no entity name, but decision 2 says each error "carries the entity". The structural repository has no entity name.                                                            | An optional `entity` option feeds both errors' `entity` field; absent → `undefined`, as `DuplicateKeyError` already allows.                                                            | `PUBLIC_API.md` signatures.                                                                                                                           |

## 3. Design decisions

### 3.1 X94-1 — every checked-out pg client gets an `'error'` listener

- **Decision:** `attachPoolErrorListener` (same file, same single call site) additionally registers
  a pool `'acquire'` handler when the pool exposes `on`. On each acquire, a client not yet in a
  module-level `WeakSet` gets ONE permanent `'error'` listener and is added to the set. The listener
  warns `'Database pool reported a checked-out-connection error'` with
  `{ error: describeError(error) }` and never rethrows. It is attached regardless of the pool-level
  guard (an app's own pool `'error'` listener does not cover checked-out clients). The function's
  return value keeps its current meaning (whether the POOL listener was attached). The in-flight
  request then answers through the classifier: the held transaction's next statement is refused with
  `'Client has encountered a connection error and is not queryable'` → `DatabaseUnavailableError`
  (§3.2) → `transaction()` rolls back (rollback failure ignored, as today) → 503.
- **Why:** `'acquire'` is pg-pool's public event and fires for every checkout, including clients
  created before the plugin attached; `'connect'` fires only for new clients. A WeakSet keeps it to
  one listener per client and lets destroyed clients be collected. The client's own `'error'` is the
  only place the event surfaces while a transaction holds it.
- **Test home:** `test/unit/pool-error-listener.test.ts` (fake EventEmitter pool: one listener per
  client across repeated acquires; app pool listener present → pool listener skipped, client
  listener still attached; emitting `'error'` on a checked-out fake does not throw; warn text);
  `test/integration/real-drizzle-adapter.test.ts` new guarded case **"a backend killed during an
  open Drizzle transaction answers 503 and the process lives"**: a real `Pool` wrapped by
  `createDrizzleDatabase(db, (database, work) => database.transaction(work))`, registered through
  `DatabasePlugin` on a kernel app (so `register()` attaches the listener), `transaction()` that
  writes, awaits a deferred, then writes again; `pg_terminate_backend` from a control pool while the
  deferred is pending; assert the rejection is `DatabaseUnavailableError` with status hint 503,
  `pool.query('SELECT 1')` still answers, and (vitest fails on an uncaught exception) the suite
  completes. Must FAIL with the `'acquire'` registration removed. Second case: kill during an
  in-flight `pg_sleep` via the repository-wrapped path → `DatabaseUnavailableError` or
  `DatabaseTimeoutError`, never a crash.

### 3.2 X94-2 — measured anchors, one rule for the status

- **Decision:** the classifier gains anchors for the X94 signals. The STATUS follows one rule: **503
  (`'unavailable'`)** when the server gave a verdict that the statement did not run, or the driver
  refused before sending it; **504 (`'timeout'`)** when the connection was lost while a statement
  was in flight with no verdict (outcome unknown). **Measured 2026-11-01** (probes in the session
  scratchpad; x94-pg pg 16, x94-mysql MySQL 8, x94-mongo-rs single-node replica set, libsql 0.18,
  Prisma 7.10.1 over adapter-pg and adapter-mariadb). Only these rows ship:

  | Backend              | Signal (how matched)                                                                                                                      | Measured as                                                                                                                                 | Class                  |
  | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
  | pg                   | string code `57P01`                                                                                                                       | in-flight query killed by `pg_terminate_backend`; also the client `'error'` event when idle in a transaction                                | unavailable            |
  | pg                   | exact message `'Client has encountered a connection error and is not queryable'`, chain without a string code                             | next statement on a client whose connection died while idle in a transaction (the X94-1 shape)                                              | unavailable            |
  | pg                   | exact message `'Client was closed and is not queryable'`, chain without a string code                                                     | pg source (`client.js:774`), raised before I/O; pinned by a real test (`client.end()` then query)                                           | unavailable            |
  | pg                   | exact message `'Connection terminated unexpectedly'`, chain without a string code                                                         | X94 drizzle-pg/prisma-pg logs, in-flight queries during the kill phase                                                                      | timeout                |
  | Prisma               | string code `P1001`                                                                                                                       | unreachable host (`DriverAdapterError` kind `DatabaseNotReachable`)                                                                         | unavailable            |
  | Prisma               | string code `P2028`                                                                                                                       | `$transaction` start exceeding `maxWait`                                                                                                    | unavailable            |
  | Prisma               | `P2039` / `P2010` whose `meta.driverAdapterError.cause.originalCode` is a string: that code is classified as a further cause-chain member | adapter-pg: `originalCode: '57P01'` (model query `P2039`, raw `P2010`); adapter-mariadb: `'45009'`, `'45028'`; X94 logs `'45013'`, `'1053'` | per the code's own row |
  | mariadb (via Prisma) | `originalCode` `'45028'` ER_GET_CONNECTION_TIMEOUT, `'45013'` ER_CMD_CONNECTION_CLOSED, `'1053'` server shutdown                          | pool timeout; command on a closed connection; shutdown                                                                                      | unavailable            |
  | mariadb (via Prisma) | `originalCode` `'45009'` ER_SOCKET_UNEXPECTED_CLOSE                                                                                       | in-flight query, connection KILLed                                                                                                          | timeout                |
  | mysql2               | string code `PROTOCOL_CONNECTION_LOST`                                                                                                    | in-flight query, connection KILLed                                                                                                          | timeout                |
  | mysql2               | string code `ER_SERVER_SHUTDOWN`                                                                                                          | mysql2 source (`constants/errors.js:2229`, `packets/packet.js:931`); X94 log text `'Server shutdown in progress'`                           | unavailable            |
  | libsql               | string code `SQLITE_BUSY` (on `LibsqlError` and its `SqliteError` cause)                                                                  | second writer while a write transaction is open                                                                                             | unavailable            |
  | MongoDB              | name `MongoWaitQueueTimeoutError`                                                                                                         | `maxPoolSize: 1`, `waitQueueTimeoutMS: 200`, pool held                                                                                      | unavailable            |
  | MongoDB              | name `MongoPoolClearedError`                                                                                                              | X94 mongo logs (name; the pool clear could not be forced on demand)                                                                         | unavailable            |
  | MongoDB              | numeric code `10107` (`NotWritablePrimary`), only under `adapterType === 'mongodb'`                                                       | write after `replSetStepDown`                                                                                                               | unavailable            |

  **Dropped (not reproduced, not shipped):** pg `57P02`; Prisma `P1017`, `P2024` (Prisma over
  adapter-pg surfaces the pg pool anchor, already classified); Mongo `13435`, `11600`, `91`; a
  `'database is locked'` message anchor (libsql carries the code). The anchor set lives in
  `classify-driver-error.test.ts` as DATA (one row per signal: input shape → class), per CLAUDE.md
  "a set belongs in the test as data". PostgreSQL and MongoDB rows are additionally pinned by
  guarded real-backend tests (CI runs both); MySQL, mariadb and libsql rows cite this probe, as
  `ER_DUP_ENTRY` did (`classify.ts:73-80` precedent).

- **Why:** the served `503` detail promises "not applied" (C1); a lost connection mid-statement
  cannot promise that, and the 504 class already means "outcome unknown". The evidence logs drop
  `code` (§1), so the codes must be measured, not remembered.
- **Test home:** `test/unit/classify-driver-error.test.ts` (data table + the code-outranks-message
  rule for each new message anchor); `test/integration/outage-real.test.ts` new guarded cases (pg
  `pg_terminate_backend` on an in-flight query; Mongo stepDown or pool-clear where the CI replica
  set allows it — otherwise the unit row cites the probe); `test/unit/error-status-hints.test.ts`
  (each class's served status/detail unchanged).

### 3.3 V11-5 — `transaction()` never classifies the work's own errors

- **Decision:** in `DatabaseService.transaction`'s catch, an error raised by `work` (i.e. not during
  `commit`) is rethrown as `scrubDriverError(error)` — never passed to `classifyDriverError`. Begin
  errors keep `classifiedOrOriginal` (unchanged, `:288-290`); commit errors keep
  `duplicateAtCommitOrOriginal` (unchanged). Repository calls inside `work` are already classified
  by `wrapDataSource`, so a database fault from a repository still reaches the caller as
  409/503/504.
- **Why:** `IUnitOfWork` exposes only `getRepository` (§1), so the only database calls `work` can
  make outside a wrapped repository are through the native Drizzle transaction handle — which is
  unclassified in the outer scope already, so leaving it unclassified here makes the two scopes
  agree. Scrubbing (not classifying) keeps the existing guarantee that a native Drizzle error's
  bound values never reach a log, and `scrubDriverError` returns the same object for a foreign
  error, so the caller gets its own error back by identity.
- **Test home:** `test/unit/database-service.test.ts`: `transaction(async () => { throw err })`
  where `err` carries `code: 'ECONNREFUSED'` (and a `TypeError('fetch failed')` with that cause)
  rejects with `toBe(err)`; a work error with `code: '40001'` is NOT turned into
  `SerializationConflictError`; a repository-raised 40001 inside `work` still is; a native-shaped
  Drizzle `Failed query:` error thrown from `work` comes back scrubbed. Must fail without the fix.

### 3.4 X94-3 — `getRepository` memoizes per entity on the outer scope

- **Decision:** `DatabaseService` keeps a private `Map<string, IRepository<unknown, EntityKey>>`.
  `getRepository(entity)` checks `_closed` FIRST (unchanged message), then returns the cached
  repository, else builds it exactly as today and caches it. Not cached: (a) a build that throws
  (nothing stored; the next call rebuilds and throws again, as today); (b) a data source exposing
  `getLastAccessPath` while `logQueries` is on (the Dynamo access-path log would race, §1).
  `close()` clears the map. Transaction-scoped repositories (`UnitOfWork`'s factory) are never
  cached. `TenantRepository` objects are built by multi-tenancy-plugin and are not in this map; the
  tenant store's outer repository may be shared because the store adds its tenant precondition per
  call and the repository carries no tenant state.
- **Why:** the profile attributes the whole point-read gap to the rebuild
  (`~/setu-benchmarks/2026-10-31-db/results/PROFILE.md`: Drizzle 38.0 → 36.2 µs, Prisma 40.3 → 38.5
  µs CPU/request when fetched once). `getRepository` per handler is the documented usage, so the fix
  must be inside the service, not in the docs.
- **Test home:** `test/unit/database-service.test.ts`: same entity → same object, `createDataSource`
  called once; different entities → different objects; after `close()` → throws, and a second
  service-level call does not resurrect the cache; a throwing factory is retried; Dynamo-style
  source with `logQueries` on → a fresh object per call; UoW repositories are distinct per
  transaction. Benchmark before/after (§7).

### 3.5 `updateVersioned` / `deleteVersioned` — one implementation over the structural minimum

- **Decision:** new `src/repositories/versioned-write.ts`, exported from the barrel:

  ```ts
  export interface VersionedWritable<E, Id> {
    updateWhere?(id: Id, where: WritePrecondition, data: Readonly<Partial<E>>): Promise<E | null>;
    findById(id: Id): Promise<E | null>;
  }
  export interface VersionedDeletable<E, Id> {
    deleteWhere?(id: Id, where: WritePrecondition): Promise<boolean>;
    findById(id: Id): Promise<E | null>;
  }
  export interface VersionedWriteOptions {
    readonly field?: string;   // default 'version'
    readonly entity?: string;  // carried by the two errors, never by their served detail
  }
  export function updateVersioned<E, Id>(repo: VersionedWritable<E, Id>, id: Id,
    expectedVersion: number, data: Readonly<Partial<E>>, options?: VersionedWriteOptions): Promise<E>;
  export function deleteVersioned<E, Id>(repo: VersionedDeletable<E, Id>, id: Id,
    expectedVersion: number, options?: VersionedWriteOptions): Promise<void>;
  ```

  Order, all refusals BEFORE any I/O: (1) `expectedVersion` must be a non-negative safe integer and
  `expectedVersion + 1` safe, else
  `UnsupportedQueryFeatureError('write-precondition', 'database-plugin', …)`; (2) `field` must be a
  non-empty string (default `'version'`); (3) `data` must not own the field, else the same
  `write-precondition` refusal; (4) `repo.updateWhere` / `deleteWhere` absent →
  `UnsupportedQueryFeatureError('conditional-write', …)` (501, the existing refusal). Then
  `updateWhere(id, { [field]: expectedVersion }, { ...data, [field]: expectedVersion + 1 })`; a row
  → returned as-is; `null` → `findById(id)`: `null` → `EntityNotFoundError`, a row →
  `VersionConflictError`. `deleteVersioned` mirrors it with `deleteWhere`; `true` → resolve. A
  `conditional-write` refusal thrown BY the repository (the buffered transaction sources) propagates
  unchanged. The re-read happens after the failed write, so a delete racing in between reports 404 —
  documented: both answers are true at the moment of the re-read.

- **Why:** a free function, not an `IRepository` member: `IRepository` has external implementers
  (`repository-implementor-contract.test.ts`) and a required member would break them. The structural
  minimum also accepts unit-of-work and tenant repositories (§1 probe), so there is one
  implementation for every entry point.
- **Test home:** `test/unit/versioned-write.test.ts` (each refusal before I/O with a recording fake
  asserting zero calls; applied; conflict; not-found; custom `field`; `entity` carried; a
  repository-thrown `conditional-write` refusal passes through); the versioned row in
  `conditional-write-conformance.test.ts` across all eight sources (applied → version+1, stale →
  `VersionConflictError`, missing → `EntityNotFoundError`); a transaction table AS DATA in the same
  file: `{ drizzle, prisma, mongodb } → applies`,
  `{ memory overlay, d1, dynamodb, cosmos, bigtable } → 501 conditional-write`; a type-level test
  (`expectTypeOf` or a compile-only fixture under `pnpm run check`) that `IRepository<Article>`,
  `uow.getRepository<Article>()` and `ITenantRepository<Article>` are all accepted and an unknown
  data field is rejected.

### 3.6 `VersionConflictError` and `EntityNotFoundError`

- **Decision:** both in `src/errors.ts`, exported. Each has `name`,
  `readonly entity: string | undefined`, a full diagnostic `message` (may name the entity, never ids
  or values) and `withHttpStatusHint`: `VersionConflictError` →
  `{ status: 409, title: 'Conflict', detail: 'The record was changed after it was read. Reload it and try again.' }`;
  `EntityNotFoundError` →
  `{ status: 404, title: 'Not Found', detail: 'The record does not exist.' }`. Neither is classified
  by `classifyDriverError` (they carry a hint, so `classifiedOrOriginal` returns them untouched,
  `database-service.ts:92`).
- **Why:** with `errorHandler` registered an app gets an RFC 9457 409/404 with no extra code, and
  the served detail cannot leak a key.
- **Test home:** `test/unit/error-status-hints.test.ts` (hint per class); new
  `test/integration/versioned-write-status.test.ts`: a kernel app with `errorHandler` from
  `@setu-ts/exceptions` (wired as `refusal-status.test.ts` does), memory adapter, a route calling
  `updateVersioned` with a stale version → `409`, `content-type: application/problem+json`, body
  field by field `type`, `title: 'Conflict'`, `status: 409`, `detail` exactly the fixed sentence,
  `instance` the request path (formatter-owned, so it may contain the route's id); ABSENT from the
  body: `message`, `entity`, the version values; `detail` and `title` contain neither the id nor a
  version; same for 404.

### 3.7 Tenant-path conditional writes

- **Decision:** `common/src/services/tenancy.ts` adds OPTIONAL members:
  `ITenantDataStore.updateWhere?<E, Id>(tenantId, entity, id, where: WritePrecondition, data: Readonly<Record<string, unknown>>): Promise<E | null>`,
  `ITenantDataStore.deleteWhere?<Id>(tenantId, entity, id, where): Promise<boolean>`, and
  `ITenantRepository.updateWhere?(id, where, data)` / `deleteWhere?(id, where)`. Absence means "no
  conditional writes" (so `updateVersioned` answers the 501).
  - `DatabaseTenantDataStore.updateWhere`: refuse a `where` owning the tenant column with
    `UnsupportedQueryFeatureError('write-precondition', …)` whose message does NOT contain the
    column name; strip the tenant column from `data` (as `update` does); call
    `repo.updateWhere(id, { ...where, [col]: tenantId }, stripped)` DIRECTLY — no
    `conditionalUpdate` fallback, so a source without conditional writes surfaces the
    `conditional-write` 501 instead of the racy check-then-write; keep the
    `updated[col] !== tenantId` post-check. `deleteWhere` mirrors it. An empty stripped `data` goes
    to `BaseRepository`, which refuses it (unchanged behaviour of `updateWhere`).
  - `MemoryTenantDataStore.updateWhere` / `deleteWhere`: `checkWritePrecondition` from common
    (refusal → `TypeError` with the checker's problem text); when the isolation strategy is
    `'column'`, refuse a `where` owning `getTenantColumn()` (`TypeError`, column not named); match
    every `where` key with `===` against the stored row; apply exactly as `update`/`delete` do. One
    synchronous call, so atomic.
  - `TenantRepository`: assigns `updateWhere` / `deleteWhere` in its constructor ONLY when the store
    has them (declared as optional readonly members), so absence is preserved end to end.
- **Why:** optional members keep every custom store compiling; delegating directly (no fallback) is
  the only way a version check stays a single atomic precondition.
- **Test home:** `packages/database-plugin/test/unit/database-tenant-data-store.test.ts` (merge,
  tenant-column refusal without echo, foreign row not updated, 501 on a non-conditional source with
  zero writes); `test/integration/tenant-store-race-real.test.ts` new guarded case: two concurrent
  `updateVersioned(tenantRepo, …)` with the same expected version on real PostgreSQL → exactly one
  applies, the other `VersionConflictError`;
  `packages/multi-tenancy-plugin/test/unit/memory-tenant-store.test.ts` and
  `tenant-repository.test.ts` (match/miss, column refusal, member absent when the store lacks it).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Every new member on a `common` interface is optional; the
X94-2/V11-5 status changes are behaviour fixes recorded under CHANGELOG `Fixed` (a work error that
used to arrive as `DatabaseUnavailableError` now arrives as itself). Ships in minor `0.12.0`.

| Exported symbol                                            | Kind             | Consumer / real code path that READS it                                                                                                                                            |
| ---------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updateVersioned` (database-plugin)                        | fn               | Application routes (CMS demo D5 replaces its hand-written read-version/`updateWhere`/re-read); `test/integration/versioned-write-status.test.ts` drives it through a kernel route. |
| `deleteVersioned` (database-plugin)                        | fn               | Same, for deletes.                                                                                                                                                                 |
| `VersionedWritable`, `VersionedDeletable`                  | type             | The parameter types of the two functions; every caller's repository is checked against them.                                                                                       |
| `VersionedWriteOptions`                                    | type             | The `options` parameter of both functions.                                                                                                                                         |
| `VersionConflictError`                                     | class            | Thrown by both functions; read by `errorHandler` through its status hint; apps `instanceof` it.                                                                                    |
| `EntityNotFoundError`                                      | class            | Same.                                                                                                                                                                              |
| `ITenantDataStore.updateWhere?` / `deleteWhere?` (common)  | optional members | Read by `TenantRepository`'s constructor (presence) and its delegating calls.                                                                                                      |
| `ITenantRepository.updateWhere?` / `deleteWhere?` (common) | optional members | Read by `updateVersioned` / `deleteVersioned` through the structural types.                                                                                                        |

### 4.1 Options — every option names its consumer

| Option                         | Consumer                                                    | Behavior (per implementation)                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VersionedWriteOptions.field`  | `updateVersioned`, `deleteVersioned`                        | Names the version column in both the precondition and the written payload; default `'version'`; empty string refused before I/O. Same for every adapter (it is just a key). |
| `VersionedWriteOptions.entity` | `VersionConflictError` / `EntityNotFoundError` constructors | Stored as `.entity` and in the log diagnostic; never in the served detail.                                                                                                  |

## 5. Implementation files

| File                                                                                                                                                                                                 | Purpose                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/database-plugin/src/index.ts`                                                                                                                                                              | Export the six new database-plugin symbols.                                                                         |
| `packages/database-plugin/src/repositories/versioned-write.ts`                                                                                                                                       | New: §3.5.                                                                                                          |
| `packages/database-plugin/src/errors.ts`                                                                                                                                                             | `VersionConflictError`, `EntityNotFoundError` (§3.6).                                                               |
| `packages/database-plugin/src/errors/classify.ts`                                                                                                                                                    | Measured anchors (§3.2).                                                                                            |
| `packages/database-plugin/src/adapters/drizzle/pool-error-listener.ts`                                                                                                                               | Checked-out client listener (§3.1).                                                                                 |
| `packages/database-plugin/src/services/database-service.ts`                                                                                                                                          | V11-5 catch (§3.3); repository cache (§3.4).                                                                        |
| `packages/database-plugin/src/tenancy/database-tenant-data-store.ts`                                                                                                                                 | `updateWhere` / `deleteWhere` (§3.7).                                                                               |
| `packages/common/src/services/tenancy.ts`                                                                                                                                                            | Optional members (§3.7).                                                                                            |
| `packages/multi-tenancy-plugin/src/stores/memory-tenant-store.ts`                                                                                                                                    | `updateWhere` / `deleteWhere` (§3.7).                                                                               |
| `packages/multi-tenancy-plugin/src/repositories/tenant-repository.ts`                                                                                                                                | Conditional delegation (§3.7).                                                                                      |
| `PUBLIC_API.md`, `packages/database-plugin/README.md`, `packages/multi-tenancy-plugin/README.md`, `CHANGELOG.md`, `docs/upgrading.md`, `ROADMAP.md` (C2 gate line, tracking row), `CLAUDE.md` status | Docs; optimistic-locking section in the database-plugin README with the tenant example and the 404-after-race note. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                               | src covered                                     | Key assertions (and the signature each call type-checks against)                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `database-plugin/test/unit/versioned-write.test.ts` (new)               | `repositories/versioned-write.ts`               | §3.5 refusals with zero calls, applied/conflict/not-found, `field`, `entity`, pass-through refusal; calls type-check against §3.5's signatures. |
| `database-plugin/test/unit/conditional-write-conformance.test.ts`       | `versioned-write.ts` over all eight sources     | Versioned row per source; transaction outcome table as data.                                                                                    |
| `database-plugin/test/unit/versioned-write-types.test.ts` (new)         | type surface                                    | `expectTypeOf`: `IRepository<Article, string>`, UoW repository, `ITenantRepository<Article, string>` accepted; `{ nope: 1 }` rejected.          |
| `database-plugin/test/integration/versioned-write-status.test.ts` (new) | `errors.ts` hints via `errorHandler`            | 409/404 Problem Details field by field, forbidden fields absent.                                                                                |
| `database-plugin/test/unit/error-status-hints.test.ts`                  | `errors.ts`                                     | Hints for the two new classes; 503/504 details unchanged.                                                                                       |
| `database-plugin/test/unit/classify-driver-error.test.ts`               | `errors/classify.ts`                            | Measured anchor table as data; code outranks message; numeric Mongo codes only under `mongodb`.                                                 |
| `database-plugin/test/integration/outage-real.test.ts`                  | `classify.ts` real pins                         | Guarded pg in-flight termination; Mongo where reproducible.                                                                                     |
| `database-plugin/test/unit/pool-error-listener.test.ts`                 | `pool-error-listener.ts`                        | §3.1 unit cases.                                                                                                                                |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts`         | `pool-error-listener.ts`, `database-service.ts` | §3.1 X94-1 gate (fails without the fix).                                                                                                        |
| `database-plugin/test/unit/database-service.test.ts`                    | `services/database-service.ts`                  | §3.3 and §3.4 cases.                                                                                                                            |
| `database-plugin/test/unit/database-tenant-data-store.test.ts`          | `tenancy/database-tenant-data-store.ts`         | §3.7 store cases.                                                                                                                               |
| `database-plugin/test/integration/tenant-store-race-real.test.ts`       | tenant path end to end                          | Guarded concurrent versioned update: one applies, one 409.                                                                                      |
| `multi-tenancy-plugin/test/unit/memory-tenant-store.test.ts`            | `stores/memory-tenant-store.ts`                 | Match/miss, column refusal, checker refusal.                                                                                                    |
| `multi-tenancy-plugin/test/unit/tenant-repository.test.ts`              | `repositories/tenant-repository.ts`             | Members present iff the store has them; delegation threads tenant id and entity.                                                                |
| `common`                                                                | `services/tenancy.ts`                           | Types only (no runtime), checked by `pnpm run check` and the type test above.                                                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m128-optimistic-locking
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local          # final commit; all shards, real backends
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

During fix rounds: `pnpm test:coverage database-plugin common multi-tenancy-plugin --no-tooling`,
ANSI-stripped per-file table, every changed `src` file ≥90% branch/function/line. Real backends via
the full-backend env block (memory note `full-backend-test-command`); the ignored count proves the
guarded suites ran.

**Milestone-specific proofs (Claude, after implementation):**

- **X94-1 at the real surface:** the `part21/x94/out/repro/` sequence against the `x94-drizzle-pg`
  workload with the branch's packed `@setu-ts/*` tarballs: the process lives and
  `POST /transfer?hold=4000` answers 503; control: the same on published 0.11.0 exits.
- **X94-3:** `~/setu-benchmarks/2026-10-31-db/` pairs `setu-drizzle,hono-drizzle` and
  `setu-prisma,nest-prisma`, `SERVER_CORES=8-15 LOAD_CORES=16-23`, local tarballs per the harness
  README; scope and minutes agreed with the maintainer before running (memory note
  `benchmark-scope-ask-first`).
- Fail-without-fix for X94-1, V11-5 and X94-3's identity test.

## 8a. Design security review

> Added after implementation, before the committed-tree audit: the plan as first written named no
> audit and carried no review, although the tenant-path change crosses the tenancy boundary and the
> pool listener adds a log line. Written by the planner; the audit runs in a fresh context against
> it.

- **Reviewed flows:**
  - **F1 — tenant-scoped conditional write.** An HTTP request whose tenant the multi-tenancy
    middleware resolved reaches an application handler, which calls `updateWhere` / `deleteWhere` or
    `updateVersioned` / `deleteVersioned` on the tenant repository; `TenantRepository` delegates to
    `DatabaseTenantDataStore` (over `IDatabaseService`) or `MemoryTenantDataStore`. The request
    controls the record id, the precondition values (typically the version from the body) and the
    update payload's fields and values.
  - **F2 — versioned-write refusal.** A stale or missing record produces `VersionConflictError` /
    `EntityNotFoundError`, served by `errorHandler` as Problem Details and logged.
  - **F3 — checked-out connection error.** A pg client checked out by a Drizzle transaction emits
    `'error'`; the plugin's listener logs it at `warn` through `describeError`.
  - **F4 — driver error classification.** A driver rejection (now including Prisma's
    `meta.driverAdapterError.cause`) is read by `classifyDriverError` and served as a fixed-detail
    `503` / `504`, the scrubbed driver error kept as `cause`.
  - **F5 — transaction work errors.** An error the caller's transaction work throws reaches the
    caller unclassified (only scrubbed).
  - **F6 — shared outer repository.** `getRepository(entity)` returns one instance per entity for
    every request and every tenant.
- **Assets:** another tenant's rows (confidentiality, integrity, existence); the tenant column's
  integrity (a row must never move between tenants); record ids and version values (not served in a
  refusal's body); bound statement values, credentials and SQL inside driver errors (never served,
  never logged unscrubbed); log integrity; process availability.
- **Attackers:** an authenticated user of tenant A sending arbitrary ids, preconditions and payloads
  (including the tenant column, `__proto__`, numeric strings, values of the wrong type); a database
  server or network that fails, terminates connections, or returns hostile error text; an
  application handler that passes request input into a repository call as documented.
- **Budgets:** one `warn` per `'error'` event of a checked-out client (no request can trigger one
  without a database fault); `checkedOutListeners` holds at most one entry per client currently
  checked out (removed on `'release'`, weakly held); `_repositories` holds one entry per distinct
  entity name the application passes to `getRepository` — entity names are application constants,
  and a build that throws (an unknown Drizzle or Prisma entity) caches nothing; no new numeric
  option is added.
- **Audit obligations:**
  1. With two tenants holding rows under the SAME id and version, prove tenant A's `updateWhere`,
     `deleteWhere`, `updateVersioned` and `deleteVersioned` never change or remove tenant B's row,
     on `DatabaseTenantDataStore` (memory backend, and real PostgreSQL through Drizzle) and on
     `MemoryTenantDataStore`; positive control: tenant B's own call succeeds.
  2. Prove the tenant column cannot be set through `data` (stripped) or named in `where` (refused,
     message without the column name) — under its resolved property AND its configured column name
     when the two differ (a Drizzle table whose property is not the column name); positive control:
     a precondition on another field applies.
  3. Prove a cross-tenant `updateVersioned` / `deleteVersioned` answers `404`, the same as a missing
     id, never `409`: no existence oracle across tenants.
  4. Plant canaries in the record id, the version values, the payload and the entity name, and prove
     their absence from the `409` / `404` body (`instance` excepted, which is the request path);
     show the logged line carries no payload value.
  5. Plant canaries in a driver error's message, `cause` chain and Prisma `meta`, and in a
     transaction work error; prove none reaches a response body, and that CR/LF/NUL in a checked-out
     client's error text cannot split the `warn` line.
  6. Drive hostile values into the precondition and payload on both tenant stores (`__proto__`,
     `constructor` keys, getters that throw, a revoked `Proxy`, non-finite numbers) and into
     `classifyDriverError`'s Prisma `meta` path; expected: refused or ignored, never a crash or a
     widened match.
  7. Prove a shared outer repository leaks nothing between requests: concurrent tenant A and B
     operations through `DatabaseTenantDataStore` each see only their rows; positive control: each
     sees its own.
  8. Show the pg listener cannot be made to keep a client's listener after release, and that the
     process survives a terminated backend during an open transaction (live PostgreSQL).

| Threat                                                         | Resolution                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant A writes tenant B's row through a matching precondition | §3.7: the tenant column joins the caller's `where` as one precondition, set LAST in the spread                                         |
| A row moved between tenants through the payload                | §3.7: the tenant column is stripped from `data` on both stores; the Database store post-checks the returned row's tenant               |
| The precondition overrides or widens the tenant predicate      | §3.7: a `where` naming the tenant column (property or configured column) is refused before any write                                   |
| A racy ownership check                                         | §3.7: no check-then-write fallback on the conditional path; a source without conditional writes answers `501`                          |
| Cross-tenant existence oracle through 409 vs 404               | §3.5: the miss is re-read through the same tenant-scoped `findById`, so a foreign row reads as absent                                  |
| Ids, versions or entity in a served body                       | §3.6: fixed `detail`; the entity is only on `.entity` and in the logged `message`                                                      |
| Driver text, SQL or bound values served or logged              | Classified errors serve fixed sentences; causes are scrubbed (`scrubDriverError`); work errors are scrubbed, never reclassified (§3.3) |
| Log injection through a terminated connection's error          | §3.1: the listener logs `describeError(error)`, which collapses control characters                                                     |
| Process exit on a lost transaction connection                  | §3.1: every checked-out client carries an `'error'` listener                                                                           |
| State shared across requests by the cached repository          | §3.4: repositories are stateless; the one stateful diagnostic (Dynamo access path) is not cached while logging                         |

## 8. Risks & mitigations

- **A message anchor drifts with a driver release** → every message anchor is matched exactly and
  only on a chain without a string code, and the pg ones are pinned by guarded real tests that fail
  if the text moves.
- **A Prisma code means more than one thing (P2028 covers "start timed out" and "transaction already
  closed")** → both mean the transaction did not commit; commit-time errors stay on the commit path,
  which maps only duplicates (unchanged).
- **The pre-existing `ECONNRESET`/`EPIPE`/`MongoNetworkError` → 503 arms already break C1's "not
  applied" promise for an in-flight write** → recorded as a known limitation in `PUBLIC_API.md` and
  §9; changing them is a separate decision, not slipped in here.
- **A shared repository object is mutated by an application** → documented that `getRepository` may
  return the same instance; repositories are stateless facades.
- **Codex quota (5-hour window)** → implementation split into two runs: Part A (measurement probe
  first, then §3.1–3.4), then Part B (§3.5–3.7 and docs); each run's log checked for a limit error.

## 9. Out of scope

- Classifying errors from the native Drizzle query handles — unclassified in both scopes today;
  owner: a future database-plugin milestone if a user asks.
- Re-mapping the existing connection-fault and `MongoNetworkError` arms to 504 for in-flight writes
  — needs its own maintainer decision; noted in `PUBLIC_API.md`.
- The SQLite fd climb after pool exhaustion (X94 observation, not a row) — looked at only if the
  `SQLITE_BUSY` measurement explains it; otherwise left in `smoke/X94-X95-FINDINGS.md`.
- Per-entity version-field declaration and `create` stamping `version: 1` (ROADMAP decision 4).

## 10. As built (deviations recorded during implementation)

- **CI does not run the database-plugin live-PostgreSQL cells.** `.github/workflows/ci.yml` sets
  `OUTBOX_POSTGRES_URL`, never `POSTGRES_URL`, so `real-drizzle-adapter.test.ts`,
  `real-prisma-adapter.test.ts` and `tenant-store-race-real.test.ts` are IGNORED there by design.
  §3.1's X94-1 gate, the `57P01` and closed-client pins and §3.7's race were run locally against
  `he-postgres` (127.0.0.1:5434) with a generated Prisma client; the evidence goes in the PR. §3.2's
  "pinned by guarded real-backend tests (CI runs both)" is corrected to "run locally".
- **§3.1:** the checked-out listener is removed on pg-pool's `'release'` event (which fires after
  the idle listener is back), not left permanent: a permanent one double-reported an idle error
  beside the pool listener (caught by the existing idle-client live test).
- **§3.2:** the in-flight live case drives a repository statement blocked on a table lock, so it
  pins `57P01` → 503 through the wrapper; the native-handle variant was dropped (unclassified by
  design).
- **Security audit of `f9e6bd8c` (fresh agent):** all eight §8a obligations held; three findings,
  all fixed on this branch at the maintainer's direction (2026-11-01): **M1** (Medium) the memory
  tenant store's `updateWhere`/`deleteWhere` threw synchronously → now `async`, rejecting; **L1**
  (Low) the repository cache grows per distinct entity name on adapters that build any name → the
  budget is documented (README, PUBLIC_API, upgrading); **L2** (Low) caller-input refusals answered
  a masked 500 → `'write-precondition'` is branded `400` with a fixed detail, in both tenant stores
  too. Also fixed: an empty `where` on `DatabaseTenantDataStore` is refused (O2), and
  `TenantRepository`'s optional members are `declare`d, so absent means no own property (O3). The
  re-audit of `7b5205f5` passed; its observation O7 (the 400 brand also covered the
  application-supplied `options.field` refusal) was fixed after it: an empty `field` is a
  `TypeError`, a configuration fault served as a masked 500.
- **Test homes:** §3.3/§3.4 → `test/unit/database-service-m128.test.ts`; §3.5 type checks →
  `test/unit/versioned-write.test.ts` (`expectTypeOf`); §3.6 →
  `test/integration/versioned-write-status.test.ts` (hints asserted there field by field, not in
  `error-status-hints.test.ts`); §3.7 store cases →
  `test/integration/tenant-store-conditional.test.ts` over a real `DatabaseService` +
  `MemoryAdapter`. The conformance "applies inside a transaction" set opens real adapter
  transactions (Drizzle, Prisma, MongoDB fakes); the fake Drizzle table, the Prisma fixture
  validator and the D1 fixture table gained a `version` column.
