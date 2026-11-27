# Milestone 143h — Database errors a client can act on, and store signals (`@setu-ts/database-plugin` + 5)

> **Status:** Planning (2026-11-27 IST). Open decisions in §12 wait for the maintainer; no code is
> written before an explicit go. Branch: `feat/m143h-database-errors-store-signals`, cut from
> `origin/develop` at `1f21e029a` (after #617 M143q and #618 M143c). `develop` and `main` are
> protected; all work, implementation and fixes, stays on this branch until it merges through one
> pull request into `develop`.

## 0. Objective & scope

The Data lane's second letter, after M143q (#617). Fifteen rows where a database fault reaches a
client as a masked `500` or as a status that says something false, where several conflicts look the
same to a client, and where a store fails without saying why. When it ships: a serialization
conflict raised through the framework's own Drizzle handle, a foreign-key or NOT NULL violation, a
value too long or out of range, and a lock wait timeout each answer a named status on every SQL
cell; a call that timed out answers `504` and claims nothing about the write; a Prisma `P1017` and a
MongoDB pool-cleared subclass are classified; the three kinds of `409` carry different problem
types; a full pg pool reads as saturation in both the response and readiness, and gets its counters
without hand-wiring; an audit entry can be written inside the caller's transaction; the vector-store
indicator and the agent-run loop log the cause of a failure; the pgvector index check says "wrong
operator class" rather than "missing"; the run-budget recipe works outside this repository; and a
resolver-name array in multi-tenancy is refused at startup instead of resolving no tenant.

Code changes are in the Data lane's packages: `database-plugin`, `exceptions` (docs only, §3.13),
`audit-plugin`, `agent-runs-plugin`, `vector-store-plugin`, `multi-tenancy-plugin`, their tests and
READMEs, plus the per-letter entries in `PUBLIC_API.md`, `CHANGELOG.md` and `docs/upgrading.md`. Two
changes touch `packages/common` (D-1, D-5); the lane rule routes a change to an existing `common`
contract through the Core lane, which §12 puts to the maintainer. Three files outside the lane's
packages are touched and named in the lanes table first (C3): `docs/durable-runs.md` (V12-8), a new
`docs/problem-types.md` (D-5), and one row of `test/response-stream-cancel-inventory.test.ts`
(§3.18).

- **In scope:** V13-9, V13-27, V13-39, V13-40, V13-115, V13-237, V13-5, V13-50, V13-132, V13-133,
  V13-139, V13-218 (the `database-plugin` half), V13-252, V12-8, V12-15; plus:
  - **E-1, added by the maintainer (2026-11-27):** the DynamoDB plain `update` and `delete`
    pre-reads inside a unit of work become strongly consistent (§3.16). Not registered in
    `smoke/DEFECTS.md`, by the maintainer's direction.
  - **E-2, received from M143q §11:** the Prisma driver-adapter kinds
    `ForeignKeyConstraintViolation`, `NullConstraintViolation`, `LengthMismatch` and
    `ValueOutOfRange` (§3.11, §3.12); the `TimeoutError` name rule and Bigtable `DEADLINE_EXCEEDED`
    (§3.8).
  - **E-3, received from M143q §11:** the `conditional-write` refusal names the bound adapter rather
    than `'database-plugin'` (V13-250's third clause; §3.17).
  - **E-4, received from M143i:** `agent-runs-plugin/src/log/respond.ts`'s `cancel()` waits for the
    replay pump that reads the run store (§3.18).
- **NOT this letter:**
  - M143o (Workers lane): V13-218's D1 half (`cloudflare-plugin/src/database/d1-data-source.ts`; the
    two SQLite message anchors). This letter adds the classes and the classifier arms D1 reads;
    `d1-data-source.ts` itself is M143o's (ROADMAP "Half of a row owned elsewhere: V13-218").
  - M143j (CLI lane, templates): any `setu add database` text about `poolStats` (V13-40). With the
    default of §3.5 nothing has to be written by hand, so no template half is needed; M143j is told
    so in §11.
  - M143n (Docs lane): V13-134 (the "Bounding a call" table rows for mysql2 and SQLite), V13-250's
    first two clauses, V13-253 (isolation advice on MySQL).
  - The bare `ECONNRESET`/`EPIPE`/`MongoNetworkError` arms that the README lists as a known
    limitation (503 even for a write in flight). They are not a row; §3.9 records why `P1017` does
    not join them.

## 1. Contracts verified from SOURCE (not names)

All references read at `1f21e029a`.

| Reference                           | Source (file:line)                                                                                                                                                                                                                                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 `classifyDriverError`           | `packages/database-plugin/src/errors/classify.ts:198-236`                                                                                                                                                                                                                                                          | Returns `'conflict' \| 'unavailable' \| 'duplicate' \| 'timeout' \| null`. Already-classified package errors at the top level return `null`. Structured signals (codes, Mongo labels, Prisma adapter `kind`) over the whole chain run before names and messages.                                                                                                                                                                    |
| C-2 Name arm                        | `classify.ts:584-597`                                                                                                                                                                                                                                                                                              | Exact `name` strings: `TransactionConflictException`; four Mongo names; `TimeoutError` and `NetworkingError` → `'unavailable'` (V13-237's line).                                                                                                                                                                                                                                                                                    |
| C-3 Errno arm                       | `classify.ts:563`; `packages/common/src/errors/connection-fault.ts:8-28`                                                                                                                                                                                                                                           | `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EPIPE`, … → `'unavailable'`. Runs in the structured arm, so it beats the name arm.                                                                                                                                                                                                                                                          |
| C-4 Prisma adapter cause            | `classify.ts:262-287`                                                                                                                                                                                                                                                                                              | Read only when `meta.driverAdapterError.cause.originalCode` is a string; returns `code`, `message`, `kind`, and the `mysql-adapter` namespace for `kind: 'mysql'`.                                                                                                                                                                                                                                                                  |
| C-5 Prisma adapter-pg mapping       | `node_modules/@prisma/adapter-pg@7.10.1/dist/index.js:436-600`                                                                                                                                                                                                                                                     | Server errors carry `originalCode` (SQLSTATE) plus a `kind`: `22001` `LengthMismatch`, `22003` `ValueOutOfRange`, `23502` `NullConstraintViolation`, `23503` `ForeignKeyConstraintViolation`, `40001`/`40P01` `TransactionWriteConflict`, `53300` `TooManyConnections`. Socket errors carry **no** `originalCode`: `ECONNREFUSED`/`ENOTFOUND` `DatabaseNotReachable`, `ECONNRESET` `ConnectionClosed`, `ETIMEDOUT` `SocketTimeout`. |
| C-6 Prisma kinds                    | `@prisma/driver-adapter-utils@7.10.1/dist/index.d.ts:138-262`                                                                                                                                                                                                                                                      | The `MappedError` union, including the kinds above, `RestrictViolation` and `InvalidInputValue`.                                                                                                                                                                                                                                                                                                                                    |
| C-7 AWS SDK timeouts                | `@smithy/node-http-handler@4.14.2/dist-cjs/index.js:56-58, 88-96, 144, 382, 820, 884`                                                                                                                                                                                                                              | `name: 'TimeoutError'` for a connection not established (56), a `requestTimeout` with `throwOnRequestTimeout` (88, **also `code: 'ETIMEDOUT'`**), a socket idle after send (144), a socket `ECONNRESET`/`EPIPE`/`ETIMEDOUT` renamed (382), and two HTTP/2 stream timeouts. Four of the six fire after the request was sent.                                                                                                         |
| C-8 Cosmos timeout                  | `@azure/cosmos@4.10.2/dist/commonjs/request/TimeoutError.js:26-29`                                                                                                                                                                                                                                                 | `code = 'TimeoutError'`, `name = 'TimeoutError'`.                                                                                                                                                                                                                                                                                                                                                                                   |
| C-9 Mongo subclass names            | `mongodb@6.22.0/lib/cmap/errors.js` (`PoolClearedError` extends `MongoNetworkError`, `name` getter `'MongoPoolClearedError'`; `PoolClearedOnNetworkError` extends it, getter `'PoolClearedOnNetworkError'`); `lib/error.js` (`MongoNetworkTimeoutError` extends `MongoNetworkError`; `MongoOperationTimeoutError`) | A subclass overrides `name`, so the exact-name arm misses it (V13-133).                                                                                                                                                                                                                                                                                                                                                             |
| C-10 drizzle-orm query wrapper      | `drizzle-orm@0.45.2/errors.js:10-20`; `pg-core/session.js:41-81`                                                                                                                                                                                                                                                   | `DrizzleQueryError` sets `query`, `params`, `cause` and **no `name`** (it reads `'Error'`).                                                                                                                                                                                                                                                                                                                                         |
| C-11 Transaction catch              | `packages/database-plugin/src/services/database-service.ts:322-357`                                                                                                                                                                                                                                                | `beginTransaction` rejections are classified; a `commit()` rejection maps only `'duplicate'` (`duplicateAtCommitOrOriginal`, `:188-193`); an error the work throws is scrubbed and rethrown unclassified (V11-5, M128).                                                                                                                                                                                                             |
| C-12 Interception sites             | `database-service.ts:92-129` (`classifiedOrOriginal`), `:322`, `:343`, `:373` (`query()`), and `wrapDataSource`                                                                                                                                                                                                    | One builder maps a class to its error object; value refusals (`refusalErrorOf`) only where an entity is known.                                                                                                                                                                                                                                                                                                                      |
| C-13 Value refusal                  | `classify.ts:354-414`; `errors/refusal.ts:23-30`; `packages/common/src/errors/invalid-field-value.ts:15-30`                                                                                                                                                                                                        | `VALUE_REFUSAL_CODES` = `22P02`, `22003`, `22007`, `22008`, Prisma `P2007`, `PrismaClientValidationError` → `InvalidFieldValueError(entity)` 400. `22001` is absent (V13-252).                                                                                                                                                                                                                                                      |
| C-14 Status hints and problem types | `packages/common/src/errors/status-hint.ts:89-148`; `error-responder.ts:150-188` (`ProblemTypeInit`, `ErrorResponseInit.problem`); `packages/exceptions/src/middleware/error-handler.ts:219-235`; `error-responder-impl.ts:97-140`                                                                                 | A hint may carry `problem: { type, title, extensions? }`; the RFC 9457/7807 formats emit it, `default` ignores it. `withHttpStatusHint` defines the brand `configurable: true`. Precedent: `auth-plugin/src/quota/refusal.ts:5-25` (`https://iana.org/assignments/http-problem-types#quota-exceeded`).                                                                                                                              |
| C-15 Classified error classes       | `packages/database-plugin/src/errors.ts:504-725`; `packages/common/src/errors/duplicate-key.ts:49-76`                                                                                                                                                                                                              | `SerializationConflictError` 409, `DatabaseUnavailableError` 503, `DatabaseTimeoutError` 504, `VersionConflictError` 409, `EntityNotFoundError` 404 in this package; `DuplicateKeyError` 409 in `common`. None sets `problem`.                                                                                                                                                                                                      |
| C-16 Error log level                | `packages/exceptions/src/middleware/error-handler.ts:341-370`                                                                                                                                                                                                                                                      | Every served 5xx logs at `error`, 4xx at `warn`, with the serialized cause.                                                                                                                                                                                                                                                                                                                                                         |
| C-17 Pool capacity seams            | `packages/database-plugin/src/health/database-capacity.ts:27-249`; `adapters/drizzle/drizzle-adapter.ts:311-317`; `plugin/database-plugin.ts:206-325`                                                                                                                                                              | Capacity, progress and probe-acquire-timeout seams are attached **only when `poolStats` is configured**. Saturated + progressing → `up` with `reachable: 'unknown'`; otherwise `degraded` (`/ready` 503).                                                                                                                                                                                                                           |
| C-18 Pool timeout predicate         | `classify.ts:320-324` (`isPoolAcquireTimeout`)                                                                                                                                                                                                                                                                     | True for pg-pool's exact `timeout exceeded when trying to connect` text on a chain with no string code.                                                                                                                                                                                                                                                                                                                             |
| C-19 The plugin reaches the pg pool | `plugin/database-plugin.ts:165-169`; `packages/common/src/pool-error-listener.ts` (`attachPoolErrorListener` reads `database.$client`)                                                                                                                                                                             | The Drizzle instance's `$client` is the application's pool.                                                                                                                                                                                                                                                                                                                                                                         |
| C-20 Audit contract                 | `packages/common/src/services/audit.ts:44-55`; `packages/audit-plugin/src/services/audit-service.ts`; `storage/database-audit.ts`; `interfaces/index.ts:119-151`; `storage/audit-record.ts:95-108`                                                                                                                 | `IAuditLogger.log(entry)` only. `DatabaseAuditStorage` writes through an injected `IAuditDbClient.insert(table, row)`; `toAuditRow` produces the row.                                                                                                                                                                                                                                                                               |
| C-21 Outbox scope                   | `packages/common/src/services/outbox.ts:184-200`; `database-plugin/src/outbox/database-outbox-store.ts:257-259`                                                                                                                                                                                                    | `IOutboxWriteScope.getRepository(entity).create(row)`; the database outbox store appends through it. An `IUnitOfWork` satisfies it structurally.                                                                                                                                                                                                                                                                                    |
| C-22 Agent-run model call           | `packages/agent-runs-plugin/src/runtime/ai-runtime.ts:29-49`; `loop/step-loop.ts:239-262, 326-334`                                                                                                                                                                                                                 | `toUIMessageStream({ onError: () => 'Agent model call failed.' })` drops the error; `step-loop.ts:253` throws a new `Error`; the failure log reads `error.name` and the status hint. `ai@7.0.159` types `onError?: (error: unknown) => string` (`dist/index.d.ts:2749`).                                                                                                                                                            |
| C-23 Vector-store indicator         | `packages/vector-store-plugin/src/health/indicator.ts:33-79`                                                                                                                                                                                                                                                       | `createCachedProbe({ fallback: false })` turns a rejection or timeout into `false`; nothing is logged.                                                                                                                                                                                                                                                                                                                              |
| C-24 Reporter                       | `packages/common/src/health/connection-errors.ts:42-116`                                                                                                                                                                                                                                                           | `createConnectionErrorReporter({ source, logger })`: `report(error)` warns once per description, then `debug`; `recovered()` logs `info`. Sibling use: `service-discovery-plugin/src/plugin/service-discovery-plugin.ts:82-86`.                                                                                                                                                                                                     |
| C-25 pgvector index check           | `vector-store-plugin/src/adapters/pgvector/pgvector-sql.ts:113-131`; `pgvector-store.ts:231-236`                                                                                                                                                                                                                   | One `EXISTS` folds "absent" and "present with another operator class or method" into `vector_index = false`; the message always says "missing".                                                                                                                                                                                                                                                                                     |
| C-26 Resolver chain                 | `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:46-84, 206-210`; `interfaces/index.ts:116-117`                                                                                                                                                                                                   | `if (Array.isArray(config)) return config;` — any array passes through unchecked; an empty chain is refused at `register()`.                                                                                                                                                                                                                                                                                                        |
| C-27 Run-budget recipe              | `docs/durable-runs.md:84-124`; `docs/ai.md:424-…`                                                                                                                                                                                                                                                                  | The recipe imports `../../apps/ai-chat/…`; `docs/ai.md` already holds the whole budget middleware with `BudgetScope`.                                                                                                                                                                                                                                                                                                               |
| C-28 DynamoDB pre-reads             | `database-plugin/src/adapters/dynamo/dynamo-data-source.ts:276-293` (update), `:312-321` (delete), `:367-371` and `:419-423` (the conditional ones, `ConsistentRead: true` since M143q)                                                                                                                            | The plain pre-reads run **only inside a unit of work** (`transactionBuffer !== undefined`). Outside one, `update` is an `UpdateItem` with `attribute_exists` and `delete` a `DeleteItem` with `ALL_OLD`: no pre-read.                                                                                                                                                                                                               |
| C-29 Conditional-write refusal      | `database-plugin/src/repositories/base-repository.ts:123-137`; `repositories/versioned-write.ts:15`                                                                                                                                                                                                                | Both name `'database-plugin'` as the adapter.                                                                                                                                                                                                                                                                                                                                                                                       |
| C-30 Replay pump                    | `test/response-stream-cancel-inventory.test.ts:75-85`                                                                                                                                                                                                                                                              | Row `cancel-does-not-await` with `handOver` to the Data lane; evidence regex over `respond.ts`.                                                                                                                                                                                                                                                                                                                                     |
| C-31 Lane rule for `common`         | `ROADMAP.md` "Rules that keep the lanes apart"                                                                                                                                                                                                                                                                     | "`common` is additive outside the Core lane … A change to an existing contract is made by the Core lane first, as a small pull request of its own."                                                                                                                                                                                                                                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                 | Resolution (picked side)                                                                                                             | Doc deliverable (same PR)                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| C1  | `packages/database-plugin/README.md` "Errors your own transaction work throws are not classified (M128)" against the X38-1 decision that a serialization conflict answers 409 (V13-115). | The X38-1 decision. A driver error the work throws is classified by §3.7's rule; a foreign error still reaches the caller as itself. | README paragraph rewritten; `docs/upgrading.md` 0.14.0 entry.      |
| C2  | The exceptions README: "Read `status` to distinguish errors" against three 409s with different client actions (V13-139).                                                                 | Distinguish by problem `type` (D-5).                                                                                                 | `packages/exceptions/README.md` sentence; `docs/problem-types.md`. |
| C3  | The lanes table lists no owner for `docs/durable-runs.md`, `docs/problem-types.md` or `test/response-stream-cancel-inventory.test.ts`.                                                   | They join the Data lane for this letter, as M143q's D-10 did for its files.                                                          | `ROADMAP.md` lanes table, Data row, in the first commit.           |
| C4  | README connection-loss table puts the Prisma `P1001` row under 503, with no row for `P1017`.                                                                                             | §3.9.                                                                                                                                | README table row.                                                  |

## 3. Design decisions

Each decision has a comparison (§12.1 holds the sources) and a developer-impact line: what an
application upgrading to `0.14.0` meets, and its way out. Rules applied throughout: refuse only when
carrying on would lose data or fail silently, otherwise adjust and warn once; add no machinery the
compared frameworks lack; there are no existing users to keep compatible.

### 3.0 One classification table, every interception site

The classifier gains classes, and every site that classifies today reads them through
`classifiedOrOriginal`, so a signal answers the same way through a repository, `query()`,
`beginTransaction`, the transaction catch (§3.7) and `commit()` (where only server verdicts map,
§3.7). The full table is the data of `test/unit/classify-driver-error.test.ts` (rows: signal,
backend, class, site set). New `DriverErrorClass` members: `'foreign-key'`, `'not-null'`, `'value'`
(value too long or out of range; the existing value-refusal path), `'lock-timeout'` folds into
`'conflict'` (§3.12). `DriverErrorClass` is exported (`@since 0.5.0`), so widening it is listed in
§4.

### 3.1 V13-9: an audit entry inside the caller's transaction (D-1, D-2)

- **Decision (recommended, D-1):** `IAuditLogger.log(entry, options?: AuditLogOptions)` in `common`,
  with `AuditLogOptions = { readonly scope?: IOutboxWriteScope }` — the scope type the outbox
  already uses, which an `IUnitOfWork` satisfies. With a scope, `AuditPlugin`'s `'database'` storage
  writes the row through `scope.getRepository(table).create(row)`, where `table` is the existing
  `options.table` (default `'audit_logs'`), naming the repository entity, and `row` is
  `toAuditRow`'s row, so both paths store the same columns. Without a scope nothing changes. A scope
  passed to the `memory`, `log` or `file` storage rejects with `AuditScopeUnsupportedError` (named,
  value-free) and writes nothing: those sinks cannot roll back, so writing would keep an entry for a
  business write that rolls back — the silent loss of atomicity the caller asked to avoid (D-2).
  Redaction and stamping run as today, before both paths.
- **Why:** the outbox is this framework's own precedent (`IOutbox.write(scope, …)`), and every
  compared ORM-level audit library writes inside the business transaction (§12.1 T-1).
- **Developer impact:** none for an existing call. To join a transaction:
  `await audit.log(entry, { scope: uow })` inside `db.transaction(...)`, with an entity named by
  `options.table` registered on the database (a Drizzle table or Prisma model whose fields are
  `toAuditRow`'s columns). A memory-storage test that passes a scope gets the named rejection; the
  way out is `storage: 'database'` or dropping the scope.
- **Lane routing (D-1):** this edits an existing `common` contract. §12 asks whether it ships as a
  small Core follow-up pull request first (the lane rule, as #612/#613 did) or in this letter.
- **Test home:** `packages/audit-plugin/test/unit/audit-scope.test.ts` (scoped write reaches
  `scope.getRepository(table).create` with `toAuditRow`'s row; no scope uses the client; memory, log
  and file reject `AuditScopeUnsupportedError` and write nothing; redaction applies on the scoped
  path); `packages/database-plugin/test/integration/audit-in-transaction.test.ts` (real
  `DatabasePlugin` memory adapter + `AuditPlugin`: a rolled-back transaction leaves no audit row, a
  committed one leaves exactly one; guarded PostgreSQL cell).

### 3.2 V13-27: a failed model call logs its cause

- **Decision:** `ai-runtime.ts` keeps the error `toUIMessageStream`'s `onError` receives (the
  returned text stays `'Agent model call failed.'`), and the generation exposes it as
  `failure(): unknown`. `step-loop.ts:253` throws that error when present (falling back to today's
  `Error` only when the stream sent an error chunk with no captured error). The failure log already
  reads `error.name` and the status hint, so a spent budget logs `QuotaExceededError` with `429`, a
  quota-store outage its own class and `503`, and a provider refusal `AI_APICallError`. Nothing else
  is logged: the value-free rule of plan §8a O6 (M136) stands — no message, no provider text.
- **Why:** the docs already promise the class and status (`docs/durable-runs.md:213`); the AI SDK
  hands the original error to `onError` (§12.1 T-8).
- **Developer impact:** log lines change from `"error":"Error"` to the real class; no API change.
- **Test home:** `packages/agent-runs-plugin/test/unit/step-loop-failure.test.ts` (a fake runtime
  whose stream errors with a `QuotaExceededError` → log carries the class and `429`; a
  provider-shaped error → its name; an error chunk with nothing captured → `Error`, as today); one
  real-`ai` test in `test/integration/ai-runtime-real.test.ts` driving `loadAi()` with a mock model
  that throws.

### 3.3 V13-39: the vector-store indicator logs its probe's cause

- **Decision:** the indicator wraps the adapter's `isHealthy` in a `createConnectionErrorReporter`
  (`source: 'vector-store-plugin: <adapter>'`, `logger: () => ctx.logger`): a rejection is
  `report(error)`ed; a probe that does not answer within the bound is reported as a plain `Error`
  built in the indicator ("did not answer within 2000 ms"), never thrown out; a `true` calls
  `recovered()`. The health payload is unchanged (`reachable: false`), so `details: true` discloses
  nothing new.
- **Why:** the sibling indicators log the cause this way (service-discovery, M139f; the
  connection-error reporter, M119g); a log line is where an operator tells a revoked key from a dead
  backend.
- **Developer impact:** one `warn` per outage and one `info` on recovery in the application log.
- **Test home:** `packages/vector-store-plugin/test/unit/indicator.test.ts` (rejection → one warn
  with the description, repeats at debug, recovery info; timeout → warn naming the bound; no logger
  → no throw).

### 3.4 V13-5: the pgvector index check tells "wrong" from "missing"

- **Decision:** `describeStatement` returns one more column, `vector_index_present` (the index named
  `<table>_hnsw` exists on the table at all). The check then says "is missing its HNSW index" only
  when it is absent, and otherwise "has an index named `<table>_hnsw` that is not
  `USING hnsw (embedding vector_cosine_ops)`; drop it and create it as expected". Same for the
  source index.
- **Why:** an operator reading "missing" runs `CREATE INDEX IF NOT EXISTS`, which does nothing.
- **Developer impact:** message text only.
- **Test home:** `test/unit/pgvector-store.test.ts` (fake rows: absent → "missing"; present but
  wrong → "is not"); guarded real cell in `test/integration/real-pgvector.test.ts` building the
  index with `vector_l2_ops`.

### 3.5 V13-40: a pg pool's counters by default

- **Decision:** when the Drizzle registration sets no `poolStats` and the instance's `$client` is a
  node-postgres pool (numeric `totalCount`, `idleCount` and `waitingCount`), the adapter reads them
  as its default `poolStats`, which attaches the capacity, progress and probe-acquire-timeout seams
  (C-17). An explicit `poolStats` wins. mysql2's pool has no public counters, and Prisma exposes
  none, so those arms keep today's behaviour, and the README says so.
- **Why:** the plugin already reaches the pool (C-19); the saturation rule exists and only lacked
  its input. Compared frameworks read their own pool's counters (§12.1 T-4).
- **Developer impact:** on Drizzle with pg, a saturated but progressing pool stops failing `/ready`
  without any change; an application that wrote `poolStats` by hand can delete it.
- **Test home:** `test/unit/drizzle-default-pool-stats.test.ts` (a `$client` with the three counters
  → seams attached and read; explicit `poolStats` wins; a client without numeric counters → no
  seams); guarded live cell in `test/integration/real-drizzle-adapter.test.ts`: saturate a
  two-connection pool with no `poolStats` and read `/ready` 200 with `reachable: 'unknown'`.

### 3.6 V13-50: a pool acquire timeout reads as saturation (D-4)

- **Decision (recommended, D-4):** a pg-pool acquire timeout (C-18) becomes
  `DatabaseUnavailableError` with a new read-only `reason: 'pool-saturated'` (other cases
  `'unreachable'`), served `503` with the detail "The database connection pool is busy. The request
  was not applied." and the problem type `database-pool-saturated` (D-5); the outage keeps today's
  sentence and `database-unavailable`. The error-handler log level is unchanged (`error` per served
  5xx), as for every other 5xx: §12 records the alternative of logging this case at `warn`.
- **Why:** the response then agrees with readiness (`isSaturated`, M101a) instead of calling the
  same state an outage. One line per failed request is what every compared framework logs for an
  acquire timeout (§12.1 T-4).
- **Developer impact:** the `detail` and `type` change on this one case;
  `instanceof DatabaseUnavailableError` still holds, and a client can branch on the type.
- **Test home:** `test/unit/classify-driver-error.test.ts` (row) and
  `test/unit/database-errors.test.ts` (reason, detail, type).

### 3.7 V13-115: driver errors thrown by the transaction's own work (D-3)

- **Decision (recommended, D-3):** in `transaction()`'s catch, an error the work throws is
  classified when it is **itself a driver error**: its own members carry a signal, or it is
  drizzle-orm's query wrapper (C-10: an `Error` with a string `query`, an array `params` and a
  `cause`) whose `cause` carries one. A signal found deeper — an application error that wraps a
  driver error as its `cause` — is not read, and the application's error reaches the caller as
  itself. Two signals are excluded at this site because a foreign call raises them too: the errno
  family (C-3) and the AWS `TimeoutError`/`NetworkingError` names. This keeps V11-5 closed (a
  refused webhook is not "database unavailable") while a SQLSTATE `40001` from
  `getDrizzleTransaction(...)` answers 409 again.
- **Commit-time verdicts:** `commit()` already maps `'duplicate'`; it also maps `'conflict'`
  (`40001`/`40P01`, which PostgreSQL may raise at `COMMIT` under SERIALIZABLE) and `'foreign-key'`
  (a deferred constraint checked at `COMMIT`). Each is the server refusing the whole transaction, so
  nothing was applied. Unavailable and timeout at commit stay unclassified: the acknowledgement may
  have been lost after the write.
- **Why:** frameworks that hand out a native handle translate its errors at the connection layer
  (§12.1 T-5); wrapping the handle in a proxy is machinery none of them has, so the transaction
  boundary is the one site this package owns.
- **Developer impact:** a native-handle conflict now answers 409 "safe to retry" instead of a
  masked 500. Outside a transaction (`getDrizzleDatabase(...)`), errors still reach the application
  as thrown; the README says so, and points at `instanceof` checks on the drizzle cause.
- **Test home:** `test/unit/transaction-work-classification.test.ts` (table: a pg error thrown
  directly → classified; a `DrizzleQueryError`-shaped wrapper → classified; an app error with a
  driver `cause` → itself; `ECONNREFUSED` and a `TimeoutError` → itself; a commit `40001` → 409; a
  commit `23503` → 409; a commit `ECONNRESET` → itself); guarded real cell in
  `test/integration/real-drizzle-adapter.test.ts`: two SERIALIZABLE transactions through
  `getDrizzleTransaction` → one 200, one 409.

### 3.8 V13-237: a timed-out call answers 504 and claims nothing

- **Decision:** the name `TimeoutError` (AWS SDK, Cosmos) maps to `'timeout'` (504), and it is read
  **before** the errno arm, because smithy's `requestTimeout` error carries `code: 'ETIMEDOUT'` too
  (C-7). Cosmos's `code: 'TimeoutError'` string maps the same way. For Bigtable, gRPC code `4`
  (`DEADLINE_EXCEEDED`) maps to `'timeout'` for calls M143q's own bound did not end (an SDK default
  deadline, an injected facade). `NetworkingError` stays `'unavailable'`: it is an SDK v2 name that
  v3 never raises (§12.1 T-3). A connection-establishment timeout also becomes 504; that answer is
  less specific but never false, while splitting on the SDK's message text would need an anchor per
  SDK version.
- **Why:** the README's own rule — no verdict on a sent request means the outcome is unknown — and
  gRPC's definition of `DEADLINE_EXCEEDED` (§12.1 T-3).
- **Developer impact:** a DynamoDB or Cosmos request timeout answers 504 "did not answer in time"
  instead of 503 "not applied"; a client stops repeating writes that landed.
- **Test home:** `test/unit/classify-driver-error.test.ts` rows (smithy shapes from C-7, Cosmos C-8,
  Bigtable `{ code: 4 }` with `adapterType: 'bigtable'`, and `{ code: 4 }` under `mongodb`
  unclassified); guarded real cells exist from M143q's frozen relay and gain the unbounded-SDK case.

### 3.9 V13-132: Prisma `P1017` and the socket kinds (D-6)

- **Decision (recommended, D-6):** `P1017` ("Server has closed the connection") maps to `'timeout'`
  (504), and so do `P1008` (socket timeout) and the adapter kinds `ConnectionClosed` and
  `SocketTimeout` (Prisma's engine turns them into `P1017` and `P1008`, §12.1 T-7);
  `DatabaseNotReachable` and `TooManyConnections` map to `'unavailable'` (503). The kind is read
  even when the adapter cause carries no `originalCode` (C-5: socket errors never do), which M143q's
  reader required.
- **Why:** M128's rule (README "Connection loss during an outage") puts a connection dropped under a
  statement with no verdict at 504. `ConnectionClosed` is Prisma's mapping of `ECONNRESET` (C-5),
  and the bare `ECONNRESET` arm is a documented limitation at 503; this letter does not extend the
  limitation to a new code.
- **Developer impact:** during a PostgreSQL restart a Prisma call answers 504 instead of a
  masked 500.
- **Test home:** `classify-driver-error.test.ts` rows (Prisma shapes with and without
  `originalCode`).

### 3.10 V13-133: MongoDB error subclasses

- **Decision:** the name arm reads each prototype's `name` along the error's prototype chain
  (bounded to 8 hops, guarded like `safeMembers`), most derived first, so
  `PoolClearedOnNetworkError` matches `MongoPoolClearedError`. Two derived names are mapped before
  their parent: `MongoNetworkTimeoutError` and `MongoOperationTimeoutError` → `'timeout'` (504: a
  socket or operation timeout after send), matching §3.8.
- **Why:** a subclass is a more specific case of its parent. Spring Data MongoDB matches socket
  errors by `instanceof`, which covers every subclass (§12.1 T-6). The driver's own label on
  `PoolClearedError` is spelt differently in v6 and v7 (`PoolRequstedRetry`/`PoolRequestedRetry`),
  so a label match would break across majors.
- **Developer impact:** a pool cleared by a network error answers 503 instead of a masked 500.
- **Test home:** `classify-driver-error.test.ts` rows built from the real `mongodb` classes (the
  package is a devDependency) and from plain objects with a hand-built prototype chain.

### 3.11 V13-218: foreign-key and NOT NULL violations (D-7)

- **Decision (recommended, D-7):** two new classes in this package, each with an optional `entity`
  like `DuplicateKeyError`: `ForeignKeyViolationError` (`409`, type `foreign-key-violation`, detail
  "The write refers to a record that does not exist, or would remove one that others refer to.") and
  `NotNullViolationError` (`400`, type `not-null-violation`, detail "A required field has no
  value."). Signals: SQLSTATE `23503`/`23502`; mysql2 `ER_NO_REFERENCED_ROW_2`,
  `ER_ROW_IS_REFERENCED_2`, `ER_BAD_NULL_ERROR`; the Prisma kinds `ForeignKeyConstraintViolation`,
  `RestrictViolation` (`23001`) and `NullConstraintViolation`, and Prisma `P2003`/`P2011`; SQLite's
  `FOREIGN KEY constraint failed` and `NOT NULL constraint failed:` message anchors, which M143o's
  D1 half reads through this classifier. Every interception site (§3.0).
- **Why:** every compared framework classifies all four as non-transient caller faults (Spring
  `DataIntegrityViolationException`, Hibernate `ConstraintViolationException` with its kind, Rails
  `InvalidForeignKey`/`NotNullViolation`, Django `IntegrityError`, EF.Exceptions, Prisma
  `P2003`/`P2011`), but only Spring Data REST serves a status for them (409 for every integrity
  violation); the rest answer 500 (§12.1 T-2). The framework's own `DuplicateKeyError` reasoning (a
  masked 500 says the server failed when the caller's write did) applies unchanged.
- **Developer impact:** these answer 409/400 with a fixed sentence instead of a masked 500; nothing
  about the row or the constraint is disclosed.
- **Test home:** `classify-driver-error.test.ts` rows; guarded real cells on PostgreSQL, MySQL (both
  Drizzle and Prisma) and `node:sqlite`.

### 3.12 V13-252: value too long, out of range, lock wait timeout

- **Decision:**
  - Value too long and numeric out of range join the existing value refusal (C-13):
    `InvalidFieldValueError` (400) on repository calls, where an entity is known. Signals: SQLSTATE
    `22001` (`22003` already), Prisma `P2000`/`P2020` and kinds `LengthMismatch`/`ValueOutOfRange`,
    mysql2 `ER_DATA_TOO_LONG` and `ER_WARN_DATA_OUT_OF_RANGE`. Through `query()` and the
    transaction's own work they stay unclassified: the statement is the application's, the class
    needs an entity, and the README says so.
  - A lock wait timeout is `'conflict'`: `SerializationConflictError` (409, "safe to retry").
    Signals: SQLSTATE `55P03` (`lock_not_available`), mysql2 `ER_LOCK_WAIT_TIMEOUT`, mariadb `1205`
    under the `mysql-adapter` namespace. PostgreSQL aborts the transaction; MySQL rolls back the
    statement, and the framework then rolls back the unit of work, so in both the write was not
    applied.
- **Developer impact:** 400 or 409 with a fixed sentence instead of a masked 500.
- **Test home:** `classify-driver-error.test.ts` rows; guarded real cells (a 16-character value into
  `varchar(8)`; `lock_timeout = '100ms'` on PostgreSQL and `innodb_lock_wait_timeout = 1` on MySQL
  against a held row lock).

### 3.13 V13-139: three 409s a client can tell apart (D-5)

- **Decision (recommended, D-5):** every database error class whose status another class shares
  carries a problem `type` through its hint (C-14): `https://setu-ts.dev/docs/problem-types/#<slug>`
  with the slugs `write-conflict`, `version-conflict`, `duplicate-key`, `foreign-key-violation`,
  `not-null-violation`, `database-pool-saturated`, `database-unavailable`, and `database-timeout`.
  Each title is the class's own ("Write Conflict", …). `docs/problem-types.md` documents each type:
  what it means, the client action (retry, reload, change the input), and the status. The `default`
  format is unchanged (it ignores `problem`); the exceptions README says that distinguishing by type
  needs a Problem Details format, which every starter and template uses.
- **`DuplicateKeyError` lives in `common`.** Giving it a type changes an existing `common` class, so
  it shares D-1's routing question in §12.
- **Developer impact:** under `rfc9457` the body's `type` and `title` change from `about:blank` and
  `Conflict` to the class's own; `status` and `detail` are unchanged.
- **Test home:** `test/unit/database-errors.test.ts` (each class's hint, field by field, with the
  forbidden `message` absent); `packages/exceptions/test/integration/problem-type-database.test.ts`
  (a thrown `VersionConflictError` and `SerializationConflictError` through
  `errorHandler({ format: 'rfc9457' })` give different `type`s; `default` format bodies are
  byte-identical to before).

### 3.14 V12-8: a run-budget recipe that works outside this repository

- **Decision:** the recipe in `docs/durable-runs.md` imports the budget middleware from the file the
  reader created from `docs/ai.md`'s "Budget middleware" (`./chat.budget.ts`) and the quota from
  `@setu-ts/auth-plugin`'s `createQuota`, with no import from `apps/`. The fence compiler
  type-checks it against the same files `docs/ai.md`'s fences define.
- **Developer impact:** the recipe copies into a scaffolded project.
- **Test home:** the README/docs fence gate (`check:docs` fence compiler) for the changed fences.

### 3.15 V12-15: a resolver array holds resolvers

- **Decision:** `buildResolverChain` refuses at `register()` an array with any element that is not
  an object with a `resolve` function, with a message naming the index and saying that names do not
  chain ("pass resolver instances, for example `new HeaderResolver()`"). An unknown name string is
  refused the same way instead of producing an empty chain.
- **Why:** a configuration that boots and resolves no tenant fails silently, which the rules refuse.
- **Developer impact:** a JavaScript configuration with `['header', 'subdomain']` fails at startup
  with the way out in the message.
- **Test home:** `packages/multi-tenancy-plugin/test/unit/resolver-chain.test.ts`.

### 3.16 E-1: DynamoDB plain pre-reads inside a unit of work are strongly consistent

- **Reproduction read (C-28).** Only inside a unit of work does a plain `update` or `delete` read
  the row first; outside one, `UpdateItem` with `attribute_exists` and `DeleteItem` with `ALL_OLD`
  decide on the server, so there is nothing stale to act on. Inside one, an eventually consistent
  read can return the state before an acknowledged write:
  - `update` after a recent `create`: the read misses, the call throws a plain `Error` (a
    masked 500) although the row exists;
  - `update` after a recent `update`: the returned row merges the new values over stale ones, so the
    caller sees attributes that are no longer stored (the commit itself is guarded by
    `attribute_exists` and writes correctly);
  - `delete` after a recent `create`: the read misses, `delete` returns `false` and **buffers
    nothing**, so the row survives and the caller is told it was not there;
  - `delete` after a recent `delete`: the read hits, a `Delete` is buffered, the commit deletes
    nothing and the call reports `true`.
- **Decision:** both pre-reads pass `ConsistentRead: true`, as the two conditional pre-reads have
  since M143q. A missing key on `update` keeps its current answer (the plain `Error`); aligning it
  with the outer path's answer is not this item.
- **Why:** the read decides what the call returns and whether a `Delete` is buffered at all, so a
  stale read gives a false answer (above). AWS documents strongly consistent reads as the way to
  read the latest acknowledged write, at 1 RCU per 4 KB against 0.5 (§12.1 T-9); the survey found no
  AWS sentence that says a read deciding a write must be strong, so this plan does not claim one.
  None of the compared DynamoDB libraries pre-reads before `update` or `delete` at all: they send
  one conditional write. This adapter pre-reads only because a buffered transaction must answer
  before its commit, which is why the cheaper fix of dropping the read is not open here.
- **Developer impact:** each such pre-read costs one read capacity unit per 4 KB instead of half,
  and only inside a unit of work; no API change.
- **Test home:** `test/unit/dynamo-data-source.test.ts` (recording fake: both pre-reads send
  `ConsistentRead: true`; the outer paths send no `GetItem`).

### 3.17 E-3: the conditional-write refusal names the adapter

- **Decision:** `BaseRepository` takes the adapter type as an optional second constructor argument
  (`DatabaseService` passes `_adapterType`); `updateWhere`/`deleteWhere`/the versioned helpers use
  it in `UnsupportedQueryFeatureError`, falling back to `'database-plugin'` for a directly
  constructed repository.
- **Developer impact:** the detail names the adapter that lacks the feature.
- **Test home:** `test/unit/base-repository.test.ts`.

### 3.18 E-4: the agent-run replay stream's `cancel()` waits for its pump

- **Decision:** `respond.ts` keeps the pump's promise; `cancel()` aborts and then awaits it (the
  pump swallows its own abort), so `ctx.defer` cleanups run after the last store read. The inventory
  row moves to `cancel-awaits-work` with new evidence and no `handOver`.
- **Test home:** `packages/agent-runs-plugin/test/unit/respond-cancel.test.ts` (a store read held
  open: `cancel()` does not settle until it returns); the inventory test.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `IAuditLogger.log` gains an optional second parameter, which an
existing implementation still satisfies; `DriverErrorClass` gains members, which only narrows code
that switches on it exhaustively (listed in the CHANGELOG as a change, ships in minor 0.14.0).

| Exported symbol                                | Kind  | Consumer / real code path that READS it                                                   |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| `AuditLogOptions` (`common`)                   | type  | `IAuditLogger.log`; `AuditService.log` reads `scope`                                      |
| `AuditScopeUnsupportedError` (`audit-plugin`)  | class | thrown by `AuditService.log` for a scope on memory/log/file; applications `instanceof` it |
| `ForeignKeyViolationError` (`database-plugin`) | class | built by `classifiedOrOriginal` for `'foreign-key'`; `errorHandler` serves its hint       |
| `NotNullViolationError` (`database-plugin`)    | class | built by `classifiedOrOriginal` for `'not-null'`                                          |
| `DatabaseUnavailableError.reason`              | field | read by its own constructor to pick detail and type; applications branch on it            |
| `DriverErrorClass` (widened)                   | type  | `classifyDriverError`'s return; `classifiedOrOriginal` switches on it                     |

### 4.1 Options — every option names its consumer

| Option                                              | Consumer                                                           | Behavior (per implementation)                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AuditLogOptions.scope`                             | `AuditService.log` → `DatabaseAuditStorage.appendIn(scope, entry)` | database: writes through the scope; memory/log/file: rejects `AuditScopeUnsupportedError` |
| `AuditStorageOptions.table` (existing, new reading) | `DatabaseAuditStorage`                                             | names the table for the client and the entity for a scope                                 |
| `DrizzleAdapterOptions.poolStats` (existing)        | `DrizzleAdapter`                                                   | explicit wins; absent on a pg pool → the pool's counters                                  |

## 5. Implementation files

| File                                                                                                                                              | Purpose                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/common/src/services/audit.ts`                                                                                                           | `AuditLogOptions`; `log(entry, options?)` (routing per D-1)    |
| `packages/common/src/errors/duplicate-key.ts`                                                                                                     | problem type on the hint (routing per D-1/D-5)                 |
| `packages/audit-plugin/src/services/audit-service.ts`, `storage/*.ts`, `src/errors.ts` (new), `src/index.ts`                                      | scoped append; refusal class                                   |
| `packages/database-plugin/src/errors/classify.ts`                                                                                                 | new classes and signals (§3.0, 3.6–3.12)                       |
| `packages/database-plugin/src/errors.ts`, `src/index.ts`                                                                                          | two classes, `reason`, problem types                           |
| `packages/database-plugin/src/errors/problem-types.ts` (new, internal)                                                                            | the slug → `ProblemTypeInit` table, one source for every class |
| `packages/database-plugin/src/services/database-service.ts`                                                                                       | transaction catch and commit (§3.7); class builders            |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                                                                | default pool counters (§3.5)                                   |
| `packages/database-plugin/src/adapters/dynamo/dynamo-data-source.ts`                                                                              | `ConsistentRead` (§3.16)                                       |
| `packages/database-plugin/src/repositories/base-repository.ts`, `versioned-write.ts`                                                              | adapter name (§3.17)                                           |
| `packages/agent-runs-plugin/src/runtime/ai-runtime.ts`, `loop/step-loop.ts`, `log/respond.ts`                                                     | §3.2, §3.18                                                    |
| `packages/vector-store-plugin/src/health/indicator.ts`, `plugin/vector-store-plugin.ts`, `adapters/pgvector/pgvector-sql.ts`, `pgvector-store.ts` | §3.3, §3.4                                                     |
| `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts`                                                                                | §3.15                                                          |
| `docs/durable-runs.md`, `docs/problem-types.md` (new), READMEs, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, `ROADMAP.md`                | docs (§13)                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                  | src covered                                                    | Key assertions                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `database-plugin/test/unit/classify-driver-error.test.ts` (extended)                                                                                                                                       | `errors/classify.ts`                                           | the signal table of §3.0 as data; every new row, and the negative rows (`{code:4}` under mongodb, numeric strings outside the namespace) |
| `database-plugin/test/unit/database-errors.test.ts`                                                                                                                                                        | `errors.ts`, `errors/problem-types.ts`                         | each class's hint field by field; `reason`                                                                                               |
| `database-plugin/test/unit/transaction-work-classification.test.ts` (new)                                                                                                                                  | `services/database-service.ts`                                 | §3.7 table                                                                                                                               |
| `database-plugin/test/unit/drizzle-default-pool-stats.test.ts` (new)                                                                                                                                       | `adapters/drizzle/drizzle-adapter.ts`                          | §3.5                                                                                                                                     |
| `database-plugin/test/unit/dynamo-data-source.test.ts` (extended)                                                                                                                                          | `adapters/dynamo/dynamo-data-source.ts`                        | §3.16                                                                                                                                    |
| `database-plugin/test/unit/base-repository.test.ts` (extended)                                                                                                                                             | `repositories/base-repository.ts`, `versioned-write.ts`        | §3.17                                                                                                                                    |
| `database-plugin/test/integration/audit-in-transaction.test.ts` (new)                                                                                                                                      | cross-package                                                  | §3.1                                                                                                                                     |
| guarded real cells (`real-drizzle-adapter`, `real-prisma-adapter`, `real-prisma-mysql`, `real-drizzle-mysql`, `real-mongo-adapter`, `real-dynamo-adapter`, `real-bigtable-adapter`, `real-cosmos-adapter`) | real drivers                                                   | the measured signal of every new row                                                                                                     |
| `audit-plugin/test/unit/audit-scope.test.ts` (new)                                                                                                                                                         | `services/audit-service.ts`, `storage/*.ts`, `src/errors.ts`   | §3.1                                                                                                                                     |
| `agent-runs-plugin/test/unit/step-loop-failure.test.ts`, `respond-cancel.test.ts` (new); `test/integration/ai-runtime-real.test.ts`                                                                        | `runtime/ai-runtime.ts`, `loop/step-loop.ts`, `log/respond.ts` | §3.2, §3.18                                                                                                                              |
| `vector-store-plugin/test/unit/indicator.test.ts`, `pgvector-store.test.ts` (extended); `real-pgvector.test.ts`                                                                                            | `health/indicator.ts`, `adapters/pgvector/*`                   | §3.3, §3.4                                                                                                                               |
| `multi-tenancy-plugin/test/unit/resolver-chain.test.ts` (new)                                                                                                                                              | `plugin/multi-tenancy-plugin.ts`                               | §3.15                                                                                                                                    |
| `exceptions/test/integration/problem-type-database.test.ts` (new)                                                                                                                                          | (consumer proof)                                               | §3.13                                                                                                                                    |
| `common/test/unit/duplicate-key.test.ts` (extended)                                                                                                                                                        | `errors/duplicate-key.ts`                                      | type and title                                                                                                                           |
| `test/response-stream-cancel-inventory.test.ts`                                                                                                                                                            | (inventory)                                                    | §3.18 row                                                                                                                                |

## 7. Verification gates

```bash
git branch --show-current   # feat/m143h-database-errors-store-signals
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
/home/dkpaul91/.local/bin/setu-suite-queue pnpm test:coverage database-plugin audit-plugin agent-runs-plugin vector-store-plugin multi-tenancy-plugin exceptions common
/home/dkpaul91/.local/bin/setu-suite-queue pnpm run ci:local   # once, on the final commit
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0
```

Real-backend cells run against the `he-*` containers through the suite queue, with the env block of
M143q (`m143q-dbenv.sh` in the notes folder). A security audit by a freshly spawned agent runs on
the committed tree (§10).

## 8. Risks & mitigations

- **A new classifier arm catches an error it should not.** → Every arm is a row in the data table
  with a negative row beside it; the transaction-work rule reads only the thrown error or drizzle's
  wrapper.
- **A message anchor drifts with a driver release.** → Each anchor (SQLite FK and NOT NULL) has a
  real `node:sqlite` test that fails if the text moves.
- **The prototype walk reads a hostile getter.** → Guarded and bounded like `safeMembers`.
- **The default pool counters read a non-pg client.** → Only numeric `totalCount`/`idleCount`/
  `waitingCount` attach; anything else attaches nothing.

## 9. Out of scope

- The D1 half of V13-218 (M143o); CLI text about `poolStats` (none needed, M143j told); V13-134,
  V13-250 clauses one and two, V13-253 (M143n).
- Classifying errors from the outer native handle (`getDrizzleDatabase`), which never cross this
  package (§3.7).
- Changing the `ECONNRESET`/`EPIPE`/`MongoNetworkError` 503 limitation (§3.9).
- A `Retry-After` on any 503 or 409 (the hint has no header channel; unchanged since M90f).

## 10. Design security review

The diff crosses one trust boundary: what a client is told about a database error. Obligations for
the committed-tree audit:

- S-1: no new served string carries driver text, a constraint or column name, a value, or an id;
  each new detail is a fixed sentence (assert field by field).
- S-2: problem `type` URIs are constants; nothing request- or driver-derived enters them.
- S-3: the transaction-work rule cannot turn an application's own 4xx/`HttpError` into a database
  error (negative control).
- S-4: the audit scope path writes the same redacted row as the client path (negative control: a
  secret in `before` is redacted on both).
- S-5: the vector-store and agent-run log lines are value-free (`describeError` and class names
  only).

## 11. Hand-overs

| To              | Row             | Sentence                                                                                                                                                                                                                                                                 |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M143o (Workers) | V13-218 D1 half | "M143h adds `ForeignKeyViolationError`/`NotNullViolationError` and the SQLite anchors `FOREIGN KEY constraint failed` and `NOT NULL constraint failed:` to the classifier; `d1-data-source.ts` routes its errors through it as it does for `UNIQUE constraint failed:`." |
| M143j (CLI)     | V13-40          | "No template half: since M143h a Drizzle-with-pg registration gets its pool counters by default, so `setu add database` need not mention `poolStats`."                                                                                                                   |
| M143n (Docs)    | V13-139         | "`docs/problem-types.md` exists since M143h; link it from the error-format pages you write."                                                                                                                                                                             |

## 12. Open decisions for the maintainer

Each is written into §3 as the recommended option, so the plan is complete if every recommendation
is taken; a different answer changes only the named section.

| #   | Section     | Question                                                                                               | Recommended                                                                                                                             | Alternative and its cost                                                                                                                                                   |
| --- | ----------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | §3.1, §3.13 | Where do the two `common` edits ship (`IAuditLogger.log` options; `DuplicateKeyError`'s problem type)? | A small "M143 Core follow-up" pull request first, as #612/#613 did, then this letter on top of it (the lane rule, C-31).                | In this letter, with the lanes table naming the two files: one pull request fewer, against the written rule.                                                               |
| D-2 | §3.1        | A scope given to the memory, log or file audit storage.                                                | Reject with `AuditScopeUnsupportedError`; nothing written.                                                                              | Write at once and warn once: keeps tests on memory storage working, and keeps an entry for a write that rolls back.                                                        |
| D-3 | §3.7        | Which errors the transaction's own work throws are classified.                                         | The thrown driver error, or drizzle's wrapper around one; not errno codes or the AWS timeout names; plus server verdicts at `commit()`. | Classify the whole cause chain: also catches an app error wrapping a driver error, and can replace the app's own error. Or document only (today), which leaves X38-1 open. |
| D-4 | §3.6        | A pool acquire timeout.                                                                                | Same class, `reason: 'pool-saturated'`, its own detail and type; log level unchanged (`error` per served 5xx).                          | Also log it at `warn`: needs a log-level channel on the hint, a `common` change; HikariCP logs at DEBUG, EF Core at Error, Spring's health check at WARN (T-4).            |
| D-5 | §3.13       | Problem `type` URIs.                                                                                   | `https://setu-ts.dev/docs/problem-types/#<slug>`, documented on a new docs page; one `type` per database class sharing a status.        | `tag:setu-ts.dev,2026:<slug>` (RFC 9457 allows non-resolving types; no page to keep); or only the three 409s the row names.                                                |
| D-6 | §3.9        | Prisma `P1017` / `ConnectionClosed`.                                                                   | 504 (outcome unknown), the M128 rule.                                                                                                   | 503, as the bare `ECONNRESET` it maps from: consistent with a documented limitation, and says "not applied" for a write that may have run.                                 |
| D-7 | §3.11       | Statuses for FK and NOT NULL.                                                                          | FK 409 `ForeignKeyViolationError`; NOT NULL 400 `NotNullViolationError`.                                                                | Both 409 under one `ConstraintViolationError`, as Spring Data REST answers every integrity violation (T-2).                                                                |

### 12.1 Framework comparison (primary sources, read 2026-11-27)

Full tables with line numbers are in the session notes (`m143h-survey-errors.md`,
`m143h-survey-stores.md`); the rows below carry the sources this plan relies on. `SF` =
`github.com/spring-projects/spring-framework` (main), `RA` = `github.com/rails/rails` (main,
`activerecord/lib/active_record/`).

**T-1 Audit in the caller's transaction (D-1, D-2).**

| Framework                          | Same transaction?                      | How it joins                                         | Source                                                                |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Hibernate Envers                   | Yes                                    | implicit, same session/connection, before completion | `hibernate-orm` `envers/.../AuditProcess`                             |
| Rails paper_trail                  | Yes; rolled-back versions cleared      | implicit, model callbacks                            | `paper-trail-gem/paper_trail` `lib/paper_trail/model_config.rb`       |
| django-auditlog                    | Yes, same DB alias inside `atomic()`   | implicit, `post_save`                                | `jazzband/django-auditlog` `auditlog/receivers.py`                    |
| laravel-auditing                   | Yes, savepoint on the same connection  | implicit                                             | `owen-it/laravel-auditing` `src/Drivers/Database.php`                 |
| JaVers                             | Opt-in                                 | `TransactionalJaversBuilder`                         | `javers.org/documentation/spring-integration`                         |
| ABP                                | No: new non-transactional unit of work | —                                                    | `abpframework/abp` `AuditingStore.cs`                                 |
| EF Core interceptor sample         | No: its own audit database             | —                                                    | `learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors` |
| Spring Boot `AuditEventRepository` | No contract                            | —                                                    | `spring-boot` `actuate/audit/AuditEventRepository.java`               |

No compared library has an audit sink that cannot roll back yet claims to join; the explicit `scope`
argument is this framework's outbox shape rather than an implicit connection.

**T-2 Conflicts and constraint faults (D-5, D-7, §3.12).**

| Framework                             | Version conflict / unique / serialization                                                         | FK, NOT NULL, too long, out of range                                                                                  | Lock wait timeout                                                                                        | HTTP                          | Source                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Spring DAO                            | transient / non-transient / transient                                                             | `DataIntegrityViolationException` (non-transient)                                                                     | `CannotAcquireLockException` (transient) via the error-code table; untranslated by the SQLSTATE fallback | none                          | SF `spring-tx/.../dao/*.java`, `spring-jdbc/.../SQLStateSQLExceptionTranslator.java`, `sql-error-codes.xml` |
| Spring Data REST                      | 409 for optimistic lock and every integrity violation, one body                                   | 409                                                                                                                   | —                                                                                                        | 409                           | `spring-data-rest` `RepositoryRestExceptionHandler.java` L135-172                                           |
| Hibernate 7                           | `StaleObjectStateException` / `ConstraintViolationException(UNIQUE)` / `LockAcquisitionException` | `ConstraintViolationException(FOREIGN_KEY, NOT_NULL)`, `DataException`                                                | `PessimisticLockException`, `LockTimeoutException`                                                       | none                          | `hibernate-orm` `dialect/*SqlExceptionConversionDelegate`                                                   |
| Rails                                 | `StaleObjectError` (409) / `RecordNotUnique` (500) / `SerializationFailure`, `Deadlocked`         | `InvalidForeignKey`, `NotNullViolation`, `ValueTooLong`, `RangeError`                                                 | `LockWaitTimeout`                                                                                        | only `StaleObjectError` → 409 | RA `errors.rb`, `railtie.rb` L24-29                                                                         |
| Django / DRF                          | `IntegrityError`                                                                                  | `IntegrityError`, `DataError`                                                                                         | `OperationalError`                                                                                       | 500                           | `django/db/utils.py`; DRF `views.py` `exception_handler`                                                    |
| EF Core (+ EF.Exceptions)             | `DbUpdateConcurrencyException` / `UniqueConstraintException`                                      | `ReferenceConstraintException`, `CannotInsertNullException`, `MaxLengthExceededException`, `NumericOverflowException` | provider exception                                                                                       | none                          | `learn.microsoft.com/ef/core/saving/concurrency`; `Giorgi/EntityFramework.Exceptions`                       |
| Prisma 7                              | none (P2025) / P2002 / P2034 (40001 and 40P01)                                                    | P2003, P2011, P2000, P2020                                                                                            | unmapped (P2039)                                                                                         | —                             | `prisma-engines` `libs/user-facing-errors`; `@prisma/adapter-pg@7.10.1`                                     |
| RFC 9457                              | `type` need not resolve; `tag:` allowed; absolute URIs recommended                                |                                                                                                                       |                                                                                                          |                               | `rfc-editor.org/rfc/rfc9457` §3.1.1                                                                         |
| ASP.NET Core / Spring `ProblemDetail` | default `type` = the RFC 9110 section of the status / `about:blank` (6.2)                         |                                                                                                                       |                                                                                                          |                               | `aspnetcore` `ProblemDetailsDefaults.cs`; SF `ProblemDetail.java`                                           |

No compared framework gives the three 409s distinct problem types; the problem-type seam already
exists here (C-14), so D-5 adds data, not machinery.

**T-3 Timeouts (§3.8, §3.9).**

| Source                                                                                                                   | Fact                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `smithy-typescript` `node-http-handler/src/set-connection-timeout.ts`, `set-request-timeout.ts`, `set-socket-timeout.ts` | Connection, request and socket timeouts are all `name: 'TimeoutError'`: the name does not say whether the request was sent.                  |
| AWS SDK v2                                                                                                               | `NetworkingError` is a v2 name only (absent from v3/smithy source).                                                                          |
| AWS Builders' Library, "Timeouts, retries and backoff with jitter"                                                       | "A timeout or failure doesn't necessarily mean that side effects haven't happened."                                                          |
| `grpc.io/docs/guides/status-codes`                                                                                       | `DEADLINE_EXCEEDED` "may be returned even if the operation has completed successfully".                                                      |
| SF `QueryTimeoutException`                                                                                               | transient.                                                                                                                                   |
| RA `postgresql_adapter.rb` L988-1005                                                                                     | `ConnectionNotEstablished` (never sent) against `ConnectionFailed` (the server may have executed it): the same split as M128's 503/504 rule. |

**T-4 Pool saturation (§3.5, §3.6, D-4).**

| Framework                 | Saturation vs outage                                                                             | Acquire-timeout log        | Source                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Spring Boot               | a timed-out borrow in the health check is DOWN; the database is not in readiness by default      | WARN (health check)        | `spring-boot` `DataSourceHealthIndicator.java`, `AbstractHealthIndicator.java` L78-80; "Kubernetes probes" docs |
| HikariCP                  | `SQLTransientConnectionException` with total/active/idle/waiting in the message; MXBean counters | DEBUG                      | `HikariPool.java` L419-425, L695; `HikariPoolMXBean.java`                                                       |
| ASP.NET Core NpgSql check | every exception → the registration's failure status                                              | —                          | `HealthChecks.NpgSql/NpgSqlHealthCheck.cs`                                                                      |
| EF Core                   | —                                                                                                | `ConnectionError` at Error | `RelationalStrings.Designer.cs`                                                                                 |
| pg-pool                   | `totalCount`, `idleCount`, `waitingCount`; the timeout is a bare `Error`                         | none                       | `node-postgres` `packages/pg-pool/index.js` L501-515                                                            |

None treats a full pool as degraded-but-ready on its own; this framework's rule for that (M101a) is
a prior decision, and §3.5 only supplies its input.

**T-5 Native SQL inside a transaction (D-3).** Translated: Rails `connection.execute` (RA
`abstract_adapter.rb` `with_raw_connection`), Django cursors (`django/db/backends/utils.py`),
Hibernate native queries. Not translated: EF Core raw SQL (`RelationalCommand.cs` rethrows), a raw
JDBC connection from SF `DataSourceUtils`. Drizzle 0.45 wraps every statement, `commit` included, in
`DrizzleQueryError` with the driver error as `cause`; Prisma raw queries surface as `P2010` with the
kind in `meta`.

**T-6 Subclass matching (§3.10).** Spring Data MongoDB `MongoExceptionTranslator.java` L58-151:
`instanceof` for socket errors, exact simple names for the rest. `mongodb` v6 `cmap/errors.ts`:
`PoolClearedError` extends `MongoNetworkError` and carries one label, `PoolRequstedRetry` (spelt
`PoolRequestedRetry` in v7).

**T-7 Prisma codes (§3.9).** `prisma-engines` `libs/user-facing-errors/src/common.rs`: `P1001`
"Can't reach database server" (`DatabaseNotReachable`), `P1008` socket timeout (`SocketTimeout`),
`P1017` "Server has closed the connection" (`ConnectionClosed`).

**T-8 AI SDK (§3.2).** `vercel/ai` (`ai@7.0.183` source): `toUIMessageStream({ onError })` receives
the raw error and returns the text; `streamText({ onError })` receives `{ error }`; after retries
the error is a `RetryError` whose `lastError` is the `APICallError` (`statusCode`, `isRetryable`).

**T-9 DynamoDB reads (§3.16).**

| Source                                                                                     | Fact                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html` | Reads are eventually consistent unless `ConsistentRead: true` (tables and LSIs).                                                                            |
| `.../developerguide/read-write-operations.html`                                            | Strong 1 RCU per 4 KB, eventual 0.5, transactional 2.                                                                                                       |
| `.../developerguide/DynamoDBLocal.UsageNotes.html`                                         | DynamoDB Local's reads are eventually consistent, though most appear strong: a local test cannot show the stale read, so the unit test asserts the request. |
| AWS SDK Java v2 Enhanced Client, DynamoDBMapper, ElectroDB, Dynamoose                      | None pre-reads before `update`/`delete`; each sends one conditional write.                                                                                  |

## 13. Docs deliverables

`packages/database-plugin/README.md` (classified-conditions table, connection-loss table, the
transaction-work paragraph, the pool default, DynamoDB consistency), `AGENT_CARD.md`,
`packages/audit-plugin/README.md`, `packages/agent-runs-plugin/README.md`,
`packages/vector-store-plugin/README.md`, `packages/multi-tenancy-plugin/README.md`,
`packages/exceptions/README.md`, `docs/problem-types.md`, `docs/durable-runs.md`, `PUBLIC_API.md`,
`CHANGELOG.md`, `docs/upgrading.md`, the ROADMAP M143h row list (E-1) and lanes table (C3).
