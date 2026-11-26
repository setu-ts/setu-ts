# Milestone 143q — Databases off PostgreSQL (`@setu-ts/database-plugin`)

> **Status:** Approved by the maintainer on 2026-11-23 (decisions in §12); re-verified against
> `develop` at `712369753` (after #609, #610, #611, #613). Branch:
> `feat/m143q-databases-off-postgresql` (one branch and one pull request, D-1). `develop` and `main`
> are protected; all work, implementation and fixes, stays on this branch until it merges through
> one pull request into `develop`.

## 0. Objective & scope

The Data lane's first letter. Twelve rows from Part 26 (X119 on the Cosmos, DynamoDB and Bigtable
emulators, X120 on MySQL 8.4) where an adapter that works on PostgreSQL either tells a caller
something false or cannot run. When it ships: on Prisma with MySQL a conditional or versioned write
that lost its race reports the miss, so 100 concurrent writers give exactly one winner; Drizzle with
MySQL writes, filters and pages through the repository; a MySQL deadlock or duplicate key through
`query()` answers the same status as on PostgreSQL; a Bigtable project runs on a host with no Google
credentials and its reads stay flat as a row is updated; a call to Cosmos, DynamoDB or Bigtable ends
within a bound that applies by default, and `/ready` reports a stopped store; a unit of work on
those three stores can carry a conditional write; and the outbox, inbox, idempotency and agent-run
stores are proved on MySQL or refused there by name.

Every code change is inside `packages/database-plugin` (its `src/`, `test/`, `README.md`,
`AGENT_CARD.md`, `deno.json` imports, `package.json` devDependencies) plus the per-letter entries in
`PUBLIC_API.md`, `CHANGELOG.md` and `docs/upgrading.md`. Three repository files no lane lists are
also touched, and the lanes table is corrected first to name them under Data for this change (D-10):
`scripts/node-dependency-ranges.ts` (two range rows), `pnpm-lock.yaml`, and (D-10)
`.github/workflows/ci.yml`. No other lane package is edited. `packages/common` is not changed (§1
rows C-1, C-2 show the contracts this letter needs already exist).

- **In scope:** V13-230 (High), V13-231 (High), V13-236, V13-238, V13-239, V13-240, V13-241,
  V13-242, V13-243, V13-244, V13-249, V13-251; the `database-plugin` half of V13-142 (a README note,
  owned by M143b).
