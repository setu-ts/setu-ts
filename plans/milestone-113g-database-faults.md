# Milestone 113g — Database calls and errors under faults and edge inputs (`@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m113g-database-faults`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

Five rows from the `v0.9.0` smoke run (X70, X72, M104 security F9) where a database call answers
something the contract does not say: a primary-key change applied on one backend and silently
dropped on another, a query that hangs for a whole outage with no documented bound, a raw driver
error where a named refusal exists, one connect timeout answered 500 and the next 503, and a
malformed client cursor answered `501 … not supported by the 'drizzle' database adapter`. Each row
gets ONE portable rule, applied to every adapter that implements the surface, and a test that drives
every adapter through it.

- **In scope:**
  - **V9-25** — an `update` / `updateWhere` payload carrying a primary-key column whose value
    differs from the addressed key is refused, by one shared check, on all eight `IDataSource`
    implementations (Memory, Drizzle, Prisma, MongoDB, DynamoDB, Cosmos, Bigtable, and D1 in
    `cloudflare-plugin`), with one error class answered `400`.
  - **V9-26** — a Drizzle data source whose key columns are not columns of its table is refused when
    the repository is created (every method, not only `findById`), and a Drizzle `create` / `update`
    / `updateWhere` payload naming a field that is not a column of the table is refused by name
    instead of being dropped by Drizzle and surfacing as the driver's raw `Failed query`.
  - **V9-34** — pg-pool's second connect-timeout message,
    `Connection terminated due to connection timeout`, is classified `unavailable` (`503`) beside
    the existing `timeout exceeded when trying to connect`.
  - **V9-33** — node-postgres's client-side `query_timeout` is the documented call bound, and its
    `Query read timeout` rejection is classified as a new `timeout` kind answered `504` through a
    new `DatabaseTimeoutError` (the statement may have run, so it is NOT `DatabaseUnavailableError`,
    whose contract says the operation did not happen). A README section names the bound per adapter.
  - **V9-48** — a cursor the backend cannot use (malformed token, sort-fingerprint mismatch,
    key-shape mismatch) is refused with a new `InvalidCursorError` answered `400`, with a fixed
    detail that names no adapter, on all eight `findPage` implementations.
- **NOT this milestone:**
  - A framework-side call deadline (`withDeadline` around repository calls) — rejected in §3.4; not
    deferred to any milestone.
  - Unknown-payload-field refusal on D1, Prisma, MongoDB, DynamoDB, Cosmos, Bigtable and Memory — §9
    says why each is out.
  - Classifying MongoDB CSOT (`MongoOperationTimeoutError`) and the AWS/Cosmos/gRPC per-call
    timeouts onto `timeout` — §9; the README table marks each unverified.
  - Schema-aware readiness (V9-68) — M113o.

