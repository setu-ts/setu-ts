# Milestone 107 — Transactional outbox (`@setu-ts/messaging-plugin`, `@setu-ts/common`, `@setu-ts/database-plugin`, `@setu-ts/telemetry-plugin`)

> **Status:** Planning. Branch: `feat/m107-transactional-outbox`. `main` and `develop` are protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A service that changes its own data and announces the change must do both or neither. This milestone
writes an integration-event envelope as a row in the SAME database transaction as the business
change, through the caller's own `IUnitOfWork`, and relays persisted rows to the broker afterwards:
at least once, per ordering key in write order, re-parented to the trace that wrote the row. The
relay is a job on `CAPABILITIES.SCHEDULER` on Node, Deno and Bun, and a Cron Trigger plus
`waitUntil` on Cloudflare Workers. The promise is stated once (§3.13) and nowhere stronger.

- **In scope:**
  - `CAPABILITIES.OUTBOX`, the `IOutboxStore` port and its record types in `common` (§3.1 — the port
    another plugin implements; §2.2 forces it there).
  - `createDatabaseOutboxStore()` in `database-plugin`: the bridge that implements the port over
    `IDatabaseService`, owns the column mapping and the discriminator, and refuses an unsupported
    backend by name at startup (§3.4, the M101c `createDatabaseTenantDataStore` precedent).
  - The `outbox` arm on `MessagingCommonOptions` and the `IOutbox` service in `messaging-plugin`:
    `write`, `dispatch`, `sweep`, `purge`, `release`.
  - The lap-based, keyset-paged pending-set relay with per-key blocking, conditional transitions,
    poison handling, one sweep deadline, a shutdown drain, a separately scheduled retention purge,
    trace re-parenting, a health indicator and optional metrics.
  - `SpanOptions.root?` in `common`, carried by `TelemetryService.withSpan` and `tracer.ts` to
    OTel's own `SpanOptions.root`, so a background sweep does not attribute a traceless row to the
    request that dispatched it (§3.9).
  - The Workers hybrid, driven on real workerd in `apps/cloudflare` (§3.12).
  - One `cli` claim-table line and the `docs/health-indicators.md` classification the M70c/M70g
    gates require for a new `ctx.health.register` site, and a structural change to
    `test/plugin-claims-gate.test.ts` so one package may declare several derived indicator names
    (§3.11).
  - CI: a PostgreSQL service on `OUTBOX_POSTGRES_URL` and a single-node MongoDB replica set on
    `MONGODB_RS_URI` in the three suite-running workflows, pinned by `test/apps-gate.test.ts`, and
    the M101a pin amended (§6, C8).
