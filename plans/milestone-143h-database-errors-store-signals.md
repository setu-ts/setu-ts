# Milestone 143h — Database errors a client can act on, and store signals (`@setu-ts/database-plugin` + 5)

> **Status:** Approved by the maintainer on 2026-11-27 (IST): D-2 to D-8 as recommended, and D-1
> changed to its alternative (the `common` edits ship in this pull request; §12). Implementation
> waits for the maintainer's explicit go. Branch: `feat/m143h-database-errors-store-signals`, cut
> from `origin/develop` at `1f21e029a` (after #617 M143q and #618 M143c). `develop` and `main` are
> protected; all work, implementation and fixes, stays on this branch until it merges through one
> pull request into `develop`.

## 0. Objective & scope

The Data lane's second letter, after M143q (#617). Fifteen rows where a database fault reaches a
client as a masked `500` or as a status that says something false, where several conflicts look the
same to a client, and where a store fails without saying why. When it ships: a serialization
conflict raised through the framework's own Drizzle handle, a foreign-key or NOT NULL violation, a
lock wait timeout each answer a named status on every SQL cell, and a value too long or out of range
does on every repository call; a call that timed out answers `504` and claims nothing about the
write; a Prisma `P1017` and a MongoDB pool-cleared subclass are classified; the three kinds of `409`
carry different problem types; a full pg pool reads as saturation in both the response and
readiness, and gets its counters without hand-wiring; an audit entry can be written inside the
caller's transaction; the vector-store indicator and the agent-run loop log the cause of a failure;
the pgvector index check says "wrong operator class" rather than "missing"; the run-budget recipe
works outside this repository; and a resolver-name array in multi-tenancy is refused at startup
instead of resolving no tenant.

Code changes are in the Data lane's packages: `database-plugin`, `exceptions` (`ERROR_TYPE_BASE`'s
source and docs, §3.13), `audit-plugin`, `agent-runs-plugin`, `vector-store-plugin`,
`multi-tenancy-plugin`, their tests and READMEs, plus the per-letter entries in `PUBLIC_API.md`,
`CHANGELOG.md` and `docs/upgrading.md`. Changes in `packages/common` (D-1, D-5) include edits to
existing `common` contracts, which the lane rule routes through the Core lane; by the maintainer's
decision D-1 they ship in this pull request instead, named in the lanes table as an approved
out-of-lane edit. Files outside the lane's packages are named in the lanes table first (C3):
`docs/durable-runs.md` and `docs/problem-types.md`, the agent-runs row of
`test/response-stream-cancel-inventory.test.ts`, `test/guide-fence-compiler.test.ts` and
`test/fixtures/snippets/fence-engine.ts` (§3.14), `packages/idempotency-plugin` (§3.7, D-8; in no
lane), `pnpm-lock.yaml` (the new `audit-plugin` devDependency) and `website/src/lib/docs-nav.ts`
(the new docs page).

**Row clauses this letter resolves by decision rather than by code**, so a re-run does not reopen
them: V13-115's widened clause (typed-builder errors outside a transaction, through
`getDrizzleDatabase`, reach the application as thrown; §3.7, §9), and V13-50's log-volume clause
(one `error` line per failed request stays, D-4).

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
    `d1-data-source.ts` itself is M143o's (ROADMAP "Half of a row owned elsewhere: V13-218"). Since
    a D1 registration's errors are classified by `DatabaseService` (§3.11), M143o's half is the
    proof on `workerd`.
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

| #   | Conflict                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                           | Doc deliverable (same PR)                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| C1  | `packages/database-plugin/README.md` "Errors your own transaction work throws are not classified (M128)" against the X38-1 decision that a serialization conflict answers 409 (V13-115).                                                       | The X38-1 decision. A driver error the work throws is classified by §3.7's rule; a foreign error still reaches the caller as itself.                               | README paragraph rewritten; `docs/upgrading.md` 0.14.0 entry.                           |
| C2  | The exceptions README: "Read `status` to distinguish errors" against three 409s with different client actions (V13-139).                                                                                                                       | Distinguish by problem `type` (D-5).                                                                                                                               | `packages/exceptions/README.md` sentence; `docs/problem-types.md`.                      |
| C3  | The lanes table lists no owner for the files outside the lane named in §0.                                                                                                                                                                     | They join the Data lane for this letter, as M143q's D-10 did for its files.                                                                                        | `ROADMAP.md` lanes table, Data row (all named since the decision commit of 2026-11-27). |
| C4  | README connection-loss table puts the Prisma `P1001` row under 503, with no row for `P1017`.                                                                                                                                                   | §3.9.                                                                                                                                                              | README table row.                                                                       |
| C5  | README: "The older `ECONNRESET`/`EPIPE`/`MongoNetworkError` arms still answer `503` even for a write in flight; that is a known limitation" (`README.md:1668-1669`), and "Every other commit rejection is still rethrown unchanged" (`:1643`). | §3.8 ends the limitation on DynamoDB (smithy renames those codes to `TimeoutError`); it still holds for Cosmos; §3.7 maps commit-time conflicts and FK violations. | Both sentences rewritten; the `503` row stops implying the AWS names.                   |
| C6  | The committed problem-type base (`exceptions` `ERROR_TYPE_BASE = 'https://setu-ts.dev/errors'`, used by `validation-plugin` and documented at `exceptions/README.md:133-136`) against a first draft of D-5 that used a second scheme.          | The committed base (§3.13); its source moves to `common` and `exceptions` re-exports it.                                                                           | Exceptions README paragraph extended with the database types.                           |

## 3. Design decisions

Each decision has a comparison (§12.1 holds the sources) and a developer-impact line: what an
application upgrading to `0.14.0` meets, and its way out. Rules applied throughout: refuse only when
carrying on would lose data or fail silently, otherwise adjust and warn once; add no machinery the
compared frameworks lack; there are no existing users to keep compatible.

### 3.0 One classification table, every interception site

The classifier gains two classes, `'foreign-key'` and `'not-null'` (`DriverErrorClass` is internal:
not exported from `src/index.ts`, and the README calls the classifier internal). Every site that
classifies today reads them through `classifiedOrOriginal`: a repository call, `query()`,
`beginTransaction`, the transaction catch (§3.7) and `commit()` (server verdicts only, §3.7). Value
refusals stay on the existing `refusedInputOf`/`refusalErrorOf` path, outside the class union
(§3.12). The pass-through list at the top of `classifyDriverError` (`classify.ts:206-213`) gains the
two new error classes, so a probe or a direct caller cannot re-wrap them. The full table is the data
of `test/unit/classify-driver-error.test.ts` (rows: signal, backend, class, site set, and a negative
row beside each new arm).

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
  `options.table` registered on the database (a Drizzle table or Prisma model whose **field names**
  are `toAuditRow`'s snake_case keys — `resource_id`, `user_id` — since the SQL adapters refuse
  unknown fields, M119e; the README recipe says so). A memory-storage test that passes a scope gets
  the named rejection; the way out is `storage: 'database'` or dropping the scope.
- **Lane routing (D-1, decided):** this edits an existing `common` contract. By the maintainer's
  decision of 2026-11-27 ("Do D1 in the same PR") it ships in M143h's own pull request, with no
  separate Core follow-up. This departs from the lane rule that a change to an existing `common`
  contract is made by the Core lane first (C-31); the `common` files are named in the lanes table as
  a maintainer-approved out-of-lane edit (C3).