**Package list corrected from the ROADMAP's one (`database-plugin`) to three** (the
M70b/M70g/M70k/M90a precedent): `common` carries the two new error classes and the shared key check,
because `cloudflare-plugin`'s D1 data source raises both and AI_GUIDELINES §2.2 forbids it importing
`database-plugin` (the `DuplicateKeyError` precedent, `common/src/errors/duplicate-key.ts`);
`cloudflare-plugin` is the D1 adapter, which implements both surfaces the rows describe.

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory key refusal                  | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:246-257`                | `changesKey` compares `data[col] !== row[col]` against the STORED row; `immutableKeyError` is a plain `Error` (masked 500). Called at `:645` (transaction), `:724` (`update`), `:866` (`updateWhere`)                                                                                                                                                              |
| Bigtable key refusal                | `packages/database-plugin/src/adapters/bigtable/bigtable-data-source.ts:207-227`        | `assertKeyUnchanged` compares `String(supplied) === String(current)`; skips `undefined`; throws `UnsupportedQueryFeatureError('row-key', …)` (501) whose message ECHOES both key values. Called at `:326` and `:403`                                                                                                                                               |
| MongoDB update                      | `packages/database-plugin/src/adapters/mongo/mongo-data-source.ts:240-292`, `:301-330`  | `update` and `updateWhere` DELETE every `primaryKey` column and `_id` from the patch before `$set`, so a changed key returns the unchanged row as success (the V9-25 MongoDB half)                                                                                                                                                                                 |
| Cosmos update payload               | `packages/database-plugin/src/adapters/cosmos/cosmos-data-source.ts:343-372`            | `updatePayload` deletes `target.primaryKey` and `id` silently; a changed PARTITION key throws a plain `Error`                                                                                                                                                                                                                                                      |
| DynamoDB update                     | `packages/database-plugin/src/adapters/dynamo/dynamo-data-source.ts:234-245`            | filters out `target.keyColumns` silently; an all-key payload throws `UnsupportedQueryFeatureError('update', …)`                                                                                                                                                                                                                                                    |
| Drizzle update / create             | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:726-747`              | `create` passes `data` to `insert().values()` unchecked; `update` passes it to `.set()` unchecked, so a key column in the payload MOVES the row (the V9-25 Drizzle half)                                                                                                                                                                                           |
| Drizzle key columns                 | `drizzle-adapter.ts:676-686`, `:998-1005`, `:972-979`                                   | `keyColumns = resolveKeyColumns(primaryKeyOverride ?? 'id')`; `columnFor` throws `Drizzle table '<e>' has no '<f>' column required by the database repository.` LAZILY, inside `findById`/`update`/`delete`; `hasColumn` = own property, not `undefined`. The comment at `:352-356` claims refusal "at the moment a repository is asked for", which is false today |
| D1 data source                      | `packages/cloudflare-plugin/src/database/d1-data-source.ts:110-131`, `:233-264`         | malformed cursor and fingerprint mismatch throw `CloudflareUnsupportedError`; `update` / `updateWhere` build SQL that sets every payload column, key included                                                                                                                                                                                                      |
| `decodeCursor`                      | `packages/common/src/services/cursor.ts:121`                                            | returns `CursorPayload \| null`; `null` for any malformed token                                                                                                                                                                                                                                                                                                    |
| Cursor refusal sites                | `grep -rn "'cursor-pagination'" packages/database-plugin/src`                           | memory `:960`/`:974`, drizzle `:892`, prisma `:649`/`:663`, mongo (decode site), cosmos `:614`/`:626`, dynamo `:81`/`:443`/`:454`/`:501`, bigtable `:574`/`:581`/`:589`. Each must be classified in implementation as cursor-content (→ `InvalidCursorError`) or capability (→ stays `UnsupportedQueryFeatureError`)                                               |
| `QUERY_SHAPE_FEATURES`              | `packages/database-plugin/src/errors.ts:98-120`                                         | `'cursor-pagination'` and `'row-key'` are branded 501                                                                                                                                                                                                                                                                                                              |
| `DatabaseUnavailableError` contract | `packages/database-plugin/src/errors.ts:539-565`                                        | JSDoc: "The operation did **not** happen and **may be retried**"                                                                                                                                                                                                                                                                                                   |
| Classifier                          | `packages/database-plugin/src/errors/classify.ts:40`, `:101`, `:183-187`, `:295-318`    | `DriverErrorClass = 'conflict' \| 'unavailable' \| 'duplicate'`; pool anchor `timeout exceeded when trying to connect`; `isPoolExhaustion` matches only that anchor; fallback message arms run last                                                                                                                                                                |
| Classification sites                | `packages/database-plugin/src/services/database-service.ts:84-110`                      | `classifiedOrOriginal` maps a kind to an error and scrubs the cause (M113f)                                                                                                                                                                                                                                                                                        |
| Drizzle probe                       | `drizzle-adapter.ts:409-423`                                                            | rethrows when `isPoolExhaustion(error)` (→ indicator `undefined`, `degraded`), else answers `false` (`down`)                                                                                                                                                                                                                                                       |
| pg-pool messages (`pg-pool@3.14.0`) | `node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:224`, `:276` | `:224` `timeout exceeded when trying to connect` (waiting for a pooled client); `:276` `new Error('Connection terminated due to connection timeout', { cause: err })` (a NEW client's connect timed out). Both governed by `connectionTimeoutMillis`                                                                                                               |
| pg `query_timeout` (`pg@8.23.1`)    | `node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/client.js:702-730`                    | client-side timer; on fire rejects with `new Error('Query read timeout')`, removes the query from the queue if unsent, otherwise leaves it on the wire (non-pipeline). `pool.query` releases the client with the error (`pg-pool/index.js:460-481`), which removes it from the pool                                                                                |
| `withHttpStatusHint`                | `packages/common/src/errors/status-hint.ts:141`                                         | brands an error with `{ status, title, detail }`; the served `detail` is the hint's, never `message`                                                                                                                                                                                                                                                               |
| `checkWritePrecondition`            | `packages/common/src/services/write-precondition.ts:75-94`                              | validates `where` and `data`, returns private copies; knows no key columns                                                                                                                                                                                                                                                                                         |
| `DuplicateKeyError` precedent       | `packages/common/src/errors/duplicate-key.ts:49`                                        | an error raised by both `database-plugin` and `cloudflare-plugin` lives in `common`                                                                                                                                                                                                                                                                                |
| README guarantees table             | `packages/database-plugin/README.md:918-926`                                            | row "Changing a primary key by `update` — Memory **Refused**, Prisma / Drizzle `Refused (Mongo)`"                                                                                                                                                                                                                                                                  |
| README driver-condition table       | `packages/database-plugin/README.md:955-962`                                            | names "the pg pool timeout" (one of two) as `503`; no timeout row; no call bound named anywhere                                                                                                                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                        | Resolution (picked side)                                                               | Doc deliverable (same PR)                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| C1  | README guarantees table claims a key change is refused on Drizzle/Prisma/MongoDB; the code applies it (Drizzle, Prisma, D1) or drops it (Mongo, Cosmos, Dynamo) | The README's rule is the right one; the code changes (§3.1)                            | Guarantees row reads **Refused** in both columns, naming `PrimaryKeyChangeError` (`400`)               |
| C2  | README "What a driver condition returns" names one pg pool timeout; pg-pool has two                                                                             | Both are `unavailable` (§3.3)                                                          | Table names both messages; new `504` row for `DatabaseTimeoutError`                                    |
| C3  | `drizzle-adapter.ts:352-356` says a missing key column is refused when the repository is asked for; it is refused lazily inside three methods                   | The comment's behaviour (§3.2)                                                         | Comment stays true; README Drizzle section says the refusal happens at `getRepository`                 |
| C4  | `QUERY_SHAPE_FEATURES` JSDoc (`errors.ts:69-77`) lists "its cursor" as a `501` caller refusal                                                                   | A cursor the caller sent is a `400` (§3.5); `501` stays for a backend that cannot page | JSDoc and README "What a refused query returns" corrected                                              |
| C5  | ROADMAP M113g `Package(s)` names `database-plugin` only                                                                                                         | Three packages (§0)                                                                    | ROADMAP M113g section and letter-table row list `database-plugin`, `common`, `cloudflare-plugin`       |
| C6  | README names no call bound for any adapter (V9-33)                                                                                                              | The driver's bound is the mechanism (§3.4)                                             | New README section "Bounding a call" with a per-adapter table, each cell marked verified or unverified |

## 3. Design decisions

### 3.1 V9-25 — a primary-key change through `update` is refused everywhere

- **Decision:** `common` exports `assertPrimaryKeyUnchanged(entity, keyColumns, id, data): void`,
  which throws `PrimaryKeyChangeError` when `data` has an OWN property for a key column whose value
  is not `undefined` and does not equal the addressed key's value for that column. The addressed
  value is `id` for a single key column given a scalar, and `id[column]` for a composite record; any
  other id shape is skipped (each adapter already refuses it elsewhere). Equality, in order: both
  `Date` → equal `getTime()`; otherwise each side a `string`, `number` or `bigint`, or an object
  with a callable `toHexString` (a MongoDB `ObjectId`) → equal `String()`; otherwise `Object.is`.
  String comparison is deliberate: `repo.update(params.id, body)` passes a route-param string while
  a JSON body carries a number, and refusing that would refuse the commonest call shape. Every
  `update` and `updateWhere` (and the transaction-scoped variants) of all eight data sources calls
  it **before any I/O** and rejects (never throws synchronously from a `Promise`-typed method — the
  M52b class). After the check each adapter keeps its current payload handling — Mongo, Cosmos and
  DynamoDB still strip key columns; Drizzle, Prisma and D1 still send them (an equal value is a
  no-op `SET`); **Memory now strips key columns from the patch**, because its lookup is strict
  equality and writing `1` over a stored `'1'` would move the row. A literal `_id` in a MongoDB
  payload and a Cosmos document `id` that is not the mapped primary key keep their current silent
  strip (the M78 raw-document carry-over); only mapped primary-key columns are checked. Memory's
  `changesKey` / `immutableKeyError` and Bigtable's `assertKeyUnchanged` are deleted in favour of
  the shared check.
- **Error:** `PrimaryKeyChangeError` (common), hint
  `{ status: 400, title: 'Bad Request', detail: 'An update cannot change a row\'s primary key.' }`.
  The `message` names the entity and the column, **never a key value** (the Memory precedent at
  `memory-adapter.ts:259`; Bigtable's current message echoes both and stops doing so).
- **Why:** the README already states the rule, the memory adapter and Bigtable already enforce it,
  and every other behaviour (move, silent drop) differs between backends — the defect is the
  divergence. `400` because the payload the request carried asked for something the contract never
  allows; it is not a backend capability gap (`501`).
- **Breaking:** Drizzle, Prisma and D1 stop moving rows; Mongo, Cosmos and DynamoDB stop answering
  success for a changed key; Bigtable's refusal changes class (`UnsupportedQueryFeatureError` →
  `PrimaryKeyChangeError`) and status (`501` → `400`); Memory's changes from a masked `500`.
- **Test home:** `packages/database-plugin/test/unit/primary-key-change-conformance.test.ts`,
  `packages/common/test/unit/primary-key-change.test.ts`, D1 case in
  `packages/cloudflare-plugin/test/unit/d1-database.test.ts`, real PostgreSQL and real MongoDB cases
  in `real-drizzle-adapter.test.ts` / `real-mongo-adapter.test.ts`.

### 3.2 V9-26 — Drizzle refuses a missing key column and an unknown payload field by name

- **Decision:** `createDrizzleDataSourceInner` resolves every key column through `columnFor` once,
  when the data source is built (so `getRepository` and `uow`'s `createDataSource` refuse), with the
  existing message. `create`, `update` and `updateWhere` refuse, before any I/O, a payload own key
  whose value is not `undefined` and which is not a column of the table (`hasColumn`), with
  `UnsupportedQueryFeatureError('payload-field', 'drizzle', "Drizzle table '<e>' has no '<f>' column; the payload field would be dropped.")`.
  `'payload-field'` is NOT added to `QUERY_SHAPE_FEATURES`, so it stays a masked `500`: the field
  name is chosen by application code, not by a client, so it is a deployment/programming fault (the
  `'mapping'` reasoning at `errors.ts:78-85`) and its message names a column a client must not see.
- **Why:** today a misspelled or mis-mapped field is dropped by Drizzle and the row is written
  without it (or fails NOT NULL with the raw driver text); Prisma already refuses the same call. The
  tenant-column mis-mapping in V9-26 becomes the same named refusal on the first write.
- **Breaking:** a Drizzle caller passing extra non-column fields (a whole DTO) now fails.
- **Test home:** `drizzle-adapter-columns.test.ts` (eager key check; each write method's field
  refusal; `undefined` extra accepted), `real-drizzle-adapter.test.ts` (non-`id` key table:
  `getRepository` refuses by name, and a `primaryKey` override works end to end).

### 3.3 V9-34 — both pg connect timeouts are `unavailable`

- **Decision:** add
  `PG_NEW_CONNECTION_TIMEOUT_ANCHOR = 'Connection terminated due to connection timeout'` to the
  fallback message arm in `classifyDriverError`, classified `unavailable` (`503`). The query was
  never sent under both messages, so `DatabaseUnavailableError`'s "did not happen" holds.
  `isPoolExhaustion` is renamed `isUnansweredConnect` (internal; one caller) and matches BOTH
  anchors: a new connection that did not complete its handshake inside the bound is the database not
  answering, which the Drizzle probe reports as `undefined` (`degraded`) exactly as M101a decided
  for the pool-wait timeout; a refused connection still answers `false` (`down`).
- **Why:** the finding is one condition answered two ways; pg-pool raises the second message when
  the pool has room and opens a new client whose connect hangs — the common case during a pause.
- **Test home:** `classify-driver-error.test.ts` (both anchors; the new one inside a drizzle
  `Failed query` wrapper), `drizzle-adapter-probe-saturation.test.ts` (new anchor → probe rethrows),
  and the paused-PostgreSQL case in `outage-real.test.ts` (§3.4).

### 3.4 V9-33 — the call bound is the driver's; its timeout is a `504`

- **Decision:** the plugin adds **no** call deadline of its own. node-postgres's `query_timeout`
  (set by the application on the `Pool` it hands Drizzle) is the documented bound. A new
  `DriverErrorClass` member `'timeout'` is classified from the message anchor `Query read timeout`
  (fallback arm, after the structured arms), and `classifiedOrOriginal` maps it to a new exported
  `DatabaseTimeoutError` (database-plugin), hint
  `{ status: 504, title: 'Gateway Timeout', detail: 'The database did not answer in time.' }`, the
  scrubbed driver error as `cause`. Its JSDoc says the outcome of a write is **unknown** (the
  statement may have run) and that a retry must be idempotent. The probe treats it as unanswered
  (`isUnansweredConnect` matches it too, so the indicator reads `degraded`).
- **Why not a framework deadline:** a JavaScript deadline cannot cancel the statement — the
  connection stays occupied, so a deadline only moves the hang from the caller to pool exhaustion —
  and inside a transaction it rejects while the statement may still commit. `query_timeout` is
  enforced by the driver that owns the connection, and through `pool.query` the timed-out client is
  released with the error and removed from the pool (`pg-pool/index.js:460-481`). Not
  `DatabaseUnavailableError`: its committed contract says the operation did not happen.
- **Measured in implementation (stop condition):** against a **throwaway** PostgreSQL container
  (`docker run --rm -d --name m113g-pg -p 55432:5432 postgres:16`), never a long-lived local
  container, because the case pauses whatever container publishes the port, with `docker pause` for
  ≥ 5 s, a `Pool({ query_timeout: 1000, connectionTimeoutMillis: 1000 })`, warmed: (a) a repository
  read on the open connection rejects with `DatabaseTimeoutError` within ~1 s instead of waiting the
  pause; (b) a read needing a new connection rejects `DatabaseUnavailableError`; (c) the pool
  recovers after unpause with no restart; (d) inside `service.transaction(...)` record what the
  caller sees and how long it waits (the ROLLBACK queues behind the hung statement on the same
  client). If (a)–(c) do not hold as written, STOP and report — the decision rests on them. (d) is
  documented as measured, whatever it is.
- **README:** a "Bounding a call" section: Drizzle on node-postgres — `query_timeout` and
  `connectionTimeoutMillis`, verified (this milestone); and one row each for Prisma, MongoDB,
  DynamoDB, Cosmos, Bigtable and D1 naming the driver's own setting, marked **unverified**.
- **Test home:** `classify-driver-error.test.ts`, `database-service.test.ts` (kind → class → hint),
  `outage-real.test.ts` (guarded paused-PostgreSQL case), `refusal-status.test.ts` (served body).

### 3.5 V9-48 — a cursor the backend cannot use is a `400`

- **Decision:** `common` exports `InvalidCursorError`, hint
  `{ status: 400, title: 'Bad Request', detail: 'The pagination cursor is not valid for this query.' }`
  — a fixed sentence naming no adapter, entity or token. Every cursor-CONTENT refusal in the eight
  `findPage` implementations throws (rejects) it: `decodeCursor` returned `null`, a sort-fingerprint
  mismatch, and a decoded key-value list whose length or kinds do not fit the target (e.g.
  `bigtable-data-source.ts:589`). The `message` names the entity and which check failed, **never the
  token or its values**. Sites where the backend cannot page the query at all stay
  `UnsupportedQueryFeatureError` (`501`); the implementation lists each site of §1's "Cursor refusal
  sites" row with its classification in the PR description.
- **Why:** the token is client input (a `?cursor=` query parameter); a damaged or replayed one is
  the client's error, and `501 … not supported by the 'drizzle' database adapter` is both false and
  a disclosure (security F9).
- **Breaking:** `instanceof UnsupportedQueryFeatureError` no longer matches a malformed cursor.
- **Test home:** `packages/database-plugin/test/unit/invalid-cursor-conformance.test.ts` (every
  adapter: malformed, fingerprint-mismatch, and — where the adapter has one — key-shape tokens),
  `packages/common/test/unit/invalid-cursor-error.test.ts`, D1 case in `d1-database.test.ts`,
  `refusal-status.test.ts` (served body field by field).

### 3.6 Served bodies are asserted through a real application

- **Decision:** `refusal-status.test.ts` boots a kernel app with
  `errorHandler({ format: 'rfc9457' })` and the Memory adapter, and asserts field by field (present:
  `type`, `title`, `status`, `detail`; absent: `message`) for `PrimaryKeyChangeError` (400),
  `InvalidCursorError` (400) and `DatabaseTimeoutError` (504, thrown by a fake data source through
  `DatabaseService`'s interception), and that no body contains the adapter name, the entity, a key
  value or the cursor.
- **Test home:** as named.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** an out-of-repo `IDataSource` is not forced to change, but the
behaviour of every in-repo adapter changes (§3.1, §3.2, §3.5) — `ships in minor 0.10.0`.

| Exported symbol                          | Kind     | Consumer / real code path that READS it                                                                     |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `PrimaryKeyChangeError` (common)         | class    | thrown by `assertPrimaryKeyUnchanged`; `errorHandler` reads its hint; applications `instanceof` it          |
| `assertPrimaryKeyUnchanged` (common)     | function | every `update`/`updateWhere` in `database-plugin`'s seven adapters and `cloudflare-plugin`'s D1 data source |
| `InvalidCursorError` (common)            | class    | thrown by the eight `findPage` implementations; `errorHandler` reads its hint                               |
| `DatabaseTimeoutError` (database-plugin) | class    | built by `classifiedOrOriginal` for the `timeout` kind; `errorHandler` reads its hint                       |

`isUnansweredConnect` and the `timeout` kind stay internal (not barrel-exported).

### 4.1 Options — every option names its consumer

None (checked): no option is added. `query_timeout` and `connectionTimeoutMillis` are node-postgres
options on the application's own `Pool`, documented, not wrapped.

## 5. Implementation files

| File                                                                                           | Purpose                                                               |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/common/src/errors/primary-key-change.ts`                                             | `PrimaryKeyChangeError`, `assertPrimaryKeyUnchanged`                  |
| `packages/common/src/errors/invalid-cursor.ts`                                                 | `InvalidCursorError`                                                  |
| `packages/common/src/index.ts`                                                                 | barrel exports                                                        |
| `packages/database-plugin/src/errors.ts`                                                       | `DatabaseTimeoutError`; `QUERY_SHAPE_FEATURES` JSDoc (C4)             |
| `packages/database-plugin/src/errors/classify.ts`                                              | new-connection anchor, `timeout` kind, `isUnansweredConnect`          |
| `packages/database-plugin/src/services/database-service.ts`                                    | `timeout` → `DatabaseTimeoutError`                                    |
| `packages/database-plugin/src/index.ts`                                                        | export `DatabaseTimeoutError`                                         |
| `packages/database-plugin/src/adapters/{memory,drizzle,prisma,mongo,dynamo,cosmos,bigtable}/…` | key check; cursor errors; Drizzle eager key columns and field refusal |
| `packages/cloudflare-plugin/src/database/d1-data-source.ts`                                    | key check; cursor errors                                              |

Documentation deliverables (same PR): `packages/database-plugin/README.md` (C1, C2, C3, C4, C6, the
equality rule of §3.1, the Drizzle field refusal of §3.2), `packages/cloudflare-plugin/README.md`
(D1 key and cursor refusals), `PUBLIC_API.md` (the four exports, the two refusal statuses, the 504
row), `CHANGELOG.md` `Unreleased` (Added: the four exports; Changed, breaking: §3.1, §3.2, §3.5 and
the Bigtable refusal class), `docs/upgrading.md` `Unreleased` (catching the old refusal classes,
stripping extra Drizzle fields, setting `query_timeout`), ROADMAP M113g section and tracking row,
and the CLAUDE.md status entry.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                         | src covered                        | Key assertions                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/test/unit/primary-key-change.test.ts`                                     | `primary-key-change.ts`            | each equality arm (Date, string vs number, ObjectId-like, `Object.is`); `undefined` skipped; inherited property ignored; composite record; unknown id shape skipped; message carries no value; hint                                        |
| `common/test/unit/invalid-cursor-error.test.ts`                                   | `invalid-cursor.ts`                | name, hint, fixed detail                                                                                                                                                                                                                   |
| `common/test/unit/barrel-exports.test.ts` (extend)                                | `index.ts`                         | three new exports present                                                                                                                                                                                                                  |
| `database-plugin/test/unit/primary-key-change-conformance.test.ts`                | the seven adapters' update paths   | over `test/fixtures/conditional-sources.ts`: changed key refused (`update`, `updateWhere`, in a transaction where the adapter has one) with no write recorded; equal key (incl. `'5'` vs `5`) accepted; Memory keeps the stored key's type |
| `database-plugin/test/unit/invalid-cursor-conformance.test.ts`                    | the seven adapters' `findPage`     | malformed / fingerprint-mismatch / key-shape → `InvalidCursorError`, rejected not thrown, no backend call made                                                                                                                             |
| `database-plugin/test/unit/drizzle-adapter-columns.test.ts` (extend)              | `drizzle-adapter.ts`               | eager key-column refusal at data-source creation (repository and transaction); field refusal in `create`/`update`/`updateWhere`; `undefined` extra accepted                                                                                |
| `database-plugin/test/unit/classify-driver-error.test.ts` (extend)                | `classify.ts`                      | both pg connect anchors → `unavailable`; `Query read timeout` → `timeout`; wrapped in drizzle's `Failed query`; `isUnansweredConnect` true for all three, false for `ECONNREFUSED`                                                         |
| `database-plugin/test/unit/database-service.test.ts` (extend)                     | `database-service.ts`, `errors.ts` | `timeout` → `DatabaseTimeoutError` with scrubbed cause and 504 hint                                                                                                                                                                        |
| `database-plugin/test/unit/drizzle-adapter-probe-saturation.test.ts` (extend)     | `drizzle-adapter.ts` probe         | new-connection and read-timeout errors rethrown (indicator `undefined`)                                                                                                                                                                    |
| `database-plugin/test/integration/refusal-status.test.ts` (extend)                | served bodies                      | §3.6                                                                                                                                                                                                                                       |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts` (extend, guarded) | real PostgreSQL                    | key change refused, row unmoved in a fresh read; non-`id` table refused at `getRepository`; `primaryKey` override works                                                                                                                    |
| `database-plugin/test/integration/real-mongo-adapter.test.ts` (extend, guarded)   | real MongoDB                       | key change refused; stored document unchanged                                                                                                                                                                                              |
| `database-plugin/test/integration/outage-real.test.ts` (extend, guarded)          | real paused PostgreSQL             | §3.4 (a)–(c) asserted, (d) recorded                                                                                                                                                                                                        |
| `cloudflare-plugin/test/unit/d1-database.test.ts` (extend)                        | `d1-data-source.ts`                | key change refused (real `node:sqlite`, row unmoved); malformed and mismatched cursors → `InvalidCursorError`                                                                                                                              |

Every existing test asserting the old behaviour (Memory's `/cannot change the primary key/`,
Bigtable `'row-key'`, Mongo/Cosmos/Dynamo silent drop, cursor `UnsupportedQueryFeatureError`) is
updated to the new rule, never deleted. **Negative controls** (each observed failing, then
reverted): (1) remove the shared check from Drizzle's `update` → the conformance and real-PG cases
fail; (2) remove the new pg anchor → the classifier case fails; (3) map `timeout` to
`DatabaseUnavailableError` → the service and served-body cases fail; (4) restore one adapter's
`UnsupportedQueryFeatureError` for a malformed cursor → the cursor conformance case fails for that
adapter only.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113g-database-faults
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run test:deno-lane
pnpm run check:docs
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

Real-backend cases run with the local env block (PostgreSQL, MongoDB replica set); the guarded
suites' ignored count is reported.

## 8. Risks & mitigations

- **String-equality false acceptance** (`'05'` vs `5` on an integer key compares unequal; `'5'` vs
  `5` equal) → documented in the README rule; on SQL backends an equal-by-string value is coerced by
  the database to the same key.
- **A cursor site misclassified** (a capability refusal turned into `400`, or a content refusal left
  `501`) → the PR lists every site with its classification; the conformance test asserts content
  refusals per adapter.
- **Drizzle payload refusal breaks a working app passing extra fields** → CHANGELOG `Changed`
  (breaking) and `docs/upgrading.md` entry with the fix (pick the columns before `create`).
- **`query_timeout` inside a transaction may still wait for the hung statement** → measured (§3.4
  (d)) and stated in the README, not hidden.

## 9. Out of scope

- **Unknown payload fields on other adapters:** Prisma already refuses them; D1 builds SQL from the
  payload's keys, so an unknown column already fails in SQLite with a named column (not dropped);
  the document stores (MongoDB, DynamoDB, Cosmos, Bigtable) and Memory are schema-less, so an extra
  field is data, not a mistake.
- **Prisma on a non-`id` key with no override:** Prisma's own validation refuses, through the M105
  sanitized message. Not a row here.
- **Classifying other drivers' call timeouts onto `timeout`** (MongoDB CSOT, AWS SDK, Cosmos, gRPC
  deadlines): each needs its own measurement against a real backend; the README marks them
  unverified. Unowned.
- **A framework-side call deadline:** rejected (§3.4).
- **Schema-aware readiness (V9-68):** M113o.

## 10. Design security review

### 10.1 Trust boundaries and reviewed flows

| Flow | Path                                                                                                     | Boundary crossed                       |
| ---- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| F1   | client `?cursor=` → application → `repo.findPage` → adapter `decodeCursor` → refusal → `errorHandler`    | client input → backend query, response |
| F2   | client body → application → `repo.update(id, body)` → `assertPrimaryKeyUnchanged` → adapter write        | client input → stored row identity     |
| F3   | driver timeout → classifier → `DatabaseTimeoutError` / `DatabaseUnavailableError` → `errorHandler` → log | database state → client, operator log  |

### 10.2 Assets and attackers

**Assets.** (a) Row identity — a key change rewrites which record a later lookup addresses, and on a
tenant-scoped store can move a row under another key. (b) Backend topology — the adapter name,
entity and column names. (c) Values carried in a cursor token or a key. **Attacker A1:** a remote
client controlling the cursor parameter and any body field the application forwards to `update`.

### 10.3 Threats, mitigations and residuals

| Threat                                                         | Mitigation                                                                                        | Residual                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A1 sends a different `id` in an update body to move a row      | §3.1 refuses on every adapter before any I/O                                                      | none on the eight in-repo adapters                                 |
| A1 probes the backend through cursor error text (security F9)  | §3.5 fixed `detail` naming no adapter; `message` (log only) carries no token text                 | the `501` capability refusals still name the adapter (M89b design) |
| A1 forges log lines through a cursor or key value in a message | neither new message embeds a caller value; Bigtable's value-echoing message is removed            | none                                                               |
| A retry after a `504` repeats a write that did commit          | `DatabaseTimeoutError` JSDoc and README say the outcome is unknown and a retry must be idempotent | an application that retries blindly                                |

### 10.4 Obligations for the committed-tree audit

Confirm on the merge commit: no new message interpolates a key value, payload value or cursor token
(grep the three error constructors and every call site); every cursor-content site rejects with
`InvalidCursorError` and every capability site keeps `501`; the key check runs before any backend
call on all eight adapters (the conformance test's "no write recorded" assertion); the served bodies
of §3.6 carry none of the forbidden strings.