- **NOT this milestone:**
  - The consumer inbox — M108 (which inherits the discriminator rule, §3.2).
  - Change-data-capture relays (PostgreSQL logical decoding, MongoDB change streams, DynamoDB
    Streams, Cosmos change feed) and therefore Bigtable — a later CDC milestone (ROADMAP M107 "Out
    of scope").
  - Native `FOR UPDATE SKIP LOCKED` multi-relay on PostgreSQL — a later Postgres-only option.
  - Closing the read-then-write window of a status transition — needs M105's `updateWhere` (§3.7).
  - A dynamic tenant list for database-per-tenant (no tenant catalog exists; M89c cut `tenantById`).
  - Trace continuity across `WorkersBroker` — a pre-existing gap (the custom-broker adapter drops
    framework headers); named in §9, not fixed.
  - The pre-existing `MongoTransactionUnavailableError` wrapping that never fires on the real driver
    (§1) — a defect in merged code, for a `fix/…` branch; the outbox's own startup check does not
    depend on it (§3.4).

## 1. Contracts verified from SOURCE (not names)

Paths are relative to the repository root. Every row was read in source on 2026-10-08.

| Reference                                           | Source (file:line)                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IUnitOfWork`                                       | `packages/database-plugin/src/interfaces/index.ts:168-179`                                                                   | ONE member, `getRepository<Entity, Id>(entity)`; declared in `database-plugin`, NOT in `common` — `messaging-plugin` may not import it (§2.2)                                                                                                                                |
| `IDatabaseService`                                  | `packages/database-plugin/src/interfaces/index.ts:187-252`                                                                   | `getRepository`, `transaction(work, options?)`, `query`, `migrate`, `isHealthy`, `close`; also in `database-plugin`                                                                                                                                                          |
| `CAPABILITIES.DATABASE`                             | `packages/common/src/tokens.ts:48-49`                                                                                        | `'database'`; its documented interface is `IDatabaseService`. The ONLY `src` reader outside its provider is `database-plugin`'s own tenant bridge (`database-tenant-data-store.ts:322`)                                                                                      |
| Multi-tenancy reaches the database                  | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts:1-60`, `:320-325`; `common/src/services/tenancy.ts:143`  | NOT structurally. The port `ITenantDataStore` is in `common`; `database-plugin` ships the bridge as a `RegistryFactory`; `multi-tenancy-plugin` resolves it at `onInit`. `git log -S "CAPABILITIES.DATABASE" -- packages/multi-tenancy-plugin/src` finds comments only       |
| `IAdapterTransaction.createDataSource`              | `packages/common/src/services/database.ts:289-297`                                                                           | every repository from one handle targets one transaction                                                                                                                                                                                                                     |
| `IDataSource` deferral note                         | `packages/common/src/services/database.ts:189-202`                                                                           | a transaction-scoped source MAY defer writes to commit (D1 the worked example); reads see committed state only                                                                                                                                                               |
| `NormalizedQuery` / `FilterExpression`              | `packages/common/src/services/database.ts:74-120`, `:163-185`                                                                | `where` (equality), `filter` (`eq`/`contains`/`gt`/`gte`/`lt`/`lte`/`in`, `and`/`or`), `orderBy`, `limit`, `offset`, `select`                                                                                                                                                |
| `DatabaseService.transaction`                       | `packages/database-plugin/src/services/database-service.ts:210-261`                                                          | `beginTransaction` → UoW over `txn.createDataSource` → `work(uow)` → `commit()`; any error → `rollback()`; a commit-time unique violation becomes `DuplicateKeyError` (`:130-134`)                                                                                           |
| `DatabaseService.migrate`                           | `packages/database-plugin/src/services/database-service.ts:287-293`                                                          | always rejects `UnsupportedMigrationError`, every adapter — no portable migration exists                                                                                                                                                                                     |
| `DuplicateKeyError`                                 | `packages/common/src/errors/duplicate-key.ts:49-79`                                                                          | `name`, `entity`, status hint 409; raised for a duplicate key on every adapter (`database-plugin/src/errors/classify.ts:80-315`)                                                                                                                                             |
| `UnsupportedQueryFeatureError`                      | `packages/database-plugin/src/errors.ts:290-312`                                                                             | `feature`, `adapter` fields — what the bridge reads to name a refusal (§3.4)                                                                                                                                                                                                 |
| Memory transaction                                  | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:334-453`                                                     | in-process overlay keyed by entity, flushed at commit — two entities in one transaction                                                                                                                                                                                      |
| Memory relay query                                  | `memory-adapter.ts:738-773`; `query/query-builder.ts:199-205`, `:350-366`                                                    | evaluated in process; a `Date` compared with a number is `false`; `orderBy` on a column no row has is refused unless the store is empty                                                                                                                                      |
| Prisma transaction                                  | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:267-339`                                                     | interactive `$transaction`, one `tx` for every entity (`:316-324`); timeout `transactionTimeout` (default 30 000)                                                                                                                                                            |
| Drizzle transaction                                 | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:438-501`                                                   | interactive through `transactionBridge`, one `tx` for every entity (`:479-481`); native `orderBy`/`lte`/`limit` (`:704-724`)                                                                                                                                                 |
| Mongo transaction                                   | `packages/database-plugin/src/adapters/mongo/mongo-adapter.ts:233-256`                                                       | driver session shared by every collection; standalone refused with `MongoTransactionUnavailableError` (`:244`)                                                                                                                                                               |
| DynamoDB transaction                                | `dynamo-adapter.ts:241-254`, `:370-392`; `dynamo-transaction-buffer.ts:6`, `:40-60`                                          | one buffered `TransactWriteItems` across tables; at most 100 writes, one per (table, key) — `UnsupportedQueryFeatureError('transaction')`                                                                                                                                    |
| DynamoDB ordering                                   | `packages/database-plugin/src/adapters/dynamo/dynamo-access-path.ts:339-360`                                                 | `orderBy` must be exactly ONE field equal to the resolved access path's sort key, else `UnsupportedQueryFeatureError('orderBy')`; GSIs configured as `indexes` (`dynamo-mapping.ts:90-96`)                                                                                   |
| Cosmos transaction                                  | `packages/database-plugin/src/adapters/cosmos/cosmos-transaction.ts:55-100`                                                  | one batch: ONE container, ONE partition-key value, ≤100 ops — `CosmosTransactionScopeError`; the container is the entity name unless mapped (`container ?? entity`)                                                                                                          |
| Bigtable transaction                                | `packages/database-plugin/src/adapters/bigtable/bigtable-transaction.ts:160-171`                                             | ONE (table, row key) — a second row throws `BigtableTransactionScopeError`                                                                                                                                                                                                   |
| Bigtable ordering                                   | `packages/database-plugin/src/adapters/bigtable/bigtable-scan.ts:110-127`                                                    | `orderBy` only on the full row key ascending — `UnsupportedQueryFeatureError('order-by')`                                                                                                                                                                                    |
| D1 transaction                                      | `packages/cloudflare-plugin/src/database/d1-adapter.ts:218-251`                                                              | buffered, one `db.batch()` at commit, shared across tables; in-transaction `create` needs an explicit key (`d1-data-source.ts:353-363`)                                                                                                                                      |
| D1 dates                                            | `packages/cloudflare-plugin/src/database/d1-sql.ts:136-147`                                                                  | a `Date` in an ordered comparison is REFUSED — epoch numbers are the portable time type                                                                                                                                                                                      |
| Missing-entity detection                            | adapter survey (see §3.4)                                                                                                    | no portable existence API; `findAll({ limit: 1 })` rejects for a missing table on Prisma, Drizzle, DynamoDB, Cosmos, Bigtable and D1, and cannot detect absence on memory and MongoDB (both create lazily)                                                                   |
| `createEnvelope` (internal)                         | `packages/messaging-plugin/src/integration/envelope.ts:71-111`                                                               | the only envelope writer; `id = runtime.uuid()`, `occurredAt` from `runtime.now()`; refuses an `undefined` payload and a non-finite `aggregateVersion`                                                                                                                       |
| `publishIntegrationEvent`                           | `packages/messaging-plugin/src/integration/publish.ts:68-96`                                                                 | validates options, builds the envelope, ordering key = caller's > definition selector > none, `deduplicationId` defaults to the envelope id, then `broker.publish`                                                                                                           |
| `IntegrationEventDefinition.orderingKey`            | `packages/messaging-plugin/src/integration/definition.ts` (method-syntax member)                                             | `orderingKey?(envelope): string \| undefined`                                                                                                                                                                                                                                |
| `PublishOptions` and validation                     | `packages/common/src/services/messaging.ts:99-112`, `:152-153`, `:317-319`, `:371`                                           | reserved names include `traceparent`, `tracestate` and the `x-setu-` prefix; `parsePublishOptions` is the one copy-once parse                                                                                                                                                |
| `MessageBrokerAdapter.publishWithHeaders`           | `packages/messaging-plugin/src/brokers/message-broker.ts:40-60`                                                              | internal framework-header channel; `TracedBroker` and `PipelinedBroker` both implement it                                                                                                                                                                                    |
| Custom-broker adapter                               | `packages/messaging-plugin/src/brokers/custom-adapter.ts` (`asBrokerAdapter`, `publishWithHeaders: (…, _headers, …)`)        | a custom instance without the full seam has its framework headers DROPPED — so `TracedBroker`'s `traceparent` never reaches `WorkersBroker` (pre-existing)                                                                                                                   |
| `WorkersBroker`                                     | `packages/cloudflare-plugin/src/messaging/workers-broker.ts:173`, `:259-288`                                                 | implements `IMessageBroker` with M106 `PublishOptions`; has no `publishWithHeaders`                                                                                                                                                                                          |
| Messaging plugin composition                        | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:165`, `:230-235`, `:428-473`, `:510-534`, `:544-586`               | token `messaging` or `messaging.<name>`; `optionalDependencies: ['logger', CAPABILITIES.TELEMETRY]`; connect → close hook → `TracedBroker` (when telemetry) → `PipelinedBroker` (when behaviours) → register; cached probe indicator; `onInit` factory resolution            |
| `TracedBroker.publishWithHeaders`                   | `packages/messaging-plugin/src/tracing/traced-broker.ts:50-73`                                                               | opens `publish <topic>` producer span with NO `parentContext`, so its parent is whatever span is ACTIVE at publish; injects that span's `traceparent` on the framework channel                                                                                               |
| `ITelemetryService.withSpan` / `SpanOptions`        | `packages/common/src/services/telemetry.ts:43-56`, `:166-225`                                                                | `SpanOptions.parentContext?: TelemetryContext` EXISTS; `activeSpanContext?()` optional; `SpanKind` includes `'internal'` (`:25`)                                                                                                                                             |
| `withSpan` implementation                           | `packages/telemetry-plugin/src/services/telemetry-service.ts:141-176`; `tracing/tracer.ts:297-380`                           | honours `parentContext` over the ambient context; runs `fn` inside `activate` only when a context manager was registered                                                                                                                                                     |
| Trace-context codec                                 | `packages/common/src/trace-context.ts:11-92`                                                                                 | `parseTraceparentToContext(header \| null)` (invalid → id-less context, never a throw); `contextToTraceparent(ctx)` (`null` for invalid / all-zero)                                                                                                                          |
| Stored-traceparent precedent                        | `packages/queue-plugin/src/tracing/traced-queue.ts:90-147`                                                                   | `TracedQueue.process` re-parents with `parentContext: parseTraceparentToContext(job.headers?.traceparent)` — the exact pattern the relay uses                                                                                                                                |
| Real-SDK continuity tests                           | `packages/messaging-plugin/test/integration/trace-continuity-real.test.ts:48-240`                                            | real API + SDK + `AsyncLocalStorageContextManager`, `InMemorySpanExporter`, a clean-context redelivery case; vacuity traps in the comments                                                                                                                                   |
| `IScheduler`                                        | `packages/common/src/services/scheduler.ts:83-179`                                                                           | `cron`/`every`/`delay`/`pause`/`resume`/`remove`/`getNextRun` — NO accessor for the lock in use                                                                                                                                                                              |
| Scheduler locks                                     | `packages/scheduler-plugin/src/services/scheduler-service.ts:558-640`, `:642-715`; `lock/distributed-lock.ts:52-80`          | per-fire slot lock (never released) + per-handler mutex acquired with `ttlMs` (default 30 000) and NO renewal; default lock `MemoryLock` (process-local) unless `distributedLock` says otherwise                                                                             |
| Scheduler on Workers                                | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:155-156`                                                           | `register()` throws `SchedulerUnavailableError` on `cloudflare-workers`                                                                                                                                                                                                      |
| `WorkersCron` / `createScheduledHandler`            | `packages/cloudflare-plugin/src/cron/workers-cron.ts:77-167`; `cron/scheduled-handler.ts:213-238`                            | `cron.on(expression, handler)`; `dispatch` runs every handler and throws `AggregateError` on any failure                                                                                                                                                                     |
| `waitUntil`                                         | `packages/cloudflare-plugin/src/background/wait-until.ts:25`, `:57-70`; `options.ts:187-221`                                 | `WaitUntilHost = (promise) => void`, injected by the app from `cloudflare:workers`                                                                                                                                                                                           |
| `RegistryFactory` / `resolveRegistryEntry`          | `packages/common/src/registry.ts:66`, `:216`                                                                                 | `(services) => T`; a throwing factory becomes `Failed to resolve <label>` with `cause`                                                                                                                                                                                       |
| `withDeadline` / `createCachedProbe`                | `packages/common/src/health/deadline.ts:34`, `:118`; `health/probe.ts:121-139`                                               | per-call bound; cached probe with TTL and timeout                                                                                                                                                                                                                            |
| `HealthCheckResult` / `HealthStatus`                | `packages/common/src/services/health.ts:13-26`; `common/src/types.ts:62`                                                     | `{ status: 'up' \| 'down' \| 'degraded', data? }`                                                                                                                                                                                                                            |
| Queue backlog health (M90b)                         | `packages/queue-plugin/src/services/queue-service.ts:273-391`                                                                | facts in `data`, no threshold — this milestone adds one, which the ROADMAP asks for (§3.11)                                                                                                                                                                                  |
| Optional-metrics collector (M45b)                   | `packages/worker-pool-plugin/src/metrics/worker-pool-collector.ts:34-160`; `plugin/worker-pool-plugin.ts:52-68`              | instruments created eagerly (unguarded), every write `#guard`ed, logger read at call time                                                                                                                                                                                    |
| `describeError`                                     | `packages/messaging-plugin/src/brokers/describe-error.ts:36-52`                                                              | one bounded line, Cc/Cf removed — the `lastError` source                                                                                                                                                                                                                     |
| `ITenant` / `IRequest.tenant`                       | `packages/common/src/services/tenancy.ts:14`; `common/src/http.ts:66`                                                        | no ambient tenant store exists; a writer must be handed the tenant id                                                                                                                                                                                                        |
| Capability-token grammar                            | `packages/common/src/tokens.ts:296`, `:317`                                                                                  | lowercase kebab segments joined by `.` — `outbox` and `outbox.<name>` are legal                                                                                                                                                                                              |
| Health-indicator gates                              | `test/health-indicator-audit.test.ts`; `test/plugin-claims-gate.test.ts`; `packages/cli/src/utils/plugin-claims.ts:30-60`    | every `ctx.health.register(` site must be classified (by file:line) in `docs/health-indicators.md`; every indicator name a plugin registers must be in the CLI claim table                                                                                                   |
| CI backends                                         | `.github/workflows/ci.yml:66-91` (env), `:100-109` (services: `mongo:8`), `:175-185` (DynamoDB Local), `:378` (`ALLOW_SKIP`) | Redis, RabbitMQ, MongoDB, DynamoDB Local and the Bigtable emulator in CI (also `release.yml:42-66`, `drift.yml:36-61`); **no PostgreSQL** in any workflow; `apps/cloudflare` is the one `ALLOW_SKIP` entry                                                                   |
| CI MongoDB is standalone                            | `.github/workflows/ci.yml:100-109`                                                                                           | `mongo:8` with no `--replSet`: a replica-set suite on `MONGODB_URI` would be a permanent skip                                                                                                                                                                                |
| M101a pin: no `POSTGRES_URL` in CI                  | `test/apps-gate.test.ts:627-646`                                                                                             | asserts `not.toContain('POSTGRES_URL')` on `ci.yml` and `release.yml` — a SUBSTRING match, so `OUTBOX_POSTGRES_URL` fails it too; and `real-drizzle-adapter.test.ts` (`skipLivePg`) / the Prisma real suite un-ignore on `POSTGRES_URL`                                      |
| `database-plugin` net grant                         | `packages/database-plugin/deno.json:20`                                                                                      | `127.0.0.1:5433` (the local M79 Postgres port), not 5432                                                                                                                                                                                                                     |
| Cosmos has no entity discriminator                  | `packages/database-plugin/src/adapters/cosmos/cosmos-query.ts:295`, `:317`; `cosmos-mapping.ts:120`                          | a query is `SELECT … FROM c <where>` over the whole CONTAINER; the container defaults to the entity name, so two entities mapped to one container read each other's documents                                                                                                |
| DynamoDB sort-key comparisons                       | `packages/database-plugin/src/adapters/dynamo/dynamo-access-path.ts:236-265`                                                 | with the partition equality present, an `eq`/`gt`/`gte`/`lt`/`lte` comparison on the path's sort key is folded into `KeyConditionExpression` — a `position > lastSeen` keyset runs as a key condition on the GSI                                                             |
| Id-less `parentContext` falls back to ambient       | `packages/telemetry-plugin/src/tracing/tracer.ts:320-342`                                                                    | the parent is built only when `traceId && spanId`; otherwise `startSpan` gets no context and OTel uses the ACTIVE span — so a sweep run inside a request parents to that request                                                                                             |
| `publishIntegrationEvent` honours a caller dedup id | `packages/messaging-plugin/src/integration/publish.ts:89`                                                                    | `deduplicationId: validated.deduplicationId ?? envelope.id`                                                                                                                                                                                                                  |
| Scheduler losers record `contended`                 | `packages/scheduler-plugin/src/services/scheduler-service.ts:582`, `:677-701`                                                | under a shared lock only the slot winner runs the handler; every other replica's fire is `contended` and runs nothing                                                                                                                                                        |
| MongoDB standalone, real driver (measured)          | throwaway `mongo:8` standalone, `npm:mongodb@^6`, 2026-10-08                                                                 | `hello.setName` is `undefined`; `session.startTransaction()` does NOT throw; the first operation inside it — `insertOne` and `find` alike — rejects `MongoServerError` code `20` `IllegalOperation` "Transaction numbers are only allowed on a replica set member or mongos" |
| `MongoTransactionUnavailableError` wrapping         | `packages/database-plugin/src/adapters/mongo/mongo-adapter.ts:238-249`                                                       | wraps a throw from `startTransaction()`, which the real driver never raises (measured above) — so on a standalone server the refusal surfaces later, unwrapped (pre-existing; §9)                                                                                            |
| `IUnitOfWork` satisfies a minimal write scope       | measured: `deno check` of a scratch probe (2026-10-08)                                                                       | `const s: { getRepository(e: string): { create(d: Readonly<Record<string, unknown>>): Promise<unknown> } } = uow` type-checks for `database-plugin`'s `IUnitOfWork`, inside `db.transaction(...)` too                                                                        |

**Measurement: the watermark trap on real PostgreSQL 16 (2026-10-08, M107).** A throwaway
`postgres:16-alpine`; table
`outbox(seq bigserial, id text, created_at timestamptz default
clock_timestamp(), status text default 'pending')`.
Transaction A inserts `A` (seq 1, earlier `created_at`) and stays open; B inserts `B` (seq 2) and
commits; a relay tick reads `[B]` and marks it sent; A commits. Second tick:

| Relay strategy                       | Second tick published                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| watermark `seq > 2`                  | `[]` — **A is never published**                                                                |
| watermark `created_at > <last seen>` | `[B]` — A skipped, and B re-read (the JS watermark is millisecond-truncated, the column is µs) |
| pending set `status = 'pending'`     | `[A]` — correct                                                                                |

The same run shows the limit §3.13 states: A's `created_at` precedes B's, yet B was published first,
because B committed first. A pending-set relay orders only the rows it can see.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                            | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                            | Doc deliverable (same PR)                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M107 says `messaging-plugin` "reaches the database structurally the way `multi-tenancy-plugin` does". Source (§1): multi-tenancy reaches it through a port in `common` and a bridge in `database-plugin`, never by resolving `CAPABILITIES.DATABASE` itself | Source. Follow the real precedent (§3.1)                                                                                                                                                                                                                                                                                                                                                                                                            | ROADMAP M107 placement paragraph corrected; package list gains `database-plugin`, `telemetry-plugin` and `cli` |
| C2 | ROADMAP M107 lists `cloudflare-plugin` for the Workers relay                                                                                                                                                                                                        | No `cloudflare-plugin` source changes: `WorkersCron` calls `outbox.sweep()`, `waitUntil` is the outbox's `background` hook, and D1 is reached through the bridge as a `'custom'` adapter (§3.12)                                                                                                                                                                                                                                                    | ROADMAP M107 package list corrected; `apps/cloudflare` carries the Workers example                             |
| C3 | ROADMAP M107: "Column isolation is one table with the tenant in the row and in the headers"                                                                                                                                                                         | Row only. A tenant header would ride the framework channel (callers may not use the reserved `x-setu-` prefix), which custom brokers drop (§1), and a delivered header is a hint a consumer may never authorize on (M106 §3.9). An event that needs its tenant carries it in the payload                                                                                                                                                            | ROADMAP M107 tenancy bullet corrected                                                                          |
| C4 | ROADMAP M107: Bigtable "is refused by name, pointing at the CDC follow-up" — implied at the write                                                                                                                                                                   | Refused at STARTUP by the bridge (§3.4): the relay query cannot run on Bigtable (`bigtable-scan.ts:110-127`)                                                                                                                                                                                                                                                                                                                                        | Bridge JSDoc, README, PUBLIC_API                                                                               |
| C5 | ROADMAP M107: "Cosmos only when the row shares the business partition key"                                                                                                                                                                                          | Sharpened from source: the outbox entity must map to the business CONTAINER (`cosmos-transaction.ts:58-63`), its partition-key path must be a column the row carries (`tenantId` or `orderingKey`), and — because Cosmos queries the whole container (`cosmos-query.ts:295`) — every outbox read carries the discriminator (§3.2)                                                                                                                   | Per-backend table in README + PUBLIC_API                                                                       |
| C6 | ROADMAP M107 promises "per aggregate in order"                                                                                                                                                                                                                      | Measured (§1): a pending-set relay cannot order a row whose transaction commits after a later row of the same key was published; across replicas `position` follows each writer's clock (§3.2)                                                                                                                                                                                                                                                      | ROADMAP M107 promise sentence corrected; README states it with the measurement                                 |
| C7 | `ITelemetryService.withSpan` JSDoc names a `parentSpan` option (`common/src/services/telemetry.ts:177`); the option is `parentContext` (`:55`)                                                                                                                      | Source                                                                                                                                                                                                                                                                                                                                                                                                                                              | JSDoc corrected in `common`                                                                                    |
| C8 | `test/apps-gate.test.ts:627-646` (M101a §3.8) pins `POSTGRES_URL` ABSENT from `ci.yml` and `release.yml` with a substring match, while this milestone adds a PostgreSQL service                                                                                     | Both hold: the database-plugin live-Postgres cells stay local-only (they need a generated Prisma client and the `:5433` grant), and the outbox suite uses a DISTINCT variable, `OUTBOX_POSTGRES_URL`. The pin is amended from `not.toContain('POSTGRES_URL')` to `not.toMatch(/(?<![A-Z_])POSTGRES_URL/)`, which still refuses the bare name and admits the prefixed one, and gains a positive pin for `OUTBOX_POSTGRES_URL` in all three workflows | The amended assertion and its comment, naming M107                                                             |
| C9 | `mongo-adapter.ts:226-231` documents that a standalone server "fails here", at `beginTransaction`; measured (§1), the real driver fails at the first operation inside the transaction, unwrapped                                                                    | Measurement                                                                                                                                                                                                                                                                                                                                                                                                                                         | JSDoc corrected to describe where the refusal surfaces; the behaviour fix is named in §9 for a `fix/…` branch  |

## 3. Design decisions

### 3.1 Placement and the database seam

- **Decision:** the outbox lives in `messaging-plugin` as an `outbox` arm of
  `MessagingCommonOptions` and an `IOutbox` service registered under `CAPABILITIES.OUTBOX`
  (`outbox`, or `outbox.<name>` for a named messaging instance). It never resolves
  `CAPABILITIES.DATABASE`. The database is reached through a port:
  - `common` gains `IOutboxStore` and its types (`common/src/services/outbox.ts`, §3.3) and the
    token.
  - `database-plugin` ships `createDatabaseOutboxStore(options?)`, a `RegistryFactory<IOutboxStore>`
    over `IDatabaseService` — the M101c `createDatabaseTenantDataStore` shape.
  - `IOutboxWriteScope` is the one-method slice of a unit of work the write needs
    (`getRepository(entity).create(data)`); `database-plugin`'s `IUnitOfWork` satisfies it
    structurally (measured, §1).
- **Why:**
  - Inside `messaging-plugin` because it owns the envelope (`createEnvelope` is internal), the
    ordering-key and deduplication precedence, the composed broker and the integration contract; a
    separate `outbox-plugin` would re-derive the precedence and duplicate `publishIntegrationEvent`
    (§11.1).
  - A port, not a structural cast of `CAPABILITIES.DATABASE`: CLAUDE.md binds a token to its
    documented interface, and two shipped plugins already chose not to resolve the database token
    from outside (`audit-plugin`'s inject-only `IAuditDbClient`, M26; the M101c bridge). The port is
    also where backend knowledge belongs: the column mapping, the discriminator and the per-adapter
    refusals live in the one package that knows the adapters.
  - In `common` because `database-plugin` must implement it by name and §2.2 forbids it importing
    `messaging-plugin`.
- **Test home:** `packages/common/test/unit/outbox-contract.test.ts` (type-level: `IUnitOfWork`
  assigns to `IOutboxWriteScope`); the three barrel tests (§6).

### 3.2 The outbox row, the discriminator and `position`

- **Decision:** one record shape, `OutboxRecord` in `common`, every field a JSON scalar:

  | Field         | Type                                             | Meaning                                                                                                |
  | ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
  | `id`          | `string`                                         | the ENVELOPE id — primary key                                                                          |
  | `kind`        | `'setu-outbox'`                                  | the discriminator: written on every row, required by every read (below)                                |
  | `topic`       | `string`                                         | the definition's topic                                                                                 |
  | `envelope`    | `string`                                         | `JSON.stringify(envelope)`, built at write time                                                        |
  | `options`     | `string`                                         | `JSON.stringify` of the EFFECTIVE publish options `{ orderingKey?, deduplicationId, headers? }` (§3.5) |
  | `orderingKey` | `string` (absent when none)                      | the effective key, duplicated out of `options` because the relay blocks on it                          |
  | `tenantId`    | `string` (absent when none)                      | the tenant the writer named (§3.10)                                                                    |
  | `traceparent` | `string` (absent when none)                      | the trace active at write (§3.9)                                                                       |
  | `position`    | `string`                                         | the ONE ordering column (below)                                                                        |
  | `createdAt`   | `number`                                         | `runtime.now()` at write — the real time, used for age                                                 |
  | `status`      | `'pending' \| 'sent' \| 'failed' \| 'discarded'` | lifecycle (§3.7)                                                                                       |
  | `attempts`    | `number`                                         | publish attempts recorded                                                                              |
  | `availableAt` | `number`                                         | epoch ms before which the relay must not retry                                                         |
  | `lastError`   | `string` (absent when none)                      | `describeError(error)` cut to 1024 characters                                                          |
  | `settledAt`   | `number` (absent until `sent`/`discarded`)       | epoch ms; the retention clock (§3.14)                                                                  |
  | `sentBy`      | `string` (absent until sent)                     | `<relay instance id>/<scheduled \| dispatch>` (§3.8)                                                   |

  - **The discriminator is one rule on every backend.** The bridge writes `kind: 'setu-outbox'` on
    `append` and adds `kind` to the `where` of EVERY read it issues (`scanPending`, `failedKeys`,
    `stats`, `purge`); a lookup by id (`findById` before a transition) treats a row whose `kind`
    differs as missing. A business document that happens to carry `status: 'pending'` or `'sent'` in
    a shared container is therefore never read, counted, transitioned or deleted. M108's inbox
    inherits the same hazard and the same rule; the ROADMAP M108 section gains that sentence.
  - **`aggregateId` and `aggregateVersion` travel inside `envelope`**, not as columns: the relay
    never reads them, and the consumer's ordering correction reads the delivered envelope.
  - **`position`** is `<ms, 15 decimal digits><id, 32 lowercase hex>` with no separators, where `ms`
    is clamped per `IOutbox` instance to `max(runtime.now(), last + 1)` and `id` is the envelope id
    with its hyphens removed. No separator, fixed widths and one character class per segment, so a
    collation that ignores punctuation (PostgreSQL under a non-`C` locale) orders it like a byte
    comparison; the ordering column and the keyset comparison (§3.6) always use the same collation,
    so they agree with each other on every backend.
  - **`blockKey`** is `JSON.stringify([tenantId ?? null, orderingKey])`, so no tenant or key value
    can contain a separator that makes two pairs collide.
- **Why:**
  - Numbers, not `Date`: D1 refuses a `Date` in an ordered comparison (`d1-sql.ts:136-147`), the
    memory evaluator compares a `Date` with a number as `false` (`query-builder.ts:199-205`), and
    DynamoDB needs a declared encoding for one.
  - One ordering column because DynamoDB orders by exactly one attribute
    (`dynamo-access-path.ts:349`).
  - The clamp keeps two writes in one transaction in write order even within one millisecond, and
    keeps one instance's positions monotonic across an NTP step back. It does not make positions
    monotonic ACROSS instances: each writer's clock decides, and §3.13 says so. Under a sustained
    write rate above 1000 per second per instance the clamped `ms` runs ahead of wall time; that
    affects ordering only, not `createdAt`, which stays the real time.
  - The discriminator is required because Cosmos queries the whole container with no entity
    predicate (`cosmos-query.ts:295`, `:317`), and the container defaults to — or is mapped onto —
    the business container (`cosmos-mapping.ts:120`). Applying it everywhere keeps one rule and one
    implementation instead of a Cosmos special case.
- **Test home:** `packages/database-plugin/test/unit/outbox/outbox-columns.test.ts` (round trip,
  optionals absent, `kind` written);
  `packages/database-plugin/test/unit/outbox/outbox-discriminator.test.ts` (business documents with
  `status: 'pending'` and `'sent'` in the SAME entity as outbox rows are never returned by
  `scanPending`/`failedKeys`, never counted by `stats`, never transitioned, never purged — memory
  adapter, and the Cosmos-shaped case on the local Cosmos emulator, §6);
  `packages/messaging-plugin/test/unit/outbox/position.test.ts` (fixed width; same-millisecond
  writes keep order; a backwards clock step keeps positions increasing; blockKey collisions refused
  for `["a|b", "c"]` against `["a", "b|c"]`-style pairs).

### 3.3 The `IOutboxStore` port — method table

`verify` IS on the port: every store, including a custom one, must be able to refuse at startup.
Every method returns a promise that REJECTS on failure, never throws synchronously.

| Method        | Signature                                                                                                | Behaviour                                                                                                                                                                                                                                                | Missing row / unexpected status                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `append`      | `(scope: IOutboxWriteScope, record: OutboxRecord) => Promise<void>`                                      | `scope.getRepository(entity).create(row)` inside the caller's transaction                                                                                                                                                                                | a duplicate id rejects with the adapter's `DuplicateKeyError`                            |
| `scanPending` | `(after: string \| undefined, limit: number) => Promise<readonly OutboxRecord[]>`                        | `where { kind, status: 'pending' }`, `filter position > after` when `after` is set, `orderBy { position: 'asc' }`, `limit`; NO `availableAt` filter (§3.6)                                                                                               | —                                                                                        |
| `failedKeys`  | `(limit: number) => Promise<readonly OutboxKey[]>`                                                       | `where { kind, status: 'failed' }`, `select ['tenantId', 'orderingKey']`, `limit` — never reads envelopes. Called only at LAP START (§3.6)                                                                                                               | —                                                                                        |
| `markSent`    | `(id, { settledAt, sentBy, deleteNow }) => Promise<OutboxTransition>`                                    | `findById` → if `kind` ok and `status === 'pending'`: `update` to `sent` (or `delete` when `deleteNow`) and answer `{ outcome: 'applied' }`                                                                                                              | `{ outcome: 'missing' }`; `{ outcome: 'not-pending', status, sentBy }` — nothing written |
| `markFailure` | `(id, { attempts, lastError, availableAt, status: 'pending' \| 'failed' }) => Promise<OutboxTransition>` | same read; writes only from `pending`                                                                                                                                                                                                                    | as `markSent` — a late failure can never regress `sent`                                  |
| `release`     | `(id, action: 'retry' \| 'discard', now) => Promise<OutboxTransition>`                                   | read; writes only from `failed`: `retry` → `pending`, `attempts: 0`, `availableAt: now`; `discard` → `discarded`, `settledAt: now`                                                                                                                       | `missing` / `{ outcome: 'not-failed', status }`                                          |
| `stats`       | `() => Promise<OutboxStoreStats>`                                                                        | `count({ kind, status: 'pending' })`, `count({ kind, status: 'failed' })`, oldest pending `createdAt` by `scanPending(undefined, 1)`                                                                                                                     | —                                                                                        |
| `purge`       | `(before: number, limit: number) => Promise<number>`                                                     | for `status` in `sent`, then `discarded` (one equality query each): `where { kind, status }`, `filter settledAt < before`, `select ['id']`, `limit`; then `delete` each by id; returns rows deleted. Called on its own interval, never per sweep (§3.14) | a row already gone counts zero                                                           |
| `verify`      | `() => Promise<void>`                                                                                    | §3.4                                                                                                                                                                                                                                                     | —                                                                                        |

- **Per implementation:**
  - **`database-plugin` bridge:** the table above, over `IDatabaseService`; the column mapping and
    discriminator are its own; adapter refusals become `OutboxStoreUnavailableError` (§3.4).
  - **A custom store:** must implement the same table, including "writes only from the expected
    status" and the discriminator semantics; the README states the contract and
    `outbox-store-contract.test.ts` exercises it against the bridge (an internal test helper, not an
    export — no consumer outside this repo's tests).
  - **Refused backends:** `verify` rejects; no other method is reached, because `onInit` runs
    `verify` before scheduling the relay or accepting a `write` (a `write` before `onInit` completes
    rejects `OutboxNotReadyError`).
- **What `IOutbox.release` calls:** it validates `tenantId` (§3.10), selects the store, and calls
  `store.release(id, action, runtime.now())`; a `not-failed` or `missing` outcome rejects
  `OutboxRowStateError` naming the outcome, never the row's contents. A release takes effect for the
  relay at the next LAP (§3.6): a lap in progress keeps the released key blocked.
- **Test home:** `packages/database-plugin/test/unit/outbox/outbox-store-ops.test.ts` (every row,
  every missing/unexpected-status branch); `outbox-store-contract.test.ts`.

### 3.4 Per-backend support and the startup check

- **Decision:** the bridge's `verify()` runs at `onInit` and performs, in order:
  1. The relay's first query, `scanPending(undefined, 1)`.
  2. A transactional probe that reads exactly what the relay reads:
     `transaction(uow => uow.getRepository(entity).findAll({ where: { kind, status: 'pending' },
     limit: 1 }))`.

  A rejection becomes `OutboxStoreUnavailableError` naming the entity, with the adapter error as
  `cause` and a reason from a fixed vocabulary:
  - `UnsupportedQueryFeatureError` with `adapter: 'bigtable'` → "Bigtable cannot serve an outbox (no
    secondary index); use a change-data-capture relay".
  - `UnsupportedQueryFeatureError` with `adapter: 'dynamodb'` and `feature: 'orderBy'` → names the
    required GSI `{ partitionKey: 'status', sortKey: 'position' }`.
  - An error whose cause chain carries `code === 20` and `codeName === 'IllegalOperation'` (the
    measured standalone-MongoDB refusal, §1) → "MongoDB transactions need a replica set". Detected
    from the driver error at step 2, because `hello` is not reachable through `IDatabaseService`
    (the bridge has no client handle) and `startTransaction()` does not fail on its own (§1).
  - Anything else → "the outbox entity is missing or unreadable".

  The DynamoDB GSI must use projection `ALL` (§3.14); a narrower projection is not detected by
  `verify()` and is a documented requirement.

  On a standalone MongoDB, `write` would reject inside the caller's transaction at its first
  operation with the same code-20 error — the startup refusal is what makes that unreachable.

  | Backend  | Same-transaction write                                                                                                     | Relay query                                                                                                                                        | Verdict                                                                                               |
  | -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | memory   | yes — overlay across entities (`memory-adapter.ts:396-438`)                                                                | in process                                                                                                                                         | supported (single process)                                                                            |
  | Prisma   | yes — one interactive `tx` (`prisma-adapter.ts:316-324`)                                                                   | native                                                                                                                                             | supported; table must exist (§3.14)                                                                   |
  | Drizzle  | yes — one interactive `tx` (`drizzle-adapter.ts:479-481`)                                                                  | native                                                                                                                                             | supported; `drizzleTables` must register the outbox table                                             |
  | MongoDB  | yes on a replica set (`mongo-data-source.ts:679-690`); standalone refused at the first in-transaction operation (measured) | native                                                                                                                                             | supported on a replica set; standalone refused at startup by name                                     |
  | DynamoDB | yes — one `TransactWriteItems`, ≤100 writes INCLUDING outbox rows                                                          | only through a GSI `{ partitionKey: 'status', sortKey: 'position' }`; `position > after` becomes a key condition (`dynamo-access-path.ts:236-265`) | supported with that GSI; refused at startup without it                                                |
  | Cosmos   | only when the outbox entity maps to the business container and partition                                                   | native, cross-partition, discriminated by `kind`                                                                                                   | supported in that mapping; a mismatch is the adapter's own `CosmosTransactionScopeError` at the write |
  | Bigtable | no — one row per transaction (`bigtable-transaction.ts:166`)                                                               | refused (`bigtable-scan.ts:110-127`)                                                                                                               | refused at startup by name                                                                            |
  | D1       | yes — one `db.batch()` across tables (`d1-adapter.ts:229-240`)                                                             | native SQLite                                                                                                                                      | supported; table must exist                                                                           |

  On memory and MongoDB a missing entity cannot be detected (both create lazily), so step 1 passes
  there by construction — stated, not hidden.
- **Why:** the relay query and the transaction are the two operations that differ per backend, so
  running each once at startup turns an unusable backend into a named startup failure instead of a
  relay that fails every tick (the M52c binding-guard shape).
- **Test home:** `packages/database-plugin/test/unit/outbox/outbox-verify.test.ts` (each reason with
  a fake rejecting the adapter's real error class, and a fake MongoDB error shaped as measured);
  `outbox-backends-real.test.ts` (§6).

### 3.5 The atomic write, and one rule for the deduplication id

- **Decision:** `IOutbox.write(scope, definition, payload, input?)` with
  `input = { metadata?, options?, tenantId? }`, returning `Promise<string>` (the envelope id):
  1. Build the envelope and the EFFECTIVE options through ONE internal
     `prepareIntegrationPublish(runtime, definition, payload, metadata, options)`, extracted from
     `publishIntegrationEvent`, which now calls it too. It validates the caller's options (copy
     once), applies the ordering precedence (caller key > selector > none) and the deduplication
     rule `caller's deduplicationId ?? envelope.id` (`publish.ts:89`), and validates the result. The
     outbox stores exactly that effective object, so a caller's `deduplicationId` reaches the broker
     through the outbox exactly as through `publishIntegrationEvent`.
  2. Serialize; refuse with `OutboxEnvelopeTooLargeError` when the UTF-8 byte length exceeds
     `maxEnvelopeBytes` (default 262 144), before any write.
  3. Capture `traceparent` from `telemetry?.activeSpanContext?.()` through `contextToTraceparent`
     (absent when telemetry or its accessor is absent, or the result is `null`).
  4. Validate `tenantId` with the M106 id rule (`publishIdProblem`) when present.
  5. Select the store for `tenantId` (§3.10) and call `store.append(scope, record)`.

  Every refusal is a REJECTED promise (the method is `async`). A refusal propagates to the caller's
  `transaction(...)` callback, so the business write rolls back with it.
- **Why:** the envelope id is fixed at write time because it is the deduplication id every re-send
  carries; refusing an oversized envelope inside the transaction is the only point at which refusal
  prevents an unsendable committed row. Two entry points with one precedence implementation is the
  CLAUDE.md "one capability, one implementation" rule. 256 KiB is the Service Bus Standard ceiling
  from documentation, not measured, and is an option.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/outbox-write.test.ts`;
  `packages/messaging-plugin/test/unit/outbox/precedence-parity.test.ts` — drives
  `publishIntegrationEvent` and `write` + `sweep` under a NON-default caller `deduplicationId` and a
  non-default selector and asserts the identical options reach the broker; the existing
  `integration/publish.test.ts` passes unchanged after the extraction.

### 3.6 The sweep: a lap over the pending set, keyset-paged, with two row budgets

- **Decision:** the relay walks the pending set in LAPS. A lap is per store and per `IOutbox`
  instance, and its state is `{ cursor, blocked: Set<blockKey>, capReached }`, kept in memory across
  sweeps until the lap ends.
  1. **Lap start** (no lap in progress): `failedKeys(maxFailedScan)` (default 1000) runs — ONLY
     here, never mid-lap. Its keys seed `blocked`. When it returns exactly `maxFailedScan` keys, the
     set may be incomplete and `capReached` is set for the whole lap. `cursor` starts undefined.
  2. **Each sweep** pages with `scanPending(cursor, pageSize)` (default 100) and examines rows ONE
     AT A TIME, in `position` order, while three budgets last: `scanned < scanLimit` (default 1000),
     `published < publishLimit` (default 100), and the sweep deadline (§3.8). After each examined
     row `cursor = row.position` — the cursor never jumps to the page's last row, so a budget that
     stops the sweep mid-page leaves the cursor on the last row actually examined, and the next
     sweep resumes at the first unexamined one. Per row, for a KEYED row (`orderingKey` present):
     - its key is in `blocked` → skipped;
     - `capReached` → skipped AND its key added to `blocked`;
     - `availableAt > now` → skipped AND its key added to `blocked`;
     - otherwise decoded and published (§3.7).

     An UNKEYED row is never blocked: it is published unless in backoff, which skips only that row.
     Every skip counts toward `scanned` only. The query never filters by `availableAt`: doing so
     would hide an earlier row in backoff and let a later row of the same key overtake it.
  3. **Blocked-set cap (N6):** `blocked` holds at most 10 000 keys. An insertion that would exceed
     it sets `capReached` instead, so every further keyed row of the lap is skipped — the same
     mechanism as step 1, and the same fail-safe: an incomplete blocked set never publishes a keyed
     row.
  4. **A rejected store write ends the sweep** (§3.7) with the row's key added to `blocked`; the lap
     resumes at the next sweep from that row's position.
  5. **Lap end:** a page shorter than requested means every pending row has been examined. The lap
     state is discarded and the NEXT sweep starts a new lap (step 1), re-seeding from the store.
- **Why:**
  - Not a watermark (§1): the lap wraps, so every pending row is examined every lap and a row that
    commits behind the cursor is read at the next lap.
  - Separate scan and publish budgets let a blocked key with any number of later rows cost scan
    budget, never publish budget; carrying the lap across sweeps lets the scan move past them, so an
    unblocked key behind them is reached within `ceil(rowsAhead / scanLimit) + 1` sweeps.
  - Seeding only at lap start, and persisting `blocked` and `capReached` with the cursor, is what
    makes a resumed sweep safe: every row before the cursor was examined in THIS lap, so any key
    that must stay blocked is already in `blocked`. Re-seeding mid-lap would REMOVE keys whose
    blocking row was released or published meanwhile while their later rows remain behind the cursor
    — the reorder N1 found.
  - A cap-skip must block its key for the same reason a backoff skip does: a later row of that key
    may follow inside the lap.
  - A `release` mid-lap changes nothing until the next lap: the released key stays in `blocked`, so
    the released row and the key's later rows publish together, in `position` order, from the next
    lap's start.
  - The lap state is per instance and in memory. Under a shared lock the next sweep may run on
    another replica with its own lap; each lap is internally consistent, so this delays but never
    reorders (a stale blocked set only blocks more). A restart starts a new lap.
  - `position > after` is a portable `gt` on a string; on DynamoDB it folds into the GSI key
    condition (`dynamo-access-path.ts:236-265`), so paging does not rescan.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/relay-paging.test.ts`:
  - a poisoned key with `pageSize × 3` later rows ahead of an unblocked key — the unblocked key
    publishes in the first sweep when `scanLimit` covers them, and within the bounded number of
    sweeps when it does not;
  - `publishLimit` stops the sweep MID-PAGE — the cursor sits on the last examined row, and the next
    sweep publishes the following row and skips nothing;
  - a `release` mid-lap — the key stays blocked for the rest of the lap;
  - a sweep resumed after that release does not publish the key's later row before its released
    earlier row (the N1 reorder, as a negative control: re-seeding `failedKeys` mid-lap makes this
    case fail);
  - a cap-skip blocks its key; the 10 000-key blocked-set cap sets `capReached`;
  - backoff rows are not overtaken;
  - the lap wraps and re-reads a row committed behind the cursor.

  `outbox-backends-real.test.ts` drives the `position > after` page on DynamoDB Local.

### 3.7 Conditional transitions, retries, poison rows and rejected store writes

- **Decision:**
  - Every transition (`markSent`, `markFailure`, `release`) reads the row and writes only from the
    expected status (§3.3). A failure recorded after another relay marked the row `sent` writes
    nothing. **Residual window:** between the read and the write another relay can change the row;
    the worst outcome is one status overwritten by a stale write — a `sent` row returned to
    `pending` and published again (a duplicate, never a loss). It closes when M105's `updateWhere`
    makes the transition one conditional statement.
  - A publish failure sets `attempts + 1`, `lastError`, and
    `availableAt = now + min(baseBackoffMs × 2^(attempts − 1), maxBackoffMs)` (defaults 1000 and 300
    000), and blocks the key for the lap; at `maxAttempts` (default 10) the row becomes `failed` and
    blocks its key until `release`.
  - **A rejected store write ends the sweep.** If `markSent`, `markFailure` (or any other store call
    of the sweep) rejects or times out, the row's key is added to `blocked` and the sweep returns.
    In particular, a `markSent` rejection AFTER a successful publish blocks the key, so no later row
    of that key is published before the next lap re-reads the still-`pending` row — which it then
    publishes again, a duplicate within the stated promise (§3.13). A rejected `markFailure` records
    no attempt; the row is retried at the next lap, so a failing store bounds the retry rate to one
    attempt per row per lap rather than letting it spin. There is no in-memory retry map.
  - **Shutdown:** once the outbox is closing (§3.8), a publish or store failure writes nothing — no
    attempt is counted against `maxAttempts` for a failure caused by the application stopping.
  - A row that cannot be decoded is `failed` at once with `lastError: 'invalid-row'`, poisoning its
    key: `envelope` is not JSON or exceeds `maxEnvelopeBytes`; its `id` differs from the row id;
    `options` fail `validatePublishOptions`; `options.orderingKey` differs from the row's
    `orderingKey` column (the column decides blocking and the options decide placement, so a
    disagreement would order by one key and place by another); or `topic` is empty, over 255 UTF-8
    bytes, or contains a Cc/Cf/Zl/Zp character (`hasForbiddenAliasCharacter`).
  - `IOutbox.release(id, action, { tenantId? })` is the operator path (§3.3).
- **Why:** a failed row BLOCKS its key because skipping it would publish later events of the same
  key first — silently. A blocked key is loud (health, metrics) and has an explicit unblock. Ending
  the sweep on a rejected store write is the simplest rule that keeps the blocked set truthful: the
  sweep cannot know the row's real status, and the store is probably failing for the next row too.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/relay-blocking.test.ts` (each rule,
  each `invalid-row` cause including a bad stored topic and an `orderingKey` mismatch);
  `packages/messaging-plugin/test/unit/outbox/relay-store-failure.test.ts` (a `markSent` rejecting
  after publish blocks the key, ends the sweep, and the next lap republishes that row before the
  key's later row; a rejecting `markFailure` records nothing and the row is retried next lap, once);
  `packages/messaging-plugin/test/integration/outbox-overlap.test.ts` (two overlapping sweeps: a
  late failure write after the other sweep's `markSent` leaves the row `sent`);
  `packages/messaging-plugin/test/unit/outbox/outbox-release.test.ts`.

### 3.8 One relay: the scheduler lock, one sweep deadline, overlap detection, shutdown

- **Decision:**
  - `outbox.relay.schedule` (default `true`) registers
    `scheduler.every('outbox-relay[.<name>]', intervalMs, () => sweep('scheduled'))` at `onInit`
    (`intervalMs` default 1000). With no `CAPABILITIES.SCHEDULER`, startup rejects with
    `OutboxRelayUnscheduledError`, naming `SchedulerPlugin` and `relay: { schedule: false }` with a
    Cron Trigger. `CAPABILITIES.SCHEDULER` joins `optionalDependencies` for ordering.
  - All sweeps in one process go through one single-flight: a sweep requested while one runs gets
    the running sweep's promise, and a `dispatch` marks one follow-up.
  - **One deadline bounds the entire sweep**: `sweepDeadlineMs` (default 15 000), measured on
    `hrtime` from the sweep's start and covering `failedKeys`, every page, every publish, every
    status write — and nothing else, because `purge` runs on its own schedule (§3.14). Every awaited
    call goes through `withDeadline` with `min(perCallBound, remaining)`, where the per-call bounds
    are `publishTimeoutMs` and `storeTimeoutMs` (defaults 5000 each). The sweep starts a new row
    only while `remaining ≥ publishTimeoutMs + storeTimeoutMs`, so a row it starts can finish its
    publish and its status write. An expired call is a failure (§3.7); the sweep then ends.
  - **Worst case, stated:** a sweep holds the scheduler's handler mutex for at most
    `sweepDeadlineMs` = 15 000 ms, against the default `distributedLock.ttlMs` of 30 000 — a 15 000
    ms margin. A call abandoned at the deadline may still complete afterwards (a late publish is a
    duplicate; a late status write is a transition the next lap's read sees). The plan's previous
    arithmetic was wrong: `10 000 + 5000 + 2 × 5000` is 25 000, not "below 20 000".
  - **README rule:** keep `sweepDeadlineMs ≤ distributedLock.ttlMs − 10 000` (the margin absorbs the
    lock release round trip and timer lateness). Raising `ttlMs` permits a larger `sweepDeadlineMs`;
    raising `sweepDeadlineMs` requires raising `ttlMs` with it; the per-call bounds must stay below
    `sweepDeadlineMs` or no row ever starts. The plugin cannot read `ttlMs` (`IScheduler` exposes no
    lock, §1), so it validates only the relation among its own options: construction refuses
    `publishTimeoutMs + storeTimeoutMs > sweepDeadlineMs`.
  - **The plugin cannot tell whether the scheduler's lock is shared** — `IScheduler` has no accessor
    and the mutex is `MemoryLock` unless configured. It does not refuse; it DETECTS: a `markSent`
    answering `not-pending` with `status: 'sent'` and a `sentBy` of ANOTHER instance is an overlap.
    Two `scheduled` sweeps overlapping is evidence of a non-shared lock (a per-instance health
    signal, §3.11); an overlap involving a `dispatch` sweep (§3.12) is expected and only counted; a
    `sentBy` of THIS instance is a stale read, counted separately.
  - **`retainSentMs: 0` disables overlap detection**: a row deleted at mark-sent answers `missing`,
    which cannot be told apart from an operator's delete.
  - **On DynamoDB a stale GSI read can report a false overlap**: replica B's sweep can read a row
    replica A has just marked `sent` as `pending` (GSI reads are eventually consistent), publish it
    again, and find it `sent` by A. Documented; unverified (§12).
  - **Shutdown (m-d).** The kernel runs `onStopping`, closes the server, runs `onShutdown` hooks
    (last registered first), THEN `onClose` hooks in registration order (`application.ts:900-912`,
    `lifecycle-manager.ts:195-225`). The broker's close hook is an `onClose` registered in
    `MessagingPlugin.register()` (`messaging-plugin.ts:439-441`), and `DatabasePlugin`'s disconnect
    is an `onClose` too. So the outbox drains in an `onShutdown` hook, which runs before ANY close
    hook whatever the plugin order: it calls `scheduler.remove('outbox-relay[.<name>]')`, makes
    `dispatch()` a no-op, sets `closing`, and awaits the in-flight sweep up to its own deadline. An
    `onClose` hook repeats the same steps idempotently, because a FAILED start runs close hooks only
    (`application.ts:540`). Because draining is phase-ordered, the outbox declares no ordering
    dependency on `DatabasePlugin` (the store may also be custom) beyond resolving the store at
    `onInit`, when every plugin has registered.
- **Why:** refusing a non-shared lock needs information the contract does not carry, and a flag the
  plugin cannot check would be a claim, not a control. One deadline is the only bound that holds
  regardless of how the work inside the sweep is split.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/relay-budget.test.ts` (the deadline
  ends a sweep with a hung `failedKeys`, a hung publish and a hung status write — each asserting the
  call is still pending before advancing the fake clock; no row starts below the reserve; the
  single-flight; the option relation refused at construction);
  `packages/messaging-plugin/test/integration/outbox-overlap.test.ts` (two apps over one memory
  store with process-local schedulers — overlap detected; a `dispatch` overlap counted only;
  `retainSentMs: 0` reports no overlap);
  `packages/messaging-plugin/test/integration/outbox-plugin.test.ts` (`app.stop()` during a sweep:
  the sweep finishes before the broker's and the database's close hooks run, observed through
  recording fakes; the job is removed; a `dispatch()` after stop does nothing; a publish rejected
  after `closing` writes no attempt; a failed start runs the close-hook path).

### 3.9 Trace re-parenting, and a clean context for rows without a valid one

- **Decision:**
  - The relay publishes each row inside `telemetry.withSpan('outbox relay <topic>', publish, opts)`
    when telemetry is registered. **The rule:** a stored `traceparent` that
    `parseTraceparentToContext` turns into a context with BOTH ids is used as
    `{ kind: 'internal', parentContext }`; ANYTHING else — absent, malformed, or edited into an
    invalid value — gives `{ kind: 'internal', root:
    true }`. `TracedBroker` opens its producer
    span under the active relay span (`traced-broker.ts:56-73`) and injects its `traceparent`.
  - `common` gains an optional `SpanOptions.root?: boolean`. Its JSDoc states that an
    `ITelemetryService` implementation that ignores it starts the span under the ACTIVE span.
  - `telemetry-plugin`:
    - `TelemetryService.withSpan` builds the host options field by field
      (`telemetry-service.ts:146-160`) and would drop `root`; it gains the field.
    - The `TracerHost.startSpan` options type gains `root?`.
    - `tracer.ts` passes it through to OTel's own `SpanOptions.root` ("The new span should be a root
      span. (Ignore parent from context)", `@opentelemetry/api` 1.9.1
      `build/src/trace/SpanOptions.d.ts:22-23`) and passes no parent context when it is set.
    - The noop host is NOT edited: it ignores options entirely.
- **Why:**
  - Without `parentContext` the producer span's parent is the scheduler tick — a detached trace.
  - Without `root`, an id-less `parentContext` falls back to the ACTIVE span (`tracer.ts:320-342`),
    so a sweep started by `dispatch()` from inside a request would parent every traceless row — or
    one whose stored value was edited (§10 A3) — to that unrelated request: a false edge in the
    trace graph. `root` is the minimal widening; it is optional, so no implementor breaks.
- **Limits, stated:** activation needs a registered context manager (`contextPropagation` on);
  without one the producer span is a root and the README says so. On a custom broker without
  `publishWithHeaders` (`WorkersBroker`) `TracedBroker`'s framework header is dropped (§1), so the
  consumer cannot continue the trace — named in §9.
- **Test home:**
  - `packages/telemetry-plugin/test/unit/telemetry-service-root.test.ts`:
    `withSpan(..., { root:
    true })` reaches the host's `startSpan` options (a recording host),
    and an omitted `root` does not appear.
  - `packages/telemetry-plugin/test/unit/span-root.test.ts`: with the real SDK, `root: true` yields
    a parentless span while another span is active, and omitting it keeps the parent.
  - `packages/messaging-plugin/test/integration/outbox-trace-real.test.ts` (real OTel API + SDK +
    `AsyncLocalStorageContextManager`, the `trace-continuity-real.test.ts` harness):
    - one traceId across server span → relay span → producer → consumer, with the parent chain
      asserted by exact ids and the `toBeDefined()` vacuity guard;
    - a clean-context redelivery of the recorded wire headers;
    - a traceless row, and a row whose stored `traceparent` was edited to an invalid value, each
      swept by `dispatch()` inside a request span, produce ROOT relay spans;
    - controls: without `parentContext` the trace splits in two, and without `root` the traceless
      row parents to the request.

### 3.10 Tenancy

- **Decision:**
  - **Column isolation:** one `store`; `write(..., { tenantId })` records the tenant in the row; the
    relay sweeps all tenants together; block keys include the tenant (§3.2).
  - **Database per tenant:** `stores: Readonly<Record<string, OutboxStoreEntry>>`, keyed by tenant
    id and supplied by the application (each typically
    `createDatabaseOutboxStore({ database: '<name>' })`, reading `database.<name>`). `write` and
    `release` take `tenantId`, select the store, and reject `OutboxUnknownTenantError` for a missing
    or unknown one. The relay sweeps the stores in rotating order within one budget. `store` and
    `stores` are a union: supplying both is a compile error.
  - **A store bound to another database than the caller's unit of work cannot be detected.**
    `IOutboxWriteScope` (and `IUnitOfWork`, §1) carries no database identity, so the row always
    lands in the database the scope is bound to. Whenever the SELECTED store reads a different
    database — a per-tenant `stores` entry for another tenant, or a
    `createDatabaseOutboxStore({ database })` naming a different `database.<name>` than the
    transaction's — the selected store's relay never sees the row: it is relayed under the wrong
    tenant label if that database has its own relay, and never relayed if it does not. This is a
    CALLER obligation stated in the `write` JSDoc and README for both forms, and an audit obligation
    (§10 D14, obligation 10).
  - The tenant is never a published header (C3).
- **Why:** no tenant catalog exists (M89c cut `tenantById`), so the list comes from the application;
  no ambient tenant exists outside a request, so the writer passes it.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/outbox-tenancy.test.ts`.

### 3.11 Health and metrics

- **Decision:**
  - Indicator `outbox` (`outbox.<name>`), registered once, reads `store.stats()` through
    `createCachedProbe` (TTL 5000, bound 2000). `down` when `stats()` does not answer; `degraded`
    with `data.reasons` drawn from a fixed vocabulary; else `up`. `data` carries counts, ages in ms
    and the last local sweep result — never a tenant id, ordering key, topic list or error text.

    | Reason                | Source                                                                                                                 | Scope                               |
    | --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
    | `oldest-pending-age`  | store: the oldest pending row is older than `degradedAfterMs` (default 60 000)                                         | cluster-wide — every replica agrees |
    | `failed-rows`         | store: failed count above zero                                                                                         | cluster-wide                        |
    | `failed-scan-cap`     | store: failed count ≥ `maxFailedScan`, so a lap's blocked set is incomplete                                            | cluster-wide                        |
    | `blocked-key-cap`     | this instance's current lap overflowed the 10 000-key blocked set (§3.6)                                               | per instance                        |
    | `store-write-failing` | this instance's most recent sweep ended on a rejected store write (§3.7); cleared by the next sweep that completes one | per instance                        |
    | `scheduled-overlap`   | this instance observed two `scheduled` sweeps overlapping inside `overlapWindowMs` (default 600 000) (§3.8)            | per instance                        |

    Staleness comes from the STORE. There is no per-instance "last sweep" rule: under a correct
    shared lock the replicas that lose the slot are `contended` and never sweep
    (`scheduler-service.ts:582`, `:677-701`), so such a rule would flap. The three per-instance
    reasons are labelled as such in the README: a replica that never sweeps reports none of them.
  - Optional `CAPABILITIES.METRICS` (joins `optionalDependencies`), an `OutboxCollector` on the M45b
    pattern: counters `outbox_published_total{topic}`, `outbox_publish_failures_total{topic}`,
    `outbox_poisoned_total{topic}`, `outbox_overlaps_total{origin}`; gauges `outbox_pending_rows`,
    `outbox_oldest_pending_seconds`. The `topic` label is taken only from a row that passed decode
    (§3.7) and is bounded: after 100 distinct values per instance, further topics are labelled
    `other`.
  - The new `ctx.health.register(` site is classified `live-state` in `docs/health-indicators.md`;
    `messaging-plugin`'s row in `packages/cli/src/utils/plugin-claims.ts` gains `outbox`; and
    `test/plugin-claims-gate.test.ts` changes structure (below).
  - **The claims gate (m-a).** `DERIVED_SITES` (`test/plugin-claims-gate.test.ts:37-46`) maps a
    package to ONE `{ expression, name }`, and its filter compares a site's argument with that one
    expression (`:109`). `messaging-plugin` already registers `token`; the outbox registers a second
    derived name. The map becomes `ReadonlyMap<string, readonly { expression; name }[]>`, the filter
    accepts a site whose argument matches ANY of its package's expressions, and the default-name
    check walks every entry. The matching becomes a pure function of `(sites, DERIVED_SITES)` so the
    gate's own failure path can be tested.
- **Why:** a stuck relay is otherwise silent, and the oldest pending row's age rises whatever the
  cause. Store-derived reasons are the ones a load balancer may act on, because every replica
  reports them identically. The label bound matters because a row's topic is editable by anyone with
  database write access (§10 A3).
- **Test home:** `packages/messaging-plugin/test/unit/outbox/outbox-health.test.ts` (each reason;
  `failed-scan-cap` from a store reporting exactly `maxFailedScan` failed rows; a replica that never
  sweeps stays `up` while the store's oldest row is young);
  `packages/messaging-plugin/test/unit/outbox/outbox-collector.test.ts` (label cap);
  `test/plugin-claims-gate.test.ts` (extended: a package with two derived sites passes, and a third,
  unaccounted derived name in the same package still fails the gate — a self-test over a synthetic
  site list, so the gate's own failure path is proven).

### 3.12 Latency: `dispatch`, and the Workers hybrid

- **Decision:**
  - `IOutbox.dispatch(): void` requests a sweep through the single-flight with origin `dispatch`.
    The application calls it after its `transaction(...)` resolves. It never throws; the promise is
    handed to the `background` hook (default: detached with a logged `catch`; on Workers,
    `waitUntil`). Traceless rows in that sweep get `root` spans (§3.9).
  - On Cloudflare Workers the application sets `relay: { schedule: false }`, passes
    `background: waitUntil`, and registers `cron.on('* * * * *', () => outbox.sweep())` on
    `WorkersCron`, plus a slower trigger calling `outbox.purge()` (§3.14). The outbox entity is a D1
    table through `DatabasePlugin({ type: 'custom', adapter: new D1Adapter(env.DB) })`; the broker
    is `WorkersBroker` through the `'custom'` arm.
- **Why:** a full sweep, not a publish of "the rows just written", keeps ordering, blocking and
  marking in one implementation (§11.1). Cron Triggers fire at most once a minute, so `dispatch` is
  what makes Workers latency acceptable, and the cron is what makes it reliable.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/outbox-dispatch.test.ts`;
  `apps/cloudflare` smoke on real workerd (`wrangler dev`).

### 3.13 The promise and the crash table

- **Decision:** README, `IOutbox` JSDoc and PUBLIC_API state exactly: at-least-once delivery of
  every committed row; per-ordering-key publish order among committed rows, provided rows of one key
  commit in the order they were written (serialize writes to one aggregate, as optimistic
  concurrency on `aggregateVersion` does) and, across replicas, provided the writers' clocks agree
  (`position` follows each writer's clock, clamped only per instance); delivery order as the broker
  gives it (M106 §3.8); consumers compare `aggregateVersion`. Never "exactly once".

  | Crash or fault point                               | Outcome                                                                                                                                 | Test (`outbox-crash.test.ts` unless named)                  |
  | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | before commit                                      | nothing written, nothing published                                                                                                      | "throw inside the transaction"                              |
  | after commit, before any sweep                     | the next sweep publishes it                                                                                                             | "app stopped after commit, new app sweeps"                  |
  | mid-batch (process stops after some publishes)     | marked rows stay sent; the published-but-unmarked row is published again by the new process's first lap; unreached rows follow in order | "stop after the second publish"                             |
  | after publish, before mark-sent (process stops)    | published again by the next lap, same envelope id                                                                                       | "markSent never runs"                                       |
  | `markSent` REJECTS after a successful publish      | key blocked, sweep ends; the next lap republishes that row before any later row of its key                                              | `relay-store-failure.test.ts`                               |
  | the failure write (`markFailure`) rejects          | no attempt recorded; sweep ends; the row is retried once at the next lap                                                                | `relay-store-failure.test.ts`                               |
  | publish times out, then the broker accepts it late | recorded as a failure, retried after backoff — the broker holds two copies with one deduplication id                                    | "late publish" (a fake broker resolving after the deadline) |
  | the application stops mid-sweep                    | the `onShutdown` drain awaits the sweep; a failure after `closing` records no attempt                                                   | `outbox-plugin.test.ts`                                     |
  | during purge                                       | rows deleted so far stay deleted; the rest are purged at the next purge interval                                                        | "purge rejects midway"                                      |
  | `markSent` on a row already purged or deleted      | `missing`; nothing written; counted, not an overlap                                                                                     | "markSent on a purged row"                                  |
  | after mark-sent                                    | nothing more                                                                                                                            | same file                                                   |

- **Why:** the measured limit (§1) is the honest boundary of a pending-set relay, and each row above
  is a real fault the relay meets.
- **Test home:** `packages/messaging-plugin/test/integration/outbox-crash.test.ts` (memory store and
  in-memory broker, faults injected by fakes that throw at a named call); repeated on real
  PostgreSQL + RabbitMQ and on Redis Streams in `outbox-real.test.ts`.

### 3.14 Provisioning and retention

- **Decision:**
  - No portable migration exists (`migrate()` always rejects, §1). The README ships DDL for
    PostgreSQL, MySQL and SQLite/D1 with two indexes — `(kind, status, position)` for the relay and
    `(kind, status, settledAt)` for the purge — a Prisma model, a Drizzle `pgTable`, the MongoDB
    indexes, the DynamoDB table + GSI and the Cosmos mapping. The PostgreSQL DDL is the fixture
    `packages/messaging-plugin/test/fixtures/outbox-postgres.sql` the real suite applies, and a test
    asserts the README contains it verbatim; the Drizzle table is compiled by the package-README
    fence gate.
  - **DynamoDB:** the GSI is `{ partitionKey: 'status', sortKey: 'position' }` with projection
    `ALL`, so `failedKeys`' `select` and every relay read are served from the index. The purge has
    no index on `settledAt`: it is a `status`-partition Query over that GSI with
    `settledAt < before` as a `FilterExpression`, which READS every `sent` (then `discarded`) item
    it passes over and bills for those reads, not for the rows it returns. `purgeBatch`
    (default 100) bounds the deletes per run, and `purgeIntervalMs` (default 60 000) bounds the
    reads; the README states the cost.
  - **Retention:** `purge(now − retainSentMs, purgeBatch)` runs on its own interval,
    `purgeIntervalMs`, never per sweep — through the scheduler (`outbox-purge[.<name>]`) when the
    relay is scheduled, and from the same Cron Trigger on Workers via `IOutbox.purge()`. It deletes
    `sent` AND `discarded` rows whose `settledAt` is older than `retainSentMs` (default 7 days).
    `retainSentMs: 0` deletes a row at mark-sent (and disables overlap detection, §3.8). `failed`
    rows are never purged: they block a key until an operator acts.
- **Why:** the startup check refuses a missing table by name; the template is the remedy it points
  at. Settled rows hold event payloads, which may be personal data. A purge per sweep would put an
  index-less scan inside the sweep deadline every second.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/outbox-retention.test.ts` (interval,
  not per sweep; `sent` and `discarded` purged, `failed` never; `retainSentMs: 0`);
  `packages/messaging-plugin/test/unit/outbox/readme-ddl.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Every addition is a new symbol or an optional member
(`MessagingCommonOptions.outbox`, `SpanOptions.root`, the matching optional field on the
`TracerHost.startSpan` options); no published interface gains a required member, and
`publishIntegrationEvent`'s behaviour is unchanged by the extraction (§3.5).

| Exported symbol                                                                                                                                             | Kind            | Consumer / real code path that READS it                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.OUTBOX` (`common`)                                                                                                                            | token           | `messaging-plugin` registers `IOutbox`; applications resolve it                                                                             |
| `IOutboxStore` (`common`)                                                                                                                                   | interface       | implemented by the `database-plugin` bridge; read by the `messaging-plugin` writer and relay                                                |
| `OutboxRecord`, `OutboxStatus`, `OutboxKey`, `OutboxTransition`, `OutboxStoreStats`, `OUTBOX_RECORD_KIND` (`common`)                                        | types / const   | the port's parameter and return types; `OUTBOX_RECORD_KIND` (`'setu-outbox'`) is written by the bridge and read by its discriminator filter |
| `IOutboxWriteScope` (`common`)                                                                                                                              | interface       | `IOutboxStore.append`'s scope parameter; satisfied by `IUnitOfWork`                                                                         |
| `SpanOptions.root` (`common`)                                                                                                                               | optional member | the relay (§3.9); implemented by `telemetry-plugin`                                                                                         |
| `createDatabaseOutboxStore` (`database-plugin`)                                                                                                             | function        | the application, in `MessagingPlugin({ outbox: { store } })`                                                                                |
| `DatabaseOutboxStoreOptions` (`database-plugin`)                                                                                                            | type            | its parameter                                                                                                                               |
| `OutboxStoreUnavailableError` (`database-plugin`)                                                                                                           | class           | thrown by `verify()`; applications `instanceof` it at startup                                                                               |
| `IOutbox` (`messaging-plugin`)                                                                                                                              | interface       | the type applications resolve `CAPABILITIES.OUTBOX` to                                                                                      |
| `OutboxOptions`, `OutboxRelayOptions`, `OutboxStoreEntry`, `OutboxWriteInput`, `OutboxSweepResult` (`messaging-plugin`)                                     | types           | the option arm, the `write` input and the `sweep` result                                                                                    |
| `OutboxEnvelopeTooLargeError`, `OutboxRelayUnscheduledError`, `OutboxUnknownTenantError`, `OutboxRowStateError`, `OutboxNotReadyError` (`messaging-plugin`) | classes         | thrown by `write`, startup, `write`/`release`, `release`, `write` before `onInit`; applications `instanceof` them                           |

### 4.1 Options — every option names its consumer

| Option                                                                | Consumer                        | Behavior (per implementation)                                                        |
| --------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `outbox.store` / `outbox.stores`                                      | writer, relay, health           | §3.10                                                                                |
| `outbox.maxEnvelopeBytes`                                             | `write`, relay decode           | §3.5, §3.7                                                                           |
| `outbox.background`                                                   | `dispatch`                      | §3.12                                                                                |
| `outbox.relay.schedule`, `intervalMs`                                 | `onInit` scheduling             | §3.8                                                                                 |
| `outbox.relay.pageSize`, `scanLimit`, `publishLimit`, `maxFailedScan` | the sweep                       | §3.6                                                                                 |
| `outbox.relay.maxAttempts`, `baseBackoffMs`, `maxBackoffMs`           | failure path                    | §3.7                                                                                 |
| `outbox.relay.sweepDeadlineMs`, `publishTimeoutMs`, `storeTimeoutMs`  | the sweep deadline              | §3.8; `publishTimeoutMs + storeTimeoutMs ≤ sweepDeadlineMs` enforced at construction |
| `outbox.health.degradedAfterMs`, `outbox.health.overlapWindowMs`      | health indicator                | §3.11                                                                                |
| `outbox.retainSentMs`, `purgeBatch`, `purgeIntervalMs`                | the purge job / `IOutbox.purge` | §3.14                                                                                |
| `createDatabaseOutboxStore({ entity, database })`                     | bridge                          | `entity` default `'Outbox'`; `database` selects `database.<name>`                    |

Every numeric option is validated at construction (a finite integer in range; `NaN` refused — the
M90a fail-open class), refusals naming the option.

## 5. Implementation files

| File                                                           | Purpose                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/outbox.ts`                       | port, record, scope, transition and stats types; `OUTBOX_RECORD_KIND`                                       |
| `packages/common/src/tokens.ts`                                | `OUTBOX` token                                                                                              |
| `packages/common/src/services/telemetry.ts`                    | `SpanOptions.root` and its JSDoc; C7 JSDoc fix                                                              |
| `packages/common/src/index.ts`                                 | barrel                                                                                                      |
| `packages/telemetry-plugin/src/services/telemetry-service.ts`  | `withSpan` forwards `root` to the host                                                                      |
| `packages/telemetry-plugin/src/interfaces/index.ts`            | optional `root` on the `TracerHost.startSpan` options                                                       |
| `packages/telemetry-plugin/src/tracing/tracer.ts`              | passes `root` to OTel's `SpanOptions.root` and no parent context                                            |
| `packages/database-plugin/src/outbox/database-outbox-store.ts` | the bridge (§3.3, §3.4)                                                                                     |
| `packages/database-plugin/src/outbox/errors.ts`                | `OutboxStoreUnavailableError`                                                                               |
| `packages/database-plugin/src/adapters/mongo/mongo-adapter.ts` | C9 JSDoc only                                                                                               |
| `packages/database-plugin/src/index.ts`                        | barrel                                                                                                      |
| `packages/messaging-plugin/src/integration/prepare.ts`         | internal `prepareIntegrationPublish`                                                                        |
| `packages/messaging-plugin/src/integration/publish.ts`         | calls `prepare.ts`                                                                                          |
| `packages/messaging-plugin/src/outbox/outbox-service.ts`       | `IOutbox`: `write`, `dispatch`, `sweep`, `purge`, `release`, single-flight, lap state, closing              |
| `packages/messaging-plugin/src/outbox/relay.ts`                | one sweep (§3.6, §3.7, §3.8)                                                                                |
| `packages/messaging-plugin/src/outbox/lap.ts`                  | lap state: cursor, blocked set with its 10 000-key cap, `capReached`                                        |
| `packages/messaging-plugin/src/outbox/position.ts`             | clamped `position`; `blockKey`                                                                              |
| `packages/messaging-plugin/src/outbox/record-codec.ts`         | encode at write; decode + `invalid-row` at relay                                                            |
| `packages/messaging-plugin/src/outbox/options.ts`              | option resolution and validation                                                                            |
| `packages/messaging-plugin/src/outbox/outbox-health.ts`        | indicator                                                                                                   |
| `packages/messaging-plugin/src/outbox/outbox-collector.ts`     | optional metrics, label cap                                                                                 |
| `packages/messaging-plugin/src/outbox/errors.ts`               | five error classes                                                                                          |
| `packages/messaging-plugin/src/interfaces/index.ts`            | `outbox` arm and types                                                                                      |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`     | wiring: register, `onInit` (store resolve, verify, schedule relay and purge), `onShutdown` drain, `onClose` |
| `packages/messaging-plugin/src/index.ts`                       | barrel                                                                                                      |
| `packages/cli/src/utils/plugin-claims.ts`                      | `outbox` claim                                                                                              |
| `test/plugin-claims-gate.test.ts`                              | several derived sites per package (§3.11)                                                                   |
| `test/apps-gate.test.ts`                                       | C8 amendment and the new CI pins                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Real-backend suites guard with `ignore:` on their env var — never an early return (the M70c trap).

**CI (decided, C8).** `ci.yml`, `drift.yml` and `release.yml` gain:

- a `postgres:16` service on `127.0.0.1:5432`, declaring `POSTGRES_PASSWORD: postgres` and a
  `--health-cmd "pg_isready -U postgres"` health check with the same interval/timeout/retries
  options the existing services use (`ci.yml:100-109`), and `OUTBOX_POSTGRES_URL`
  (`postgres://postgres:postgres@127.0.0.1:5432/postgres`) — a distinct variable, so the
  database-plugin live-Postgres cells keep ignoring on `POSTGRES_URL`;
- a step starting a single-node MongoDB replica set on its own port —
  `docker run -d --name mongo-rs -p 127.0.0.1:27018:27018 mongo:8 --replSet rs0 --port 27018
  --bind_ip_all`,
  then `rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] })` through
  `mongosh`, waiting for a primary — and `MONGODB_RS_URI`
  (`mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true`). The existing standalone
  `mongo:8` service and `MONGODB_URI` are untouched.

`test/apps-gate.test.ts` pins both variables, the service with its health check and the step in all
three workflows, keeps neither in `ALLOW_SKIP`, and the M101a assertion is amended as C8 states.

**Grants (decided).** `packages/messaging-plugin/deno.json` `test.permissions.net` gains
`127.0.0.1:5432`, `127.0.0.1:27017` (the standalone MongoDB the refusal test drives),
`127.0.0.1:27018`, `127.0.0.1:8000`, `127.0.0.1:8086` and `127.0.0.1:8082` (the local-only Cosmos
emulator); a CLI `--allow-net` replaces the block (M53), so the grants live here.
`packages/database-plugin/deno.json` is unchanged (its `:5433` grant serves its own local-only
cells; the bridge's real-backend tests run from `messaging-plugin`, where the composition is).

**Deviation recorded at implementation (PostgreSQL port 5433, not 5432).** The service, the URL and
the grant above use host port **5433**, not 5432: the workflows map `127.0.0.1:5433:5432`,
`OUTBOX_POSTGRES_URL` is `postgres://postgres:postgres@127.0.0.1:5433/postgres`, and
`messaging-plugin` grants `127.0.0.1:5433` instead of `127.0.0.1:5432`. Reason: 5433 is the port
`database-plugin`'s real tests already grant (`packages/database-plugin/deno.json:20`) and the port
the local PostgreSQL backend runs on, while local 5432 is occupied by an unrelated application's
database. One port in CI and locally means the guarded suites run identically in both.
`test/apps-gate.test.ts` pins the 5433 form.

| Test file                                                                  | src covered                                          | Key assertions                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/outbox-contract.test.ts`                        | `services/outbox.ts`, token                          | `IUnitOfWork` assigns to `IOutboxWriteScope` (static); token passes `createCapabilityToken`                                                                                                                                                                                                                                                                                          |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)              | `index.ts`                                           | every §4 `common` symbol exported, checked at compile time against the barrel                                                                                                                                                                                                                                                                                                        |
| `packages/database-plugin/test/unit/barrel-exports.test.ts` (extended)     | `index.ts`                                           | the three bridge exports present; internals absent                                                                                                                                                                                                                                                                                                                                   |
| `packages/database-plugin/test/unit/outbox/outbox-columns.test.ts`         | bridge                                               | record ↔ row round trip, optionals omitted, `kind` written                                                                                                                                                                                                                                                                                                                           |
| `packages/database-plugin/test/unit/outbox/outbox-discriminator.test.ts`   | bridge                                               | business rows with `status` `pending`/`sent` in the same entity never read, counted, transitioned or purged                                                                                                                                                                                                                                                                          |
| `packages/database-plugin/test/unit/outbox/outbox-store-ops.test.ts`       | bridge, `errors.ts`                                  | every §3.3 row and every missing / unexpected-status branch; `failedKeys` issues `select`                                                                                                                                                                                                                                                                                            |
| `packages/database-plugin/test/unit/outbox/outbox-store-contract.test.ts`  | bridge                                               | the custom-store contract as a reusable internal helper, run against the bridge                                                                                                                                                                                                                                                                                                      |
| `packages/database-plugin/test/unit/outbox/outbox-verify.test.ts`          | bridge, `errors.ts`                                  | each §3.4 reason; the probe's `where` is `{ kind, status: 'pending' }`; the measured MongoDB code-20 shape gives the replica-set reason; memory passes                                                                                                                                                                                                                               |
| `packages/telemetry-plugin/test/unit/telemetry-service-root.test.ts`       | `telemetry-service.ts`                               | `root` reaches `startSpan`; omitted `root` absent                                                                                                                                                                                                                                                                                                                                    |
| `packages/telemetry-plugin/test/unit/span-root.test.ts`                    | `tracer.ts`                                          | real SDK: `root` ignores an active span; omitted `root` unchanged                                                                                                                                                                                                                                                                                                                    |
| `packages/messaging-plugin/test/unit/outbox/outbox-write.test.ts`          | `outbox-service.ts`, `record-codec.ts`, `prepare.ts` | oversized refused before `append`; traceparent captured; write before `onInit` rejects; every refusal rejected, never thrown                                                                                                                                                                                                                                                         |
| `packages/messaging-plugin/test/unit/outbox/precedence-parity.test.ts`     | `prepare.ts`, `publish.ts`, relay                    | a non-default caller `deduplicationId` and selector reach the broker identically through both entry points                                                                                                                                                                                                                                                                           |
| `packages/messaging-plugin/test/unit/outbox/position.test.ts`              | `position.ts`                                        | fixed width; same-ms order; backwards clock step stays increasing; `blockKey` cannot collide                                                                                                                                                                                                                                                                                         |
| `packages/messaging-plugin/test/unit/outbox/relay-paging.test.ts`          | `relay.ts`, `lap.ts`, `outbox-service.ts`            | §3.6's list: starvation, mid-page `publishLimit`, release mid-lap, resume-after-release order, cap-skip blocks, 10 000-key cap, no `availableAt` overtake, lap wrap                                                                                                                                                                                                                  |
| `packages/messaging-plugin/test/unit/outbox/relay-blocking.test.ts`        | `relay.ts`, `record-codec.ts`                        | failed row blocks; backoff blocks; unkeyed unaffected; tenant in key; every `invalid-row` cause                                                                                                                                                                                                                                                                                      |
| `packages/messaging-plugin/test/unit/outbox/relay-store-failure.test.ts`   | `relay.ts`                                           | §3.7 rejected store writes                                                                                                                                                                                                                                                                                                                                                           |
| `packages/messaging-plugin/test/unit/outbox/relay-budget.test.ts`          | `relay.ts`, `outbox-service.ts`, `options.ts`        | §3.8 deadline cases; single-flight; option relation refused                                                                                                                                                                                                                                                                                                                          |
| `packages/messaging-plugin/test/unit/outbox/outbox-release.test.ts`        | `outbox-service.ts`                                  | retry/discard; `not-failed`/`missing` rejected; tenant store selection                                                                                                                                                                                                                                                                                                               |
| `packages/messaging-plugin/test/unit/outbox/outbox-tenancy.test.ts`        | `outbox-service.ts`, `options.ts`                    | store selection; unknown tenant; rotation                                                                                                                                                                                                                                                                                                                                            |
| `packages/messaging-plugin/test/unit/outbox/outbox-dispatch.test.ts`       | `outbox-service.ts`                                  | coalescing; background hook; never throws; no-op once closing                                                                                                                                                                                                                                                                                                                        |
| `packages/messaging-plugin/test/unit/outbox/outbox-retention.test.ts`      | `outbox-service.ts`                                  | §3.14                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/messaging-plugin/test/unit/outbox/outbox-health.test.ts`         | `outbox-health.ts`                                   | §3.11 reasons and scopes; `data` carries no tenant/key/error text                                                                                                                                                                                                                                                                                                                    |
| `packages/messaging-plugin/test/unit/outbox/outbox-collector.test.ts`      | `outbox-collector.ts`                                | instruments; guarded writes; label cap                                                                                                                                                                                                                                                                                                                                               |
| `packages/messaging-plugin/test/unit/outbox/outbox-options.test.ts`        | `options.ts`, `errors.ts`                            | every numeric option refused at `NaN`/out of range by name; `store` + `stores` compile error (`@ts-expect-error`)                                                                                                                                                                                                                                                                    |
| `packages/messaging-plugin/test/unit/outbox/readme-ddl.test.ts`            | (docs)                                               | README contains `outbox-postgres.sql` verbatim                                                                                                                                                                                                                                                                                                                                       |
| `packages/messaging-plugin/test/unit/outbox/barrel-exports.test.ts`        | `index.ts`                                           | every §4 symbol exported at compile time; internals not                                                                                                                                                                                                                                                                                                                              |
| `packages/messaging-plugin/test/integration/outbox-plugin.test.ts`         | `messaging-plugin.ts`                                | real kernel app: `onInit` verify, relay and purge scheduled, unscheduled refusal, health registered; §3.8 shutdown ordering and failed-start close path                                                                                                                                                                                                                              |
| `packages/messaging-plugin/test/integration/outbox-atomicity.test.ts`      | write path                                           | business row + outbox row commit together; a throw rolls both back — read back                                                                                                                                                                                                                                                                                                       |
| `packages/messaging-plugin/test/integration/outbox-crash.test.ts`          | relay                                                | the §3.13 crash table                                                                                                                                                                                                                                                                                                                                                                |
| `packages/messaging-plugin/test/integration/outbox-overlap.test.ts`        | relay                                                | overlap detection; a late failure write cannot regress `sent`                                                                                                                                                                                                                                                                                                                        |
| `packages/messaging-plugin/test/integration/outbox-watermark-real.test.ts` | relay                                                | `OUTBOX_POSTGRES_URL`: two transactions committing out of position order → both published (the negative control)                                                                                                                                                                                                                                                                     |
| `packages/messaging-plugin/test/integration/outbox-real.test.ts`           | relay, bridge                                        | `OUTBOX_POSTGRES_URL` + `RABBITMQ_URL` (Drizzle over `npm:pg`): write → sweep → consumed, envelope id as `x-setu-deduplication-id`; crash table; `REDIS_URL` with Redis Streams: same                                                                                                                                                                                                |
| `packages/messaging-plugin/test/integration/outbox-backends-real.test.ts`  | bridge                                               | `MONGODB_RS_URI` replica set supported; `MONGODB_URI` (standalone in CI) refused with the REPLICA-SET reason specifically, not merely `OutboxStoreUnavailableError`; `DYNAMODB_ENDPOINT` with the GSI (supported, `position > after` paging) and without (refused); `BIGTABLE_EMULATOR_ENDPOINT` refused by name; `COSMOS_ENDPOINT` (local-only) shared-container discriminator case |
| `packages/messaging-plugin/test/integration/outbox-trace-real.test.ts`     | relay §3.9                                           | §3.9's list                                                                                                                                                                                                                                                                                                                                                                          |
| `test/plugin-claims-gate.test.ts` (extended)                               | (gate)                                               | §3.11: several derived sites per package; an unaccounted one still fails                                                                                                                                                                                                                                                                                                             |
| `apps/cloudflare/smoke.ts` (extended)                                      | Workers hybrid                                       | real workerd: D1 write + `dispatch` via `waitUntil` delivers; `__scheduled` sweep delivers                                                                                                                                                                                                                                                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m107-transactional-outbox
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test              # with OUTBOX_POSTGRES_URL, MONGODB_RS_URI, RABBITMQ_URL, REDIS_URL, MONGODB_URI, DYNAMODB_ENDPOINT, BIGTABLE_EMULATOR_ENDPOINT set
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
deno task check:docs
deno task check:apps        # apps/cloudflare on real workerd locally
deno task publish:check
deno task release:verify <version>
```

Negative controls, each observed failing and reverted:

- replace the pending-set page with a `position >` watermark that never wraps (the real PostgreSQL
  test fails);
- restore a single `limit` budget without the lap (the starvation test fails);
- re-seed `failedKeys` at every sweep instead of at lap start (the resume-after-release test
  reorders);
- advance the cursor to the page's last row (the mid-page `publishLimit` test skips a row);
- let a cap-skip leave its key unblocked (the cap test publishes a later row of the key);
- add `availableAt <= now` to the query (the overtake test fails);
- drop `kind` from one read (the discriminator test fails);
- let `markFailure` write from any status (the overlap test regresses `sent`);
- continue the sweep after a rejected `markSent` (the store-failure test publishes the key's later
  row first);
- remove `parentContext` (two traces); remove `root`, or drop it in `TelemetryService.withSpan` (the
  traceless row parents to the request);
- build the envelope at publish time instead of write time (the duplicate carries a different id);
- drop the caller's `deduplicationId` from the stored options (the parity test fails);
- drop the tenant from `blockKey` (the cross-tenant stall test fails);
- skip `verify()` (Bigtable, GSI-less DynamoDB and standalone MongoDB boot clean);
- remove the per-instance clamp (the backwards-clock test fails);
- drain in `onClose` instead of `onShutdown` (the shutdown test sees the broker closed mid-sweep).

## 8. Risks & mitigations

- **Two relays publish concurrently** — a process-local lock in a multi-replica deployment, or a
  sweep outliving the scheduler's `ttlMs`. Mitigation: one deadline bounds a sweep with a stated 15
  000 ms margin under the default `ttlMs` (§3.8); overlaps are detected and degrade health;
  duplicates carry one envelope id, which M108's inbox absorbs.
- **The read-then-write window of a transition** can return a `sent` row to `pending` once (§3.7).
  Mitigation: a duplicate, never a loss; closed by M105.
- **DynamoDB GSI reads are eventually consistent** (AWS documentation, not measured): duplicates and
  false overlap reports (§3.8). Mitigation: documented.
- **Out-of-order commit within one key, and clock skew across writers** (§1, §3.2). Mitigation: the
  stated promise (§3.13).
- **A hot `status = 'pending'` GSI partition on DynamoDB.** Mitigation: documented; rows leave the
  partition at mark-sent.
- **A call abandoned at the sweep deadline completes later** — a late publish (a duplicate) or a
  late status write the next lap's read sees. Mitigation: both are within the promise; the deadline
  bounds how long the relay HOLDS the lock, not when an abandoned call settles.
- **The DDL template drifts from the record.** Mitigation: the real suite applies the fixture the
  README embeds; the column round-trip test pins field names.

## 9. Out of scope

- The consumer inbox — M108 (inherits the discriminator rule).
- CDC relays and Bigtable support — a later milestone.
- `SKIP LOCKED` multi-relay on PostgreSQL — later.
- Conditional transitions as one statement — after M105.
- A dynamic tenant list — needs a tenant catalog (M89c).
- Trace continuity through `WorkersBroker` (framework headers dropped by `asBrokerAdapter`) — a
  pre-existing gap for a `fix/…` branch or a later Workers milestone.
- `MongoTransactionUnavailableError` never firing on the real driver (`mongo-adapter.ts:238-249`,
  measured §1) — a pre-existing defect for a `fix/…` branch; this PR corrects only its JSDoc (C9).

## 10. Design security review (recorded before implementation)

Recorded 2026-10-08, before any implementation, and revised twice the same day after two independent
reviews of this plan against source. Nothing below is reverse-engineered from code.

**Flows reviewed.**

- A caller's payload, metadata, publish options and tenant id entering `IOutbox.write` inside a
  business transaction.
- The record crossing into the database through the port, possibly into an entity or container
  shared with business data.
- The relay reading rows (possibly written or edited by anyone with database write access) lap by
  lap, decoding them, and publishing to the broker with the stored options, topic and `traceparent`.
- Status transitions racing between relays.
- The purge job deleting rows.
- The health payload, metric labels and `lastError` text leaving the process.
- The operator `release` call; `dispatch` triggered per request; shutdown.

**Assets.** Business data in a shared entity or container; tenant isolation of events and of relay
progress; the integrity of what reaches the broker (topic, envelope, headers the broker acts on);
the order of each key's events; the trace graph; event payloads at rest (possibly personal data);
availability of the relay for every tenant and key; the metrics backend; log and health integrity.

**Attackers.**

- (A1) An end user whose request data reaches `payload`, `options` or `tenantId`.
- (A2) Another tenant of the same application.
- (A3) Someone with write access to the outbox table but not to the broker (a compromised reporting
  job, a SQL injection elsewhere in the application).
- (A4) A reader of logs, health and metrics.
- (A5) A flood of requests each calling `dispatch`.
- (A6) Application code that hands `write` a unit of work bound to a different database than the
  selected store's.

**Approved budgets.**

- Per write: one validation pass, one `JSON.stringify`, one insert.
- Per sweep: one deadline, `sweepDeadlineMs` (default 15 000), bounding everything inside it.
  - At most `scanLimit` rows examined, in pages of `pageSize`.
  - At most `publishLimit` publishes and transitions.
  - One `failedKeys` scan of two columns, at lap start only.
- Per lap and instance: a blocked set of at most 10 000 keys, beyond which the lap is `capReached`.
- Per purge interval (`purgeIntervalMs`): at most `purgeBatch` deletes per status. On DynamoDB, the
  index reads the filter passes over are stated as a cost, not bounded.
- Per instance: at most 100 topic label values. No other in-memory structure grows with the data.

**Design-time findings.**

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Disposition                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Caller headers with reserved names stored and replayed by the relay (A1)                                                                                                                                                                                                                                                                                                                                                                                                            | Validated at write (M106 §3.4) and again by the broker at publish; a stored row failing validation becomes `invalid-row` (§3.7)                                                                                                                                                                                             |
| D2  | An edited row smuggles reserved headers, a huge envelope, a forged `traceparent`, a malformed topic, or an `options.orderingKey` that disagrees with its `orderingKey` column (A3)                                                                                                                                                                                                                                                                                                  | Rows re-validated on read: options, size, id equality, topic (non-empty, ≤255 bytes, no Cc/Cf/Zl/Zp), ordering-key agreement — each failure is `invalid-row`, poisoning the key rather than ordering by one key and placing by another; an invalid `traceparent` gives a root span, never a throw and never a parent (§3.9) |
| D3  | One tenant's poisoned row stalls another tenant's key with the same value (A2)                                                                                                                                                                                                                                                                                                                                                                                                      | Block key includes the tenant, JSON-encoded so no separator collides (§3.2)                                                                                                                                                                                                                                                 |
| D4  | Health, metrics or logs expose tenant ids, keys or payload fragments (A4)                                                                                                                                                                                                                                                                                                                                                                                                           | `data` carries counts, ages and fixed reasons only; `lastError` is `describeError`, Cc/Cf-stripped, cut to 1024                                                                                                                                                                                                             |
| D5  | An oversized payload commits an unsendable row that poisons its key forever (A1)                                                                                                                                                                                                                                                                                                                                                                                                    | Refused inside the transaction (§3.5)                                                                                                                                                                                                                                                                                       |
| D6  | `tenantId` with control characters or unbounded length forges log lines or bloats rows (A1)                                                                                                                                                                                                                                                                                                                                                                                         | Validated with the M106 id rule                                                                                                                                                                                                                                                                                             |
| D7  | `dispatch` per request spawns unbounded concurrent sweeps (A5)                                                                                                                                                                                                                                                                                                                                                                                                                      | Single-flight with one follow-up; a no-op once closing (§3.8)                                                                                                                                                                                                                                                               |
| D8  | Event payloads retained forever (privacy)                                                                                                                                                                                                                                                                                                                                                                                                                                           | Purge of `sent` and `discarded` rows on its own interval (§3.14); `failed` rows kept for the operator and documented                                                                                                                                                                                                        |
| D9  | A row's stored topic is attacker-chosen (A3), redirecting an event to another topic                                                                                                                                                                                                                                                                                                                                                                                                 | Format validated (D2), destination not: database write access is a stronger capability than the broker trust boundary assumes; the README says the outbox table must be protected like the broker credentials                                                                                                               |
| D10 | The relay publishes every tenant's rows with one broker identity                                                                                                                                                                                                                                                                                                                                                                                                                    | Accepted: the same as a direct `publishIntegrationEvent`                                                                                                                                                                                                                                                                    |
| D11 | `release` is an operator capability with no built-in authorization                                                                                                                                                                                                                                                                                                                                                                                                                  | Documented: the application gates the route that calls it                                                                                                                                                                                                                                                                   |
| D12 | **Cross-entity corruption:** an outbox sharing a container or collection with business documents reads, transitions or purges business documents that carry `status: 'pending'`/`'sent'`                                                                                                                                                                                                                                                                                            | Discriminator on every read, every transition (a row whose `kind` differs is `missing`) and every purge, on every backend (§3.2)                                                                                                                                                                                            |
| D13 | **Metrics label explosion:** an edited row with a unique topic per row (A3) creates unbounded label values                                                                                                                                                                                                                                                                                                                                                                          | Label only from decoded rows, capped at 100 distinct values per instance, then `other` (§3.11)                                                                                                                                                                                                                              |
| D14 | **Store/database mismatch (A6):** any store bound to a database other than the one the caller's unit of work belongs to — a per-tenant `stores` entry for another tenant, or a `createDatabaseOutboxStore({ database })` naming another `database.<name>` — writes the row into the unit of work's database, where the selected store's relay never looks. If that database has a relay of its own the row is published labelled with the wrong tenant; if not, it is NEVER relayed | Cannot be checked (no database identity on the scope, §3.10): a caller obligation in the `write` JSDoc and README, and audit obligation 10                                                                                                                                                                                  |
| D15 | A late failure write regresses a row another relay already sent, republishing it indefinitely                                                                                                                                                                                                                                                                                                                                                                                       | Transitions write only from `pending` (§3.7); residual single overwrite documented until M105                                                                                                                                                                                                                               |
| D16 | A traceless or edited-`traceparent` row swept from inside a request is attributed to that request                                                                                                                                                                                                                                                                                                                                                                                   | `root` span, carried through `TelemetryService.withSpan` and `tracer.ts` to OTel (§3.9)                                                                                                                                                                                                                                     |
| D17 | **Reordering after a release or a cap:** a resumed sweep that re-seeds its blocked set, or a cap-skip that does not block its key, publishes a key's later row before its earlier one                                                                                                                                                                                                                                                                                               | Seed only at lap start; persist the blocked set and `capReached` with the cursor; a cap-skip blocks its key (§3.6)                                                                                                                                                                                                          |
| D18 | **Blocked-set exhaustion:** an A3 attacker inserting rows under many distinct keys grows the relay's memory                                                                                                                                                                                                                                                                                                                                                                         | Blocked set capped at 10 000 keys; overflow sets `capReached`, which publishes no keyed row for the rest of the lap and reports `blocked-key-cap` (§3.6, §3.11)                                                                                                                                                             |
| D19 | A failure caused by shutdown counts toward `maxAttempts` and poisons healthy rows on every deploy                                                                                                                                                                                                                                                                                                                                                                                   | Drain in `onShutdown`, before any close hook; failures after `closing` write nothing (§3.8)                                                                                                                                                                                                                                 |

**Obligations the implementation audit must meet.**

1. Every reserved header name is refused at `write`, and a row edited to carry one is never
   published — it becomes `invalid-row`.
2. A row whose envelope exceeds `maxEnvelopeBytes`, whose envelope id differs from its row id, whose
   envelope is not JSON, whose `options.orderingKey` disagrees with its column, or whose topic fails
   §3.7 is never published.
3. No health field, metric label, log line or refusal message contains a tenant id, ordering key,
   payload fragment or stored header value; topic labels stop at 100 distinct values.
4. A poisoned row of tenant A does not block tenant B's key with the same value.
5. A business document without `kind: 'setu-outbox'` in the outbox's entity or container is never
   returned, counted, updated or deleted by any store method — driven on the memory adapter in CI
   and on the Cosmos emulator locally.
6. No transition writes a row that is not in its expected status at read time.
7. No key's later row is published before an earlier pending row of the same key: across a resumed
   sweep, a `release` mid-lap, a cap-skip, the blocked-set cap and a rejected `markSent`.
8. The blocked set never exceeds 10 000 keys; overflow publishes no keyed row for the rest of the
   lap.
9. `dispatch` under a request flood runs at most one sweep at a time per process.
10. The `write` JSDoc and README state D14's caller obligation for BOTH forms (per-tenant `stores`
    and a `database.<name>` binding); the audit confirms no code path selects a store by anything
    other than the caller's `tenantId` and the configured binding.
11. Every refusal from `write`, `release` and the store is a rejected promise, never a synchronous
    throw.
12. With `retainSentMs` set, no `sent` or `discarded` row older than it survives a purge run that
    had budget.
13. No failure caused by the application stopping is counted against `maxAttempts`.
14. The README states D9's trust requirement, the promise (§3.13) and the overlap limits (§3.8).

## 11. Documentation deliverables

- `packages/messaging-plugin/README.md`: an "Outbox" section — the promise, the crash table, the
  per-backend table (§3.4), the discriminator rule, the DDL templates, the relay budget rule,
  overlap detection and its limits (`retainSentMs: 0`, DynamoDB staleness), Workers wiring, operator
  `release`, the custom-store contract, D9 and D14.
- `packages/database-plugin/README.md`: `createDatabaseOutboxStore` and the backend requirements.
- `packages/telemetry-plugin/README.md`: `SpanOptions.root`.
- `PUBLIC_API.md`: the `common` port, token and `SpanOptions.root`, the bridge, the `IOutbox`
  service and options, each export with JSDoc.
- `CHANGELOG.md` `Unreleased` → Added (outbox; port; bridge; `SpanOptions.root`), Fixed (C7 and C9
  JSDoc).
- `docs/health-indicators.md`: the new site classified `live-state`, and the existing
  `messaging-plugin` site's line number updated if the edit moves it.
- `ROADMAP.md`: C1–C6 corrections; the M108 sentence on the discriminator; M107 row and deliverables
  flipped at completion.
- `test/apps-gate.test.ts`: the C8 amendment and the new pins.
- `test/plugin-claims-gate.test.ts`: several derived sites per package, with the pure matching
  function extracted so a self-test proves an unaccounted name still fails (§3.11).
- The `SpanOptions.root` JSDoc: an `ITelemetryService` that ignores it parents to the active span.
- `docs/upgrading.md`: nothing — no breaking change (§4).

## 12. Claims NOT verified at plan time

Each is an obligation for implementation, measured before the code relies on it.

- **DynamoDB GSI selection and `position > after` as a key condition.** Read from
  `dynamo-access-path.ts:78-90`, `:236-265`; not driven against DynamoDB Local. GSI read consistency
  is from AWS documentation, and the false-overlap scenario (§3.8) is reasoned, not reproduced.
- **Cosmos with the outbox in the business container.** That a row whose partition-key path is
  `tenantId` (or `orderingKey`) shares the business write's batch is reasoned from
  `cosmos-transaction.ts:55-72`; the Cosmos emulator suite is local-only and was not run.
- **The CI MongoDB replica-set step.** The command shape (own port, `--replSet rs0`, `rs.initiate`
  with a `127.0.0.1:27018` member, `directConnection=true`) is designed, not run on a GitHub runner.
  The standalone refusal shape IS measured (§1).
- **That a transaction containing only a read commits cleanly on every adapter** (§3.4 step 2).
  Measured for none; D1's empty buffer is a no-op by source (`d1-adapter.ts:233-241`); DynamoDB,
  Cosmos and Prisma are to be driven during implementation.
- **Collation behaviour of `position`.** The separator-free format is chosen so a
  punctuation-ignoring collation cannot change its order; not measured against a non-`C` PostgreSQL
  locale.
- **`maxEnvelopeBytes` default.** 256 KiB is the Service Bus Standard ceiling from Microsoft's
  documentation; Kafka's `message.max.bytes` (about 1 MB) and Cloudflare Queues' 128 KB are also
  documentation.
- **Workers hybrid on real workerd** (`apps/cloudflare`): planned, not run.
- **The scheduler handler-mutex overrun.** That a sweep outliving `ttlMs` lets a second replica run
  concurrently is read from source (no renewal, `scheduler-service.ts:558-640`), not measured.
- **`SpanOptions.root` on the real SDK.** The option is read from `@opentelemetry/api` 1.9.1's
  declaration (`SpanOptions.d.ts:22-23`); that it yields a parentless span while another span is
  active is not yet driven here.
- **The sweep deadline's margin.** 15 000 ms under a 30 000 ms `ttlMs` is chosen, not measured
  against a loaded Redis lock; the release round trip and timer lateness it absorbs are expected to
  be milliseconds.
- **The shutdown order.** `onShutdown` before `onClose` is read from `application.ts:900-912` and
  `lifecycle-manager.ts:195-225`; the plugin test is what proves the drain finishes before the
  broker closes.