- **Test home:** `packages/audit-plugin/test/unit/audit-service.test.ts` and
  `database-audit.test.ts` (scoped write reaches `scope.getRepository(table).create` with
  `toAuditRow`'s row; no scope uses the client; memory, log and file reject
  `AuditScopeUnsupportedError` and write nothing; redaction applies on the scoped path);
  `packages/audit-plugin/test/integration/audit-in-transaction.test.ts` (real `DatabasePlugin`
  memory adapter + `AuditPlugin`, `@setu-ts/database-plugin` added as a `workspace:^` devDependency
  of `audit-plugin`: a rolled-back transaction leaves no audit row, a committed one leaves exactly
  one; guarded PostgreSQL cell).

### 3.2 V13-27: a failed model call logs its cause

- **Decision:** `ai-runtime.ts` keeps the error `toUIMessageStream`'s `onError` receives (the
  returned text stays `'Agent model call failed.'`), and the generation exposes it as
  `failure(): unknown`. `step-loop.ts:253` throws that error when present (falling back to today's
  `Error` only when the stream sent an error chunk with no captured error). The failure log already
  reads `error.name` and the status hint, so a spent budget logs `QuotaExceededError` with `429`, a
  quota-store outage its own class and `503`, a non-retryable provider refusal `AI_APICallError`,
  and a provider error that exhausted its retries `AI_RetryError`. Nothing else is logged: the
  value-free rule of plan §8a O6 (M136) stands — no message, no provider text.
- **Why:** the docs already promise the class and status (`docs/durable-runs.md:213`); the AI SDK
  hands the original error to `onError` (§12.1 T-8).
- **Developer impact:** log lines change from `"error":"Error"` to the real class; no API change.
- **Test home:** `packages/agent-runs-plugin/test/unit/step-loop.test.ts` (a fake runtime whose
  stream errors with a `QuotaExceededError` → log carries the class and `429`; a provider-shaped
  error → its name; an error chunk with nothing captured → `Error`, as today); one real-`ai` test in
  `test/integration/real-ai.test.ts` driving `loadAi()` with a mock model that throws.

### 3.3 V13-39: the vector-store indicator logs its probe's cause

- **Decision:** the plugin passes the indicator a `createConnectionErrorReporter`
  (`source: 'vector-store-plugin: <adapter>'`, `logger: () => ctx.logger`). The function the
  indicator hands `createCachedProbe` as `probe` calls `isHealthy` and races it against its own
  timer on `runtime.setTimeout`, set to the same bound (`PROBE_TIMEOUT_MS`): `createCachedProbe`
  turns a timeout into `fallback` internally with no hook (`common/src/health/probe.ts:171-187`), so
  the indicator's wrapper is where the timeout is seen. A rejection is `report(error)`ed; the timer
  firing reports an `Error("did not answer within 2000 ms")` built there; a `false` with no error
  (pgvector saturated and not progressing, `pgvector-store.ts:368-370`; Qdrant's collection absent,
  `qdrant-store.ts:349`) reports `Error("reported unreachable")`; a `true` calls `recovered()`. The
  first outcome of a probe wins: a settlement after the wrapper's timer fired is ignored (no late
  `recovered()`, no second line), and the adapter's own `undefined` (it could not tell, e.g.
  pgvector saturated and progressing) reports nothing. Nothing is thrown out of the wrapper beyond
  what `createCachedProbe` already handles, and the health payload is unchanged
  (`reachable: false`), so `details: true` discloses nothing new.
- **Why:** the sibling indicators log the cause this way (service-discovery, M139f; the
  connection-error reporter, M119g); a log line is where an operator tells a revoked key from a dead
  backend.