- **NOT this letter:**
  - M143h (Data lane, after this letter): V13-237 (`TimeoutError` name read as 503, Bigtable
    `DEADLINE_EXCEEDED` masked), V13-115 (errors through the typed Drizzle builder), V13-252 (value
    too long, lock wait timeout), V13-218 (foreign key, NOT NULL), V13-132 (`P1017`), V13-133,
    V13-139, V13-50, V13-40. This letter edits `src/errors/classify.ts` for three MySQL signals only
    (§3.5); M143h builds on that file afterwards, in lane order.
  - M143n (Docs lane): V13-250 (README "four adapters", no DynamoDB or MySQL section), V13-253 (the
    isolation advice on MySQL, Prisma `update()` returning the pre-image), V13-134 (the "Bounding a
    call" rows for mysql2 and the mariadb adapter). This letter rewrites only the README rows its
    own behaviour changes (§13); M143n owns the rest of those sections.
  - M143e (CLI lane): V13-254 (Prisma arm PostgreSQL only, refusal names Drizzle).
  - M143j (CLI lane): the template half of V13-231 (§11).
  - M143l (Web lane): the `auth-plugin` half of V13-240 (§11).
  - The `cloudflare-plugin` D1 transaction source keeps refusing a conditional write in a unit of
    work (§9).

### 0.1 Compared with

The comparison rule: every default, behaviour, option name, error class, status, timeout and retry
rule below was checked against this repository's sibling adapters (the "Sibling" column) and against
established tools (web documentation, cited). "not verified" means the cell could not be confirmed
from a primary source in this planning session.

| Question                                                    | Sibling adapters here                                                                                                                                                                                                                                                                                                                                            | EF Core                                                                                                                                                                                                     | Hibernate / JPA                                                                                                                                                                                                                                                                                                                                                   | Rails                                                                                                                                                                                                                                 | Django                                                                                                                                                                                                                                            | Prisma's own guidance                                                                                                                                                                                                                                                                                                                                                                      | TypeORM / Sequelize                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How a conditional write learns it lost                      | Drizzle on PostgreSQL: `UPDATE … RETURNING`, empty = miss (`drizzle-adapter.ts:840-845`); DynamoDB: `ConditionalCheckFailedException` (`dynamo-data-source.ts:366-369`); Bigtable: CheckAndMutateRow `matched` (`bigtable-data-source.ts:374-377`); Cosmos: `IfMatch` etag (`cosmos-data-source.ts:389-396`); Prisma: only `P2025` (`prisma-adapter.ts:917-918`) | rows affected by the UPDATE; zero throws `DbUpdateConcurrencyException`, on every provider ([learn.microsoft.com/ef/core/saving/concurrency](https://learn.microsoft.com/en-us/ef/core/saving/concurrency)) | one UPDATE with the version in WHERE; a zero count is the stale signal, surfaced as `StaleObjectStateException` / `OptimisticLockException` ([Red Hat Hibernate guide §11.4](https://docs.redhat.com/en/documentation/red_hat_jboss_web_server/3/html/hibernate_core_reference_guide/sect-optimistic_concurrency_control)); exact zero-count wording not verified | `StaleObjectError` on the later save ([api.rubyonrails.org Locking::Optimistic](https://api.rubyonrails.org/classes/ActiveRecord/Locking/Optimistic.html)); the page does not state the mechanism, so "rows affected" is not verified | no built-in token; `QuerySet.update()` returns rows matched, and the MySQL backend sets `CLIENT_FOUND_ROWS` for that ([Django ticket #10438](https://code.djangoproject.com/ticket/10438), [#17435](https://code.djangoproject.com/ticket/17435)) | `updateMany` with `id` and `version` in `where`, then `count === 0` means it lost ([prisma.io v6 transactions, optimistic concurrency control](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions)); Prisma issue #10207 records the MySQL failure of the read-then-write shape ([github.com/prisma/prisma/issues/10207](https://github.com/prisma/prisma/issues/10207)) | Sequelize raises `OptimisticLockError` "when a conflict is detected" ([sequelize.org optimistic locking](https://sequelize.org/docs/v6/other-topics/optimistic-locking/)), mechanism not verified; TypeORM `update()` reports no affected count, so it cannot enforce a version (issue thread, not primary docs: not verified) |
| MySQL affected rows: matched or changed                     | none drive MySQL writes today                                                                                                                                                                                                                                                                                                                                    | not verified                                                                                                                                                                                                | not verified                                                                                                                                                                                                                                                                                                                                                      | not verified                                                                                                                                                                                                                          | matched, by setting `CLIENT_FOUND_ROWS` (ticket #10438)                                                                                                                                                                                           | not documented                                                                                                                                                                                                                                                                                                                                                                             | not verified                                                                                                                                                                                                                                                                                                                   |
| A write rejected at commit in a buffered store              | DynamoDB buffered create: `TransactionCanceledException` with `ConditionalCheckFailed` on a Put becomes `DuplicateKeyError` (`dynamo-adapter.ts:433-444`)                                                                                                                                                                                                        | `DbUpdateConcurrencyException` from `SaveChanges`, the whole save rolled back (same page)                                                                                                                   | `OptimisticLockException` at flush or commit (same guide)                                                                                                                                                                                                                                                                                                         | not verified                                                                                                                                                                                                                          | not applicable                                                                                                                                                                                                                                    | not applicable                                                                                                                                                                                                                                                                                                                                                                             | not verified                                                                                                                                                                                                                                                                                                                   |
| Cosmos concurrency inside a batch                           | Cosmos non-transactional path writes `IfMatch` (`cosmos-data-source.ts:396`)                                                                                                                                                                                                                                                                                     | EF Core's Cosmos provider offers ETag concurrency (`UseETagConcurrency`, [learn.microsoft.com/ef/core/providers/cosmos/modeling](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/modeling))      | not applicable                                                                                                                                                                                                                                                                                                                                                    | not applicable                                                                                                                                                                                                                        | not applicable                                                                                                                                                                                                                                    | not applicable                                                                                                                                                                                                                                                                                                                                                                             | not applicable                                                                                                                                                                                                                                                                                                                 |
| A per-call bound on a NoSQL client the framework constructs | node-postgres `query_timeout` set by the app on its own `Pool` (README "Bounding a call"); every Redis-backed plugin here defaults `commandTimeoutMs` to 15 000 ms (`cache-plugin/src/stores/redis-store.ts:50`, `queue-plugin/src/adapters/redis-queue.ts:63`, `idempotency-plugin/src/constants.ts:45`)                                                        | not verified                                                                                                                                                                                                | not verified                                                                                                                                                                                                                                                                                                                                                      | not verified                                                                                                                                                                                                                          | not verified                                                                                                                                                                                                                                      | not applicable                                                                                                                                                                                                                                                                                                                                                                             | Spring Boot exposes driver timeouts as properties (`spring.elasticsearch.socket-timeout`) and a driver file for Cassandra ([docs.spring.io nosql](https://docs.spring.io/spring-boot/reference/data/nosql.html), cited by the X119 runner; not re-fetched)                                                                     |
| Health probe for a NoSQL store                              | MongoDB `ping` through an optional facade member (`mongo-adapter.ts:157`); Prisma and Drizzle `SELECT 1`                                                                                                                                                                                                                                                         | ASP.NET Core documents a database probe (cited by the X119 runner: [learn.microsoft.com health checks](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)); not re-fetched        | not applicable                                                                                                                                                                                                                                                                                                                                                    | not applicable                                                                                                                                                                                                                        | not applicable                                                                                                                                                                                                                                    | not applicable                                                                                                                                                                                                                                                                                                                                                                             | Spring Boot ships Cassandra, Couchbase and MongoDB health indicators (X119 runner, [docs.spring.io actuator endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)); not re-fetched                                                                                                                  |
| Passing driver options through                              | none: every lazy arm builds its client from two or three fields (`bigtable-client.ts:30-41`, `dynamo-client.ts:38-45`, `cosmos-client.ts:259`)                                                                                                                                                                                                                   | not applicable                                                                                                                                                                                              | not applicable                                                                                                                                                                                                                                                                                                                                                    | not applicable                                                                                                                                                                                                                        | `OPTIONS` dict passed to the driver (not re-fetched: not verified)                                                                                                                                                                                | not applicable                                                                                                                                                                                                                                                                                                                                                                             | TypeORM's `extra` option passes options to the driver (not re-fetched: not verified)                                                                                                                                                                                                                                           |

Where these camps split, the choice is under §12 "Open decisions for the maintainer", not made
silently.

### 0.2 Two ordered parts on one branch

The letter is large for one pull request: twelve rows across two unrelated families of code (the SQL
adapters on MySQL, and the three NoSQL adapters), a new guarded MySQL backend, and a new
frozen-relay test fixture. The two families share only `src/errors/classify.ts`, `README.md`, the
PUBLIC_API section and the CHANGELOG entry.

- **Part 1, MySQL** (first on the branch): V13-230, V13-242, V13-243, V13-244, V13-251, the MySQL
  conformance of the outbox, inbox, idempotency and agent-run stores (§3.7), and the guarded MySQL
  suites. Holds the first High row. Its first step is the two measurements of §3.1.3 (M-1 on MySQL,
  M-2 on PostgreSQL), before any Prisma design is written into `src/`; the rest of Part 1 (Drizzle,
  classifier) does not depend on them and may proceed in parallel.
- **Part 2, NoSQL** (after Part 1, same branch): V13-231, V13-236, V13-238, V13-239, V13-240,
  V13-241, V13-249, V13-142's README note. Holds the second High row.

Part 1 goes first because its `classify.ts` change is three additions that Part 2 does not touch,
and its guarded MySQL backend is new CI infrastructure that should be seen alone. D-1 decided one
branch and one pull request (2026-11-23): the two parts are an order of work on that branch, Part 1
first; each section still names its part.

## 1. Contracts verified from SOURCE (not names)

| Reference                                            | Source (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 `IDataSource.updateWhere?` / `deleteWhere?`      | `packages/common/src/services/database.ts:272`                                                                                                                                                                                                                                                                                                                                                                                                          | Optional members; a miss returns `null` / `false`. No change needed.                                                                                                                                                                                                                                                                                                                                                              |
| C-2 `IDatabaseAdapter.isHealthy?`                    | `packages/common/src/services/database.ts:424`                                                                                                                                                                                                                                                                                                                                                                                                          | Optional `isHealthy?(): Promise<boolean>`. The three NoSQL adapters declare none today (X119-2: 0 occurrences).                                                                                                                                                                                                                                                                                                                   |
| `DatabaseService.hasReachabilityProbe` / probe call  | `packages/database-plugin/src/services/database-service.ts:414-470`                                                                                                                                                                                                                                                                                                                                                                                     | Probe present iff `typeof adapter.isHealthy === 'function'`; a missing probe omits `reachable` and reports `up` (README:1561-1568).                                                                                                                                                                                                                                                                                               |
| Reachability bound                                   | `database-service.ts:53` (`REACHABILITY_TIMEOUT_MS = 2000`), `:446-470`                                                                                                                                                                                                                                                                                                                                                                                 | A probe not answered within 2 s is reported `undefined` (could not determine); the service does not cancel it.                                                                                                                                                                                                                                                                                                                    |
| Plugin options reaching an adapter                   | `src/plugin/database-plugin.ts:396-440` (`buildAdapterOptions`, an explicit `carry(...)` list); adapters built from that bag at `:366`, `:372`, `:383`                                                                                                                                                                                                                                                                                                  | A key not on the `carry` list is dropped silently (the file's T5 comment records the same defect for `entities`).                                                                                                                                                                                                                                                                                                                 |
| Refusal statuses                                     | `src/errors.ts:111-130` (`QUERY_SHAPE_FEATURES`)                                                                                                                                                                                                                                                                                                                                                                                                        | `UnsupportedQueryFeatureError` answers 501 only for the listed features; `'create'` and `'write'` are not listed, so such a refusal is a masked 500.                                                                                                                                                                                                                                                                              |
| mysql2 parameter binding through Drizzle             | `drizzle-orm/mysql2/session.js:53,79,92`                                                                                                                                                                                                                                                                                                                                                                                                                | Drizzle calls `client.query(sql, params)`; mysql2's `query()` interpolates `?` on the client, so a "bound" value is written into the SQL text with backslash escaping.                                                                                                                                                                                                                                                            |
| Drizzle MySQL `limit`                                | `drizzle-orm/mysql-core/dialect.js:190-191`                                                                                                                                                                                                                                                                                                                                                                                                             | `buildLimit` emits LIMIT only for an object (an `sql` chunk) or a non-negative number; a `bigint` is dropped. `18446744073709551615` as a JS number becomes `18446744073709552000`.                                                                                                                                                                                                                                               |
| Drizzle mysql-proxy transactions                     | `drizzle-orm/mysql-proxy/session.js:40-47`                                                                                                                                                                                                                                                                                                                                                                                                              | `transaction()` throws "Transactions are not supported by the MySql Proxy driver".                                                                                                                                                                                                                                                                                                                                                |
| Buffered commit failures today                       | `dynamo-adapter.ts:433-444` (`failedCreateGuard`: a Put index with `ConditionalCheckFailed` → `DuplicateKeyError`); `dynamo-data-source.ts:261` (a buffered plain `Update` carries `attribute_exists`; its failure is a raw `TransactionCanceledException`); `cosmos-data-source.ts:902-930` (`CosmosTransactionBatchError(failureCode, …)` from a 207 with a per-operation 412); `bigtable-transaction.ts:243-262` (`!matched` throws a plain `Error`) | No commit failure of a predicate maps to a named 409 today.                                                                                                                                                                                                                                                                                                                                                                       |
| Buffered same-row writes                             | `dynamo-transaction-buffer.ts:46-52` (a second write to one key refused); `cosmos-data-source.ts` (Patches compose); `bigtable-transaction.ts:225-262` (one CheckAndMutateRow per transaction, one row); `CosmosTransactionScopeError` / `BigtableTransactionScopeError` (`src/errors.ts:420`, `:481`)                                                                                                                                                  | Refusal-by-name precedents for a write a buffer cannot carry.                                                                                                                                                                                                                                                                                                                                                                     |
| Runtime environment                                  | `packages/common/src/runtime.ts:430` (`IRuntimeServices.env`)                                                                                                                                                                                                                                                                                                                                                                                           | The plugin reads environment variables through `ctx.runtime.env`, never `process.env`.                                                                                                                                                                                                                                                                                                                                            |
| Prisma conditional writes                            | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:901-943`                                                                                                                                                                                                                                                                                                                                                                                | `updateWhere` calls `delegate.update({ where: { ...key, AND: [where] }, data })`; `deleteWhere` calls `delegate.delete(...)`; only `P2025` is a miss.                                                                                                                                                                                                                                                                             |
| Prisma `ModelDelegate` facade                        | `prisma-adapter.ts:145-166`                                                                                                                                                                                                                                                                                                                                                                                                                             | Declares `findUnique`, `findMany`, `create`, `update`, `delete`, `count`. **No `updateMany`/`deleteMany`.**                                                                                                                                                                                                                                                                                                                       |
| Prisma client facade `$transaction`                  | `prisma-adapter.ts:124-136`                                                                                                                                                                                                                                                                                                                                                                                                                             | Interactive `$transaction(fn, { maxWait, timeout, isolationLevel })`.                                                                                                                                                                                                                                                                                                                                                             |
| Prisma data source factory                           | `prisma-adapter.ts:777-949`; called from `beginTransaction` at `:322` (with `tx`) and `createDataSource` at `:387` (with the root client)                                                                                                                                                                                                                                                                                                               | The factory cannot tell a root client from a transaction client today; there is no scope parameter.                                                                                                                                                                                                                                                                                                                               |
| Prisma connector resolution                          | `prisma-adapter.ts:458-469`, `PROVIDERS` at `:81-85`                                                                                                                                                                                                                                                                                                                                                                                                    | `options.provider` wins, else `_activeProvider`; `'mysql'` is a known connector.                                                                                                                                                                                                                                                                                                                                                  |
| Prisma on MySQL, statements sent by `update`         | runner general log `~/Projects/hono-enterprise-published-smoke/v0.13.0/part28/x120/out/x105/mechanism/prisma-mysql-k2.txt`                                                                                                                                                                                                                                                                                                                              | `BEGIN; SELECT id … WHERE id = ? AND version = 1; UPDATE … WHERE id IN (?) AND (id = ? AND version = 1); SELECT … WHERE id = ?; COMMIT`. Both callers pass the first SELECT; the loser's UPDATE matches zero rows; Prisma returns the read-back.                                                                                                                                                                                  |
| InnoDB snapshot semantics                            | [dev.mysql.com 8.4 innodb-consistent-read](https://dev.mysql.com/doc/refman/8.4/en/innodb-consistent-read.html)                                                                                                                                                                                                                                                                                                                                         | A SELECT in a REPEATABLE READ transaction reads the snapshot; UPDATE and DELETE act on current committed data; a query sees changes made by earlier statements of the same transaction.                                                                                                                                                                                                                                           |
| Prisma's documented optimistic-concurrency pattern   | [prisma.io v6 transactions](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions)                                                                                                                                                                                                                                                                                                                                                       | `updateMany({ where: { id, version } })`, then `count === 0` is the lost race.                                                                                                                                                                                                                                                                                                                                                    |
| `@prisma/adapter-mariadb` 7.10.1 affected rows       | `~/Projects/hono-enterprise-published-smoke/v0.11.0/part21/x94/x94-prisma-my/node_modules/@prisma/adapter-mariadb/dist/index.js:331`                                                                                                                                                                                                                                                                                                                    | `executeRaw` returns `affectedRows`. The adapter passes the config to `mariadb.createPool` unchanged (`:519-521`).                                                                                                                                                                                                                                                                                                                |
| mariadb 3.5.4 `foundRows` default                    | same tree, `mariadb/lib/config/connection-options.js:173`                                                                                                                                                                                                                                                                                                                                                                                               | `this.foundRows = opts.foundRows === undefined \|\| Boolean(opts.foundRows)`: **on by default**, so `affectedRows` counts matched rows.                                                                                                                                                                                                                                                                                           |
| mysql2 3.24.4 default flags                          | same tree, `mysql2/lib/connection_config.js:286-289`                                                                                                                                                                                                                                                                                                                                                                                                    | `FOUND_ROWS` is in `getDefaultFlags`, so `affectedRows` counts matched rows unless the application passes `flags: '-FOUND_ROWS'`; `changedRows` is parsed from the localizable `info` text (`mysql2/lib/packets/resultset_header.js:98-102`).                                                                                                                                                                                     |
| Prisma driver adapter error kinds                    | `node_modules/.pnpm/@prisma+driver-adapter-utils@7.10.1/.../dist/index.d.ts:151` (`UniqueConstraintViolation`), `:209` (`TransactionWriteConflict`), `:244` (`kind: 'mysql'`)                                                                                                                                                                                                                                                                           | A portable `kind` discriminant on `meta.driverAdapterError.cause`.                                                                                                                                                                                                                                                                                                                                                                |
| mariadb adapter's mapping of 1062 and 1213           | `adapter-mariadb/dist/index.js:180-188` (`originalCode: errno.toString()`), `:190-201` (1062 → `UniqueConstraintViolation`), `:284-287` (1213 → `TransactionWriteConflict`), `:294-300` (default → `kind: 'mysql'`)                                                                                                                                                                                                                                     | **1062 and 1213 are not `kind: 'mysql'`**, so `classify.ts:277` never sets the `mysql-adapter` namespace for them and `'1062'`/`'1213'` fall through: the measured `P2010` 500s (X120-5, X120-6).                                                                                                                                                                                                                                 |
| `@prisma/adapter-pg` mapping                         | `node_modules/.pnpm/@prisma+adapter-pg@7.10.1/.../dist/index.js:472-488`, `:539-542`                                                                                                                                                                                                                                                                                                                                                                    | `23505` → `UniqueConstraintViolation`; `40001`/`40P01` → `TransactionWriteConflict`: the same kinds, so one rule covers both adapters.                                                                                                                                                                                                                                                                                            |
| Classifier tables                                    | `packages/database-plugin/src/errors/classify.ts:87` (`DUPLICATE_KEY_CODES`), `:127-147`, `:258-282` (`prismaAdapterCause` reads `originalCode`, `kind`), `:539-553`                                                                                                                                                                                                                                                                                    | No `ER_LOCK_DEADLOCK`; no read of `kind` beyond `'mysql'`; no mysql2 closed-state anchor.                                                                                                                                                                                                                                                                                                                                         |
| mysql2 closed-connection error                       | `mysql2/lib/base/connection.js:250-256`                                                                                                                                                                                                                                                                                                                                                                                                                 | `new Error("Can't add new command when connection is in closed state")`, `fatal = true`, **no `code`**; raised before the command is sent.                                                                                                                                                                                                                                                                                        |
| Drizzle repository writes                            | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:776-868`, `returningRows` `:1372-1383`, `oneReturnedRow` `:1357-1370`                                                                                                                                                                                                                                                                                                                 | Every write calls `.returning()`; a builder without it throws a plain `Error` (masked 500).                                                                                                                                                                                                                                                                                                                                       |
| Drizzle `contains`                                   | `drizzle-adapter.ts:1158-1165`, `:1266-1267`                                                                                                                                                                                                                                                                                                                                                                                                            | Emits the SQL text `escape '\'`.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Drizzle offset                                       | `drizzle-adapter.ts:764-769`                                                                                                                                                                                                                                                                                                                                                                                                                            | `.offset()` without `.limit()` when `limit` is 0.                                                                                                                                                                                                                                                                                                                                                                                 |
| Drizzle MySQL builder                                | `node_modules/.pnpm/drizzle-orm@0.45.2*/node_modules/drizzle-orm/mysql-core/query-builders/insert.d.ts:111` (`$returningId()`); `mysql2/session.d.ts:13` (`MySqlRawQueryResult = [ResultSetHeader, FieldPacket[]]`); `mysql-core/dialect.js:298-299` (`offset` emitted after `limit` only when set)                                                                                                                                                     | A MySQL insert offers `$returningId()`; an update or delete resolves to `[ResultSetHeader, …]` carrying `affectedRows`.                                                                                                                                                                                                                                                                                                           |
| MySQL `OFFSET`                                       | [dev.mysql.com 8.4 SELECT](https://dev.mysql.com/doc/refman/8.4/en/select.html)                                                                                                                                                                                                                                                                                                                                                                         | `OFFSET` exists only inside `LIMIT`; to read to the end, use `LIMIT offset, 18446744073709551615`.                                                                                                                                                                                                                                                                                                                                |
| Drizzle dialect                                      | `packages/database-plugin/src/query/json-path.ts:79-85`; option JSDoc `src/interfaces/index.ts:760-772`                                                                                                                                                                                                                                                                                                                                                 | `MySql…` class names map to `'mysql'`; the `dialect` option is documented as "used only to translate a nested JSON filter path".                                                                                                                                                                                                                                                                                                  |
| Bigtable lazy client                                 | `src/adapters/bigtable/bigtable-client.ts:30-41` (`BigtableClientConfiguration`: `projectId`, `apiEndpoint`), `:129-147`, `:260-300` (`adaptBigtableSdkModule`: `getRows(adaptReadOptions(...))`, `row.filter(test, branches)`, no call options)                                                                                                                                                                                                        | Two fields reach the SDK; no SDK option, no per-call option.                                                                                                                                                                                                                                                                                                                                                                      |
| Bigtable adapter options                             | `src/adapters/bigtable/bigtable-adapter.ts:107-140`; `src/interfaces/index.ts:1265-1350`                                                                                                                                                                                                                                                                                                                                                                | `connect()` issues no RPC; options carry `instance`, `tables`, `maxPageFetches`, `projectId`, `apiEndpoint`, `client`.                                                                                                                                                                                                                                                                                                            |
| Bigtable SDK 6.5.1                                   | `node_modules/.pnpm/@google-cloud+bigtable@6.5.1*/.../build/src/index.d.ts:33-52`, `index.js:412-422` (insecure creds when an endpoint is set), `:467-469` (metrics handler unless `metricsEnabled === false`); `tabular-api-surface.d.ts` `GetRowsOptions.gaxOptions`; `row.d.ts:38-42` `FilterConfig.gaxOptions`; `filter.d.ts:29` `column.cellLimit`; `v2/bigtable_client.d.ts:235` `pingAndWarm`                                                    | `metricsEnabled` is the only switch; both data calls take `gaxOptions`; the per-column cell limit exists. Client-side metrics are on by default for Node ([cloud.google.com bigtable client-side metrics](https://docs.cloud.google.com/bigtable/docs/client-side-metrics)).                                                                                                                                                      |
| Bigtable facade filter union                         | `src/adapters/bigtable/bigtable-client-types.ts:132-146`                                                                                                                                                                                                                                                                                                                                                                                                | Has `{ row: { cellLimit } }`; **no `{ column: { cellLimit } }`**.                                                                                                                                                                                                                                                                                                                                                                 |
| Bigtable read decode                                 | `src/adapters/bigtable/bigtable-data-source.ts:85-100`, reads at `:239-246`, `:421`, `:469`                                                                                                                                                                                                                                                                                                                                                             | Keeps `versions[0]`; no read carries a latest-cell filter.                                                                                                                                                                                                                                                                                                                                                                        |
| Buffered transaction sources omit conditional writes | `dynamo-data-source.ts:318-406`, `cosmos-data-source.ts:567-597`, `bigtable-data-source.ts:355-396`                                                                                                                                                                                                                                                                                                                                                     | `updateWhere`/`deleteWhere` are spread in only when there is no transaction buffer; `BaseRepository` then throws `UnsupportedQueryFeatureError('conditional-write', 'database-plugin', …)` (`base-repository.ts:132-137`).                                                                                                                                                                                                        |
| Bigtable transaction commit                          | `src/adapters/bigtable/bigtable-transaction.ts:103`, commit at `:235-262`                                                                                                                                                                                                                                                                                                                                                                               | One CheckAndMutateRow per transaction; the test is `[{ all: true }]` with `onMatch`/`onNoMatch` chosen by `RowPrecondition`.                                                                                                                                                                                                                                                                                                      |
| DynamoDB transaction cancel reading                  | `src/adapters/dynamo/dynamo-adapter.ts:433-444`                                                                                                                                                                                                                                                                                                                                                                                                         | Reads `CancellationReasons[i].Code === 'ConditionalCheckFailed'` and the write at that index.                                                                                                                                                                                                                                                                                                                                     |
| Cosmos batch `ifMatch`                               | `node_modules/.pnpm/@azure+cosmos@4.10.2/.../dist/esm/utils/batch.d.ts:73,80,97,105` (Create, Upsert, Replace, Patch); `client/Item/Items.js:653-693`                                                                                                                                                                                                                                                                                                   | Create, Upsert, Replace and Patch declare `ifMatch`; **`DeleteOperationInput` declares only `partitionKey`, `operationType`, `id`**. `Items.batch` sends the operation objects unchanged, so an undeclared `ifMatch` on a Delete is probably sent, but whether the service and the emulator honour it is unmeasured (§3.10, M-4). The facade type (`cosmos-client-types.ts:148-212`) declares none.                               |
| Cosmos lazy client and probe                         | `src/adapters/cosmos/cosmos-client.ts:244-261` (`new CosmosClient({ endpoint, key })`); `cosmos-adapter.ts:171-184` (`database.read()` at connect)                                                                                                                                                                                                                                                                                                      | The database read is already a connect requirement, so its permission is proven.                                                                                                                                                                                                                                                                                                                                                  |
| Cosmos per-call abort                                | `@azure/cosmos` `request/SharedOptions.d.ts:31` (`abortSignal`); `documents/ConnectionPolicy.d.ts:10` (`requestTimeout`)                                                                                                                                                                                                                                                                                                                                | Every request and feed option takes an `AbortSignal`.                                                                                                                                                                                                                                                                                                                                                                             |
| DynamoDB lazy client                                 | `src/adapters/dynamo/dynamo-client.ts:38-45`, `:191-243` (`new module.DynamoDBClient(configuration)`, `client.send(new XCommand(input))`)                                                                                                                                                                                                                                                                                                               | `send` is called with one argument. `@smithy/types@4.20.0` `http.d.ts:104` declares `abortSignal` on the handler options `send` takes.                                                                                                                                                                                                                                                                                            |
| Agent-run store verify                               | `src/agent-runs/database-agent-run-store.ts:113-152`                                                                                                                                                                                                                                                                                                                                                                                                    | A sweep-query refusal becomes `AgentRunStoreUnavailableError('query-unsupported', { cause })`.                                                                                                                                                                                                                                                                                                                                    |
| `AgentRunStoreUnavailableError`                      | `packages/common/src/errors/agent-runs.ts:56-70`                                                                                                                                                                                                                                                                                                                                                                                                        | Fixed message `'Agent run store unavailable.'`; `reason` field. A message change is a `common` contract change (Core lane).                                                                                                                                                                                                                                                                                                       |
| Outbox refusal precedent                             | `src/outbox/errors.ts:6-15`, `database-outbox-store.ts:199-215`                                                                                                                                                                                                                                                                                                                                                                                         | A reason vocabulary and a sentence per reason, read off the cause chain.                                                                                                                                                                                                                                                                                                                                                          |
| Versioned writes                                     | `src/repositories/versioned-write.ts:88-110`, `:134-150`, `:179-197`                                                                                                                                                                                                                                                                                                                                                                                    | Built on `updateWhere`/`deleteWhere`, then one `findById` to tell 404 from 409.                                                                                                                                                                                                                                                                                                                                                   |
| Capability tokens                                    | `packages/common/src/tokens.ts:438`                                                                                                                                                                                                                                                                                                                                                                                                                     | No new token is introduced by this letter.                                                                                                                                                                                                                                                                                                                                                                                        |
| Existing guarded backends                            | `.github/workflows/ci.yml:95-152` (env and `services`); `test/integration/real-cosmos-adapter.test.ts:38-43`                                                                                                                                                                                                                                                                                                                                            | CI carries PostgreSQL (5433), MongoDB, DynamoDB Local (8000) and the Bigtable emulator (8086). **Cosmos is not in CI** (its suite guards on `COSMOS_ENDPOINT` and runs only locally). **There is no MySQL anywhere.** The `test.permissions` block of `packages/database-plugin/deno.json` is not read by the Node/Vitest runner and the package has no Deno-lane test (`scripts/test-lanes.ts`), so no net grant is added there. |
| Guard style for real-backend suites                  | `test/integration/real-prisma-adapter.test.ts:118-121`                                                                                                                                                                                                                                                                                                                                                                                                  | Vitest `it(name, { skip: skipReal }, fn)` with `skipReal` computed from the environment variable; a skipped case is reported as skipped, never as a pass.                                                                                                                                                                                                                                                                         |
| Range table for new devDependencies                  | `scripts/node-dependency-ranges.ts:26` (`EXTERNAL_RANGES`), read by `scripts/node-manifests.ts:191-193`                                                                                                                                                                                                                                                                                                                                                 | An external not in the table is refused by the manifest generator, so `mysql2` and `@prisma/adapter-mariadb` need a row there (root tooling, one line each).                                                                                                                                                                                                                                                                      |
| M143b hand-over for V13-142                          | `plans/archive/milestone-143b-first-command-fails.md:152-156` (merged in #610)                                                                                                                                                                                                                                                                                                                                                                          | No code or range change; a README note in the Bigtable section.                                                                                                                                                                                                                                                                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                            | Doc deliverable (same PR)                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| C1  | README "Optimistic locking" says a versioned write applies inside a transaction on Prisma, and PUBLIC_API "Conditional writes" says a predicate miss writes nothing and returns `null`/`false`; on Prisma with MySQL the code returns a row (X120-1). | The documents are right; the code is fixed (§3.1).                                                                                                                                                  | README "Optimistic locking": add MySQL to the measured cells; CHANGELOG `Fixed`.                            |
| C2  | README says Drizzle writes require `RETURNING` and the CLI refuses `--dialect mysql`; ROADMAP M143q's Outcome says Drizzle with MySQL writes through the repository.                                                                                  | ROADMAP wins: Drizzle with MySQL writes (§3.2). The CLI refusal text is M143e's (V13-254 hand-over, §11).                                                                                           | README Drizzle section: remove the `RETURNING` requirement, add "Drizzle on MySQL".                         |
| C3  | README "Filtering": Drizzle `LIKE … ESCAPE '\'` "honours it unconditionally", while the clause does not parse on MySQL's default `sql_mode` (X120-2).                                                                                                 | Code fixed for MySQL (§3.3); the README sentence is corrected.                                                                                                                                      | README "Filtering and single-row lookup".                                                                   |
| C4  | README "What a driver condition returns" says MySQL `ER_DUP_ENTRY` answers 409 with no driver limit, and that errors through `query()` are classified; Prisma on MySQL answers 500 (X120-5, X120-6).                                                  | Code fixed (§3.5).                                                                                                                                                                                  | README table rows for mysql2 and the mariadb adapter.                                                       |
| C5  | README "Health reporting" (1561-1569) says Cosmos, Bigtable and DynamoDB "omit the probe until each gains one optional member on its own client facade"; ROADMAP M143q says `/ready` reports a stopped store.                                         | ROADMAP wins; the prior decision is argued against by X119-2 and replaced (§3.9).                                                                                                                   | README "Health reporting", PUBLIC_API database-plugin section.                                              |
| C6  | README "Bounding a call" (1494) says the plugin adds no deadline of its own; ROADMAP M143q says a NoSQL call ends within a bound.                                                                                                                     | Both hold: the plugin sets the driver's own cancelling deadline on clients it constructs and passes the signal to injected facades (§3.8). A JavaScript race that cannot cancel is still not added. | README "Bounding a call": rewrite the DynamoDB, Cosmos and Bigtable rows to "measured" with the new option. |
| C7  | README "Optimistic locking" (281-283): the buffered sources answer 501 for a conditional write in a transaction.                                                                                                                                      | Replaced for DynamoDB, Cosmos and Bigtable (§3.10); memory and D1 keep the refusal.                                                                                                                 | README "Optimistic locking".                                                                                |
| C8  | `src/interfaces/index.ts:760-772`: the Drizzle `dialect` option is "used only to translate a nested JSON filter path".                                                                                                                                | Widened: it also selects the MySQL `LIKE` escape and the offset-only limit (§3.3).                                                                                                                  | JSDoc and PUBLIC_API line.                                                                                  |

## 3. Design decisions

### 3.1 V13-230 (High, Part 1): Prisma conditional writes act on the affected-row count

**Reproduction read.** `updateWhere` (`prisma-adapter.ts:910-916`) asks Prisma for `update` with the
key and the predicate. On PostgreSQL Prisma sends one `UPDATE … RETURNING`, and a lost race returns
no row, which Prisma raises as `P2025`. On MySQL there is no `RETURNING`, so Prisma 7.10 sends a
SELECT of the id under the predicate, the UPDATE with the predicate re-applied, and a SELECT of the
row (general log, §1). The SELECT reads InnoDB's REPEATABLE READ snapshot, so two callers both see
version 1. The UPDATE reads current committed data, so the second caller's UPDATE waits for the
first, finds version 2, and changes nothing. Prisma's plan for `update` does not check the UPDATE's
affected count (it already proved existence with the first SELECT), and the final SELECT reads the
snapshot again, because the transaction changed nothing it could see: the loser gets
`{ version: 1, balance: 100 }`, never `P2025`. `deleteWhere` has the same shape (the delete answered
204 while the row existed). The exact difference from the correct cells: PostgreSQL decides the
outcome from the rows the UPDATE returned; Drizzle on MySQL through the typed builder decides it
from `affectedRows`; Prisma on MySQL decides it from a snapshot read taken before the UPDATE ran.

#### 3.1.0 DECIDED by the maintainer (D-2, 2026-11-22): which connectors take the count path

The count path (§3.1.1) goes on **every** Prisma connector only if measurement M-2 (§3.1.3) shows
its cost on PostgreSQL is small. Otherwise it applies only to connectors without `RETURNING`, chosen
by connector (§3.1.4), and PostgreSQL keeps its single statement. Both branches are specified in
full below, with their files and tests. Neither is written into `src/` until both measurements of
§3.1.3 are in. **The branch that is built is recorded in this section (by editing the line below in
the plan, in the same PR) and in the PR description, with the M-2 result table and raw log path.**

- **Branch built:** "selected by connector" (§3.1.4, Branch B). M-2 (2026-11-24, tarballs of
  `b5c2551a9`, 15 paired passes, `WARMUP=15s`, `DURATION=20s`, bombardier `-c 64 -m POST`, servers
  on cores 8-15, load on 16-23, PostgreSQL 16 on 24-31; raw log
  `~/setu-benchmarks/2026-11-24-db-m143q/results/m2.log`, report `results/REPORT-m2.md`):

  | Route                     | count / single median throughput | passes won by count | median p99 ratio | spread (single / count) |
  | ------------------------- | -------------------------------- | ------------------- | ---------------- | ----------------------- |
  | `POST /items/:id/touch`   | 33.3% (30.6-34.0%)               | 0 / 15              | 272.3%           | 4.9% / 12.2%            |
  | `POST /items/:id/version` | 48.6% (46.5-50.9%)               | 0 / 15              | 196.8%           | 8.3% / 7.5%             |

  Both runs are unimodal and under the harness's 15% spread bar, so quotable; the 95% / 110% bar
  fails on both routes by a wide margin. Cross-check with durable commits (a 3-second smoke, one
  pass): touch 63.4% of single. **Deviation (maintainer-approved, 2026-11-24):** both servers set
  `synchronous_commit=off` per session. Commit fsync on the throwaway container's storage (overlayfs
  on btrfs) stalled at about 7.5 ms per flush after about 10 s of sustained writes, which capped
  every route, raw `pg` included, near 660 rps and hid the path difference. Off, the ratio omits the
  per-write fsync both paths pay, so it overstates the gap relative to a durable server; the durable
  smoke above shows the same direction.

#### 3.1.1 The count path (shared by both branches)

- **Mechanism.** `updateWhere` and `deleteWhere` call `updateMany` / `deleteMany` with the key and
  the predicate conjoined, and act on the returned `count`, which on MySQL is the UPDATE's
  `affectedRows` (matched rows: the mariadb driver's `foundRows` defaults to on, §1), subject to
  measurement M-1. `count === 0` is the miss (`null` / `false`). For `updateWhere`, a `count` of 1
  is followed by `findUnique` on the key **on the same transaction client**, so the read sees this
  write (the "earlier statements in the same transaction" rule, §1) while the row lock the UPDATE
  took is still held. On the root client the two calls run inside
  `client.$transaction(async (tx) => …)`; on a transaction client (a unit of work) they run directly
  on that client. `deleteWhere` needs no read-back, but it runs inside the same wrapping transaction
  on the root client so a `count > 1` refusal thrown inside it rolls the delete back; on a
  transaction client the throw propagates and the unit of work rolls back, as for any failed member
  call. The read-back uses the transaction client's own delegate (`tx[delegateKey]`), never the
  outer `delegate`.
- **Transaction options.** The root `$transaction` passes exactly what the adapter's own unit of
  work passes (`prisma-adapter.ts:296-298`): `{ maxWait: 2000, timeout: transactionTimeout }`
  (default 30 000). `maxWait` bounds only acquiring a connection and starting the transaction; a
  row-lock wait happens inside the transaction and is bounded by `timeout` and the server's
  `innodb_lock_wait_timeout`. So a conditional write behaves like a one-statement unit of work under
  load, and pool exhaustion answers `P2028` (503, not applied) as a unit of work already does. The
  race test sizes the pool to its concurrency so it measures the lost race, not the pool.
- **Scope parameter.** The data-source factory gains an internal `scope: 'root' | 'transaction'`
  parameter: `createDataSource` passes `'root'` (`:387`), `beginTransaction`'s `createDataSource`
  passes `'transaction'` (`:322`). It is not exported; `createPrismaDataSource` (public, `:750`)
  passes `'root'`.
- **Composite keys.** `updateMany` takes a `WhereInput`, not a `WhereUniqueInput`, so the compound
  key field (`{ tenantId_id: { … } }`) is not accepted. The key `where` of `updateMany` and
  `deleteMany` is built from the resolved `keyColumns` as plain equalities (`buildKeyColumnsWhere`,
  internal). The `findUnique` read-back keeps today's unique `where` (`buildKeyWhere`, with
  `compoundKeyField`), because `findUnique` takes a `WhereUniqueInput`. The composite-key
  conformance case covers both.
- **A count above 1.** The key addresses at most one row, so `count > 1` means the configured
  `keyColumns` are not a key of the table. It throws a named `Error`
  (`Prisma updateWhere on '<entity>' matched <n> rows for one key; keyColumns do not name the table's key`)
  rather than reporting success.

#### 3.1.2 Branch A: one implementation on every connector

- **Decision (if M-2 passes).** `updateWhere` and `deleteWhere` take the count path of §3.1.1 on
  every connector, PostgreSQL included. Today's `delegate.update` / `delegate.delete` with
  `AND: [where]` and the `P2025` catch are deleted from both members.
- **Files.** `src/adapters/prisma/prisma-adapter.ts` only (the two members, `ModelDelegate`,
  `buildKeyColumnsWhere`, the `scope` parameter).
- **Tests.** `test/unit/prisma-conditional-write.test.ts` (the §3.1.1 rules, on a fake client in
  PostgreSQL mode and in MySQL mode); the conformance table of §3.7 with `prisma` arms for both
  dialects; the guarded `real-prisma-adapter.test.ts` (PostgreSQL, existing, now on the count path)
  and `mysql-conditional-race.test.ts`.
- **"One capability, one implementation."** Met directly: one code path.

#### 3.1.3 The two measurements that come first (Part 1, step 1)

Nothing in §3.1.2 or §3.1.4 is written into `src/` before both are recorded in the PR description.

- **M-1, MySQL correctness of `count`.** On a dedicated MySQL 8.4 (not a shared container), with the
  general log on, drive two concurrent
  `updateMany({ where: { id, version: 1 }, data: { version: 2 } })` and two concurrent `deleteMany`
  of the same shape through Prisma 7.10.1 with `@prisma/adapter-mariadb`, 100 trials each. Pass: in
  every trial exactly one call returns `count: 1` and the other `count: 0`, and the general log
  shows the UPDATE / DELETE carrying the predicate whose affected rows Prisma reported (not a count
  of the ids its pre-SELECT found). Record the statements of one trial in the PR. A guarded test
  keeps it afterwards (`mysql-conditional-race.test.ts`).
- **M-2, PostgreSQL cost.** On the repository's database benchmark harness: the paired runner
  `~/setu-benchmarks/2026-11-02-db-m128/db-bench.ts` (copied to a new dated run directory, as
  `setup.sh` / the M128 run did), which alternates two servers within every pass behind an
  equivalence gate and refuses to report any non-2xx. Two Setu-on-Prisma-on-PostgreSQL servers built
  from packed tarballs of this branch, differing only in the path (`single` = today's
  `delegate.update` path, `count` = §3.1.1; selected by a build of each tree, not a runtime switch
  in `src/`). Routes, each over 10,000 seeded rows with the row chosen at random server-side so row
  locks do not serialize the load: `POST /items/:id/touch` (`updateWhere` with a predicate that
  always holds) and `POST /items/:id/version` (read, then `updateVersioned` with the version read).
  - **Run settings.** `SERVER_CORES=8-15 LOAD_CORES=16-23`, PostgreSQL 16 in its own throwaway
    container pinned to cores 24-31 (the M128 `bench-pg` setup), `PASSES=15`, `WARMUP=15s`,
    `DURATION=20s`, bombardier `-c 64` with `-m POST`; about 2 × 15 × 2 × 35 s ≈ 35 minutes. One
    load on the machine at a time (the run waits while any suite, `ci:local` or benchmark runs, as
    the M128 `run.sh` does).
  - **Metric.** Per route: the median over passes of the paired throughput ratio `count / single`
    (requests per second), the passes won, and the median paired p99 latency ratio; the per-pass
    rows sorted, so a bimodal run is seen before a median is read.
  - **Threshold (proposed; a number the maintainer may change).** Branch A is built when, on both
    routes, the median throughput ratio is **at least 95%** and the median p99 ratio is **at most
    110%**, and the run is quotable (spread under the harness's own 15% bar and unimodal). Reason:
    5% is about the largest gap the M128 run treated as within noise for a paired median, 110% p99
    leaves room for the one extra statement's latency without hiding a tail, and an unquotable run
    decides nothing (it is re-run, not read). Expectation, stated so the result is not a surprise:
    the count path turns one statement into BEGIN, UPDATE, SELECT, COMMIT for `updateWhere` on the
    root client, so a loss above 5% is likely; `deleteWhere` stays one statement either way.
  - Otherwise Branch B (§3.1.4) is built. Either way the result table, the sorted per-pass rows and
    the raw log path go in the PR description.

#### 3.1.4 Branch B: the count path where `RETURNING` is absent, selected by connector

- **Decision (if M-2 fails).** The connector chooses the path once, at `connect()`:
  - `single` (today's `delegate.update` / `delegate.delete` with `AND: [where]` and the `P2025`
    catch, unchanged): only for `'postgresql'` and `'postgres'`, the connectors whose single
    statement is measured correct (X120's PostgreSQL controls; the guarded `real-prisma-adapter`
    suite).
  - `count` (§3.1.1): every other connector, **and an undetermined connector**. So MySQL, SQL
    Server, CockroachDB and SQLite take the count path; a connector is moved to `single` only by a
    guarded race test against that database, never by assumption.
- **Detection, from source.** The connector is the one `resolveProvider()` already resolves
  (`prisma-adapter.ts:458-469`): the explicit `options.provider` when set, else the generated
  client's `_activeProvider` (declared on the runtime client,
  `@prisma/client/runtime/client.d.ts:1197`; it is the generated schema's `datasource` provider),
  accepted only when it is in `PROVIDERS` (`:81-85`). Undetermined is `undefined`, which selects
  `count`. The resolved value is stored once as the adapter's internal
  `conditionalPath: 'single' | 'count'` and passed to the data-source factory beside `scope` (both
  data-source entry points, root and transaction, read the same value). The driver adapter's own
  `provider` field (`@prisma/adapter-mariadb` sets `provider = "mysql"`, `dist/index.js:315`) is not
  read: the client facade does not expose it.
- **How the two paths stay behaviourally identical.** One conformance table drives both. The
  `prisma` arm of `test/fixtures/conditional-sources.ts` is parameterized by dialect as data
  (`{ dialect: 'postgresql' }` → `single`, `{ dialect: 'mysql' }` → `count`,
  `{ dialect: undefined }` → `count`), and every case of `conditional-write-conformance.test.ts`
  (hit, predicate miss, absent key, lost race, tenant predicate, composite key, `count > 1`,
  returned row equals the stored row) runs over every row of that table. A path that diverges on any
  case fails the same test. The selection itself is a separate table-driven unit test: each
  `provider` value (and `undefined`) against its expected path.
- **"One capability, one implementation."** The rule exists so that two entry points to one
  behaviour cannot honour different configuration. Here there is one entry point (`updateWhere` /
  `deleteWhere`), one selection made once from the connector, and one behavioural contract enforced
  by one table over both paths; the two paths are two strategies of one member, not two entry
  points. The plan records this as a deliberate, tested exception to "one code path", justified by
  M-2's measured cost, and the README says which connectors use which statement.
- **Files.** `src/adapters/prisma/prisma-adapter.ts` (both paths, `conditionalPath`, `scope`,
  `buildKeyColumnsWhere`, `ModelDelegate`).
- **Tests.** `test/unit/prisma-conditional-write.test.ts` (both paths' rules; the path-selection
  table); `test/unit/prisma-adapter-coverage.test.ts` (the `single` arm's `P2025` catch and refusal
  branches stay covered); the dialect-parameterized conformance arm (§3.7); guarded
  `real-prisma-adapter.test.ts` (PostgreSQL, `single`) and `mysql-conditional-race.test.ts` (MySQL,
  `count`).

#### 3.1.5 Fallback if M-1 fails (the `count` is not reliable on MySQL)

- **Fallback design.** The count path issues its own statement instead of `updateMany`:
  `$executeRawUnsafe('UPDATE <table> SET … WHERE <key> AND <predicate>', …values)`, whose return
  value is the driver's affected rows (`$executeRawUnsafe(): PrismaPromise<number>`,
  `@prisma/client/runtime/client.d.ts:216`; the mariadb adapter returns `affectedRows`,
  `dist/index.js:331`), followed by the same `findUnique` read-back in the same transaction. Table
  and column names come from the client's `_runtimeDataModel` (`client.d.ts:1187`; `dbName` for
  `@@map` / `@map`), identifiers are quoted per connector, and values are bound, never interpolated.
- **What it costs.** It reads a second underscore-prefixed client field (`_runtimeDataModel`), with
  the same "not a stability promise" caveat `_activeProvider` carries, so a refusal by name when it
  is absent; the adapter takes on value serialization Prisma does today (dates, decimals, JSON,
  enums), a new branch for each type with tests; and it bypasses Prisma's query extensions and
  middleware for these two members. `deleteWhere` takes the raw `DELETE` the same way.
- **Floor.** If the raw statement cannot be made correct either, conditional writes on Prisma with
  MySQL are refused by name (`UnsupportedQueryFeatureError('conditional-write', 'prisma', …)`, 501)
  and the stores that need them refuse at `verify()`: the letter's Outcome sentence "refused there
  by name". That outcome goes back to the maintainer before it is built.

#### 3.1.6 Common to both branches

- **The facade.** `ModelDelegate` gains `updateMany(args): Promise<{ count: number }>` and
  `deleteMany(args): Promise<{ count: number }>`. Both are generated on every Prisma model, so the
  structural facade loses no client.
- **Versioned writes.** `updateVersioned` / `deleteVersioned` (`versioned-write.ts`) are unchanged:
  they build on `updateWhere`/`deleteWhere`, so a lost race now reaches `missOutcome` and answers
  409 (`VersionConflictError`) or 404.
- **Why.** The count of the statement that took the row lock is the only signal that cannot be
  stale; every compared tool that implements an optimistic token decides on it (§0.1). The
  serializable workaround the runner found is not a fix: it changes the caller's isolation.
- **Test home.** `test/unit/prisma-conditional-write.test.ts` (fake Prisma client, MySQL mode: a
  `beforeUpdate` hook lets a second writer win between the pre-check and the UPDATE, reproducing the
  general-log shape; asserts `null`/`false`, the `count > 1` refusal, the compound-key `where`, the
  root `$transaction` versus direct transaction client); the conformance table (§3.7); and the
  guarded real cell `test/integration/mysql-conditional-race.test.ts` (100 concurrent
  `updateVersioned` on one version through `POST`-shaped service calls, the mariadb pool's
  `connectionLimit` sized to the concurrency: exactly one 200-equivalent, 99 `VersionConflictError`,
  and no other outcome; 20 concurrent `updateWhere` and `deleteWhere`: exactly one winner; delete
  against update: exactly one winner; each winner's returned row read back through `findById` equals
  what is stored).

### 3.2 V13-243 (Part 1): Drizzle on MySQL writes through the repository

**Reproduction read.** `create`, `update`, `delete`, `updateWhere` and `deleteWhere`
(`drizzle-adapter.ts:776-868`) all call `returningRows`, which throws a plain `Error` when the
builder has no `returning` (`:1377-1381`); a MySQL builder has none, so every write is a masked 500
at the first write while the application boots and `/ready` is up.

- **Decision.** A write builder without `returning()` takes the **affected-row path**, decided per
  call structurally (no dialect guess needed), with these rules:
  - `update(id, data)`: `UPDATE … WHERE key`, then the row is read back by key whatever the count;
    today's `Entity '<entity>' not found` error is thrown only when the read-back finds no row. So a
    driver that counts changed rather than matched rows cannot turn a no-op update into "not found"
    (the inbox store calls `update`, `inbox/database-inbox-store.ts:243,257,324`).
  - `updateWhere(id, where, data)`: `UPDATE … WHERE key AND predicate`; zero is `null`; otherwise
    the row is read back by key.
  - `delete` / `deleteWhere`: `affectedRows > 0`.
  - `create(data)`: `INSERT`. Before sending, the key source is decided from the table's columns:
    the key is taken from `data` when it holds every key column; else from `$returningId()` only
    when exactly one key column is missing, that column is a column-level `.primary`
    (`$returningId()` collects only those, `mysql-core/query-builders/insert.js:87-96`, and mysql2
    names every returned id after the first primary column, `mysql2/session.js:60`), it is
    `autoIncrement` or has a `$defaultFn`, and the driver is not mysql-proxy; else the write is
    refused before it is sent with
    `UnsupportedQueryFeatureError('create', 'drizzle', 'Drizzle create on <entity> cannot learn the new key: the key is filled by a database default and the driver has no RETURNING')`.
    The insert and its read-back run in one transaction, and an empty `$returningId()` result throws
    inside it, so the insert rolls back. The row is then read back by key.
  - Read-back and write run on one connection and inside one transaction: on the root instance the
    pair runs in `instance.transaction(async (tx) => …)`; on a transaction instance it runs
    directly. The factory gains the same internal `scope` parameter as §3.1. Drizzle's own
    `transaction()` is used, not the adapter's application transaction bridge
    (`drizzle-adapter.ts:304`): the bridge opens a unit of work with the application's isolation
    settings, while this pair needs only one connection for two statements.
  - On the mysql-proxy driver, whose `transaction()` always refuses (§1), the pair runs unwrapped.
    The proxy is detected structurally and once, at data-source creation, with Drizzle's
    `is(db, MySqlRemoteDatabase)` (its `entityKind`), never by catching an error: on mysql2 a
    pool-acquire failure or a lost connection also rejects before the callback runs, and that
    rejection propagates unchanged. Unwrapped, the outcome is still decided by the write's count;
    the read-back is of committed data, so it may already include a later writer's change. The
    adapter logs one `warn` per adapter naming this (the standing rule: adjust and warn once, refuse
    only where carrying on loses data or fails silently), and the README says so. On mysql-proxy a
    `create` that needs `$returningId()` cannot roll back an empty result, so it is refused before
    sending there (the `create` refusal below).
  - The affected count is read by one internal function, `affectedRowsOf(result)`, which accepts
    only the shapes whose matched-rows meaning is established: mysql2's
    `[ResultSetHeader, FieldPacket[]]` tuple and a bare `ResultSetHeader`
    (`{ affectedRows: number }`). PlanetScale and TiDB report `rowsAffected`
    (`planetscale-serverless/session.js:46`, `tidb-serverless/session.js:36`) with unmeasured
    matched-or-changed semantics, so they are not accepted: any other shape throws
    `UnsupportedQueryFeatureError('write', 'drizzle', 'Drizzle <op> on <entity>: the driver reported no affected-row count this adapter can read (no RETURNING either)')`.
    Never a plain `Error`.
  - **Status of the two refusals.** `'create'` and `'write'` are not in `QUERY_SHAPE_FEATURES` (§1),
    so both are masked 500s with the named message in the log: configuration faults the caller
    cannot change (D-13).
- **`FOUND_ROWS`.** mysql2 counts matched rows by default (§1). An application that removes the flag
  (`flags: '-FOUND_ROWS'`) makes an `updateWhere` whose data equals the stored values read as a
  miss. This is documented in the README's new Drizzle-on-MySQL section, not detected: the pool's
  flags are not reachable through the Drizzle instance's public surface, and the localizable `info`
  text is not a stable signal (§1).
- **Why.** ROADMAP M143q's Outcome. The comparison (§0.1) shows every compared stack writes on MySQL
  through its repository, and the key is always known or returned, so write-then-read on one
  connection is available.
- **Test home.** `test/unit/drizzle-mysql-writes.test.ts` (fake instance with no `returning` and a
  mysql2-shaped result; every rule above, including the unknown-shape 501 and the `$returningId()`
  arms); the conformance table (§3.7); the guarded real cell
  `test/integration/real-drizzle-mysql.test.ts` (X12's filter table, 45 steps, matching the memory
  cell; every write read back through `findById`).

### 3.3 V13-242 (Part 1): `contains` and offset-only paging on Drizzle with MySQL

**Reproduction read.** `drizzle-adapter.ts:1163-1165` and `:1267` emit the SQL text `escape '\'`.
Under MySQL's default `sql_mode` a backslash escapes the closing quote, so the literal never ends: a
syntax error (X120-2, causation shown both ways). `findAll` emits `.offset()` without `.limit()`
when `limit` is 0 (`:764-769`), and MySQL has no `OFFSET` outside `LIMIT` (§1).

- **Decision (escape).** When the resolved dialect is `'mysql'`, the clause is `escape '!'` and the
  pattern is escaped with `!` (`!`, `%` and `_` each prefixed with `!`) by a dialect-aware form of
  `escapeLikePattern` (`src/query/like-escape.ts`). `!` needs no escaping in an SQL string literal,
  so the clause parses under any `sql_mode`, `NO_BACKSLASH_ESCAPES` included, whether the driver
  binds on the client (mysql2 `query()`, §1) or on the server. PostgreSQL and SQLite keep today's
  backslash literal (measured correct; not touched). An undetermined dialect keeps today's literal
  too, and the README says to pass `dialect: 'mysql'` when the instance's class name does not reveal
  it.
- **Decision (offset).** When the dialect is `'mysql'`, `offset > 0` and `limit === 0`, the query
  carries `.limit(sql.raw('18446744073709551615'))`, MySQL's documented "to the end" value (§1). An
  `sql` chunk is an object, which `buildLimit` accepts (the adapter's select facade, typed
  `limit(value: number)` at `drizzle-adapter.ts:102`, is widened to `number | SQL`); a JS number
  would round above BIGINT UNSIGNED and a `bigint` would be dropped (§1). Other dialects are
  unchanged.
- **Why.** An escape character outside SQL's own quoting is the only form that depends neither on
  `sql_mode` nor on the driver's binding; the runner's alternative (emit `'\\'`) and a bound
  backslash (mysql2 interpolates it as `'\\'`) both break under `NO_BACKSLASH_ESCAPES`.
- **Test home.** `test/unit/drizzle-query.test.ts` (rendered SQL per dialect, using the real
  `drizzle-orm/mysql-core` dialect through `mysql-proxy`: the `escape '!'` clause and pattern, and
  `limit 18446744073709551615` as text); the guarded real cell (`contains` with `%`, `_`, `!` and
  `\` in the value returns the row holding them, once with the default `sql_mode` and once after
  `SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')`; offset-only paging returns
  the tail).

### 3.4 V13-251 (Part 1): a connection lost while a unit of work is idle, on mysql2

**Reproduction read.** mysql2 refuses a command on a closed connection with
`Can't add new command when connection is in closed state`, `fatal: true`, no `code` (§1).
`classify.ts` has PostgreSQL's "not queryable" anchors (`:153-156`) and no mysql2 anchor, so the
next repository read is a masked 500 where the other three SQL cells answer 503.

- **Decision.** One message anchor, matched exactly at the start of the message and only when no
  string code is present in the chain (the existing PostgreSQL anchor rule): `'unavailable'` (503,
  "not applied"), because the command was refused before it was sent.
- **Test home.** `test/unit/classify-driver-error.test.ts` (one row in the table data); the guarded
  real cell kills the connection between two reads of a unit of work and asserts 503 through the
  service.

### 3.5 V13-244 (Part 1): MySQL deadlock and duplicate key through `query()`

**Reproduction read.** mysql2 reports a deadlock as `code: 'ER_LOCK_DEADLOCK'`, which no table holds
(`classify.ts:543-553`). Through Prisma, both arrive as `P2010` with a driver-adapter cause whose
`kind` is `UniqueConstraintViolation` (1062) or `TransactionWriteConflict` (1213); the classifier
reads that cause's `originalCode` and sets the MySQL namespace only for `kind: 'mysql'` (`:277`), so
`'1062'` and `'1213'` match nothing.

- **Decision.**
  1. `ER_LOCK_DEADLOCK` joins the string-code arm as `'conflict'` (InnoDB rolls the victim's whole
     transaction back, so the 409 "safe to retry" holds as on PostgreSQL).
  2. `prismaAdapterCause` also returns the driver-adapter `kind`, and the structured arm maps
     `kind: 'UniqueConstraintViolation'` to `'duplicate'` and `kind: 'TransactionWriteConflict'` to
     `'conflict'`. The kind is Prisma's portable discriminant (§1), so the same rule covers the pg
     adapter (already answering 409 through its SQLSTATE `originalCode`) and the mariadb adapter. No
     numeric code is read outside the existing namespace rule.
- **Not this letter.** Other kinds (`ForeignKeyConstraintViolation`, `NullConstraintViolation`,
  `LengthMismatch`, `ValueOutOfRange`, `SocketTimeout`) are M143h's rows (V13-218, V13-252); M143h
  extends the same `kind` read (hand-over §11).
- **Test home.** `test/unit/classify-driver-error.test.ts` (rows: mysql2 `ER_LOCK_DEADLOCK`; a
  `P2010` carrying each of the two kinds from `adapter-mariadb` shape, and from `adapter-pg` shape;
  a `kind: 'mysql'` with `originalCode: '1213'` stays on the existing namespace rule); guarded real
  cell: a two-row opposite-order deadlock through `query()` on both MySQL cells answers 409, a
  duplicate insert through `query()` on Prisma with MySQL answers 409.

### 3.6 V13-142 half (Part 2): the README note

- **Decision.** The Bigtable section of `README.md` gains one paragraph, the text M143b specified:
  an application that also uses `@setu-ts/telemetry-plugin` lists `@opentelemetry/resources@^2.9.0`
  and the other OpenTelemetry peers in its own `package.json`, which
  `setu new --template microservice` and `setu add` now write; Bigtable 6 pulls
  `@opentelemetry/resources` 1, so no range in this package fixes it. No code or range change.
- **Test home.** None beyond `check:docs` (a prose note with no executable claim); the claim that
  Bigtable 6 pulls `resources ^1` is cited from M143b's measurement.

### 3.7 The stores built on conditional writes, proved on MySQL (Part 1)

The outbox, inbox, idempotency, agent-run, tenant data store and grant source stores all live in
this package (`src/outbox`, `src/inbox`, `src/idempotency`, `src/agent-runs`, `src/tenancy`,
`src/authorization`) and reach the adapters only through `updateWhere`/`deleteWhere`/`create`. So
the fix in §3.1 and §3.2 is what they need; what this letter adds is the proof.

- **Decision: one table-driven conformance test.** `test/unit/conditional-write-conformance.test.ts`
  already iterates `sources` from `test/fixtures/conditional-sources.ts` (dynamodb, memory, prisma,
  drizzle, mongodb, cosmos, bigtable, d1). Two arms join that table as data: `prisma-mysql` (the
  fake Prisma client in MySQL mode, §3.1) and `drizzle-mysql` (the fake Drizzle instance with no
  `returning` and mysql2 result tuples, §3.2). Each arm also gets a `lostRace(source)` hook, defined
  per arm: for a fake whose check runs client-side (Prisma, Drizzle) it lets a concurrent winner
  land between the predicate check and the write; for an arm whose check is server-side (DynamoDB,
  Cosmos, Bigtable) it makes the fake's conditional primitive report a failed condition, and one
  shared case asserts, for every arm, that a lost race returns `null` / `false` and leaves the
  winner's row. The enumeration of which arms support a conditional write inside a transaction is
  the same table's `transactionalConditional: true | 'refused'` column, so a comment cannot drift
  from it.
- **Real backends (guarded).** A new environment variable `MYSQL_URL` (a dedicated MySQL 8.4 on
  `127.0.0.1:3307`, database `setu_test`), guarded with Vitest's `{ skip: skipMysql }` (the §1 guard
  style) so a missing variable is counted as skipped, never as a pass. The guarded suites:
  - `test/integration/mysql-conditional-race.test.ts` (§3.1) for both cells;
  - `test/integration/real-drizzle-mysql.test.ts` (§3.2, §3.3, §3.4, §3.5);
  - `test/integration/real-prisma-mysql.test.ts` (§3.1, §3.5), with a second generated client under
    `test/fixtures/prisma-mysql/` (`provider = "mysql"`, `@prisma/adapter-mariadb`);
  - `test/integration/store-conformance-mysql.test.ts`: runs the existing store contracts
    (`describeOutboxStoreContract`, the inbox contract, the idempotency fixture, the agent-run
    Postgres fixture's cases) against both MySQL cells, from new DDL fixtures
    `test/fixtures/{outbox,inbox,idempotency}-mysql.sql`; plus a race case per store (two relays
    claiming one outbox row, two consumers recording one inbox envelope, six parallel idempotency
    begins on one key): exactly one winner, read back through the store's own reads.
  - The tenant data store and the grant source run on both MySQL cells too, on the shapes of the
    existing `tenant-store-race-real.test.ts` and `grant-source-real.test.ts`, from MySQL DDL
    fixtures `test/fixtures/{tenant-store,grant-source}-mysql.sql`: a cross-tenant conditional write
    returns `null` and leaves the row; a concurrent revoke is reported once.
  - A store that cannot be served on MySQL is refused at `verify()` by name with its existing reason
    vocabulary; the test asserts the refusal reason. None is expected, but the stores use more than
    conditional writes: `update`, `count` and comparison filters as well
    (`outbox/database-outbox-store.ts:267,404,419`, `idempotency/database-idempotency-store.ts:201`,
    the inbox's `update`), so the MySQL cells drive those through the stores' own contracts.
  - **The generated MySQL Prisma client.** `test/fixtures/prisma-mysql/schema.prisma` is generated
    the way the existing PostgreSQL fixture is (`prisma generate` into a directory excluded like
    `test/fixtures/prisma-client-generated`), locally and in the CI step that already generates the
    PostgreSQL client.
- **Recording fakes versus real.** The unit conformance runs every arm on fakes; the guarded suites
  run MySQL for real. PostgreSQL arms stay on their existing guarded suites, unchanged.
- **Stores in other lanes.** The outbox relay (`messaging-plugin`) and `IdempotencyPlugin`
  (`idempotency-plugin`) consume these stores through `common` interfaces; they are not edited.
  Their proof on MySQL is the store conformance above. No hand-over is needed for them.
- **Test home.** As listed.

### 3.8 V13-238 (Part 2): a bound on every call to Cosmos, DynamoDB and Bigtable

**Reproduction read.** With the store frozen for 200 s no read returned on any of the three. The
lazy arms build their clients from two or three fields (§1) and pass no per-call option, so no bound
is settable; the documented DynamoDB `requestTimeout` only warns without `throwOnRequestTimeout`,
Cosmos `requestTimeout` bounds writes only (X119-4).

- **Decision.** Each of the three arms gains `requestTimeoutMs?: number` (name D-3, default D-4: 15
  000 ms, `0` disables). It is a **cancelling driver deadline**, not a JavaScript race:
  - DynamoDB: the lazy facade calls `client.send(command, { abortSignal })`; every facade method
    takes an optional second argument `{ abortSignal?: AbortSignal }` (additive on `IDynamoClient`),
    which the adapter always passes; an injected facade that ignores it is unbounded, as documented.
  - Cosmos: every facade call that does I/O takes an optional `{ abortSignal }` in its request or
    feed options (additive on the `ICosmosClient` family of types), passed by the data source and
    transaction on every call.
  - Bigtable: `readRows` and `conditionalMutate` on the facade take an optional `{ timeoutMs }`. The
    lazy arm maps it to `gaxOptions: { timeout }` on `getRows` and `row.filter`, **and** bounds the
    whole read: `gaxOptions.timeout` is only each attempt's deadline on a streaming `ReadRows` (a
    fast-failing attempt is followed by a fresh full-length one, up to 10 retries on codes 4, 8, 10,
    14; `createReadStreamInternal.js:76-78, 308-311`, `tabular-api-surface.js:31`), so the arm also
    arms one whole-call `AbortSignal.timeout(timeoutMs)` that ends the read stream (`end()`) and
    rejects. `CheckAndMutateRow` is `non_idempotent` (no retries,
    `bigtable_client_config.json:52-55`), so its gax deadline already bounds the whole call. This
    makes D-3's "the whole call, retries included" true on Bigtable too.
  - The signal is `AbortSignal.timeout(requestTimeoutMs)` (a web standard, not a runtime API). On
    DynamoDB and Cosmos a rejection while `signal.aborted` is true becomes `DatabaseTimeoutError`
    (504, "outcome unknown"), thrown by the adapter with the driver error as `cause` (decided by
    `signal.aborted`, not by error identity: smithy rewraps the reason into its own `AbortError`,
    `@smithy/node-http-handler/dist-cjs/index.js:9-25`). On Bigtable, where the bound is a gRPC
    deadline, a rejection with gRPC code 4 (`DEADLINE_EXCEEDED`) on a call this adapter bounded
    becomes `DatabaseTimeoutError` the same way. `gaxOptions.timeout` is a per-attempt deadline on
    streaming `ReadRows` and also ends the SDK's resumption loop
    (`createReadStreamInternal.js:76-78, 251-257, 308-311`;
    `google-gax/build/src/createApiCall.js:80-105`). It does not rely on the classifier's
    `TimeoutError` rule, which M143h changes (V13-237), so the two letters cannot disagree.
  - **Range (maintainer decision D-4, 2026-11-23).** Default 15 000 ms. `0` **disables** the bound
    (no signal, no `gaxOptions.timeout`: the SDK's own defaults apply, as before this letter), as
    the Redis `commandTimeoutMs` does. Validated exactly as M143r validates its `requestTimeoutMs`
    (maintainer, 2026-11-23: one name, one rule; `storage-plugin/src/providers/fault.ts:61`,
    `mail-plugin/src/providers/bounded-send.ts:50` on `feat/m143r-provider-arms`):
    `deadlineRangeError('requestTimeoutMs', value)` from `@setu-ts/common`
    (`packages/common/src/health/deadline.ts:77`, already on `develop`), thrown at construction. It
    refuses a non-finite value (`NaN`, `Infinity`), a negative value and a value above 2 147 483 647
    with its own `RangeError` text ("… must be a finite number between 0 and 2147483647 milliseconds
    (0 disables the bound)"); a non-integer is accepted.
  - **Name (D-3).** `requestTimeoutMs`: Setu's existing name for a whole-call bound (M143r ships it
    for storage, secrets and mail, following the Vault provider's sibling option). Its JSDoc and the
    README say it bounds the whole call, retries included, unlike the SDKs' per-HTTP-request
    `requestTimeout` (AWS `NodeHttpHandler`, Cosmos `ConnectionPolicy`).
- **Inside a unit of work.** The bound applies to each call, including the commit's single batch.
- **Why.** The fixed-behaviour rule: a project that configures nothing must not hang. The plugin
  constructs these clients, so the README's "the application owns the driver's bound" argument does
  not hold for them (C6). The sibling bound in this repository for a backend the plugin constructs
  is the Redis `commandTimeoutMs`, 15 000 ms in three packages (§0.1).
- **Test home.** `test/unit/nosql-call-bound.test.ts` (each adapter with a fake facade that never
  settles until aborted: rejects `DatabaseTimeoutError` with the abort as cause; the option reaches
  the lazy arms: recording SDK fakes see `abortSignal` / `gaxOptions.timeout`; `0` passes no signal
  and no `gaxOptions.timeout`; construction refuses exactly what `deadlineRangeError` refuses —
  negatives, `NaN`, `Infinity`, values above the ceiling — and accepts a non-integer such as
  `1500.5`); guarded real cells in `real-dynamo-adapter.test.ts`, `real-cosmos-adapter.test.ts`,
  `real-bigtable-adapter.test.ts` behind the frozen relay (§3.13): a point read, a page, a write and
  a unit of work each end within `requestTimeoutMs + 1 s` with 504.

### 3.9 V13-236 (Part 2): a readiness probe on the three NoSQL adapters

**Reproduction read.** The three adapters declare no `isHealthy`, so the service omits `reachable`
and `/ready` reports `up` for the whole outage (X119-2; `database-service.ts:426-427`).

- **Decision.** Each adapter assigns `isHealthy` at construction. The probe's own bound is
  `min(requestTimeoutMs, 2000)` (2000 when `requestTimeoutMs` is `0`), the service's reachability
  bound (§1), so a probe against a frozen store does not stay open after the service has stopped
  waiting. An expiry **rejects** (unknown, which the indicator reads as `degraded`, the Drizzle
  probe's precedent); `false` is kept for an answer that refused:
  - Cosmos: `database.read()`, the same call `connect()` already requires (`cosmos-adapter.ts:176`),
    so no new permission.
  - DynamoDB and Bigtable: a point read of a fixed absent key (`'__setu_readiness__'`) on the
    readiness entity's table. The readiness entity is a new option, `readinessEntity?: string`,
    defaulting to the first entity in `entities` / `tables` in declaration order. The probe key is
    built from the mapping's own key attribute names, so a string-keyed table never sees a type
    mismatch. `true` when the service answered the read (a found or absent row); `false` on a
    refusal (table missing, access denied). DynamoDB `ValidationException` (a non-string key type):
    **M-5**, a guarded measurement on DynamoDB Local, comes first; a missing table with a mismatched
    key type must answer `ResourceNotFoundException`. If it does, `ValidationException` counts as
    reachable; if not, it rejects (unknown).
  - With no readiness entity (no option, an empty mapping), the adapter has no probe, as today, and
    logs one `warn` at `connect()` naming `readinessEntity`. See D-5 for the zero-configuration
    alternative (an instance-level ping) and why it was not chosen.
- **Why.** The probe must use a permission the application already holds; a point read of the
  application's own table is that. Every compared framework ships a probe for these stores (§0.1).
- **Test home.** `test/unit/nosql-readiness-probe.test.ts` (each adapter: the probe target, each
  answer mapping, the 2 s bound rejecting, the warning without an entity);
  `test/unit/database-indicator-mapping.test.ts` gains the three adapters as rows; guarded real
  cells: stop forwarding through the relay and `/ready` reports not ready within the 2 s indicator
  bound.

### 3.10 V13-241 (Part 2): conditional writes inside a unit of work on the three NoSQL stores

**Reproduction read.** The buffered transaction sources spread `updateWhere`/`deleteWhere` in only
without a buffer (§1), so inside a unit of work `BaseRepository` refuses with 501, and an unguarded
read-modify-write loses updates while all answer 200 (200 requests, 1 or 2 applied).

- **Decision.** The transaction sources gain `updateWhere` and `deleteWhere`. At the call, the
  committed row is read and the predicate evaluated; a miss returns `null` / `false` and buffers
  nothing. A match buffers the write **with the precondition carried to the commit**:
  - DynamoDB: the buffered `Update` / `Delete` in `TransactWriteItems` carries the same
    `ConditionExpression` the non-transactional path builds (`dynamo-data-source.ts:350-359`).
  - Cosmos: the buffered batch operation carries `ifMatch` with the `_etag` of the row read (the
    non-transactional guard, `cosmos-data-source.ts:389-396`); the facade batch operation types gain
    an optional `ifMatch`.
  - Bigtable: the transaction's single CheckAndMutateRow uses the predicate test chain
    (`preconditionTest`, as the non-transactional path does at `bigtable-data-source.ts:371`) in
    place of `[{ all: true }]` for its `onMatch` branch.
  - If the precondition fails at commit, nothing is applied (each primitive is all-or-nothing) and
    the commit throws `SerializationConflictError` (409, "rolled back, safe to retry") with the
    driver's failure as `cause`. Per store:
    - DynamoDB: the reason at each index decides, Put first. `ConditionalCheckFailed` on a `Put`
      stays `DuplicateKeyError` (today's rule); on an `Update` or `Delete` (a predicate, or the
      `attribute_exists` a plain buffered update already carries, §1) it is
      `SerializationConflictError`; a `TransactionConflict` reason is `SerializationConflictError`.
      So a concurrently deleted row under a plain buffered update stops being a masked 500.
    - Cosmos: `CosmosTransactionBatchError` with `failureCode === 412` becomes
      `SerializationConflictError` with that error as `cause`; other failure codes are unchanged.
    - Bigtable: `!matched` on a buffer that expected the row present (a predicate miss or a deleted
      row) becomes `SerializationConflictError` in place of today's plain `Error`.
  - `updateVersioned` inside a unit of work therefore returns the row at the call and the unit of
    work fails at commit with 409 when another writer won: one winner per version.
  - The scope check runs **first**, before the committed read: a conditional write to a row the unit
    of work has already written, and any write to a row after a conditional write to it, is refused
    by name at the call, before any read or buffering (a read first would answer `null` from stale
    committed state). The DynamoDB buffer gains an internal `has(table, key)` for this
    (`dynamo-transaction-buffer.ts`; today it exposes only `add`/`getWrites`/`discard`, lines
    17-26). Since such units of work were refused outright before (501), this narrows a new
    capability rather than breaking an old one: DynamoDB already refuses a second write to one key
    (§1); Cosmos throws `CosmosTransactionScopeError` (a Patch before it would make the committed
    `_etag` stale and fail every such commit with a false 409); Bigtable throws
    `BigtableTransactionScopeError` (its transaction is one CheckAndMutateRow on one row, so a
    conditional write is accepted only as the buffer's first write, and the buffer then takes no
    other write).
  - **Cosmos conditional delete, measured first (M-4).** `DeleteOperationInput` declares no
    `ifMatch` (§1). The facade's own batch Delete type declares it, and a guarded cell on the Cosmos
    emulator first measures that a batch Delete carrying a stale `ifMatch` fails with 412. If it
    does not, a conditional delete inside a Cosmos unit of work keeps today's 501 refusal, and only
    the conditional update ships for Cosmos.
- **Memory and D1.** The memory adapter keeps the refusal (D-6); D1 is the Workers lane's and keeps
  it (§9).
- **Why.** Each store's atomic primitive takes a precondition, and the adapters already use them for
  the `create` guard; EF Core reports the same outcome from `SaveChanges` (§0.1).
- **Test home.** `test/unit/nosql-transactional-conditional.test.ts` (each adapter on its fake: miss
  at call, match then conflict at commit, match then commit, the 409 class and cause);
  `test/unit/nosql-commit-conflict.test.ts` (the per-store mapping, and "an earlier write, then a
  conditional write to the same row" refused before any read); the conformance table's
  `transactionalConditional` column (§3.7); guarded real cells: 200 parallel units of work doing
  `updateVersioned` on one row give one winner per version and every loser 409.

### 3.11 V13-231 (High, Part 2): a Bigtable project runs without Google credentials

**Reproduction read.** SDK 6 constructs a `GCPMetricsHandler` unless `metricsEnabled === false`
(`index.js:467-469`); its exporter runs every 60 s and throws
`Could not load the default credentials` uncaught on a host without them. The plugin builds the
client from `projectId` and `apiEndpoint` only (`bigtable-adapter.ts:136-139`), so the switch cannot
be set.

- **Decision.**
  1. The lazy arm passes `metricsEnabled: false` whenever the client points at an emulator: when
     `apiEndpoint` is set, or when `BIGTABLE_EMULATOR_HOST` is set in the environment, which the SDK
     itself honours (`index.js:413`). The plugin reads that variable through `ctx.runtime.env` (§1)
     and passes the result to the adapter as the internal `emulatorFromEnvironment: boolean` key of
     the plugin-built options bag (not in the exported `BigtableAdapterOptions` type); an adapter
     constructed directly, outside the plugin, decides from `apiEndpoint` alone (README). This is
     the Java client's rule: `BigtableDataSettings.newBuilderForEmulator` installs
     `NoopMetricsProvider` to "disable exporting metrics for emulator", and `newBuilder()` routes
     there when `BIGTABLE_EMULATOR_HOST` is set.
  2. A new option `clientOptions?: Readonly<Record<string, unknown>>` on the lazy arm is spread into
     the SDK constructor options first; the top-level `projectId` and `apiEndpoint` options win over
     the same keys in `clientOptions`, and the derived `metricsEnabled` default applies only when
     `clientOptions` does not set it. "An endpoint is set" means the top-level `apiEndpoint`,
     `clientOptions.apiEndpoint`, or `BIGTABLE_EMULATOR_HOST`. So
     `clientOptions: { metricsEnabled: false }` turns metrics off on a real project, and
     `clientOptions: { metricsEnabled: true }` keeps them on an emulator. Name and scope: D-7.
  3. `adaptBigtableSdkModule` stays internal; `clientOptions` makes exporting it unnecessary.
- **The CLI half.** M143j writes `apiEndpoint` into the scaffold's Bigtable guidance (§11).
- **Why.** The process must not die on the emulator or in CI; Google's own default stays for real
  projects, where credentials exist (D-8 for the alternative of always off).
- **Test home.** `test/unit/bigtable-client-seam.test.ts` (the recording SDK module sees
  `metricsEnabled: false` with an endpoint, absent without one, the caller's value when set, and
  every `clientOptions` key); the guarded real cell keeps the process alive past 90 s after its
  first call with no credentials in the environment (a child process started by the test with
  `GOOGLE_APPLICATION_CREDENTIALS` unset, asserting it is still serving at 90 s).

### 3.12 V13-239 and V13-240 (Part 2): Bigtable reads and the first call

**Reproduction read (V13-239).** An update writes a new cell version; reads carry no latest-cell
filter, the facade maps every version and the decoder keeps `versions[0]` (§1), so a row's read cost
grows with its update count (2.8 ms new, 97 ms after about 8,400 updates).

- **Decision (V13-239).** The facade filter union gains
  `{ readonly column: { readonly cellLimit: number } }` (the SDK's per-column limit, §1), told apart
  from the existing `{ column: string[] }` variant with `Array.isArray`. The README also advises a
  max-versions-1 garbage-collection rule on the column family, without which stored versions keep
  growing even though reads stay flat. Every read the data source issues (`readEntities`, `readOne`,
  the count read, the page read) wraps its filter in a chain that begins with
  `{ column: { cellLimit: 1 } }`; a read with no filter gets that filter alone. Condition tests and
  the existence tests (`bigtable-scan.ts:406`, `:541`) are unchanged. Breaking for an injected
  facade that switches exhaustively over the union: listed in §4.
- **Reproduction read (V13-240).** `connect()` issues no RPC (`bigtable-adapter.ts:142-150`), so the
  SDK's first-use setup, including its metadata-server detection on a host that is not Google's
  (about 3 s; the `METADATA_SERVER_DETECTION=none` control answered in 52 ms), lands on the first
  request, which the grant source's 2 s bound then denies.
- **M-3 comes first.** The 3 s first-call cost was measured with client-side metrics on; with an
  endpoint the data client uses insecure credentials and needs no ADC, so the metadata-server
  detection may belong to `GCPMetricsHandler`, which §3.11 turns off. M-3 measures the first
  `findById` after `connect()` on the emulator with `metricsEnabled: false`.
- **Decision (V13-240), DECIDED by the maintainer 2026-11-24 (option (a), narrowed).** M-3 measured
  the first call after `connect()` at 3.1 s with metrics off, and a 2 s warm-up left it at about
  1.06 s (fresh process, three runs). The cost is gax resolving the universe domain on first use:
  `google-auth-library` awaits `getUniverseDomain()` even with `sslCreds` (`googleauth.js:218-227`),
  whose metadata-server probe waits 3000 ms (`gcp-metadata` `index.js:460-462`); an explicit
  `universeDomain` skips it (measured: connect 420 ms, first read 3.0 ms). So the lazy arm passes
  `universeDomain: 'googleapis.com'` only when both hold: (1) `BIGTABLE_EMULATOR_HOST` is set (read
  by the plugin through `ctx.runtime.env`), or `apiEndpoint` / `clientOptions.apiEndpoint` is set
  and `clientOptions` carries no `sslCreds`; and (2) no universe domain is configured: neither
  `clientOptions.universeDomain` nor `GOOGLE_CLOUD_UNIVERSE_DOMAIN` (read the same way; the SDK lets
  options override that variable, `index.js:67-70`, so the default must step aside). Forcing it on a
  sovereign-cloud project would make gax refuse every call ("configured universe domain does not
  match", `google-gax` `grpc.js:398-406`), hence the narrowing. The `connect()` warm-up is dropped:
  `connect()` issues no RPC. Compared: Go dials an insecure connection with no auth, Python uses
  `AnonymousCredentials`, Java's `newBuilderForEmulator` installs `NoCredentialsProvider`; none
  forces a universe domain, they avoid the lookup by never touching auth, which the Node client
  cannot be told to do. Upgrade note: emulator boot gets faster; no change on real or
  sovereign-cloud projects.
- **Test home.** `test/unit/bigtable-page.test.ts` and `bigtable-data-source.test.ts` (every read
  carries the latest-cell filter first); `bigtable-client-seam.test.ts` (the new variant maps to the
  SDK's `column.cellLimit`; a table over every `universeDomain` trigger and skip case);
  `plugin-nosql-options.test.ts` (both environment reads); `bigtable-adapter.test.ts` (`connect()`
  issues no RPC); guarded real cells: after 2,000 updates of one row a read takes under 3× the
  new-row time; the first `findById` after `connect()` takes under 500 ms.

### 3.13 The frozen relay (Part 2, test infrastructure)

- **Decision.** A test fixture `test/fixtures/frozen-relay.ts`: a `node:net` TCP relay per emulator,
  listening on port 0 (an ephemeral port read back after `listen`, so parallel runs cannot collide)
  and forwarding to 8000, 8082 or 8086, with `freeze()` (stop forwarding, hold sockets open) and
  `thaw()`. The guarded outage cells point the adapter at the relay. No shared container is paused,
  stopped or restarted, so the suites can run beside other sessions.
- **Test home.** Used by §3.8, §3.9 cells; the fixture is under `test/` and is not measured.

### 3.14 V13-249 (Part 2): the agent-run store names why it refuses

**Reproduction read.** `verify()` wraps a sweep-query refusal as
`AgentRunStoreUnavailableError('query-unsupported', { cause })`
(`database-agent-run-store.ts:148-151`). The class's message is fixed in `common`
(`'Agent run store unavailable.'`), and the cause reads "cannot order entity 'AgentRunApproval' by
'deadline, id'; only the resolved access path's sort key '(none)' is orderable", which suggests a
missing sort key.

- **Decision.** In this package only: `verify()` reads the cause chain (as the outbox's
  `unavailableReason` does, `database-outbox-store.ts:199-215`) and, when the refusal is an
  `UnsupportedQueryFeatureError` from `dynamodb` or `bigtable`, wraps it in one more
  `UnsupportedQueryFeatureError('agent-runs', <adapter>, 'The agent-run store needs ordered multi-field queries, which the <adapter> adapter cannot serve. Use PostgreSQL, MySQL, SQLite or MongoDB for agent runs.', { cause })`
  before `AgentRunStoreUnavailableError('query-unsupported', { cause })`. The test asserts the chain
  itself (`error.cause.message` names the reason); whether the startup log prints causes is the
  kernel's (`agent-runs-plugin.ts:122` lets `verify()` reject), so no claim about the log is made.
  The `reason` value is unchanged (`'query-unsupported'`). Whether `common`'s message should carry
  the reason is D-9 (Core lane).
- **Test home.** `test/unit/agent-run-store.test.ts` (the chain for each of the two adapters; any
  other refusal unwrapped).

### 3.15 D-7 (Part 2): `clientOptions` on the DynamoDB and Cosmos lazy arms

- **Decision (maintainer, 2026-11-23: all three arms, one shape).** `DynamoAdapterOptions` and
  `CosmosAdapterOptions` gain `clientOptions?: Readonly<Record<string, unknown>>`, as Bigtable's
  (§3.11). The lazy loader spreads it into the SDK constructor first, and the arm's own top-level
  options win when they are set:
  - DynamoDB (`dynamo-client.ts`, `DynamoClientConfiguration` at `:38-45`):
    `new DynamoDBClient({ ...clientOptions, region?, endpoint?, credentials? })`, each top-level key
    applied only when set (omitted otherwise, never `undefined`).
  - Cosmos (`cosmos-client.ts:259`): `new CosmosClient({ ...clientOptions, endpoint, key })`.
  - With an injected `client`, `clientOptions` is unread; the README says so, as it already does for
    `region` and `endpoint`.
- **Not a second bound.** `clientOptions` may carry the SDKs' own per-request settings (a
  `requestHandler` with `requestTimeout`, a Cosmos `connectionPolicy`); `requestTimeoutMs` (§3.8)
  still bounds the whole call on top of them. The README's "Bounding a call" rows say which is
  which.
- **Why.** X119-4 needed an eight-method facade to set one handler option; every compared tool that
  constructs a driver passes options through (§12.1 Q5).
- **Test home.** `dynamo-client-seam.test.ts` and `cosmos-client-seam.test.ts` (a recording SDK
  module sees every `clientOptions` key, the top-level keys winning, and no `undefined` key); the
  `plugin-nosql-options.test.ts` rows for both arms.

### 3.16 No plaintext-HTTP refusal on the Cosmos lazy arm (maintainer decision, 2026-11-24)

- **Decision.** The implementation had added a refusal of `http://` endpoints on non-loopback hosts
  to the Cosmos lazy loader, mirroring the DynamoDB arm's existing guard. It is dropped from this
  letter: the vNext emulator reached from Compose by service name (e.g. `http://cosmos:8081`) must
  work. The DynamoDB guard, which predates this letter, is unchanged and questioned in a register
  row (V13-273: AWS's own DynamoDB Local Compose example uses `http://dynamodb-local:8000`).
- **Comparison.** `@azure/cosmos` 4.10.2 allows `http` with key auth (`RequestHandler.js` L72-75)
  and refuses plaintext only for an AAD bearer token (`ClientContext.js` L60-68); key auth sends an
  HMAC signature, never the key (`auth.js` L34-39); the Aspire, Python and Go clients all allow it;
  the vNext emulator defaults to `http` and checks no auth.
- **Test home.** `test/unit/cosmos-client-seam.test.ts`: the lazy loader builds a client for
  `http://cosmos:8081/`, a remote `http://` host, loopback and `https`.

### 3.17 Drizzle over mysql2 refuses `NO_BACKSLASH_ESCAPES` (maintainer decision, 2026-11-24)

- **Defect (pre-existing, V13-272).** Drizzle's mysql2 session sends text queries (`client.query`,
  drizzle `session.ts` L101/L133), so mysql2 interpolates bound values client-side, and mysql2
  3.24.x escapes `'` as `\'` whatever the server's `sql_mode`. Under `NO_BACKSLASH_ESCAPES` that is
  no escape: a bound string containing `'` leaves its literal, an SQL injection (probed on MySQL
  8.4: `' OR 1=1 -- ` matched). mysql2 #4684 (merged to `master` 2026-11-17, `ef0dfa4`) is in no
  release yet; the latest is v3.24.6.
- **Decision (maintainer, 2026-11-24, option (a): strip, then refuse).** `connect()` reads
  `@@SESSION.sql_mode` and refuses with the exported `UnsupportedSqlModeError` while it contains
  `NO_BACKSLASH_ESCAPES`; a mode it cannot read, or a read that takes longer than 2000 ms (the
  readiness probe's bound), is refused too, with the driver error as `cause`. So `connect()` now
  does I/O on this arm, and start fails while MySQL is unreachable. A `withReplicas()` instance is
  detected through its session and every pool it holds is guarded. On a pool, each new connection
  reads its mode and has `NO_BACKSLASH_ESCAPES` stripped from its session mode before the caller's
  first statement runs, because the probe showed that destroying the connection from the pool's
  `connection` event is too late (the queued INSERT still ran) and that a statement queued on that
  connection runs first; once any connection reports the flag, every adapter call refuses and one
  `warn` is logged. The handshake status flags carry the bit only for the GLOBAL mode, so the
  session read is the reliable source. Not covered, and documented: the application's own
  `SET SESSION` after the check, connections the pool opened before `connect()`, and the mysql-proxy
  driver (the adapter holds no connection there). The message names the mode and the ways out: turn
  the mode off for the application's sessions, or wait for a stable mysql2 release with #4684 and a
  Setu release that accepts it. Security entry and BREAKING refusal in the CHANGELOG; an upgrade
  note.
- **Comparison.** A framework setting the session mode has precedent: Rails sets
  `@@SESSION.sql_mode` on every connection by default
  ([`abstract_mysql_adapter.rb` L1090-1148](https://github.com/rails/rails/blob/24dc03c0f31997b87edd5eb6c6386c6c2dede0a7/activerecord/lib/active_record/connection_adapters/abstract_mysql_adapter.rb#L1090-L1148)).
  Django only warns (`mysql.W002`,
  [`validation.py` L12-36](https://github.com/django/django/blob/f14af5a88472ca10e2e94b37d6c17ee48cbdeb4d/django/db/backends/mysql/validation.py#L12-L36)).
  HikariCP's `connectionInitSql` is a per-connection hook
  ([`PoolBase.java` L449](https://github.com/brettwooldridge/HikariCP/blob/a4d93f4f85517f90e632b795486d7102e933d7ff/src/main/java/com/zaxxer/hikari/pool/PoolBase.java#L449)).
  PHP mysqlnd
  ([`mysqlnd_connection.c` L951-955](https://github.com/php/php-src/blob/8904d87f04c31b6ada6d8fc38884a2c3b9d45bc1/ext/mysqlnd/mysqlnd_connection.c#L951-L955))
  and go-sql-driver/mysql
  ([`connection.go` L256](https://github.com/go-sql-driver/mysql/blob/7a784e78adc18694f8889cece361860d2ba8f524/connection.go#L256),
  [`packets.go` L717](https://github.com/go-sql-driver/mysql/blob/7a784e78adc18694f8889cece361860d2ba8f524/packets.go#L717),
  [L962](https://github.com/go-sql-driver/mysql/blob/7a784e78adc18694f8889cece361860d2ba8f524/packets.go#L962))
  re-read the `NO_BACKSLASH_ESCAPES` status bit on every escape, so they follow later changes;
  mysql2 3.24.6 does not ([#4684](https://github.com/sidorares/node-mysql2/pull/4684) is merged but
  unreleased). Knex and TypeORM over mysql2 are exposed the same way; Sequelize and Prisma use
  server-side prepared statements.
- **Test home.** `test/unit/drizzle-mysql2-sql-mode.test.ts`: every refusal branch;
  `test/integration/real-drizzle-mysql.test.ts` on `MYSQL_URL`: under the mode `connect()` refuses
  by name, the injection matches with the guard bypassed (negative control), the default `sql_mode`
  connects; an opt-in cell (`MYSQL_GLOBAL_MODE=1`, it sets the global mode and restores it) proves
  the strip on a new pooled connection with the queued-INSERT control and the refusal plus one
  `warn` after.

### 3.18 Prisma `relationMode = "prisma"` refuses the count path (maintainer decision, 2026-11-26)

- **Found in review (PR #617), measured.** On Prisma 7.10.1 with MySQL 8.4,
  `relationMode = "prisma"` turns `updateMany({ where: { id, version: 1 } })` into a `SELECT` of the
  ids and `UPDATE … WHERE id IN (…) AND 1=1`: the predicate is dropped, on every model, with or
  without relations. In the M-1 race both writers reported `count: 1` in 100 of 100 trials, and a
  forced interleaving overwrote a committed change. `deleteMany` keeps its predicate (100/100), but
  its emulated cascade deletes children before the parent's predicate is checked. The default
  relationMode sends one predicated statement (100/100 for both). Upstream: prisma/orm#30758 and
  prisma-engines#5868, both open. Evidence: the maintainer's notes (`relmode-probe/REPORT.md`).
- **Decision (option 1).** On a connector that takes the count path (§3.1.4), `connect()` reads the
  relationMode from the datasource block of the generated client's `_engineConfig.inlineSchema`
  (reachable from the transaction and `$extends` clients); when it is `"prisma"`, `updateWhere`,
  `deleteWhere`, `updateVersioned` and `deleteVersioned` refuse at the call with a named error
  naming the ways out: relationMode `"foreignKeys"`, or Prisma's fix landing and a Setu release that
  accepts it. A client whose field is absent gets one `warn` at connect and no refusal. The
  single-statement PostgreSQL path is unaffected. BREAKING entry, upgrade note and README line.
- **Unreadable mode fails closed (maintainer decision, 2026-11-26, review of PR #617).** A schema
  the detector cannot read (the field absent, a key outside Prisma's datasource keys, an unreadable
  line or header) refuses the four conditional writes like a read `"prisma"`, on the adapter and on
  the direct `createPrismaDataSource` factory, unless the app asserts `relationMode: 'foreignKeys'`
  in its options. The assertion covers only the unreadable case: a schema read as `"prisma"` stays
  refused. The warn-only fallback could pass silently, because the adapter's `warn` callback is
  optional and the direct factory has none. Sibling precedent: the Drizzle mysql2 guard (§3.17) also
  refuses a `sql_mode` it cannot read.
- **MongoDB (maintainer decision, 2026-11-27, review of PR #617).** Prisma on MongoDB allows only
  `relationMode = "prisma"`, so a `mongodb` connector reads as `"prisma"` and the four writes are
  always refused; the `'foreignKeys'` assertion cannot lift it (it is impossible there). The way out
  the message names is Setu's native MongoDB backend, `DatabasePlugin({ type: 'mongodb', … })`.
  Developer impact: none today, since Prisma 7 has no MongoDB adapter.
- **Comparison.** Every compared tool keeps a bulk conditional update to one statement: Rails
  `update_all` (no callbacks; `delete_all` ignores `:dependent`), Django `update()` ("applied
  instantly"), TypeORM (`createForeignKeyConstraints: false` documents no emulation). Prisma's
  relation-mode docs say emulation uses "some additional database queries and logic" and state
  nothing about atomicity.
- **Test home.** Unit tests on the fake client (both modes, absent field, transaction and `$extends`
  clients, PostgreSQL unaffected); a detection pin against the real generated client in both modes;
  a guarded MySQL negative control (refused by name; with the guard bypassed both writers report
  success).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** an injected `IBigtableClient` must accept the new filter variant
`{ column: { cellLimit } }` (§3.12) and the optional `{ timeoutMs }` argument (it may ignore it); an
injected `IDynamoClient` / `ICosmosClient` gains optional arguments only. Ships in minor `0.14.0`,
as a `BREAKING` CHANGELOG entry for the Bigtable facade.

| Exported symbol                                                                              | Kind | Consumer / real code path that READS it                                                                  |
| -------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `BigtableFilter` (widened)                                                                   | type | `bigtable-data-source.ts` read paths build the new variant; `adaptBigtableSdkModule` maps it             |
| `IBigtableTable.readRows` / `IBigtableRow.conditionalMutate` (optional second argument)      | type | `bigtable-data-source.ts`, `bigtable-transaction.ts` pass `{ timeoutMs }`; lazy arm maps to `gaxOptions` |
| `IDynamoClient` methods (optional `{ abortSignal }`)                                         | type | `dynamo-data-source.ts`, `dynamo-adapter.ts` commit and probe pass it; lazy arm passes it to `send`      |
| `ICosmosClient` family (optional `abortSignal`, batch `ifMatch`)                             | type | `cosmos-data-source.ts`, `cosmos-transaction.ts`, probe                                                  |
| `BigtableAdapterOptions`, `DynamoAdapterOptions`, `CosmosAdapterOptions` (new members, §4.1) | type | the adapters' constructors                                                                               |
| `DrizzleAdapterOptions.dialect` (JSDoc widened)                                              | type | `drizzle-adapter.ts` `contains` and offset paths                                                         |

One new error class, `UnsupportedSqlModeError` (§3.17), exported from `src/index.ts` with JSDoc and
a `PUBLIC_API.md` entry; its consumer is an application that catches the Drizzle mysql2 refusal at
start. No new capability token. `affectedRowsOf`, `buildKeyColumnsWhere`, the `scope` parameters,
the mysql2 escape guard and the frozen relay are internal.

### 4.1 Options — every option names its consumer

| Option                                                                      | Consumer                                                                                                                            | Behavior (per implementation)                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestTimeoutMs` (DynamoDB, Cosmos, Bigtable arms; name D-3, default D-4) | carried by `buildAdapterOptions` (`database-plugin.ts:396-440`); every data-source call, every commit and the probe of that adapter | DynamoDB: `abortSignal` on `send`; Cosmos: `abortSignal` in request and feed options; Bigtable: `gaxOptions.timeout`; expiry is `DatabaseTimeoutError` (504); `0` disables the bound; refused at construction exactly as `deadlineRangeError` refuses (non-finite, negative, above 2 147 483 647); non-integers accepted        |
| `readinessEntity` (DynamoDB, Bigtable arms)                                 | carried by `buildAdapterOptions`; `isHealthy`                                                                                       | names the table the probe reads; default the first mapped entity; none → no probe plus one `warn`                                                                                                                                                                                                                               |
| `clientOptions` (the DynamoDB, Cosmos and Bigtable lazy arms; D-7)          | carried by `buildAdapterOptions`; each lazy loader → its SDK constructor (§3.11, §3.15)                                             | spread first; the arm's own top-level options (Bigtable `projectId`/`apiEndpoint`; DynamoDB `region`/`endpoint`/`credentials`; Cosmos `endpoint`/`key`) win when set; Bigtable's derived `metricsEnabled: false` applies only when `clientOptions` does not set `metricsEnabled`; unread when `client` is injected (documented) |
| `dialect: 'mysql'` (existing, wider consumer)                               | Drizzle `contains`, offset-only `findAll`                                                                                           | `escape '!'` with the `!`-escaped pattern; `limit 18446744073709551615` as an `sql.raw` chunk                                                                                                                                                                                                                                   |

## 5. Implementation files

| File                                                                                                            | Purpose                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                                                                                                  | No new export; types re-exported as today                                                                                                              |
| `src/interfaces/index.ts`                                                                                       | §4.1 option members and JSDoc; `dialect` JSDoc                                                                                                         |
| `src/adapters/prisma/prisma-adapter.ts`                                                                         | §3.1: `updateMany`/`deleteMany` on the facade, count path, `scope`, `buildKeyColumnsWhere`                                                             |
| `src/adapters/drizzle/drizzle-adapter.ts`                                                                       | §3.2 affected-row path, `affectedRowsOf`, `scope`; §3.3 escape and offset                                                                              |
| `src/errors/classify.ts`                                                                                        | §3.4 anchor; §3.5 `ER_LOCK_DEADLOCK`, Prisma `kind`                                                                                                    |
| `src/adapters/dynamo/dynamo-client.ts`, `dynamo-client-types.ts`                                                | §3.8 `abortSignal`, §3.15 `clientOptions`                                                                                                              |
| `src/adapters/dynamo/dynamo-adapter.ts`, `dynamo-data-source.ts`, `dynamo-transaction-buffer.ts`                | §3.8 bound, §3.9 probe, §3.10 transactional conditional writes, commit conflict and the buffer's internal `has(table, key)`                            |
| `src/adapters/cosmos/cosmos-client.ts`, `cosmos-client-types.ts`                                                | §3.8 `abortSignal`, §3.10 `ifMatch`, §3.15 `clientOptions`                                                                                             |
| `src/adapters/cosmos/cosmos-adapter.ts`, `cosmos-data-source.ts`, `cosmos-transaction.ts`                       | §3.8, §3.9, §3.10                                                                                                                                      |
| `src/adapters/bigtable/bigtable-client.ts`, `bigtable-client-types.ts`                                          | §3.11 `metricsEnabled`, `clientOptions`; §3.8 `timeoutMs`; §3.12 filter variant                                                                        |
| `src/adapters/bigtable/bigtable-adapter.ts`, `bigtable-data-source.ts`, `bigtable-transaction.ts`               | §3.8, §3.9, §3.10, §3.12                                                                                                                               |
| `src/agent-runs/database-agent-run-store.ts`                                                                    | §3.14                                                                                                                                                  |
| `src/plugin/database-plugin.ts`                                                                                 | `carry('requestTimeoutMs')`, `carry('readinessEntity')`, `carry('clientOptions')`; the `BIGTABLE_EMULATOR_HOST` read through `ctx.runtime.env` (§3.11) |
| `src/query/like-escape.ts`                                                                                      | the `!` escape form for MySQL (§3.3)                                                                                                                   |
| `src/adapters/drizzle/mysql2-escape-guard.ts`, `src/errors.ts`, `src/index.ts`                                  | §3.17: mysql2 detection, the session-mode read, the pool strip-then-refuse guard; `UnsupportedSqlModeError`                                            |
| `src/errors.ts`                                                                                                 | unchanged (D-13 decided 500)                                                                                                                           |
| `package.json`, `deno.json` (imports block, regenerated), `scripts/node-dependency-ranges.ts`, `pnpm-lock.yaml` | devDependencies `mysql2`, `@prisma/adapter-mariadb` (never runtime dependencies), with their `EXTERNAL_RANGES` rows (§1)                               |
| `README.md`, `AGENT_CARD.md`                                                                                    | §2 deliverables, §3.6 note                                                                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                | src covered                                                                                                                                                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/prisma-conditional-write.test.ts`                                                             | `prisma-adapter.ts`                                                                                                                                                                  | §3.1.1 rules via `IDataSource.updateWhere(id, where, data): Promise<E \| null>`; Branch B adds the path-selection table (each `provider` and `undefined` against `single` / `count`)                                                                        |
| `test/unit/prisma-adapter-coverage.test.ts` (extended)                                                   | `prisma-adapter.ts`                                                                                                                                                                  | `scope` root/transaction branches, `count > 1` refusal                                                                                                                                                                                                      |
| `test/unit/drizzle-mysql-writes.test.ts` (new)                                                           | `drizzle-adapter.ts`                                                                                                                                                                 | §3.2 every rule, `affectedRowsOf` shapes                                                                                                                                                                                                                    |
| `test/unit/drizzle-query.test.ts` (extended)                                                             | `drizzle-adapter.ts`                                                                                                                                                                 | §3.3 rendered SQL per dialect                                                                                                                                                                                                                               |
| `test/unit/classify-driver-error.test.ts` (extended, table data)                                         | `classify.ts`                                                                                                                                                                        | §3.4, §3.5 rows                                                                                                                                                                                                                                             |
| `test/unit/conditional-write-conformance.test.ts` + `test/fixtures/conditional-sources.ts` (extended)    | all adapters' conditional paths                                                                                                                                                      | §3.7 lost-race case over every arm; `transactionalConditional` column                                                                                                                                                                                       |
| `test/unit/nosql-call-bound.test.ts` (new)                                                               | the three adapters, clients, data sources, transactions                                                                                                                              | §3.8                                                                                                                                                                                                                                                        |
| `test/unit/nosql-readiness-probe.test.ts` (new)                                                          | the three adapters                                                                                                                                                                   | §3.9                                                                                                                                                                                                                                                        |
| `test/unit/database-indicator-mapping.test.ts` (extended)                                                | `database-service.ts` (unchanged code, new rows)                                                                                                                                     | the three adapters report `reachable`                                                                                                                                                                                                                       |
| `test/unit/nosql-transactional-conditional.test.ts` (new)                                                | `dynamo-data-source.ts`, `dynamo-transaction-buffer.ts`, `dynamo-adapter.ts`, `cosmos-data-source.ts`, `cosmos-transaction.ts`, `bigtable-data-source.ts`, `bigtable-transaction.ts` | §3.10                                                                                                                                                                                                                                                       |
| `test/unit/bigtable-client-seam.test.ts` (extended)                                                      | `bigtable-client.ts`                                                                                                                                                                 | §3.11, §3.12 mapping, `gaxOptions`                                                                                                                                                                                                                          |
| `test/unit/bigtable-adapter.test.ts`, `bigtable-data-source.test.ts`, `bigtable-page.test.ts` (extended) | `bigtable-adapter.ts`, `bigtable-data-source.ts`                                                                                                                                     | §3.12                                                                                                                                                                                                                                                       |
| `test/unit/dynamo-client-seam.test.ts`, `cosmos-client-seam.test.ts` (extended)                          | `dynamo-client.ts`, `cosmos-client.ts`                                                                                                                                               | the lazy arms pass the signal; `clientOptions` reaches each SDK constructor with the §3.15 precedence; unread with an injected `client`                                                                                                                     |
| `test/unit/agent-run-store.test.ts` (extended)                                                           | `database-agent-run-store.ts`                                                                                                                                                        | §3.14                                                                                                                                                                                                                                                       |
| `test/unit/plugin-nosql-options.test.ts` (new; DynamoDB, Cosmos and Bigtable rows)                       | `database-plugin.ts`                                                                                                                                                                 | registering through `DatabasePlugin({ type: 'dynamodb' \| 'cosmos' \| 'bigtable', options: { requestTimeoutMs, readinessEntity, clientOptions } })` delivers each value to the adapter; `BIGTABLE_EMULATOR_HOST` in a fake `runtime.env` turns metrics off  |
| `test/unit/like-escape.test.ts` (extended)                                                               | `like-escape.ts`                                                                                                                                                                     | the `!` form escapes `!`, `%`, `_` and leaves `\`                                                                                                                                                                                                           |
| `test/unit/drizzle-mysql2-sql-mode.test.ts` (new)                                                        | `mysql2-escape-guard.ts`, `drizzle-adapter.ts`                                                                                                                                       | §3.17: every refusal branch, the strip, the latch and its one `warn`, an unreadable mode                                                                                                                                                                    |
| `test/unit/cosmos-commit-deleted-row.test.ts` (new)                                                      | `cosmos-data-source.ts`                                                                                                                                                              | a 404 on a buffered conditional or plain Replace/Patch of a deleted row commits as `SerializationConflictError`; a plain delete keeps the batch error                                                                                                       |
| `test/unit/idempotency/readme-ddl.test.ts` (extended)                                                    | README DDL                                                                                                                                                                           | the MySQL DDL blocks match the fixtures                                                                                                                                                                                                                     |
| `test/unit/nosql-commit-conflict.test.ts` (new)                                                          | `dynamo-adapter.ts`, `cosmos-data-source.ts`, `bigtable-transaction.ts`                                                                                                              | §3.10 mapping table: Put → `DuplicateKeyError`; Update/Delete/`TransactionConflict` → `SerializationConflictError`; Cosmos 412 → `SerializationConflictError`, other codes unchanged; Bigtable `!matched` → `SerializationConflictError`; same-row refusals |
| `test/integration/mysql-conditional-race.test.ts` (new, `MYSQL_URL`)                                     | real Prisma and Drizzle on MySQL                                                                                                                                                     | §3.1, §3.2 races, read back                                                                                                                                                                                                                                 |
| `test/integration/real-drizzle-mysql.test.ts` (new, `MYSQL_URL`)                                         | real Drizzle on MySQL                                                                                                                                                                | §3.2–§3.5                                                                                                                                                                                                                                                   |
| `test/integration/real-prisma-mysql.test.ts` (new, `MYSQL_URL`)                                          | real Prisma on MySQL                                                                                                                                                                 | §3.1, §3.5                                                                                                                                                                                                                                                  |
| `test/integration/store-conformance-mysql.test.ts` (new, `MYSQL_URL`)                                    | the six stores                                                                                                                                                                       | §3.7                                                                                                                                                                                                                                                        |
| `test/integration/real-{dynamo,cosmos,bigtable}-adapter.test.ts` (extended)                              | real emulators through the relay                                                                                                                                                     | §3.8–§3.12                                                                                                                                                                                                                                                  |
| `test/integration/real-import.test.ts` (extended)                                                        | the real `@google-cloud/bigtable` import                                                                                                                                             | the lazy arm with `clientOptions` constructs a client                                                                                                                                                                                                       |

Every `src/` file in §5 has a test file above. The type-only `src/interfaces/index.ts` is covered by
`test/unit/plugin-options-types.test.ts` (extended with the new members).

## 7. Verification gates

```bash
git branch --show-current   # MUST be the letter's feat/ branch, never develop or main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage database-plugin   # ANSI-stripped per-file table; every touched src file ≥ 90%
pnpm run test:deno-lane
# Part 1, before any Prisma path is written into src/ (§3.1.3), each result pasted in the PR:
#   M-1: MySQL general-log race, 100 trials each for updateMany and deleteMany
#   M-3 Bigtable first call, metrics off (§3.12); M-4 Cosmos batch Delete ifMatch (§3.10);
#   M-5 DynamoDB missing table + mismatched key type (§3.9): each before the code that depends on it
#   M-2: SERVER_CORES=8-15 LOAD_CORES=16-23 PASSES=15 PAIR=setu-prisma-single,setu-prisma-count \
#        deno run -A db-bench.ts   (in a new dated copy of ~/setu-benchmarks/2026-11-02-db-m128)
# guarded backends, each with a positive control that the suite did not skip:
MYSQL_URL=mysql://root:setu@127.0.0.1:3307/setu_test \
  DYNAMODB_ENDPOINT=http://127.0.0.1:8000 COSMOS_ENDPOINT=… COSMOS_KEY=… \
  BIGTABLE_EMULATOR_ENDPOINT=127.0.0.1:8086 pnpm test database-plugin
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0   # the version on develop until the release branch bumps it
pnpm run ci:local   # final commit; every suite run goes through ~/.local/bin/setu-suite-queue
```

Self-audit pasted in the PR: the general log of one lost race on Prisma with MySQL after the fix
(the `UPDATE` affected 0, the call returned `null`); the conformance test failing with §3.1 and §3.2
reverted; the grep for `Date.now()`, `as any`, `globalThis.__` in `src/`; each new option grepped to
its consumer.

## 8. Risks & mitigations

- **Prisma `updateMany` on MySQL may not report the UPDATE's own count** (Prisma could count the ids
  its pre-SELECT found). Mitigation: measurement M-1 (§3.1.3) runs first; an offline compile of the
  Prisma 7.10.1 query plan was attempted in planning (`probes-143q/prisma-plan.mjs`) and did not get
  past the compiler's request matching, so this is not verified. If M-1 fails, §3.1.5's fallback is
  built, and its floor (a refusal) goes back to the maintainer first.
- **M-2 compares two builds of one branch.** The `single` and `count` servers must differ only in
  the path. Mitigation: build both from one commit, the `single` tree with a scratch patch in a
  separate worktree under `.claude/worktrees/` that is never committed; the equivalence gate
  confirms the response bodies match before any timing; the per-pass rows are sorted and a bimodal
  or over-15% spread run is re-run, not read.
- **M-2 occupies the machine for about 35 minutes.** Mitigation: it waits for other suites and
  benchmarks (the M128 `run.sh` loop), and its time cost is stated to the maintainer before it
  starts.
- **The gax `timeout` is per attempt on a streaming `ReadRows`.** Mitigation (now the design, §3.8):
  a whole-call timer ends the stream; a unit test drives a fast-failing first attempt followed by a
  hanging one and asserts the call ends at the bound.
- **A mysql2 pool configured without `FOUND_ROWS`** reads a no-op `updateWhere` as a miss.
  Mitigation: documented; a test pins the default-flags behaviour on the real server.
- **The frozen relay changes timing** compared with `docker pause`. Mitigation: one cell per store
  is cross-checked against the runner's X119 numbers (a bounded call ends near the bound).
- **No MySQL in CI** today. Mitigation: D-10.
- **No backend is reachable from the host today** (checked 2026-11-23 with `docker ps`): no MySQL,
  and DynamoDB Local, the Cosmos and Bigtable emulators and PostgreSQL 5433 run only inside other
  sessions' `ci:local` networks. This session does not start containers. Mitigation: M-1, M-2 and
  every guarded suite wait until the coordinator provides MySQL 8.4 on `127.0.0.1:3307`, the three
  emulators on 8000/8082/8086, and a PostgreSQL for M-2; the PR names which suites ran against which
  backend.
- **Scope**: twelve rows. Mitigation: the split in §0.2.

## 9. Out of scope

- D1's transaction source keeps refusing a conditional write in a unit of work (`cloudflare-plugin`,
  Workers lane). If the maintainer wants parity, it is a new register row for M143o or later.
- The memory adapter's transactions keep refusing a conditional write (D-6), with a register row for
  parity (§13).
- Prisma's plain `update()` on MySQL returning the pre-image after a no-op UPDATE inside a snapshot
  (X120-10): documented by M143n (V13-253); this letter changes only the conditional members.
- Throttling (Cosmos 429, DynamoDB `ProvisionedThroughputExceeded`): no emulator produces it;
  classification exists (`classify.ts:525-528`) and is unchanged.
- Real cloud accounts: every NoSQL cell is closed against emulators, as the milestone says.

## 10. Design security review

Two trust boundaries are touched.

1. **Conditional writes are the guard the tenant data store and the grant source rely on.** The
   tenant store's conditional update carries the tenant column in its predicate
   (`src/tenancy/database-tenant-data-store.ts`), and the grant source revokes through
   `deleteWhere`. §3.1 and §3.2 change how the predicate's outcome is learned on MySQL; §3.10 adds
   predicates to buffered commits. A defect here can let one tenant's write land on another tenant's
   row or report a revoke that did not happen. Obligations: the conformance table (§3.7) carries a
   tenant arm for every adapter (a write from tenant A to tenant B's row returns `null` and leaves
   the row), the store conformance on MySQL runs the tenant store and the grant source, and no code
   path decides a write's outcome from a read taken before the write.
2. **Errors reaching the client.** §3.4, §3.5 and §3.8 change statuses. Obligations: the served
   bodies are the existing fixed sentences (no driver message, no SQL, no key); the deadline's
   `DatabaseTimeoutError` makes no claim about the outcome; the 409 for a commit conflict says
   "rolled back", which every primitive guarantees.
3. **`clientOptions`** passes application values to an SDK constructor. It is application
   configuration, not request input, and is never logged (the adapter logs no option values).

**A committed-tree security audit is required** before merge (CLAUDE.md: a diff that crosses a trust
boundary), run by a fresh agent on the exact commit, following
`.roo/skills/security-audit/SKILL.md`, with the two obligations above as its probes and positive
controls.

## 11. Hand-overs

| To                         | Row                       | File                                                                               | Sentence to apply                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M143j (CLI, template half) | V13-231                   | `packages/cli/src/commands/add.ts:2059` and the Bigtable lines the templates write | "Since M143q the plugin also turns Bigtable metrics off when `BIGTABLE_EMULATOR_HOST` is set. The Bigtable registration guidance reads `apiEndpoint` from `BIGTABLE_EMULATOR_HOST` when it is set (`{ projectId, instance, apiEndpoint, tables: {} }`), so a project pointed at `cbtemulator` turns the SDK's client-side metrics off and does not exit after 60 s on a host without Google credentials." |
| M143j or M143e (CLI)       | V13-236, V13-240          | same guidance line                                                                 | "The DynamoDB and Bigtable guidance names `readinessEntity` (or writes the first generated entity into `entities` / `tables`), so `/ready` has a probe." (D-5: mapped-entity read.)                                                                                                                                                                                                                       |
| M143l (Web, `auth-plugin`) | V13-240                   | `packages/auth-plugin/src/scoped/options.ts:365`                                   | "With the emulator `universeDomain` default (M143q §3.12) the first grant check no longer pays the SDK's first-use cost; M143l decides whether a `source-timeout` on a grant source should answer 503 rather than deny with 403."                                                                                                                                                                         |
| M143e (CLI)                | V13-254                   | `packages/cli/src/commands/add.ts` Prisma arm                                      | "The `--dialect mysql` refusal for `--type drizzle` no longer applies: Drizzle with MySQL writes through the repository since 0.14.0." (The Prisma half of V13-254 is unchanged.)                                                                                                                                                                                                                         |
| M143h (Data, next letter)  | V13-218, V13-252, V13-132 | `src/errors/classify.ts`                                                           | "M143q added a read of the Prisma driver-adapter `kind` (`UniqueConstraintViolation`, `TransactionWriteConflict`); map `ForeignKeyConstraintViolation`, `NullConstraintViolation`, `LengthMismatch` and `ValueOutOfRange` on the same read."                                                                                                                                                              |
| M143h (Data)               | V13-237                   | `src/errors/classify.ts:586`                                                       | "The NoSQL call bound of M143q throws `DatabaseTimeoutError` itself, including Bigtable `DEADLINE_EXCEEDED` on a call the adapter bounded; the classifier's `TimeoutError` name rule and a Bigtable code-4 rule remain yours, for SDK-internal timeouts and injected facades."                                                                                                                            |
| M143h (Data) or M143n      | V13-250 (third clause)    | `src/repositories/base-repository.ts:132-137`, `versioned-write.ts:15`             | "The `conditional-write` refusal names `'database-plugin'` as the adapter; pass the bound source's adapter name instead." This is code in the Data lane, so M143n cannot make it.                                                                                                                                                                                                                         |
| M143n (Docs)               | V13-134, V13-250, V13-253 | `packages/database-plugin/README.md`                                               | "M143q rewrote the 'Bounding a call' rows for DynamoDB, Cosmos and Bigtable, added a Drizzle-on-MySQL section and the MySQL cells of 'Optimistic locking'; the mysql2 and mariadb bound rows, the DynamoDB section, the adapter count and the isolation advice remain yours."                                                                                                                             |

V13-142's own hand-over from M143b is applied in §3.6.

**Received from M143i, assigned to M143h (not this letter).** M143i's streamed-cancel hand-over
names `packages/agent-runs-plugin/src/log/respond.ts`: the replay pump started in `start` reads
`deps.store`, and `cancel()` only sets a flag, so a store read can outlive the request's `ctx.defer`
cleanups. `agent-runs-plugin` is a Data-lane package, but no M143q row touches it and this letter's
scope is `database-plugin` alone (§0); it is not a register row either. M143h, the lane's next
letter ("database errors a client can act on, and store signals"), takes it, with its row in
`test/response-stream-cancel-inventory.test.ts`.

## 12. Open decisions for the maintainer

D-2 (which Prisma connectors take the count path) was decided by the maintainer on 2026-11-22 and is
recorded in §3.1.0. **Every decision below was decided by the maintainer on 2026-11-23**: D-1, D-5,
D-6, D-7, D-8 (option a), D-9, D-10, D-11 and D-13 as recommended; D-3 and D-4 **changed** from the
recommendation:

- **D-3 decided: `requestTimeoutMs`** (not `callTimeoutMs`), Setu's existing name for a whole-call
  bound (M143r, #614, for storage, secrets and mail, after the Vault provider's sibling option). Its
  JSDoc and README say it bounds the whole call, retries included, unlike the SDKs' per-HTTP-request
  `requestTimeout`.
- **D-4 decided: 15 000 ms by default, and `0` disables the bound** (as Redis `commandTimeoutMs`
  does); invalid values are refused by M143r's rule, `deadlineRangeError` (non-integers accepted;
  maintainer, 2026-11-23, §3.8). Reason: a long scan or a large Bigtable read (its SDK allows 12 h)
  would otherwise fail with 504 after upgrading, with no way out.
- **D-6 decided: keep the 501, plus a register row** for memory-adapter parity (§13).

The table keeps the options and evidence as they were put to the maintainer.

**Decided by the maintainer on 2026-11-23, after the review of the changed sections** (proposed from
existing precedent; confirmed as listed):

- Prisma root conditional writes use the unit of work's own `{ maxWait: 2000, timeout }` (§3.1.1):
  the adapter's existing setting, not a new one.
- mysql-proxy runs the Drizzle read-back unwrapped with one `warn` (§3.2): the standing rule, adjust
  and warn once, since the outcome still comes from the write's count and nothing is lost.
- DynamoDB `TransactionConflict` → 409 (§3.10): a NoSQL commit conflict, which the maintainer listed
  among the 409 changes, and the repository's rule for a PostgreSQL serialization failure.
- Same-row refusals in NoSQL units of work (§3.10): a narrowing of the capability this letter adds
  (those units of work were refused outright before), refused by name where carrying on would fail
  every commit with a false 409.
- A probe past its bound rejects, read as `degraded` (§3.9): what the service already reports when
  it stops waiting at 2 s, and the Drizzle probe's rule.
- Bigtable's bound covers the whole read, retries included (§3.8): required by D-3's wording.
- `requestTimeoutMs` follows M143r's validation exactly (§3.8): one option name, one rule.

| #    | Decision                                                                                                                              | Options and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Recommendation                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | One pull request or two (§0.2)                                                                                                        | One: fewer merges of shared files. Two: each High row reviewed with its own family; the MySQL CI service lands alone. Two pull requests means two `feat/` branches for one letter, which CLAUDE.md's "exactly ONE feature branch" rule forbids unless recorded as an approved exception. No framework analogue (a process question).                                                                                                                                                                                                                                                            | One branch and one pull request, as briefed; Part 1 before Part 2 in commit order.                                                                                                                                               |
| D-3  | Name of the per-call bound                                                                                                            | `callTimeoutMs` (README heading "Bounding a call"); `commandTimeoutMs` (the Redis siblings here; ioredis `commandTimeout`); `requestTimeoutMs` (AWS `requestTimeout`, Cosmos `requestTimeout`, both per HTTP request, not per call; and M143r's whole-call `requestTimeoutMs`). Table §12.1 Q7.                                                                                                                                                                                                                                                                                                 | Recommended `callTimeoutMs`. **Decided 2026-11-23: `requestTimeoutMs`**, M143r's whole-call meaning.                                                                                                                             |
| D-4  | Default bound                                                                                                                         | No compared framework sets a per-call default for these stores: they inherit the SDK's (AWS SDK v3: none; Cosmos JS: 60 s per HTTP request, nothing per query; Cosmos .NET/EF Core: 6 s; Bigtable Node: ReadRows 12 h, CheckAndMutateRow 20 s; AWS Java v2, Quarkus, Spring Cloud AWS: none; Cassandra driver under Spring Boot: 2 s). Table §12.1 Q1. The sibling for a backend this repository constructs is Redis `commandTimeoutMs` 15 000 ms (three packages). Options: 15 000 ms; 5 000 ms; none (today, and the outcome sentence says a call ends within a bound).                       | 15 000 ms. A departure from "inherit the SDK", justified because two of the three SDK defaults are none or 12 h, and V13-238's outcome requires a bound by default.                                                              |
| D-5  | Readiness probe target without configuration                                                                                          | Mapped entity read (§3.9: the application's own data permission; no probe on an empty mapping, which is what the CLI scaffolds today). Compared: Xabaril's DynamoDB check calls `ListTables` (account-wide `dynamodb:ListTables`); its Cosmos check `ReadAccountAsync` (the `readMetadata` permission every client holds); its Azure Tables check runs a `filter:"false"` query precisely because the metadata call fails under a data-only role; Spring Cloud GCP Datastore runs a key-only query; Quarkus has no DynamoDB check and nothing has a Bigtable one (no analogue). Table §12.1 Q2. | Mapped entity read for DynamoDB and Bigtable (the Azure Tables precedent: a data-plane read the app's role can make), `database.read()` for Cosmos (the Xabaril precedent), plus the CLI hand-over so scaffolds carry an entity. |
| D-6  | Memory adapter: conditional writes inside a unit of work                                                                              | Keep the 501 (no row asks). Add them for parity with the test double: EF Core's InMemory provider does enforce concurrency tokens and throws `DbUpdateConcurrencyException`; spring-data-keyvalue does not honour `@Version`. Table §12.1 Q4.                                                                                                                                                                                                                                                                                                                                                   | Keep the refusal in this letter and open a register row for parity: with §3.10 shipped, a unit-of-work test that runs on memory would refuse what production allows.                                                             |
| D-7  | `clientOptions` on the DynamoDB and Cosmos lazy arms too                                                                              | Bigtable needs it for V13-231. Every compared ORM that constructs the client passes driver options through: TypeORM `extra`, Django `OPTIONS`, Sequelize `dialectOptions`, MikroORM `driverOptions`, Spring `MongoClientSettingsBuilderCustomizer`, Spring Cloud AWS `DynamoDbClientCustomizer`. Table §12.1 Q5.                                                                                                                                                                                                                                                                                | Add it on all three, one shape.                                                                                                                                                                                                  |
| D-8  | Bigtable metrics default                                                                                                              | (a) Off with `apiEndpoint` or `BIGTABLE_EMULATOR_HOST` (§3.11 as amended; the Java client's `newBuilderForEmulator` rule). (b) Off only with `apiEndpoint` (misses an environment-only emulator setup, which the SDK honours). (c) Always off (drops Google's default on real projects, where Node turns metrics on since 6.4.0). Table §12.1 Q3.                                                                                                                                                                                                                                               | (a).                                                                                                                                                                                                                             |
| D-9  | `AgentRunStoreUnavailableError`'s message naming its `reason`                                                                         | A `common` change (Core lane, existing contract). This letter's chain wrapper (§3.14) is enough to close V13-249. No framework analogue.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | No `common` change.                                                                                                                                                                                                              |
| D-10 | MySQL in CI                                                                                                                           | The guarded MySQL suites are skipped in CI unless `.github/workflows/ci.yml` gains a `mysql:8.4` service and `MYSQL_URL` (kept out of `ALLOW_SKIP`). No lane lists the workflow file, `scripts/node-dependency-ranges.ts` or `pnpm-lock.yaml`; the lanes table would name them under Data for this change. The milestone gate requires the MySQL stores to be "driven before they are closed". No framework analogue.                                                                                                                                                                           | Add the service, with the lanes table corrected first.                                                                                                                                                                           |
| D-11 | M-2's threshold, and how a connector other than PostgreSQL moves to the single statement under Branch B                               | Proposed: at least 95% median paired throughput and at most 110% median paired p99 on both routes, in a quotable run (§3.1.3). A stricter bar (98%, the M128 point-read gap treated as noise) favours Branch B; a looser one favours Branch A. Under Branch B, CockroachDB and SQLite have `RETURNING` but no guarded race test here, so they stay on the count path until one exists.                                                                                                                                                                                                          | 95% and 110% as proposed; CockroachDB and SQLite stay on the count path.                                                                                                                                                         |
| D-13 | Status of the two Drizzle-on-MySQL configuration refusals (§3.2: `create` cannot learn the key; the driver reports no readable count) | 500, masked, the named message in the log (a server configuration fault the caller cannot change; `QUERY_SHAPE_FEATURES` unchanged). 501 (add `'create'` and `'write'` to `QUERY_SHAPE_FEATURES`; the caller sees "not implemented" for a request it cannot vary). No framework analogue found for this exact refusal.                                                                                                                                                                                                                                                                          | 500.                                                                                                                                                                                                                             |

### 12.1 Framework comparison behind D-3 to D-8 (primary sources, read 2026-11-23)

`NM` is `node_modules/.pnpm` in this worktree. The full tables are kept in the PR description.

| Question              | Tool                                                       | Finding                                                                                                                                                                                                         | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1 bound              | AWS SDK v3 JS                                              | `requestTimeout` and `connectionTimeout` default 0 (off); over `requestTimeout` only warns unless `throwOnRequestTimeout: true`; `send(cmd, { abortSignal })` destroys the request and rejects; `maxAttempts` 4 | `NM/@smithy+types@4.20.0/.../http/httpHandlerInitialization.d.ts:23-42`; `NM/@smithy+node-http-handler@4.14.2/.../dist-cjs/index.js:84-103, 388-403`; `NM/@aws-sdk+client-dynamodb@3.1169.0/.../dist-cjs/index.js:3512-3515`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q1 bound              | @azure/cosmos 4.10.2                                       | `requestTimeout` 60 s per HTTP request; nothing bounds a whole query; `abortSignal` supported, a user abort surfaces as `AbortError`                                                                            | `NM/@azure+cosmos@4.10.2/.../documents/ConnectionPolicy.js:27`; `.../request/RequestHandler.js:51-120`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q1 bound              | @google-cloud/bigtable 6.5.1                               | ReadRows 12 h, CheckAndMutateRow 20 s, MutateRow 60 s; `gaxOptions.timeout` is a per-attempt deadline on streaming ReadRows and ends the resumption loop                                                        | `.../build/src/v2/bigtable_client_config.json:32-65`; `.../build/src/utils/createReadStreamInternal.js:76-78, 251-257, 308-311`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q1 bound              | Cosmos .NET / EF Core Cosmos                               | `RequestTimeout` default 6 s; EF Core passes it only when set                                                                                                                                                   | [CosmosClientOptions.cs](https://github.com/Azure/azure-cosmos-dotnet-v3/blob/master/Microsoft.Azure.Cosmos/src/CosmosClientOptions.cs); [SingletonCosmosClientWrapper.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.Cosmos/Storage/Internal/SingletonCosmosClientWrapper.cs)                                                                                                                                                                                                                                                                                                                                                                                |
| Q1 bound              | AWS SDK Java v2; Quarkus; Spring Cloud AWS                 | `apiCallTimeout` / `api-call-timeout`: no default                                                                                                                                                               | [ClientOverrideConfiguration.java](https://github.com/aws/aws-sdk-java-v2/blob/master/core/sdk-core/src/main/java/software/amazon/awssdk/core/client/config/ClientOverrideConfiguration.java); [SdkConfig.java](https://github.com/quarkiverse/quarkus-amazon-services/blob/main/common/runtime-spi/src/main/java/io/quarkiverse/amazon/common/runtime/SdkConfig.java); [Spring Cloud AWS reference](https://docs.awspring.io/spring-cloud-aws/docs/3.4.0/reference/html/index.html)                                                                                                                                                                                     |
| Q1 bound              | Spring Boot Cassandra                                      | no Spring default; the driver's `basic.request.timeout = 2 seconds` applies                                                                                                                                     | [CassandraProperties.java](https://github.com/spring-projects/spring-boot/blob/main/module/spring-boot-cassandra/src/main/java/org/springframework/boot/cassandra/autoconfigure/CassandraProperties.java); [reference.conf](https://github.com/apache/cassandra-java-driver/blob/4.x/core/src/main/resources/reference.conf)                                                                                                                                                                                                                                                                                                                                             |
| Q2 probe              | Spring Boot                                                | Mongo: `listDatabaseNames` + `hello`; Cassandra: driver node metadata, no query; Couchbase: `diagnostics()`, no request                                                                                         | [MongoHealthIndicator.java](https://github.com/spring-projects/spring-boot/blob/main/module/spring-boot-mongodb/src/main/java/org/springframework/boot/mongodb/health/MongoHealthIndicator.java); [CassandraDriverHealthIndicator.java](https://github.com/spring-projects/spring-boot/blob/main/module/spring-boot-cassandra/src/main/java/org/springframework/boot/cassandra/health/CassandraDriverHealthIndicator.java); [CouchbaseHealthIndicator.java](https://github.com/spring-projects/spring-boot/blob/main/module/spring-boot-couchbase/src/main/java/org/springframework/boot/couchbase/health/CouchbaseHealthIndicator.java)                                 |
| Q2 probe              | Xabaril HealthChecks                                       | DynamoDB `ListTables`; Cosmos `ReadAccountAsync` (+ optional database/container reads); Azure Tables `filter:"false"` query, because `GetPropertiesAsync` fails under a data-only role                          | [DynamoDbHealthCheck.cs](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/blob/master/src/HealthChecks.DynamoDb/DynamoDbHealthCheck.cs); [AzureCosmosDbHealthCheck.cs](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/blob/master/src/HealthChecks.CosmosDb/AzureCosmosDbHealthCheck.cs); [AzureTableServiceHealthCheck.cs](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks/blob/master/src/HealthChecks.Azure.Data.Tables/AzureTableServiceHealthCheck.cs)                                                                                                                                                                 |
| Q2 probe              | Quarkus; Spring Cloud GCP                                  | Quarkus: Mongo `ping`, no DynamoDB check; Spring Cloud GCP: no Bigtable module (Datastore runs a key-only query)                                                                                                | [MongoHealthCheck.java](https://github.com/quarkusio/quarkus/blob/main/extensions/mongodb-client/runtime/src/main/java/io/quarkus/mongodb/health/MongoHealthCheck.java); [spring-cloud-gcp](https://github.com/GoogleCloudPlatform/spring-cloud-gcp)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Q3 metrics            | Bigtable Node / Java                                       | Node: on by default since 6.4.0, not turned off for the emulator, only `metricsEnabled: false`; Java: `newBuilderForEmulator` installs `NoopMetricsProvider`                                                    | [client-side metrics setup](https://docs.cloud.google.com/bigtable/docs/client-side-metrics-setup); `.../bigtable/build/src/index.js:413-422, 467-470`; [BigtableDataSettings.java](https://github.com/googleapis/java-bigtable/blob/main/google-cloud-bigtable/src/main/java/com/google/cloud/bigtable/data/v2/BigtableDataSettings.java)                                                                                                                                                                                                                                                                                                                               |
| Q4 test double        | EF Core InMemory; spring-data-keyvalue                     | EF InMemory enforces concurrency tokens; keyvalue does not honour `@Version`                                                                                                                                    | [InMemoryTable.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.InMemory/Storage/Internal/InMemoryTable.cs); [spring-data-keyvalue src](https://github.com/spring-projects/spring-data-keyvalue/tree/main/src/main/java)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Q5 passthrough        | TypeORM, Django, Sequelize, MikroORM, Spring               | `extra`, `OPTIONS`, `dialectOptions`, `driverOptions`, client builder customizers                                                                                                                               | [TypeORM](https://typeorm.io/docs/data-source/data-source-options); [Django settings](https://docs.djangoproject.com/en/5.2/ref/settings/); [Sequelize](https://sequelize.org/docs/v6/other-topics/dialect-specific-things/); [MikroORM](https://mikro-orm.io/docs/configuration)                                                                                                                                                                                                                                                                                                                                                                                        |
| Q6 lost race on MySQL | Pomelo EF Core, Hibernate, Rails, Prisma docs, Connector/J | every tool decides from the UPDATE's row count; Pomelo forces `UseAffectedRows=False` (matched rows); Connector/J `useAffectedRows` false by default (found rows)                                               | [MySqlConnectionStringOptionsValidator.cs](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/blob/main/src/EFCore.MySql/Storage/Internal/MySqlConnectionStringOptionsValidator.cs); [Expectations.java](https://github.com/hibernate/hibernate-orm/blob/main/hibernate-core/src/main/java/org/hibernate/jdbc/Expectations.java); [optimistic.rb](https://github.com/rails/rails/blob/main/activerecord/lib/active_record/locking/optimistic.rb); [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions); [Connector/J properties](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-connection.html) |
| Q7 naming             | ioredis, node-redis, mysql2                                | ioredis `commandTimeout`; node-redis `timeout` per command or `commandOptions`; mysql2 `timeout` on a query                                                                                                     | `NM/ioredis@5.11.1/.../RedisOptions.d.ts:10-14`; `NM/@redis+client@6.3.1/.../commands-queue.d.ts:6-17`; [Query.d.ts](https://github.com/sidorares/node-mysql2/blob/master/typings/mysql/lib/protocol/sequences/Query.d.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 13. Docs deliverables

- `PUBLIC_API.md` (DatabasePlugin section): the new option members (§4.1), the Bigtable facade
  change, the conditional-write rule "decided from the write's affected rows", transactional
  conditional writes on the three NoSQL stores, the readiness probe.
- `CHANGELOG.md` (one `0.14.0` entry for the letter): `Fixed` V13-230, V13-242, V13-243, V13-244,
  V13-251, V13-231, V13-239, V13-240, V13-249; `Added` `requestTimeoutMs`, `readinessEntity`,
  `clientOptions`, conditional writes in NoSQL units of work, NoSQL readiness probes; `BREAKING` the
  Bigtable facade filter variant. Each entry names its PR number after `gh pr create`.
- `docs/upgrading.md` and the `CHANGELOG.md` entry list **every behaviour an existing application
  meets, each with its way out** (maintainer, 2026-11-23):
  - DynamoDB, Cosmos and Bigtable calls end at 15 s with 504 (`DatabaseTimeoutError`) where they
    used to wait: raise `requestTimeoutMs`, or set `0` to restore the SDK's own behaviour;
  - Bigtable client-side metrics are off whenever `apiEndpoint` is set, a real private endpoint
    included, or `BIGTABLE_EMULATOR_HOST` is set: `clientOptions: { metricsEnabled: true }` keeps
    them;
  - a NoSQL unit of work whose commit loses a precondition now answers 409
    (`SerializationConflictError`) where it was a masked 500, and a buffered plain update of a row
    deleted meanwhile does the same; a retry loop keyed on 409 now retries it;
  - a conditional write in a NoSQL unit of work to a row already written there (or any write after
    one) is refused by name (`CosmosTransactionScopeError` / `BigtableTransactionScopeError`): write
    the row once per unit of work;
  - `/ready` can now report the three stores down (the probe reads `readinessEntity`, default the
    first mapped entity; an application with no entity mapped gets one `warn` and no probe): set
    `readinessEntity` to a table the application's role can read;
  - an injected Bigtable facade must accept the new `{ column: { cellLimit } }` filter variant and
    the optional `{ timeoutMs }` argument; every read now asks for the latest cell only;
  - Prisma conditional and versioned writes on a connector other than PostgreSQL (Branch B) or on
    every connector (Branch A) run `updateMany`/`deleteMany` in a short transaction: a lost race on
    MySQL now answers 409/404 instead of reporting success; a misconfigured `keyColumns` that
    matches several rows throws and rolls back;
  - Drizzle with MySQL now writes through the repository (it was a masked 500), and the MySQL
    `contains` filter escapes with `!`; on mysql-proxy the write's read-back runs outside a
    transaction, with one `warn`;
  - Prisma conditional and versioned writes now reach Prisma as `updateMany`/`deleteMany` plus a
    `findUnique` read-back (on the connectors §3.1.0's branch puts on the count path): a client
    extension (`$extends` query hook) or middleware written for `update`/`delete` (soft delete,
    audit) no longer sees them; hook `updateMany`/`deleteMany` too;
  - on the root client such a write holds a short interactive transaction and a pool connection,
    with the unit of work's own `maxWait` of 2 s, so pool exhaustion answers 503 (`P2028`) as a unit
    of work already does: size the pool for it;
  - DynamoDB `TransactionCanceledException` with a `TransactionConflict` reason now answers 409
    (`SerializationConflictError`, rolled back, safe to retry) where it was a masked 500, the same
    rule as a PostgreSQL serialization failure here;
  - Bigtable on an emulator endpoint with no universe domain configured gets
    `universeDomain: 'googleapis.com'` (§3.12), so its first call is fast: no change on real or
    sovereign-cloud projects;
  - the readiness probe adds one read per uncached health check (a DynamoDB or Bigtable point read,
    a Cosmos `database.read()`), billed by the provider: lengthen the indicator's cache interval, or
    point `readinessEntity` at a small table;
  - Drizzle on mysql2 refuses `NO_BACKSLASH_ESCAPES` (`UnsupportedSqlModeError`) at `connect()` and
    strips it from later pooled connections before refusing every call: turn the mode off for the
    application's sessions; and its `connect()` now reads the session mode, so start fails while
    MySQL is unreachable or stalls past 2 s;
  - a Prisma `P2010` carrying a duplicate key or a write conflict through `query()` now answers 409
    where it was 500; mysql2 `ER_LOCK_DEADLOCK` answers 409; a closed mysql2 connection answers 503.
- `packages/database-plugin/README.md`: C1–C7, §3.6, a Drizzle-on-MySQL section (pool and bridge
  example, `FOUND_ROWS`, `dialect: 'mysql'`), the MySQL DDL for the outbox, inbox and idempotency
  stores (pinned by `readme-ddl.test.ts`, extended to the MySQL DDL).
- `packages/database-plugin/AGENT_CARD.md`: one line each for the call bound and the readiness
  entity, within the card's byte budget.
- `CLAUDE.md` status line and the ROADMAP Progress Tracking row, in the letter's own PR.
- `smoke/DEFECTS.md`: a new register row (D-6) — the memory adapter refuses a conditional write
  inside a unit of work while DynamoDB, Cosmos and Bigtable accept it, so a test on the memory
  double refuses what production allows (EF Core's InMemory provider enforces concurrency tokens).
  Unowned, for a later letter.
- `ROADMAP.md` lanes table: name `scripts/node-dependency-ranges.ts`, `pnpm-lock.yaml` and
  `.github/workflows/ci.yml` under Data for this change, before the code (D-10).