- **Developer impact:** one `warn` per outage (the error's `describeError` text, which includes its
  message, as the service-discovery reporter's does) and one `info` on recovery.
- **Test home:** `packages/vector-store-plugin/test/unit/health-indicator.test.ts` (extended:
  rejection → one warn, repeats at debug, recovery info; timeout → warn naming the bound; `false` →
  warn; no logger → no throw), and `test/integration/vector-store-plugin.test.ts` for the plugin
  wiring.

### 3.4 V13-5: the pgvector index check tells "wrong" from "missing"

- **Decision:** `describeStatement` returns two more columns, `vector_index_present` and
  `source_index_present`: an index of the expected name exists at all
  (`to_regclass(<name>) IS NOT NULL`). The check says "is missing its HNSW index" (or source index)
  only when it is absent; otherwise "has a relation named `<name>` that is not the expected valid,
  non-partial `<definition>` index on `<table>`; drop it and create it as expected". The neutral
  sentence covers every reason the existing `EXISTS` is false while the name exists: another method
  or operator class, an invalid index (a failed `CREATE INDEX CONCURRENTLY`), a partial index, or
  one on another table.
- **Why:** an operator reading "missing" runs `CREATE INDEX IF NOT EXISTS`, which does nothing.
- **Developer impact:** message text only.
- **Test home:** `test/unit/pgvector-store.test.ts` (fake rows: absent → "missing"; present but
  wrong → "is not the expected", for both indexes); guarded real cell (`PGVECTOR_URL`) in
  `test/integration/conformance.test.ts` building the HNSW index with `vector_l2_ops`.

### 3.5 V13-40: a pg pool's counters by default

- **Decision:** when the Drizzle registration sets no `poolStats` and the instance's `$client` is a
  node-postgres pool (numeric `totalCount`, `idleCount` and `waitingCount`), the adapter reads them
  as its default `poolStats`, which attaches the capacity, progress and probe-acquire-timeout seams
  (C-17). An explicit `poolStats` wins. mysql2's pool has no public counters, and Prisma exposes
  none, so those arms keep today's behaviour, and the README says so.
- **Not aligned:** `vector-store-plugin`'s `poolSaturated` (`pgvector-store.ts:508-520`) reads the
  same pg-pool counters with its own rule (`totalCount >= options.max`); the two packages own
  different pools and indicators, so this letter leaves both rules and the README notes the
  difference.
- **Why:** the plugin already reaches the pool (C-19); the saturation rule exists and only lacked
  its input. Compared frameworks read their own pool's counters (§12.1 T-4).
- **Developer impact:** on Drizzle with pg, a saturated but progressing pool stops failing `/ready`
  without any change; an application that wrote `poolStats` by hand can delete it.
- **Query progress (D-9, decided 2026-11-27 after the code review).** With the default counters, an
  application that queried through `getDrizzleDatabase`/`getDrizzleTransaction` made progress
  "unobservable", so a pool full because the database hung read `up` forever. pg-pool `release`
  events now count as completed queries for the progress seam, so progress is observable for every
  query: a full pool that still releases reads `up` with `reachable: 'unknown'`, and a full pool
  with no releases (a hung database) reads `degraded`. No option is added. Tests: a hung database
  filling the pool reads `degraded` (including after `getDrizzleDatabase`); a negative control fails
  without release counting; a busy pool that still releases reads `up`.
- **Test home:** `test/unit/drizzle-default-pool-stats.test.ts` (a `$client` with the three counters
  → seams attached and read; explicit `poolStats` wins; a client without numeric counters → no
  seams); guarded live cell in `test/integration/real-drizzle-adapter.test.ts`: saturate a
  two-connection pool with no `poolStats` and read `/ready` 200 with `reachable: 'unknown'`.

### 3.6 V13-50: a pool acquire timeout reads as saturation (D-4)

- **Decision (recommended, D-4):** a pg-pool acquire timeout (C-18) becomes
  `DatabaseUnavailableError` with a new read-only `reason: 'pool-saturated'` (other cases
  `'unreachable'`), served `503` with the detail "The database connection pool is busy. The request
  was not applied." and the problem type `database-pool-saturated` (D-5); the outage keeps today's
  sentence and `database-unavailable`. Saturation is read from pg-pool only
  (`isPoolAcquireTimeout`); the mariadb pool timeout `45028` stays `reason: 'unreachable'`, and the
  README says so. The error-handler log level is unchanged (`error` per served 5xx), as for every
  other 5xx: §12 records the alternative of logging this case at `warn`.
- **Why:** the response then agrees with readiness (`isSaturated`, M101a) instead of calling the
  same state an outage. One line per failed request is what every compared framework logs for an
  acquire timeout (§12.1 T-4).
- **Developer impact:** the `detail` and `type` change on this one case;
  `instanceof DatabaseUnavailableError` still holds, and a client can branch on the type.
- **Test home:** `test/unit/classify-driver-error.test.ts` (row) and `test/unit/errors.test.ts`
  (reason, detail, type).

### 3.7 V13-115: driver errors thrown by the transaction's own work (D-3, D-8)

- **Decision (recommended, D-3):** in `transaction()`'s catch, an error the work throws is
  classified when it is **itself a driver error**: its own members carry a signal (including the
  Prisma driver-adapter cause the classifier already treats as one of its members,
  `classify.ts:249-259`), or it is drizzle-orm's query wrapper (C-10: an `Error` with a string
  `query`, an array `params` and a `cause`) whose `cause` carries one. A signal found deeper — an
  application error that wraps a driver error as its `cause` — is not read, and the application's
  error reaches the caller as itself. Three signal kinds are excluded at this site because a foreign
  call raises them too: the errno family (C-3); the AWS/Cosmos `TimeoutError` and `NetworkingError`
  names; and every **numeric** code (Bigtable's gRPC `4`/`10`/`14` are what every google-gax client
  raises, and Cosmos's `429`/`449`/`503` are HTTP statuses). What remains are string codes in a
  signals the classifier reads that only a database client raises; the set is the data of
  `transaction-work-classification.test.ts`, one row per signal, marked in or out:
  - **in:** SQLSTATE codes (5 characters, including the `08` class), Prisma `P`-codes and adapter
    kinds, mysql2 `ER_*` codes and `PROTOCOL_CONNECTION_LOST`, mariadb codes under the adapter
    namespace, libsql `SQLITE_BUSY`, MongoDB labels and Mongo error names (`Mongo*`, read with the
    prototype walk of §3.10), DynamoDB `TransactionConflictException`, and the pg and SQLite message
    anchors (node:sqlite's `ERR_SQLITE_ERROR` carries the SQLite text);
  - **out:** the errno family, `TimeoutError`/`NetworkingError`, and every numeric code. This keeps
    V11-5 closed (a refused webhook, a Pub/Sub `UNAVAILABLE`, an HTTP 503 are not "database
    unavailable") while a SQLSTATE `40001` from `getDrizzleTransaction(...)` answers 409 again.
- **Commit-time verdicts:** `commit()` already maps `'duplicate'`; it also maps `'conflict'`
  (`40001`/`40P01`, which PostgreSQL may raise at `COMMIT` under SERIALIZABLE; drizzle wraps
  `COMMIT` in `DrizzleQueryError` too, T-5) and `'foreign-key'` (a deferred constraint checked at
  `COMMIT`), and `'not-null'` (D1's atomic batch and the buffered adapters raise it at `commit()`,
  where the same write outside a transaction answers 400). Each is the server refusing the whole
  transaction, so nothing was applied. A MongoDB commit error carrying the
  `UnknownTransactionCommitResult` label is never mapped (the driver adds it when the outcome is
  unknown, `mongodb/lib/sessions.js:326-336, 550-565`), and unavailable and timeout at commit stay
  unclassified: the acknowledgement may have been lost after the write.
- **Consumers that branch on `409` (D-8).** Two first-party paths treat any `409` as a conflict and
  now see new 409s (commit-time conflicts, foreign-key violations):
  `idempotency-plugin/src/within/within.ts:103-147` (`isConflict` →
  `IdempotencyWithinError ('conflict')`, "another call holds this key; retry") and
  `sdk/src/retry/retry-strategy.ts:163` (a keyed request retries every `409`). The agent-run tool
  runner (`tool-runner.ts:115`) is **not** one: the only `409` it sees is `within`'s own
  `IdempotencyWithinError('conflict')`, which carries no cause
  (`idempotency-plugin/src/errors.ts:131-153`); a tool's own database error is wrapped in
  `ToolFailure` inside `fn` and already fails the tool. Recommended (D-8): `within`'s `isConflict`
  narrows to "the key raced another call": `DuplicateKeyError` by `instanceof` (a `common` class)
  and `SerializationConflictError` by its `write-conflict` problem type from `common` (D-5), since
  `idempotency-plugin` has `database-plugin` only as a devDependency. `lock-timeout` counts too: the
  key's row was held by another call. A foreign-key violation at a `within` commit then becomes
  `store-failed` (503), which the tool runner rethrows, so the run fails rather than retrying a
  write that cannot succeed. `idempotency-plugin` is in no lane; it joins the Data lane for this
  change (C3). An application-supplied `ITransactionalIdempotencyStore` that signals a holder with a
  `409` of its own then reads as `store-failed`; the idempotency README says to raise
  `DuplicateKeyError`. The SDK keeps retrying a keyed `409` (CLI lane, unchanged): an FK violation
  is retried up to the retry limit and then surfaces, which costs requests but loses nothing; §11
  hands the narrowing to the CLI lane.
- **Why:** frameworks that hand out a native handle translate its errors at the connection layer
  (§12.1 T-5); wrapping the handle in a proxy is machinery none of them has, so the transaction
  boundary is the one site this package owns.
- **Developer impact:** a native-handle conflict now answers 409 "safe to retry" instead of a
  masked 500. Outside a transaction (`getDrizzleDatabase(...)`), errors still reach the application
  as thrown; the README says so and points at checking the drizzle `cause`. This is the resolution
  of V13-115's widened clause (§0).
- **Test home:** `test/unit/transaction-work-classification.test.ts` (new; table: a pg error thrown
  directly → classified; a `DrizzleQueryError`-shaped wrapper → classified; a Prisma `P2034` →
  classified; an app error with a driver `cause` → itself; `ECONNREFUSED`, a `TimeoutError`,
  `{ code: 14 }` under `bigtable` and `{ code: 503 }` under `cosmos` → itself; a commit `40001` →
  409; a commit `23503` → 409; a commit `NOT NULL constraint failed:` → 400; a commit `ECONNRESET` →
  itself; a Mongo commit with `UnknownTransactionCommitResult` → itself); guarded real cell in
  `test/integration/real-drizzle-adapter.test.ts`: two SERIALIZABLE transactions through
  `getDrizzleTransaction` → one 200, one 409. `idempotency-plugin/test/unit/within.test.ts`
  (extended): an FK at commit inside `within` is `store-failed`, not "another call holds this key";
  a `SerializationConflictError`-typed and a `DuplicateKeyError` rejection stay `conflict`;
  `agent-runs-plugin/test/unit/tool-runner.test.ts` (extended): `IdempotencyWithinError('conflict')`
  still gives `ToolConflict`.

### 3.8 V13-237: a timed-out call answers 504 and claims nothing

- **Decision:** the rule is per chain member, so the existing outer-name rule
  (`classify.ts:217-221`; test `classify-driver-error.test.ts:287-295`, "prefers a code found DEEPER
  in the chain over a generic name at the top") still holds:
  - in `classifyStructured`, a member whose `code` is in the errno family **and** whose own `name`
    is `TimeoutError` is `'timeout'` (smithy's `requestTimeout` error is
    `{ name: 'TimeoutError', code: 'ETIMEDOUT' }`, and its socket error renamed from
    `ECONNRESET`/`EPIPE`/`ETIMEDOUT` keeps its code, C-7); the same code with any other name stays
    `'unavailable'`;
  - Cosmos's string `code: 'TimeoutError'` is `'timeout'` (C-8);
  - in `classifyFallback`, the name `TimeoutError` with no code is `'timeout'` (`classify.ts:596`
    today reads `'unavailable'`);
  - for Bigtable, gRPC code `4` (`DEADLINE_EXCEEDED`) is `'timeout'`, for calls M143q's own bound
    did not end (an SDK default deadline, an injected facade);
  - `NetworkingError` stays `'unavailable'`: it is an SDK v2 name that v3 never raises (§12.1 T-3).
    A connection-establishment timeout also becomes 504; that answer is less specific but never
    false, while splitting on the SDK's message text would need an anchor per SDK version.
- **The NoSQL readiness probes.** `dynamo-adapter.ts:165` and `cosmos-adapter.ts:246` answer `false`
  (refused, `down`) only for `'unavailable'` and rethrow otherwise. An SDK timeout in the probe now
  rejects, so `reachability()` is `undefined` and the indicator reads `degraded`; `/ready` fails in
  both. This is the stated decision: a probe that timed out learned nothing about refusal, which is
  M143q §3.9's rule that an expiry means unknown.
- **`isConnectionLostMidCall`.** The smithy socket error renamed from `ECONNRESET`/`EPIPE` is a
  connection lost under a sent request, not a bound: it joins `isConnectionLostMidCall`
  (`classify.ts:339-352`), so the log says "connection closed … outcome unknown", not "did not
  answer within the driver call bound".
- **Why:** the README's own rule — no verdict on a sent request means the outcome is unknown — and
  gRPC's definition of `DEADLINE_EXCEEDED` (§12.1 T-3).
- **Developer impact:** a DynamoDB or Cosmos request timeout answers 504 "did not answer in time"
  instead of 503 "not applied"; a client stops repeating writes that landed. On DynamoDB a
  smithy-renamed `ECONNRESET`/`EPIPE` on **DynamoDB** therefore answers 504, which ends the README's
  "known limitation" there (§2 C5). Cosmos is built on `@azure/core-rest-pipeline`, not smithy, so a
  Cosmos `ECONNRESET` stays 503 and the limitation sentence still holds for it.
- **Test home:** `test/unit/classify-driver-error.test.ts` rows
  (`{ name: 'TimeoutError', code: 'ETIMEDOUT' }`, `{ name: 'TimeoutError', code: 'ECONNRESET' }`, a
  bare `TimeoutError`, Cosmos C-8, Bigtable `{ code: 4 }` under `bigtable`, `{ code: 4 }` under
  `mongodb` unclassified, and the `:293` outer-`TimeoutError`-over-`40001` row kept as a negative);
  `test/unit/nosql-readiness-probe.test.ts` (extended beside the refused tables at `:85-90`: an SDK
  timeout rejects, giving `degraded`).

### 3.9 V13-132: Prisma `P1017` and the socket kinds (D-6)

- **Decision (recommended, D-6):** `P1017` ("Server has closed the connection") maps to `'timeout'`
  (504), and so do `P1008` (socket timeout) and the adapter kinds `ConnectionClosed` and
  `SocketTimeout` (Prisma's engine turns them into `P1017` and `P1008`, §12.1 T-7).
  `DatabaseNotReachable` and `TooManyConnections` (`P2037`) map to `'unavailable'` (503), and so do
  the raw codes they come from on the other cells: SQLSTATE `53300` (Drizzle with pg) and mysql2
  `ER_CON_COUNT_ERROR` (1040) and `ER_TOO_MANY_USER_CONNECTIONS` (1203); adapter-mariadb already
  maps 1040/1203 to the `TooManyConnections` kind. The kind is read even when the adapter cause
  carries no `originalCode` (C-5: socket errors never do), which M143q's reader required. `P1017`
  and `ConnectionClosed` are a connection lost under a sent statement, so they join
  `isConnectionLostMidCall` and log "connection closed … outcome unknown"; `P1008` and
  `SocketTimeout` are a bound elapsing and keep "did not answer within the driver call bound".
- **Why:** M128's rule (README "Connection loss during an outage") puts a connection dropped under a
  statement with no verdict at 504. `ConnectionClosed` is Prisma's mapping of `ECONNRESET` (C-5),
  and the bare `ECONNRESET` arm is a documented limitation at 503; this letter does not extend the
  limitation to a new code.
- **Developer impact:** during a PostgreSQL restart a Prisma call answers 504 instead of a masked
  500; too many connections answers 503 on every SQL cell.
- **Test home:** `classify-driver-error.test.ts` rows (Prisma shapes with and without
  `originalCode`; the raw `53300`/1040 rows; `isConnectionLostMidCall` rows).

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
  value."). Signals: SQLSTATE `23503`, `23001` (`restrict_violation`) and `23502`; mysql2
  `ER_NO_REFERENCED_ROW_2`, `ER_ROW_IS_REFERENCED_2`, `ER_BAD_NULL_ERROR`,
  `ER_NO_DEFAULT_FOR_FIELD`; the Prisma kinds `ForeignKeyConstraintViolation`, `RestrictViolation`
  and `NullConstraintViolation` (adapter-mariadb reaches 1451/1452/1048/1263/1364 only through these
  kinds) and Prisma `P2003`/`P2011`; and SQLite's `FOREIGN KEY constraint failed` and
  `NOT NULL constraint failed:` message anchors, each accepted with and without the `D1_ERROR: `
  prefix as the unique anchor is (`classify.ts:605-608`). Every interception site (§3.0).
- **D1.** `d1-data-source.ts` does not call the classifier; a D1 registration is `type: 'custom'`
  and its errors are classified by `DatabaseService.classifiedOrOriginal` with the `D1_ERROR: `
  prefix anchor. So once the two anchors land, D1 answers the new statuses; M143o's half is the
  proof on `workerd` (§11).
- **Why:** every compared framework classifies all four as non-transient caller faults (Spring
  `DataIntegrityViolationException`, Hibernate `ConstraintViolationException` with its kind, Rails
  `InvalidForeignKey`/`NotNullViolation`, Django `IntegrityError`, EF.Exceptions, Prisma
  `P2003`/`P2011`), but only Spring Data REST serves a status for them (409 for every integrity
  violation); the rest answer 500 (§12.1 T-2). The framework's own `DuplicateKeyError` reasoning (a
  masked 500 says the server failed when the caller's write did) applies unchanged.
- **Developer impact:** these answer 409/400 with a fixed sentence instead of a masked 500; nothing
  about the row or the constraint is disclosed. The consumers that branch on 409 are covered by D-8
  (§3.7).
- **Test home:** `classify-driver-error.test.ts` rows (both anchor forms, copied from the unique
  rows at `:186-190`); guarded real cells on PostgreSQL, MySQL (Drizzle and Prisma) and
  `node:sqlite`.

### 3.12 V13-252: value too long, out of range, lock wait timeout

- **Decision:**
  - Value too long and numeric out of range join the existing value refusal (C-13):
    `InvalidFieldValueError` (400) on repository calls, where an entity is known. Signals: SQLSTATE
    `22001` (`22003` already), Prisma `P2000`/`P2020` and kinds `LengthMismatch`/`ValueOutOfRange`,
    mysql2 `ER_DATA_TOO_LONG` and `ER_WARN_DATA_OUT_OF_RANGE`. `refusedInputOf` and
    `isValueTypeRefusal` switch from `causeChainMembers` to `classificationMembers`, so the Prisma
    adapter cause (its kind, and its `originalCode` `22001`/`22003`) is read; today a Prisma `P2020`
    is a masked 500 although `22003` is in the set. Prisma's own `P2000`/`P2020` are read only on a
    `PrismaClientKnownRequestError`, as `P2007` is. `22001` joining `VALUE_REFUSAL_CODES` also
    changes `isValueTypeRefusal`, which the Drizzle and Prisma keyset cursors read
    (`drizzle-adapter.ts:1199`, `prisma-adapter.ts:910`): a forged cursor value too long for its
    column then answers `InvalidCursorError` like a mistyped one, which is intended. Through
    `query()` and the transaction's own work they stay unclassified: `InvalidFieldValueError` is
    constructed with the entity and says the value does not fit "its field", which a raw statement
    cannot name; the README says so. (`NotNullViolationError` is served there because its sentence
    names no field.)
  - A lock wait timeout is `'conflict'`: `SerializationConflictError` (409, "safe to retry"),
    constructed with `reason: 'lock-timeout'` when the internal predicate
    `isLockTimeout(error, adapterType)` holds (false unless the class is `'conflict'`, then `55P03`,
    `ER_LOCK_WAIT_TIMEOUT` or mariadb `1205` under `mysql-adapter` on the same members, the shape of
    `isConnectionLostMidCall`), which gives it its own problem type `lock-timeout` (§3.13) and the
    same detail. Signals: SQLSTATE `55P03` (`lock_not_available`), mysql2 `ER_LOCK_WAIT_TIMEOUT`,
    mariadb `1205` under the `mysql-adapter` namespace. PostgreSQL aborts the transaction; MySQL
    rolls back the statement, and the framework then rolls back the unit of work, so in both the
    write was not applied.
- **Why:** Spring's error-code table maps `55P03` and MySQL 1205 to the transient
  `CannotAcquireLockException`; Rails has `LockWaitTimeout` (§12.1 T-2).
- **Developer impact:** 400 or 409 with a fixed sentence instead of a masked 500.
- **Test home:** `classify-driver-error.test.ts` rows; `test/unit/errors.test.ts` (`reason`);
  guarded real cells (a 16-character value into `varchar(8)`; `lock_timeout = '100ms'` on PostgreSQL
  and `innodb_lock_wait_timeout = 1` on MySQL against a held row lock).

### 3.13 V13-139: conflicts a client can tell apart (D-5)

- **Decision (recommended, D-5):** every classified driver-condition class carries a problem `type`
  through its hint (C-14), on the framework's committed base `https://setu-ts.dev/errors`
  (`exceptions` exports it as `ERROR_TYPE_BASE`; `validation-plugin` serves
  `https://setu-ts.dev/errors/validation`, and the exceptions README documents it). The types:
  `write-conflict`, `lock-timeout`, `version-conflict`, `duplicate-key` (409);
  `foreign-key-violation` (409); `not-null-violation`, `invalid-field-value` (400);
  `database-unavailable`, `database-pool-saturated` (503); `database-timeout`,
  `database-connection-lost` (504). Each title is the class's own ("Write Conflict", …). The base
  and the slug table live in one new `common` file, `packages/common/src/errors/problem-types.ts`
  (additive), because `DuplicateKeyError` and `InvalidFieldValueError` are `common` classes and
  `common` cannot import `exceptions` or this package; `exceptions`' `ERROR_TYPE_BASE` then
  re-exports the `common` constant rather than declaring its own. `docs/problem-types.md` documents
  each type: what it means, the client action (retry, reload, change the input) and the status. A
  type URI need not resolve (RFC 9457 §3.1.1); the page is the documentation.
- **The ROADMAP outcome.** M143h's outcome names a serialization conflict, an FK, NOT NULL or length
  violation, a lock wait timeout and a lost connection, each "with its own problem type"; the list
  above gives each one.
- **The `default` format** is unchanged (it ignores `problem`); the exceptions README says that
  distinguishing by type needs a Problem Details format, which every starter and template uses.
- **`common` edits** (`DuplicateKeyError`, `InvalidFieldValueError` and `ERROR_TYPE_BASE`'s source)
  ship in this pull request by D-1 (decided: same pull request, an approved departure from the lane
  rule).
- **Developer impact:** under `rfc9457` the body's `type` and `title` change from `about:blank` and
  `Conflict` to the class's own; `status` and `detail` are unchanged.
- **Test home:** `test/unit/error-status-hints.test.ts` (each class's hint, field by field, with the
  forbidden `message` absent); `packages/common/test/unit/problem-types.test.ts` (new: every slug is
  unique and under the base); `test/integration/problem-type-status.test.ts` (new, in
  `database-plugin`, beside `duplicate-key-status.test.ts`: a thrown `VersionConflictError` and
  `SerializationConflictError` through `errorHandler({ format: 'rfc9457' })` give different `type`s;
  `default` bodies are byte-identical to before).

### 3.14 V12-8: a run-budget recipe that works outside this repository

- **Decision:** the recipe in `docs/durable-runs.md` imports nothing from `apps/`. It builds the
  quota **once**, at composition, from the application's runtime:
  `const quota = memoryQuota(runtime)` (`docs/ai.md:375`) beside the plugin list, and the same
  `quota` is passed to the chat route's middleware for one budget. The definition's body:
  `model: (run) => wrapLanguageModel({ model, middleware: budgetMiddleware(run, quota, runtime, prices, (record) => writeUsage(db, outbox, record)) })`,
  where `budgetMiddleware` is the fence of `docs/ai.md` "Budget middleware" (`:498`, whose
  `BudgetScope` an `AgentRunContext` satisfies structurally), `writeUsage` the fence of "Usage
  delivery" (`:639`), the model built with the provider package `docs/ai.md`'s fences already use
  (`@ai-sdk/openai-compatible`), `db` and `outbox` read from `run.services` by their capability
  tokens, and `prices` a literal `BudgetPrices`. The prose names the two files the reader saved from
  `docs/ai.md` (`./chat.budget.ts` and `./usage.ts`) and the services the application registers
  (database and outbox), and keeps the sentence that a run started with `tenantId: ''` fails at its
  first model call (`budgetMiddleware` refuses a falsy tenant, `docs/ai.md:499-500`). The sentences
  about `budgetedModel` and about `chatQuota()` keeping separate budgets are removed.
- **Fence gate:** `test/guide-fence-compiler.test.ts` compiles the fence through
  `test/fixtures/snippets/fence-engine.ts`, which resolves a relative import only through files it
  writes beside the scratch directory (`writeProjectStubs`, `:894-…`). The two files are not
  hand-written: at test time the engine writes `chat.budget.ts` and `usage.ts` from the `docs/ai.md`
  fences themselves (its `extractFences`/`assembleSource`), so the durable-runs fence compiles
  against the real fence text and a change to `budgetMiddleware` or `writeUsage` that breaks the
  recipe fails the gate. The count table (`:242`) is updated. Both root test files join the Data
  lane for this change (C3).
- **Developer impact:** the recipe copies into a scaffolded project that has saved the two
  `docs/ai.md` fences.
- **Test home:** `test/guide-fence-compiler.test.ts` (the changed fence compiles against the
  generated files; a negative control renames `budgetMiddleware` in a copy of the `docs/ai.md` fence
  and the durable-runs fence then fails).

### 3.15 V12-15: a resolver array holds resolvers

- **Decision:** `buildResolverChain` refuses at `register()` an array with any element that is not
  an object with a `resolve` function, with a message naming the index and saying that names do not
  chain ("pass resolver instances, for example `new HeaderResolver()`"). An unknown name string is
  refused the same way (today it is refused only through the empty-chain check, with a message that
  does not name it), and a single object without a `resolve` function is refused too.
- **Why:** a configuration that boots and resolves no tenant fails silently, which the rules refuse.
- **Developer impact:** a JavaScript configuration with `['header', 'subdomain']` fails at startup
  with the way out in the message.
- **Test home:** `packages/multi-tenancy-plugin/test/unit/multi-tenancy-plugin.test.ts`.

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

- **Decision:** `BaseRepository` takes the adapter type as an optional second constructor argument;
  `DatabaseService` passes `_adapterType` to `InternalRepo` at both construction sites
  (`getRepository` and the unit of work's factory, `database-service.ts:333`), and
  `PrismaRepository`/`DrizzleRepository` pass theirs. `BaseRepository.updateWhere`/`deleteWhere`
  name it in `UnsupportedQueryFeatureError`, falling back to `'database-plugin'` for a directly
  constructed repository. A `'custom'` registration (D1 included) is named `'custom'`.
  `versioned-write.ts:15` keeps `'database-plugin'`: its refusal is reached only by a repository
  that is not a `BaseRepository`, which has no adapter type to name.
- **Developer impact:** the detail names the adapter that lacks the feature.
- **Test home:** `test/unit/base-repository-conditional.test.ts` (extended).

### 3.18 E-4: the agent-run replay stream's `cancel()` waits for its pump

- **Decision:** `respond.ts` keeps the pump's promise; `cancel()` aborts and then awaits it (the
  pump swallows its own abort), so `ctx.defer` cleanups run after the last store read. The wait is
  not bounded here: it settles when the store read in flight settles (`deps.store.chunks(...)` /
  `get(...)`, `respond.ts:126-140`). The inventory row becomes `kind: 'cancel-awaits-work'` with
  `cancelSettles: 'may-hang'`, new evidence, and a `handOver` as the test requires for a non-Core
  `may-hang` row (`test/response-stream-cancel-inventory.test.ts:429-446`, as the gRPC rows have):
  "Data lane: cancel() awaits a store read that has no bound of its own; bound the store (pg
  `query_timeout`), as the database README documents".
- **Test home:** `packages/agent-runs-plugin/test/unit/respond.test.ts` (extended: a store read held
  open — `cancel()` does not settle until it returns);
  `test/response-stream-cancel-inventory.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `IAuditLogger.log` gains an optional second parameter, which an
existing implementation still satisfies (ships in minor 0.14.0). `DriverErrorClass` and
`classifyDriverError` are internal and stay unexported.

| Exported symbol                                                                            | Kind        | Consumer / real code path that READS it                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AuditLogOptions` (`common`)                                                               | type        | `IAuditLogger.log`; `AuditService.log` reads `scope`                                                                                                   |
| `ERROR_TYPE_BASE`, `DATABASE_PROBLEM_TYPES` (`common`, new file `errors/problem-types.ts`) | const       | `DuplicateKeyError`, `InvalidFieldValueError` (`common`), this package's error classes, and `exceptions`, whose `ERROR_TYPE_BASE` export re-exports it |
| `AuditScopeUnsupportedError` (`audit-plugin`)                                              | class       | thrown by `AuditService.log` for a scope on memory/log/file; applications `instanceof` it                                                              |
| `ForeignKeyViolationError` (`database-plugin`)                                             | class       | built by `classifiedOrOriginal` for `'foreign-key'`; `errorHandler` serves its hint; `within`/`tool-runner` do not treat it as a conflict (D-8)        |
| `NotNullViolationError` (`database-plugin`)                                                | class       | built by `classifiedOrOriginal` for `'not-null'`                                                                                                       |
| `PrismaRepository`, `DrizzleRepository` (existing classes)                                 | constructor | a new optional adapter-type argument, passed by their adapters (§3.17); read by `BaseRepository`'s refusals                                            |
| `DatabaseAuditStorage.appendIn(scope, entry)` (`audit-plugin`)                             | method      | called by `AuditService.log` when a scope is given; a third-party `IAuditStorage` may implement it                                                     |
| `DatabaseUnavailableError.reason`                                                          | field       | read by its own constructor to pick detail and type; applications branch on it                                                                         |
| `SerializationConflictError.reason` (`'write-conflict' \| 'lock-timeout'`)                 | field       | the same                                                                                                                                               |
| `DatabaseTimeoutError.reason` (`'bound' \| 'connection-lost'`)                             | field       | the same; `classifiedOrOriginal` already picks the message by `isConnectionLostMidCall`                                                                |

### 4.1 Options — every option names its consumer

| Option                                              | Consumer                                                           | Behavior (per implementation)                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `AuditLogOptions.scope`                             | `AuditService.log` → `DatabaseAuditStorage.appendIn(scope, entry)` | database: writes through the scope; memory/log/file: rejects `AuditScopeUnsupportedError` |
| `AuditStorageOptions.table` (existing, new reading) | `DatabaseAuditStorage`                                             | names the table for the client and the entity for a scope                                 |
| `DrizzleAdapterOptions.poolStats` (existing)        | `DrizzleAdapter`                                                   | explicit wins; absent on a pg pool → the pool's counters                                  |

## 5. Implementation files

| File                                                                                                                                                              | Purpose                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/common/src/services/audit.ts`                                                                                                                           | `AuditLogOptions`; `log(entry, options?)` (routing per D-1)                                     |
| `packages/common/src/errors/problem-types.ts` (new), `duplicate-key.ts`, `invalid-field-value.ts`, `src/index.ts`                                                 | the base and slug table; the two `common` classes' types (routing per D-1)                      |
| `packages/exceptions/src/formatters/problem-details.ts`                                                                                                           | `ERROR_TYPE_BASE` re-exported from `common`                                                     |
| `packages/audit-plugin/src/services/audit-service.ts`, `storage/*.ts`, `src/errors.ts` (new), `src/index.ts`, `package.json`                                      | scoped append; refusal class; `@setu-ts/database-plugin` devDependency                          |
| `packages/database-plugin/src/errors/classify.ts`                                                                                                                 | new classes and signals (§3.0, 3.6–3.12), `isConnectionLostMidCall` rows                        |
| `packages/database-plugin/src/errors.ts`, `src/index.ts`                                                                                                          | two classes; `reason` on three; problem types                                                   |
| `packages/database-plugin/src/services/database-service.ts`                                                                                                       | transaction catch and commit (§3.7); class builders                                             |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                                                                                | default pool counters (§3.5)                                                                    |
| `packages/database-plugin/src/adapters/dynamo/dynamo-data-source.ts`                                                                                              | `ConsistentRead` (§3.16)                                                                        |
| `packages/database-plugin/src/adapters/dynamo/dynamo-adapter.ts`, `cosmos/cosmos-adapter.ts`                                                                      | none expected (their probe reads the classifier); listed because their behaviour changes (§3.8) |
| `packages/database-plugin/src/repositories/base-repository.ts`, `adapters/prisma/*-repository.ts`, `adapters/drizzle/drizzle-repository.ts`                       | adapter name (§3.17)                                                                            |
| `packages/idempotency-plugin/src/within/within.ts`                                                                                                                | `isConflict` narrowed (D-8)                                                                     |
| `packages/agent-runs-plugin/src/runtime/ai-runtime.ts`, `loop/step-loop.ts`, `log/respond.ts`                                                                     | §3.2, §3.18                                                                                     |
| `packages/vector-store-plugin/src/health/indicator.ts`, `plugin/vector-store-plugin.ts`, `adapters/pgvector/pgvector-sql.ts`, `pgvector-store.ts`                 | §3.3, §3.4                                                                                      |
| `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts`                                                                                                | §3.15                                                                                           |
| `test/fixtures/snippets/fence-engine.ts`, `test/guide-fence-compiler.test.ts`                                                                                     | two stubs and the count table (§3.14)                                                           |
| `docs/durable-runs.md`, `docs/problem-types.md` (new), `website/src/lib/docs-nav.ts`, READMEs, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, `ROADMAP.md` | docs (§13)                                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                                                                                                                                                                                                  | src covered                                                                                               | Key assertions                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `database-plugin/test/unit/classify-driver-error.test.ts` (extended)                                                                                                                                                                                                                                                                                                                       | `errors/classify.ts`                                                                                      | the signal table of §3.0 as data; every new row with a negative row beside it |
| `database-plugin/test/unit/errors.test.ts`, `error-status-hints.test.ts` (extended)                                                                                                                                                                                                                                                                                                        | `errors.ts`                                                                                               | each class's hint field by field; the three `reason`s                         |
| `database-plugin/test/unit/transaction-work-classification.test.ts` (new)                                                                                                                                                                                                                                                                                                                  | `services/database-service.ts`                                                                            | §3.7 table                                                                    |
| `database-plugin/test/unit/drizzle-default-pool-stats.test.ts` (new)                                                                                                                                                                                                                                                                                                                       | `adapters/drizzle/drizzle-adapter.ts`                                                                     | §3.5                                                                          |
| `database-plugin/test/unit/dynamo-data-source.test.ts` (extended)                                                                                                                                                                                                                                                                                                                          | `adapters/dynamo/dynamo-data-source.ts`                                                                   | §3.16                                                                         |
| `database-plugin/test/unit/nosql-readiness-probe.test.ts` (extended)                                                                                                                                                                                                                                                                                                                       | `adapters/dynamo/dynamo-adapter.ts`, `cosmos/cosmos-adapter.ts`                                           | §3.8 probe rows                                                               |
| `database-plugin/test/unit/base-repository-conditional.test.ts` (extended)                                                                                                                                                                                                                                                                                                                 | `repositories/base-repository.ts`, the two adapter repositories                                           | §3.17                                                                         |
| `database-plugin/test/integration/problem-type-status.test.ts` (new)                                                                                                                                                                                                                                                                                                                       | (consumer proof through `errorHandler`)                                                                   | §3.13                                                                         |
| `database-plugin/test/unit/barrel-exports.test.ts` (extended)                                                                                                                                                                                                                                                                                                                              | `src/index.ts`                                                                                            | the two new classes                                                           |
| guarded real cells (`real-drizzle-adapter`, `real-prisma-adapter`, `real-prisma-mysql`, `real-drizzle-mysql`, `real-mongo-adapter`, `real-dynamo-adapter`, `real-bigtable-adapter`, `real-cosmos-adapter`)                                                                                                                                                                                 | real drivers                                                                                              | the measured signal of every new row                                          |
| `audit-plugin/test/unit/audit-service.test.ts`, `database-audit.test.ts`, `barrel-exports.test.ts` (extended); `test/integration/audit-in-transaction.test.ts` (new)                                                                                                                                                                                                                       | `services/audit-service.ts`, `storage/*.ts`, `src/errors.ts`, `src/index.ts`                              | §3.1                                                                          |
| `idempotency-plugin/test/unit/within.test.ts` (extended)                                                                                                                                                                                                                                                                                                                                   | `within/within.ts`                                                                                        | D-8                                                                           |
| `agent-runs-plugin/test/unit/step-loop.test.ts`, `ai-runtime.test.ts`, `tool-runner.test.ts`, `respond.test.ts` (extended); `test/integration/real-ai.test.ts` (extended)                                                                                                                                                                                                                  | `runtime/ai-runtime.ts`, `loop/step-loop.ts`, `log/respond.ts` (tool-runner: unchanged, a regression row) | §3.2, D-8, §3.18                                                              |
| `vector-store-plugin/test/unit/health-indicator.test.ts`, `pgvector-store.test.ts`, `test/integration/vector-store-plugin.test.ts`, `conformance.test.ts` (`PGVECTOR_URL`) (extended)                                                                                                                                                                                                      | `health/indicator.ts`, `plugin/vector-store-plugin.ts`, `adapters/pgvector/*`                             | §3.3, §3.4                                                                    |
| `multi-tenancy-plugin/test/unit/multi-tenancy-plugin.test.ts` (extended)                                                                                                                                                                                                                                                                                                                   | `plugin/multi-tenancy-plugin.ts`                                                                          | §3.15                                                                         |
| `common/test/unit/problem-types.test.ts`, `duplicate-key.test.ts` (new); `barrel-exports.test.ts` (extended)                                                                                                                                                                                                                                                                               | `errors/problem-types.ts`, `duplicate-key.ts`, `invalid-field-value.ts`                                   | §3.13                                                                         |
| `exceptions` existing formatter tests                                                                                                                                                                                                                                                                                                                                                      | `formatters/problem-details.ts`                                                                           | `ERROR_TYPE_BASE` value unchanged                                             |
| `common/test/unit/invalid-field-value.test.ts` (extended)                                                                                                                                                                                                                                                                                                                                  | `errors/invalid-field-value.ts`                                                                           | its type and title                                                            |
| Existing assertions that change by design (edit them; never revert the behaviour): `database-plugin/test/integration/versioned-write-status.test.ts:75,124`, `duplicate-key-status.test.ts:107`, `real-drizzle-adapter.test.ts:1658`, `real-prisma-adapter.test.ts:758` (`about:blank` → the class's type); `classify-driver-error.test.ts:121` (`{ name: 'TimeoutError' }` → `'timeout'`) | —                                                                                                         | D-5, §3.8                                                                     |
| `test/response-stream-cancel-inventory.test.ts`, `test/guide-fence-compiler.test.ts`                                                                                                                                                                                                                                                                                                       | (inventory, fence gate)                                                                                   | §3.18, §3.14                                                                  |

## 7. Verification gates

```bash
git branch --show-current   # feat/m143h-database-errors-store-signals
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
/home/dkpaul91/.local/bin/setu-suite-queue pnpm test:coverage database-plugin idempotency-plugin audit-plugin agent-runs-plugin vector-store-plugin multi-tenancy-plugin exceptions common
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
- S-2: problem `type` URIs are constants (each class's JSDoc links `docs/problem-types.md`, since
  the URIs themselves resolve nowhere); nothing request- or driver-derived enters them.
- S-3: the transaction-work rule cannot turn an application's own 4xx/`HttpError` into a database
  error (negative control).
- S-4: the audit scope path writes the same redacted row as the client path (negative control: a
  secret in `before` is redacted on both).
- S-5: the agent-run log line carries class names and status only; the vector-store line carries
  `describeError`'s text (which includes the error message), as the service-discovery reporter's
  does, and nothing from the request.

## 11. Hand-overs

| To               | Row             | Sentence                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M143o (Workers)  | V13-218 D1 half | "Since M143h the classifier maps SQLite's `FOREIGN KEY constraint failed` and `NOT NULL constraint failed:` (with and without the `D1_ERROR: ` prefix) to `ForeignKeyViolationError` (409) and `NotNullViolationError` (400). A D1 registration is classified by `DatabaseService`, so no `d1-data-source.ts` change is needed; the half is a proof of both on `workerd`." |
| M143j (CLI)      | V13-40          | "No template half: since M143h a Drizzle-with-pg registration gets its pool counters by default, so `setu add database` need not mention `poolStats`."                                                                                                                                                                                                                     |
| CLI lane (`sdk`) | D-8             | "Since M143h a `409` may be a foreign-key violation (problem type `…/errors/foreign-key-violation`), which never succeeds on retry; the keyed-request retry at `retry-strategy.ts:163` can narrow to the idempotency conflict."                                                                                                                                            |
| M143n (Docs)     | V13-139         | "`docs/problem-types.md` exists since M143h; link it from the error-format pages you write."                                                                                                                                                                                                                                                                               |

## 12. Decisions for the maintainer (decided 2026-11-27)

**Decided 2026-11-27:** the maintainer took every recommendation ("Yes, all eight"), then changed
D-1 to its alternative ("Do D1 in the same PR"). §3 is written to match.

- D-1 (changed by the maintainer: "Do D1 in the same PR"): the `common` edits ship in M143h's own
  pull request, with no Core follow-up; a departure from the lane rule (C-31), recorded in the lanes
  table.
- D-2: a scope on the memory, log or file audit storage rejects with `AuditScopeUnsupportedError`.
- D-3: only the thrown driver error, its Prisma adapter cause, or drizzle's wrapper is classified in
  the transaction catch, from database-only signals; plus server verdicts at `commit()`.
- D-4: `DatabaseUnavailableError` with `reason: 'pool-saturated'`; the log level stays `error`.
- D-5: the eleven types on `https://setu-ts.dev/errors/<slug>`, the base moved into `common`,
  documented on `docs/problem-types.md`.
- D-6: `P1017`/`ConnectionClosed` answer 504, outcome unknown.
- D-7: `ForeignKeyViolationError` 409; `NotNullViolationError` 400.
- D-8: `within`'s `isConflict` narrows; `idempotency-plugin` joins the Data lane (ROADMAP lanes
  table); the SDK keyed retry is handed to the CLI lane (§11).
- D-9 (raised by the code review, decided 2026-11-27, "Count pool releases"): pg-pool `release`
  events count as query progress (§3.5).
- D-10 (raised by the code review, decided 2026-11-27, "Fix in M143h's PR"): the one-line
  expectation in `packages/cloudflare-plugin/test/unit/d1-database.test.ts:131-135` (the
  `InvalidFieldValueError` hint gains its problem type) is edited in this pull request, an approved
  out-of-lane edit recorded in the lanes table and the PR body.
- D-11 (raised by the security audit as F-2, decided 2026-11-28, "Narrow it"): at the
  transaction-work site, a thrown error with a numeric `statusCode` is left as the application's own
  error. Without it, `serviceUnavailable('NOT NULL constraint failed: x')` was served 400 and an
  `HttpError` carrying `code: 'P2003'` 409. The check is in `membersAtSite` (`errors/classify.ts`),
  which every transaction-work reader goes through. The maintainer asked that Cosmos SDK errors keep
  their classification, identified by something the SDK sets. Read from `@azure/cosmos` 4.10.2
  `request/RequestHandler.js:119-126`, a Cosmos `ErrorResponse` carries its status on `code`, with
  `headers`, `activityId` and `substatus`, and has no `statusCode`, so the `statusCode` check never
  matches one and no exemption is needed; adding one would be code no path reads. A framework
  `HttpError` always carries `statusCode` (`exceptions` `http-error.ts`), so it always matches. The
  tests pin both: a real `ErrorResponse` has no `statusCode`, stays itself from transaction work
  (numeric codes are not read there, D-3), and is still a write conflict from a unit-of-work
  repository call.

| #   | Section     | Question                                                                                                                                                                                           | Recommended                                                                                                                                                                                                                                                                                               | Alternative and its cost                                                                                                                                                                                                                  |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | §3.1, §3.13 | Where do the `common` edits ship? Existing contracts: `IAuditLogger.log` options, `DuplicateKeyError`'s and `InvalidFieldValueError`'s problem types. Additive: the new `errors/problem-types.ts`. | A small "M143 Core follow-up" pull request first, as #612/#613 did, then this letter on top of it (the lane rule, C-31).                                                                                                                                                                                  | In this letter, with the lanes table naming the files: one pull request fewer, against the written rule.                                                                                                                                  |
| D-2 | §3.1        | A scope given to the memory, log or file audit storage.                                                                                                                                            | Reject with `AuditScopeUnsupportedError`; nothing written.                                                                                                                                                                                                                                                | Write at once and warn once: keeps tests on memory storage working, and keeps an entry for a write that rolls back.                                                                                                                       |
| D-3 | §3.7        | Which errors the transaction's own work throws are classified.                                                                                                                                     | The thrown driver error, its Prisma adapter cause, or drizzle's wrapper around one; string-namespace codes, Prisma kinds, Mongo labels and pg/SQLite anchors only (no errno, no AWS timeout names, no numeric codes); plus server verdicts at `commit()`.                                                 | Classify the whole cause chain: also catches an app error wrapping a driver error, and replaces the app's error. Or document only (today), which leaves X38-1 open.                                                                       |
| D-4 | §3.6        | A pool acquire timeout.                                                                                                                                                                            | Same class, `reason: 'pool-saturated'`, its own detail and type; log level unchanged (`error` per served 5xx).                                                                                                                                                                                            | Also log it at `warn`: needs a log-level channel on the hint, a `common` change; HikariCP logs at DEBUG, EF Core at Error, Spring's health check at WARN (T-4).                                                                           |
| D-5 | §3.13       | Problem `type` URIs.                                                                                                                                                                               | The committed base `https://setu-ts.dev/errors/<slug>` (as `validation-plugin`'s `/errors/validation`), its source moved to `common`; one type per classified driver-condition class, as the ROADMAP outcome lists; `docs/problem-types.md` documents them.                                               | `tag:setu-ts.dev,2026:<slug>` (RFC 9457 allows non-resolving types), a second scheme beside the committed one; or only the three 409s the row names, short of the ROADMAP outcome.                                                        |
| D-6 | §3.9        | Prisma `P1017` / `ConnectionClosed`.                                                                                                                                                               | 504 (outcome unknown), the M128 rule.                                                                                                                                                                                                                                                                     | 503, as the bare `ECONNRESET` it maps from: consistent with a documented limitation, and says "not applied" for a write that may have run.                                                                                                |
| D-7 | §3.11       | Statuses for FK and NOT NULL.                                                                                                                                                                      | FK 409 `ForeignKeyViolationError`; NOT NULL 400 `NotNullViolationError`.                                                                                                                                                                                                                                  | Both 409 under one `ConstraintViolationError`, as Spring Data REST answers every integrity violation (T-2).                                                                                                                               |
| D-8 | §3.7, §3.11 | First-party code that treats any `409` as a conflict (`idempotency-plugin` `within`; `sdk` keyed retry).                                                                                           | Narrow `within`'s `isConflict` to `DuplicateKeyError` (`instanceof`) and the `write-conflict`/`lock-timeout` types, so an FK at a `within` commit fails the run as `store-failed`; `idempotency-plugin` joins the Data lane for it; the SDK keeps retrying a keyed 409 (bounded; handed to the CLI lane). | Give FK a status no consumer reads as a conflict (422): no consumer edits, unlike Spring Data REST's 409. Or leave `within`: an FK at its commit reads "another call holds this key; retry" and the tool is retried as a holder conflict. |

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

**T-8 AI SDK (§3.2).** `vercel/ai` (`ai@7.0.183` source; the installed `7.0.159` has the same
`onError` signature, C-22): `toUIMessageStream({ onError })` receives the raw error and returns the
text; `streamText({ onError })` receives `{ error }`; after retries the error is a `RetryError`
whose `lastError` is the `APICallError` (`statusCode`, `isRetryable`).

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
`packages/exceptions/README.md`, `packages/idempotency-plugin/README.md` (D-8),
`packages/common/README.md` (exports table), `docs/problem-types.md`, `docs/durable-runs.md`,
`PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, the ROADMAP M143h row list (E-1) and lanes
table (C3).
