# Milestone 108 — Consumer inbox (`@setu-ts/messaging-plugin`, `@setu-ts/common`, `@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m108-consumer-inbox`. `main` and `develop` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

**Decisions for the maintainer to confirm before implementation.** Each is decided below, so the
plan lints and can be built as written; each is also a place where a different call is reasonable:

1. **The store reaches the subscription through the plugin, not the call** (§3.2):
   `MessagingPlugin({ inbox: { store } })`, and `onIntegrationEvent(def, handler, { inbox })`
   returns a `RegistryFactory` that resolves it. A store on every call would leave verification and
   retention with no owner.
2. **`consumer` is required and explicit, and it defaults the broker `queue`** (§3.4). M109a's
   `IngressContext.consumer` is not reused: for a queue-less subscriber it is
   `subscription:<per-process uuid>:<n>`, which changes on every process start and differs per
   replica, so it would reset every inbox key.
3. **Parking is opt-in** (`inbox.maxAttempts`, §3.8). RabbitMQ and Redis Streams carry their own
   retry budget and dead-letter queue (`consumerRetry`); NATS (no `max_deliver` is set) and Kafka
   have none, and the README tells their users to set `maxAttempts`.
4. **Cosmos and Bigtable are refused at startup** (§3.10). A Cosmos transaction is one partition,
   and an inbox row cannot be made to share the business partition without a per-application
   partition selector; that is named, unowned follow-up work.

**Plan verification.** One independent verification round (2026-10-09) checked every §1 row and the
design against source. Its one blocker (Cosmos could not pass `verify`) and six major findings are
folded into this revision: §3.3 overload order, §3.4 queue default, §3.5 hashed keys, §3.6 re-read
on any rejection, §3.8 per-broker budgets, and §3.11 close ordering.

## 0. Objective & scope

At-least-once delivery means duplicates by design: an outbox relay that crashes after publishing
re-publishes the row (M107 §3.13), and every broker redelivers after a lost acknowledgement. This
milestone gives a consumer a record of what it has applied, keyed by `(consumer, envelope id)`,
inserted in the SAME database transaction as the handler's own writes, so a duplicate delivery is
acknowledged without running the handler and a failed handler leaves no record behind. The promise
is stated once (§3.13) and nowhere stronger: database effects once per consumer; anything outside
the database is the application's stated choice (§3.12).

- **In scope:**
  - `CAPABILITIES.INBOX`, the `IInboxStore` port and its record types in `common` (§3.1 —
    `database-plugin` must implement the port by name; §2.2 forces it there).
  - `createDatabaseInboxStore()` in `database-plugin`: the bridge over `IDatabaseService`, owning
    the column mapping, the discriminator and the startup refusals (§3.10, the M107
    `createDatabaseOutboxStore` precedent).
  - The `inbox` arm on `MessagingCommonOptions` and the `IInbox` service (`parked`, `release`,
    `purge`) in `messaging-plugin`, with a health indicator and a scheduled retention purge.
  - The `inbox` option on `onIntegrationEvent`, selecting a new `IntegrationEventInboxHandler<T, S>`
    whose fourth argument is the transaction's unit of work (§3.3).
  - Opt-in poison handling: failures counted outside the rolled-back transaction, and a delivery
    parked after `maxAttempts` (§3.8); an operator `release` (§3.9).
  - One `cli` claim-table line and the `docs/health-indicators.md` classification the M70c/M70g
    gates require for the new `ctx.health.register` site (§3.11).
- **NOT this milestone:**
  - Tier C `within(uow, key, fn)` for HTTP and plain code — M109b, which builds on this milestone's
    transaction seam.
  - Cosmos and Bigtable inbox stores — refused at startup (§3.10); a Cosmos partition selector is
    unowned follow-up work.
  - Per-tenant inbox stores (database-per-tenant): the envelope carries no tenant (M107 C3), so the
    inbox has nothing to select a store by. Unowned (§9).
  - Metrics instruments for the inbox — the health indicator carries the operator signal; a counter
    set is an additive follow-up, unowned.
  - Closing the read-then-write window in `recordFailure` and `release` — needs M105's conditional
    `updateWhere` (§3.8).

## 1. Contracts verified from SOURCE (not names)

Paths are relative to the repository root. Every row was read in source on 2026-10-09, and re-cited
on `origin/develop` at `b66cf10b` (after M109a merged).

| Reference                                      | Source (file:line)                                                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onIntegrationEvent`                           | `packages/messaging-plugin/src/integration/subscribe.ts:84-116`                                                                                                           | `(definition, handler, options?: SubscribeOptions): SubscriptionDefinition`; the wrapper runs `validateEnvelope` → `definition.parse` → rebuilds `data` → `handler(payload, envelope, metadata)`                                                                                    |
| `IntegrationEventHandler<T>`                   | `packages/messaging-plugin/src/integration/subscribe.ts:27-31`                                                                                                            | `(payload: T, envelope: IntegrationEventEnvelope<T>, metadata: MessageMetadata) => void \| Promise<void>`                                                                                                                                                                           |
| `IntegrationEventEnvelope`                     | `packages/messaging-plugin/src/integration/envelope.ts:36-55`                                                                                                             | `id` (producer-assigned `runtime.uuid()`), `type`, `version`, `occurredAt`, `data`, optional causal fields                                                                                                                                                                          |
| `validateEnvelope`                             | `packages/messaging-plugin/src/integration/envelope.ts:182-280`                                                                                                           | requires `id` to be a STRING and nothing more — no length bound, no character rule; a foreign producer's id reaches the consumer unbounded                                                                                                                                          |
| `IntegrationEventRejectedError`                | `packages/messaging-plugin/src/errors.ts:148-152`, `:177-181`                                                                                                             | `reason: 'malformed' \| 'type-mismatch' \| 'version-mismatch' \| 'parse'`                                                                                                                                                                                                           |
| Deterministic-failure branches                 | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:1185`; `redis-streams-broker.ts:603`; `nats-broker.ts:625-626`, `:690-701`; `kafka-broker.ts:729-730`           | only RabbitMQ (durable retrying queues) and Redis Streams branch on `instanceof IntegrationEventRejectedError`; NATS `nak()`s every failure and its consumer sets no `max_deliver`, so redelivery is unlimited; Kafka rethrows and leaves the offset uncommitted                    |
| RabbitMQ retry scope                           | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:891-912`, `:1123`, `:1194-1197`                                                                                 | retries apply only to a durable NAMED queue; a queue-less subscriber's exclusive queue `nack`s a failure without requeue — discarded                                                                                                                                                |
| `SubscriptionDefinition` / `SubscriptionEntry` | `packages/messaging-plugin/src/interfaces/index.ts:379-397`                                                                                                               | `{ topic, handler: MessageHandler, options?: SubscribeOptions }`; an entry is a definition, or a `RegistryFactory<SubscriptionDefinition>`                                                                                                                                          |
| Subscription factories resolve at `onInit`     | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:602-653`                                                                                                        | factory entries resolve in an `onInit` hook registered at the END of `register()`, after the behaviour chain is final (M86 gate), each `subscribe()` awaited; a throwing factory rejects `start()` with `MessagingPlugin({ subscriptions })[<index>]`                               |
| Hook ordering                                  | `packages/kernel/src/lifecycle/lifecycle-manager.ts:147-154`, `:188-229`                                                                                                  | `onInit` runs in global registration order; `onShutdown` in REVERSE order; `onClose` in registration order, every hook running even after a failure                                                                                                                                 |
| Broker close hook                              | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:487`                                                                                                            | the broker disconnects in an `onClose` hook registered in `register()`; an `onClose` registered later runs after it                                                                                                                                                                 |
| Outbox registration (the precedent)            | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:183-194`, `:257-268`, `:706-782`                                                                                | option validated at construction; `outbox` / `outbox.<name>` token; scheduler + metrics optional edges only when configured; `onInit` hook (registered before the subscription hook) verifies, activates, schedules                                                                 |
| Outbox store port (the precedent)              | `packages/common/src/services/outbox.ts:1-300`                                                                                                                            | port in `common`; discriminator constant; every method rejects, never throws synchronously; `verify()` on the port                                                                                                                                                                  |
| Outbox bridge (the precedent)                  | `packages/database-plugin/src/outbox/database-outbox-store.ts:1-422`                                                                                                      | `RegistryFactory` resolving `database` / `database.<name>`; optional columns written as `null`, read back as absent; `verify()` maps adapter refusals to a named error                                                                                                              |
| `IUnitOfWork` / `IDatabaseService.transaction` | `packages/database-plugin/src/interfaces/index.ts:168-179`, `:212-215`                                                                                                    | `getRepository<Entity, Id>(entity)`; `transaction<T>(work, options?)` — declared in `database-plugin`, so `messaging-plugin` cannot name it (§2.2)                                                                                                                                  |
| `DatabaseService` adapter type                 | `packages/database-plugin/src/services/database-service.ts:172`                                                                                                           | `private readonly _adapterType: DatabaseAdapterType` — knowable inside the package, not on `IDatabaseService`                                                                                                                                                                       |
| `DuplicateKeyError`                            | `packages/common/src/errors/duplicate-key.ts:49-79`                                                                                                                       | `name: 'DuplicateKeyError'`, `entity: string \| undefined` — a refusal raised at commit carries none                                                                                                                                                                                |
| Commit-time duplicates carry no entity         | `packages/database-plugin/src/services/database-service.ts:130-134`; `adapters/dynamo/dynamo-adapter.ts:383-388`                                                          | `duplicateAtCommitOrOriginal` builds the error with `entity: undefined`; DynamoDB's cancelled `TransactWriteItems` likewise; a DynamoDB `TransactionConflict` cancellation is NOT mapped                                                                                            |
| Create-time PostgreSQL duplicate               | `packages/database-plugin/src/services/database-service.ts:80-110`                                                                                                        | `wrapDataSource` → `classifyDriverError`: a `23505` raised at `create` inside `transaction` surfaces as `DuplicateKeyError`                                                                                                                                                         |
| MongoDB concurrent insert                      | `packages/database-plugin/src/errors/classify.ts:296-304`                                                                                                                 | two in-flight transactions inserting one `_id`: `WriteConflict` with `TransientTransactionError` → `'conflict'`, i.e. `SerializationConflictError`, NOT `DuplicateKeyError`                                                                                                         |
| Memory adapter duplicate timing                | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:618-628`, `:400-409`                                                                                      | refused at `create` against committed + overlay rows, AND re-checked at commit against rows committed meanwhile                                                                                                                                                                     |
| Cosmos partition key on create                 | `packages/database-plugin/src/adapters/cosmos/cosmos-data-source.ts:216-236`, `:343-357`; `cosmos-transaction.ts:55-100`                                                  | `create` throws when the row lacks the container's partition-key path; a batch is one partition                                                                                                                                                                                     |
| Bigtable second row                            | `packages/database-plugin/src/adapters/bigtable/bigtable-transaction.ts:147-171`; `bigtable-data-source.ts:304`                                                           | `BigtableTransactionScopeError` at the SECOND row's `create`, not at commit                                                                                                                                                                                                         |
| DynamoDB without a matching index              | `packages/database-plugin/src/adapters/dynamo/dynamo-access-path.ts:78-131`                                                                                               | a query with no eligible key equality becomes a `Scan`; no read in `packages/database-plugin/src` sets `ConsistentRead`                                                                                                                                                             |
| `publishIdProblem`                             | `packages/common/src/services/messaging.ts:30`, `:47-64`                                                                                                                  | non-empty, well-formed, trimmed, no Cc/Cf, ≤ 128 UTF-8 bytes; `"`, `\`, `/`, `?`, `#` are allowed                                                                                                                                                                                   |
| `MessageMetadata` / `SubscribeOptions`         | `packages/common/src/services/messaging.ts:401-413`, `:433-436`                                                                                                           | metadata `{ topic, messageId?, timestamp?, headers? }`; subscribe options carry `queue?` only                                                                                                                                                                                       |
| Broker de-duplication of a re-publish          | `packages/messaging-plugin/src/brokers/nats-broker.ts:544-558`; `service-bus-broker.ts:981`                                                                               | `deduplicationId` becomes `Nats-Msg-Id` / `messageId`, so a re-publish inside the broker's window is dropped                                                                                                                                                                        |
| `IngressContext.consumer` (M109a)              | `packages/messaging-plugin/src/pipeline/pipelined-broker.ts`                                                                                                              | `options.queue ?? subscription:<per-process uuid>:<n>`                                                                                                                                                                                                                              |
| `RegistryFactory` / `resolveRegistryEntry`     | `packages/common/src/registry.ts:66`, `:216`                                                                                                                              | `(services) => T`, synchronous; a throwing factory becomes `Failed to resolve <label>` with `cause`                                                                                                                                                                                 |
| `IRuntimeServices.subtle`                      | `packages/common/src/runtime.ts:337`                                                                                                                                      | `SubtleCrypto` on every runtime — the key hash (§3.5)                                                                                                                                                                                                                               |
| `withDeadline` / `createCachedProbe`           | `packages/common/src/health/deadline.ts:34`, `:118`; `health/probe.ts:121-139`                                                                                            | per-call bound; cached probe with TTL, timeout and a fallback value                                                                                                                                                                                                                 |
| Capability-token grammar                       | `packages/common/src/tokens.ts:296`, `:317`                                                                                                                               | `inbox` and `inbox.<name>` are legal; no existing indicator is named `inbox`                                                                                                                                                                                                        |
| Health-indicator gates                         | `test/health-indicator-audit.test.ts`; `test/plugin-claims-gate.test.ts:49-52`; `packages/cli/src/utils/plugin-claims.ts:49`                                              | every `ctx.health.register(` site classified by file:line in `docs/health-indicators.md`; the claims gate lists derived-name expressions per package (`outboxToken` today)                                                                                                          |
| Real-backend fixtures (the precedent)          | `packages/database-plugin/test/fixtures/outbox-postgres.{sql,ts}`; `packages/messaging-plugin/test/integration/outbox-real.test.ts`; `outbox-backends-real.test.ts:55-57` | Drizzle over `npm:pg` on `OUTBOX_POSTGRES_URL`, the replica set on `MONGODB_RS_URI`, all run from `messaging-plugin`, whose grants cover 5433 and 27018                                                                                                                             |
| Overload typing (measured)                     | scratch `deno check` probes, 2026-10-09                                                                                                                                   | with the inbox overload declared FIRST and the legacy options carrying `inbox?: never`, every existing call keeps `SubscriptionDefinition`, an options VARIABLE carrying `inbox` selects the inbox overload, and `ReturnType<typeof onIntegrationEvent>` reads the legacy signature |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                  | Doc deliverable (same PR)                                             |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| C1 | ROADMAP M108 lists `packages/messaging-plugin` only                                                                                                                         | Source: `IUnitOfWork` is in `database-plugin` and the port must be implemented there by name (§1, M107 C1)                                                                                                                                | ROADMAP M108 package list gains `common`, `database-plugin` and `cli` |
| C2 | ROADMAP M108: "a `DuplicateKeyError` (#420) means 'already handled'"                                                                                                        | Source: a commit-time duplicate carries no entity, and a concurrent MongoDB loser is a `SerializationConflictError` (§1). Any `run` rejection is followed by a re-read; only a present marker means "already handled" (§3.6)              | ROADMAP M108 scope bullet corrected                                   |
| C3 | ROADMAP M108 leaves the handler shape open ("an additive fourth handler argument … or a separate `IntegrationEventInboxHandler` type")                                      | Both, as one decision: a separate exported type whose fourth argument is the unit of work, selected by an overload on the `inbox` option (§3.3)                                                                                           | ROADMAP M108 bullet records the choice                                |
| C4 | ROADMAP M108: "Backends. The same per-backend table as M107: SQL, MongoDB, DynamoDB and D1 support it; Cosmos needs the inbox row in the business partition"                | Source (§3.10): MongoDB on a replica set only; Cosmos and Bigtable refused at startup                                                                                                                                                     | Per-backend table in the messaging README and PUBLIC_API              |
| C5 | ROADMAP M108 example `{ inbox: { consumer: 'payroll' } }` returns a value usable directly in `subscriptions`, while `onIntegrationEvent` returns a `SubscriptionDefinition` | With `inbox`, the call returns a `RegistryFactory<SubscriptionDefinition>` — a valid `SubscriptionEntry`, so the ROADMAP example works as written in `subscriptions`; imperative use calls it with a registry at or after `onInit` (§3.2) | README and the `onIntegrationEvent` JSDoc show both forms             |
| C6 | ROADMAP M108: "Depends on broker redelivery being real, which #419 and #421 fixed"                                                                                          | True only for durable named queues on RabbitMQ and for Redis Streams (§1); NATS redelivers without limit and Kafka blocks the partition. §3.4 defaults the queue; §3.8 states each broker's budget                                        | ROADMAP M108 "Depends on" sentence corrected                          |

## 3. Design decisions

### 3.1 Placement and the database seam

- **Decision:** the inbox lives in `messaging-plugin` as an `inbox` arm of `MessagingCommonOptions`
  and an `IInbox` service registered under `CAPABILITIES.INBOX` (`inbox`, or `inbox.<name>` for a
  named messaging instance). It never resolves `CAPABILITIES.DATABASE`. The database is reached
  through a port:
  - `common` gains `IInboxStore`, its record types, `INBOX_RECORD_KIND` and the token
    (`common/src/services/inbox.ts`).
  - `database-plugin` ships `createDatabaseInboxStore(options?)`, a `RegistryFactory<IInboxStore>`
    over `IDatabaseService`.
- **Why:** exactly M107 §3.1: `messaging-plugin` owns the envelope and the subscription wrapper;
  `database-plugin` must implement the port by name and may not import `messaging-plugin`; and the
  backend knowledge (column mapping, discriminator, refusals) belongs in the one package that knows
  the adapters. A store on each `onIntegrationEvent` call was rejected: verification at startup and
  the retention purge would then have no owner.
- **Test home:** the three barrel tests (§6); `packages/common/test/unit/inbox-contract.test.ts`.

### 3.2 How a subscription reaches the inbox

- **Decision:** `onIntegrationEvent(definition, handler, { inbox, queue? })` returns a
  `RegistryFactory<SubscriptionDefinition>`. When the factory is resolved it:
  1. resolves `inbox` (or `inbox.<instance>` when `inbox.instance` is set); an unregistered token
     throws `InboxNotConfiguredError` naming the remedy (`MessagingPlugin({ inbox: { store } })`);
  2. looks the resolved service up in a module-private `WeakMap` the `InboxService` constructor
     fills; a provider that is not this package's (an `override` replacement) throws
     `InboxNotConfiguredError` — the subscription cannot run against a service it cannot drive;
  3. throws `InboxNotReadyError` when the service has not been verified yet — so an imperative use
     in another plugin's `register()`, or an `instance` naming a messaging instance whose `onInit`
     has not run, fails `start()` by name instead of rejecting every early delivery;
  4. registers `(consumer, topic)` with the service, refusing a second registration of the same pair
     with `InboxConsumerConflictError` (§3.4);
  5. returns `{ topic, handler, options: { queue } }` — `inbox` is never forwarded to
     `broker.subscribe`, and `queue` is `options.queue ?? inbox.consumer` (§3.4).

  In `MessagingPlugin({ subscriptions })` the factory is resolved in the existing subscription
  `onInit` hook, which is registered after the inbox's own `onInit` hook (§3.11) and runs after the
  M86 behaviour chain is final, so the store is verified before the subscription is established.
  Imperatively, inside a plugin's `onInit` or later:
  `const d = onIntegrationEvent(...)(ctx.services); await broker.subscribe(d.topic, d.handler, d.options);`
- **Why:** the ROADMAP's own example works unchanged because a `RegistryFactory` is a
  `SubscriptionEntry` (C5). The `WeakMap` lookup is the M98 package-private-attachment pattern:
  `IInbox` exposes only operator methods, and the delivery path stays internal.
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-subscribe.test.ts`.

### 3.3 The handler type and the overloads

- **Decision:** two overloads of `onIntegrationEvent`, the inbox one declared FIRST:

  ```ts
  function onIntegrationEvent<T, S = unknown>(
    definition: IntegrationEventDefinition<T>,
    handler: IntegrationEventInboxHandler<T, S>,
    options: IntegrationEventSubscribeOptions,
  ): RegistryFactory<SubscriptionDefinition>;
  function onIntegrationEvent<T>(
    definition: IntegrationEventDefinition<T>,
    handler: IntegrationEventHandler<T>,
    options?: SubscribeOptions & { readonly inbox?: never },
  ): SubscriptionDefinition;
  ```

  `IntegrationEventInboxHandler<T, S>` is
  `(payload: T, envelope: IntegrationEventEnvelope<T>, metadata: MessageMetadata, scope: S) => void | Promise<void>`;
  `IntegrationEventSubscribeOptions` is
  `SubscribeOptions & { readonly inbox: IntegrationEventInboxOptions }`. The store hands the handler
  whatever its transaction yields (`unknown` at the port); `S` is the handler's own annotation —
  `uow: IUnitOfWork` for the database bridge — exactly as `services.get<T>()` is the caller's claim.
- **Why:**
  - Every existing call keeps its type and return value (§9.2).
  - Declaring the inbox overload LAST — the plan's first draft — was falsified by the verification
    round: an options VARIABLE carrying both `queue` and `inbox` is not excess-property-checked, so
    it resolved to the legacy overload and was typed `SubscriptionDefinition` while the
    implementation returned a factory. `inbox?: never` closes that path, and declaring the legacy
    signature last keeps `ReturnType`/`Parameters<typeof onIntegrationEvent>` reading what they read
    today.
  - A three-argument handler is assignable to the inbox type, so adding `inbox` to an existing
    subscription needs no handler change. Inferring `S` from the store was rejected: the store is
    resolved at `onInit`, after type-checking.
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-types.test.ts` (type-level: the
  three-argument call returns `SubscriptionDefinition`; an options variable carrying `inbox` returns
  `RegistryFactory`; `ReturnType` reads the legacy signature; `S` inferred from the annotation; a
  misspelled option key refused; `@ts-expect-error` on assigning the inbox form to
  `SubscriptionDefinition`).

### 3.4 The consumer name and the broker queue

- **Decision:** `IntegrationEventInboxOptions.consumer` is REQUIRED and validated at the
  `onIntegrationEvent` call with `publishIdProblem` (a `TypeError` naming the option, never echoing
  the value). The broker queue defaults to it: `queue = options.queue ?? consumer`. Within one inbox
  service, a second subscription with the same `(consumer, topic)` is refused at resolution with
  `InboxConsumerConflictError`.
- **Why:**
  - The key is `(consumer, envelope id)`, so the name must be stable across deployments and
    identical across replicas; M109a's `IngressContext.consumer` is neither for a queue-less
    subscriber (§1).
  - Defaulting the queue is what makes redelivery real: on RabbitMQ a queue-less subscriber gets an
    exclusive queue whose failures are discarded (§1), so an inbox on it would de-duplicate nothing.
    The default changes no released behaviour — the `inbox` option is new — and an inbox already
    makes every replica's copy of a fan-out message a duplicate, so a shared group only removes the
    wasted transactions.
  - Two handlers sharing a consumer name on one topic would each suppress the other's work —
    silently — so the in-process case is refused; the cross-process case cannot be detected and is
    documented.
- **Test home:** `inbox-subscribe.test.ts`.

### 3.5 The inbox row, the discriminator and the keys

- **Decision:** one record shape, `InboxRecord` in `common`, every field a JSON scalar:

  | Field        | Type                                                     | Meaning                                                                                             |
  | ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
  | `id`         | `string`                                                 | the marker id, or the marker id plus `.attempts` — primary key (below)                              |
  | `kind`       | `'setu-inbox'`                                           | the discriminator: written on every row, required by every read                                     |
  | `consumer`   | `string`                                                 | the consumer name — read by `IInbox.parked()`                                                       |
  | `topic`      | `string`                                                 | the subscription topic — read by `IInbox.parked()`                                                  |
  | `envelopeId` | `string` (absent unless it passes `publishIdProblem`)    | the envelope id, for the operator — read by `IInbox.parked()`; an id the rule refuses is not stored |
  | `status`     | `'processed' \| 'parked' \| 'discarded' \| 'attempting'` | a marker is `processed`/`parked`/`discarded`; the attempts row is `attempting`                      |
  | `attempts`   | `number`                                                 | failures recorded (§3.8); a parked marker copies the final count — read by `IInbox.parked()`        |
  | `updatedAt`  | `number`                                                 | `runtime.now()` at the row's last write — the retention clock                                       |
  | `lastError`  | `string` (absent when none)                              | `describeError(error)` cut to 1024 characters — read by `IInbox.parked()`                           |
  | `envelope`   | `string` (absent unless `parked` and within the cap)     | the delivered envelope as received — returned by `release('retry')` (§3.9)                          |

  - **Keys are hashed.** The marker id is the lowercase hex SHA-256 (`runtime.subtle`) of
    `JSON.stringify(['setu-inbox/1', consumer, envelopeId.toWellFormed()])`; the attempts id is the
    marker id followed by `.attempts`. Every id is therefore 64 or 73 characters from `[0-9a-f.]` on
    every backend, whatever the producer sent. JSON-array encoding keeps the hashed input injective;
    `setu-inbox/1` versions the derivation. Derivation is internal to `messaging-plugin`
    (`inbox/inbox-key.ts`): the port receives ids, so a custom store never re-derives them.
  - **The marker and the attempts row are separate rows.** The marker's INSERT is the authority on
    "handled" (§3.6); folding the failure count into it would turn that insert into a
    read-then-update, and two concurrent attempts would both pass.
  - **The discriminator is one rule on every backend** (M107 §3.2, inherited by name in the
    ROADMAP): the bridge writes `kind: 'setu-inbox'` on every row, conjoins it to the `where` of
    every read (`find`, `parked`, `stats`, `purge`), and treats a row of another `kind` as missing.
- **Why:** the first draft used the raw JSON array as the id. The verification round measured its
  worst case at about 530 bytes (`JSON.stringify` doubles `"` and `\`, which `publishIdProblem`
  allows), and an envelope id the rule refuses could not be keyed at all — so on NATS and Kafka,
  which have no delivery budget, such a message would loop for ever before parking could see it.
  Hashing accepts any string id with a fixed-size key. `toWellFormed()` makes ill-formed ids (lone
  surrogates, reachable only through a `\ud800` JSON escape) collide with their replacement form,
  which is an adversarial-only case, stated. Numbers, not `Date` (M107 §3.2).
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-key.test.ts` (separator-bearing
  pairs hash differently; a 10 KB id and an id with every forbidden character key normally; fixed
  length and alphabet; the attempts id never equals any marker id);
  `packages/database-plugin/test/unit/inbox/inbox-columns.test.ts`; `inbox-discriminator.test.ts`.

### 3.6 Delivery: the algorithm, and what counts as a duplicate

- **Decision:** the inbox wrapper, per delivery, in order:
  1. `validateEnvelope(raw, definition)` — unchanged; a malformed envelope is refused before any
     inbox work, exactly as today.
  2. Refuse with `InboxNotReadyError` once the inbox has closed (§3.11).
  3. Derive the ids (§3.5).
  4. **Pre-read:** `store.find(markerId)` (bounded, §3.7). A marker in any status → return
     (acknowledge); the handler does not run.
  5. `definition.parse(envelope.data)` — a rejection follows §3.8.
  6. `store.run(marker, (scope) => handler(payload, delivered, metadata, scope))`, where `marker` is
     `{ status: 'processed', attempts: 0, updatedAt: now, … }`. The bridge opens ONE transaction,
     creates the marker FIRST, then runs the handler with the unit of work.
  7. On ANY rejection from `run`, a second `store.find(markerId)`: a marker present → return
     (acknowledge), whatever the error class; otherwise the original error is the handler's failure
     (including a business `DuplicateKeyError`) → §3.8.
- **Why:**
  - The marker's insert is what makes it once: on PostgreSQL a concurrent second insert blocks on
    the unique index until the first transaction ends, then fails or succeeds with it; the deferred
    backends (memory, DynamoDB, D1) refuse the duplicate at commit; a MongoDB replica set rejects
    the loser with a write conflict. In every case the losing transaction rolls back its business
    writes.
  - The re-read is required on every rejection, not only a duplicate: a commit-time
    `DuplicateKeyError` carries no entity, a MongoDB loser is a `SerializationConflictError`, and a
    DynamoDB `TransactionConflict` is unmapped (§1, C2). A present marker is safe to acknowledge for
    any error, because a committed marker means the work committed (or was parked, §3.8). Keying on
    `DuplicateKeyError` alone — the first draft — sent the MongoDB and DynamoDB losers down the
    failure path, burning a broker retry and possibly parking an event that had succeeded.
  - The pre-read is an optimisation that is also a guarantee about non-database effects: on the
    deferred backends the handler runs BEFORE the commit can refuse, so without the pre-read every
    sequential duplicate would re-run the handler's outside-world effects. With it, only genuinely
    concurrent duplicates do (§3.12). On DynamoDB, whose reads are eventually consistent (§1), a
    sequential duplicate inside the consistency window can still re-run them — documented.
  - The envelope id needs no validation step: hashing (§3.5) accepts any string, so no deterministic
    refusal is introduced that NATS or Kafka would loop on.
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-delivery.test.ts` (every branch,
  with a fake store whose `run` rejects with a duplicate, a conflict and an arbitrary error, each
  with and without a marker present); `inbox-real.test.ts` (§6).

### 3.7 Bounds

- **Decision:** `find`, `recordFailure`, `park`, `parked`, `release`, `purge` and `verify` are
  bounded by `inbox.storeTimeoutMs` (default 5000) through `withDeadline`; `stats` is bounded by the
  health probe (§3.11). An expired bound is a failure of that call: a delivery rejects, so the
  broker redelivers; an operator call rejects; a purge run ends and the next interval retries. `run`
  is NOT bounded: it contains the application's handler, and an abandoned transaction cannot be
  cancelled from outside — the database's own statement and transaction timeouts govern it (Prisma
  `transactionTimeout`, a pool timeout), documented.
- **Why:** the M101a rule — every backend call is bounded and an expired bound is a recorded failure
  — applies to every call the inbox owns; bounding the handler would report a timeout while the
  transaction later commits.
- **Test home:** `inbox-delivery.test.ts`, `inbox-release.test.ts` (a never-settling store call
  rejects after the bound).

### 3.8 Failures, counting and parking

- **Decision:** `inbox.maxAttempts` (optional; absent by default).
  - **Absent:** a handler failure rethrows unchanged, so the broker's own behaviour applies. The
    README states it per broker: RabbitMQ (durable named queue, `consumerRetry` enabled) and Redis
    Streams retry and dead-letter; Service Bus and Pub/Sub use their platform delivery count and
    dead-letter policy; **NATS redelivers without limit and Kafka blocks the partition** — the
    README tells their users to set `maxAttempts`; the in-memory broker reports and drops.
  - **Set:** after a handler failure,
    `store.recordFailure(ids, { consumer, topic, envelopeId?, lastError, now })` writes the attempts
    row OUTSIDE the rolled-back transaction (create, or read and update, returning the new count).
    When the count reaches `maxAttempts`, `store.park(record)` inserts the marker with
    `status: 'parked'`, the final count, `lastError` and the received envelope (when within
    `maxParkedEnvelopeBytes`, default 262 144; absent otherwise), and the delivery is ACKNOWLEDGED —
    so a Kafka partition is unblocked and every later redelivery is skipped by the pre-read. A
    `park` that finds a marker already present (another delivery committed) also acknowledges. A
    failing `recordFailure` or `park` is logged at `warn` and the ORIGINAL handler error is
    rethrown.
  - **A parse rejection parks at once** when `maxAttempts` is set (redelivery cannot resolve a
    deterministic rejection, and a parked envelope can be retried after the schema is fixed); with
    `maxAttempts` absent it throws `IntegrationEventRejectedError` exactly as today.
  - **The count is a lower bound.** `recordFailure` is a read-then-write without a conditional write
    (M105 owns one), so two concurrent failures can record one increment; parking can come one
    attempt late, never early.
  - **A concurrent success can lose to a park on the deferred backends.** On memory, D1 and DynamoDB
    a delivery's `park` can commit while a sibling delivery's successful transaction is still
    buffered; the sibling's commit then fails, re-reads the parked marker and acknowledges. The
    event ends parked although its work had been rolled back — recoverable through
    `release('retry')`, and documented.
- **Why:** `IngressContext.attempt` is absent for messaging by contract and the marker is rolled
  back with the handler, so the count must live outside the transaction. Parking is opt-in because
  two shipped brokers already dead-letter, and two budgets on one subscription would make the
  effective limit the smaller of two numbers set in different places.
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-failure.test.ts`.

### 3.9 Operator listing and release

- **Decision:**
  - `IInbox.parked(limit?)` lists parked markers (default 100, at most 1000) as
    `{ rowId, consumer, topic, envelopeId?, attempts, updatedAt, lastError? }` — never the envelope.
  - `IInbox.release(rowId, action: 'retry' | 'discard')`, `rowId` being a marker id from `parked()`
    (validated as 64 lowercase hex characters):
    - `retry`: the parked marker and its attempts row are DELETED, and the call resolves
      `{ topic, envelope? }` with the stored envelope parsed (absent when it was too large to
      store). The operator re-publishes it with `broker.publish(topic, envelope)` and the next
      delivery to this consumer runs the handler. The recipe deliberately passes NO
      `deduplicationId`: NATS and Service Bus map it to their own de-duplication ids (§1) and would
      drop a re-publish inside their window.
    - `discard`: the marker becomes `discarded` (its `envelope` cleared to `null`), the attempts row
      is deleted, and redeliveries stay skipped; retention then purges it.
    - A `missing` or `not-parked` outcome rejects `InboxRowStateError` naming the outcome, never the
      row's contents.
  - The inbox never re-runs a handler itself: a local re-run would bypass the messaging behaviour
    chain (M86), which may carry the tenant guard or audit behaviour the application depends on.
- **Why:** M107's `release(id, 'retry' | 'discard')` shape, so an operator learns one verb; a row id
  rather than `(consumer, envelopeId)` because an envelope id the operator cannot read (refused by
  `publishIdProblem`, so not stored) must still be addressable. A re-publish reaches every consumer
  group of the topic; groups using an inbox skip it, groups without one process it again — the
  README says so.
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-release.test.ts`;
  `packages/database-plugin/test/unit/inbox/inbox-store-ops.test.ts`.

### 3.10 The `IInboxStore` port, per-backend support and the startup check

Every method returns a promise that REJECTS on failure, never throws synchronously. `InboxIds` is
`{ marker: string; attempts: string }`.

| Method          | Signature                                                                                    | Behaviour                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find`          | `(markerId: string) => Promise<InboxRecord \| undefined>`                                    | read of the marker by id; another `kind` → `undefined`                                                                                                                                             |
| `run`           | `<R>(marker: InboxRecord, work: (scope: unknown) => Promise<R>) => Promise<R>`               | ONE transaction: `create(marker)`, then `work(uow)`; commit; any rejection rolls back and propagates                                                                                               |
| `recordFailure` | `(ids: InboxIds, update: InboxFailureUpdate) => Promise<number>`                             | non-transactional: create the attempts row with `attempts: 1`, or read it and update `attempts + 1`; returns the new count                                                                         |
| `park`          | `(marker: InboxRecord) => Promise<'applied' \| 'exists'>`                                    | non-transactional create of a `parked` marker; any rejection followed by a re-read finding a marker → `'exists'`                                                                                   |
| `parked`        | `(limit: number) => Promise<readonly InboxRecord[]>`                                         | `where { kind, status: 'parked' }`, `select` every column but `envelope`, `limit`                                                                                                                  |
| `release`       | `(ids: InboxIds, action: 'retry' \| 'discard', now: number) => Promise<InboxReleaseOutcome>` | read the marker; only from `parked`: `retry` deletes it and the attempts row and answers the record; `discard` updates it to `discarded` and deletes the attempts row                              |
| `stats`         | `() => Promise<{ readonly parked: number }>`                                                 | `count({ kind, status: 'parked' })`                                                                                                                                                                |
| `purge`         | `(before: number, limit: number) => Promise<number>`                                         | for `processed`, `discarded`, `attempting` (one equality query each): `where { kind, status }`, `filter updatedAt < before`, `select ['id']`, `limit`; delete each; `parked` rows are never purged |
| `verify`        | `() => Promise<void>`                                                                        | below                                                                                                                                                                                              |

- **`verify()`** runs at `onInit`, before the service activates:
  1. The adapter type is read through an INTERNAL `adapterTypeOf(service)` in
     `database-plugin/src/services/database-service.ts` (not barrel-exported; `undefined` for an
     `IDatabaseService` that is not this package's `DatabaseService`). `'cosmos'` and `'bigtable'`
     are refused immediately by name.
  2. The purge's first query with `before: 0` and `limit: 1`.
  3. A transactional probe that creates TWO probe rows (a marker id derived from a `runtime.uuid()`,
     and its attempts id, both `status: 'attempting'`) and then throws a private sentinel, so the
     transaction always rolls back. The sentinel is expected; any other rejection is a refusal. This
     is what catches a standalone MongoDB and a custom adapter with a one-row-per-transaction bound.

  A refusal becomes `InboxStoreUnavailableError` naming the entity, with the adapter error as
  `cause` when there is one, and a reason from a fixed vocabulary: `cosmos-unsupported`,
  `bigtable-unsupported`, `mongodb-standalone` (the measured code-20 `IllegalOperation`, M107 §1),
  `transaction-scope` (a `BigtableTransactionScopeError`-shaped refusal at the second probe row), or
  `entity-unavailable`. The probe writes nothing that survives: every backend rolls the transaction
  back, and the deferred backends send nothing at all.

  | Backend  | Marker + business rows in one transaction                                      | Verdict                                                                                                                                                                                                      |
  | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | memory   | yes — overlay across entities                                                  | supported (single process)                                                                                                                                                                                   |
  | Prisma   | yes — one interactive `tx`                                                     | supported; table must exist                                                                                                                                                                                  |
  | Drizzle  | yes — one interactive `tx`                                                     | supported; `drizzleTables` must register the inbox table                                                                                                                                                     |
  | MongoDB  | yes on a replica set; standalone refused at the first in-transaction operation | supported on a replica set; standalone refused at startup by name                                                                                                                                            |
  | DynamoDB | yes — one `TransactWriteItems`, ≤100 writes INCLUDING the marker               | supported; purge and the health count are a `Scan` without an index, so a GSI `{ partitionKey: 'status', sortKey: 'updatedAt' }` is required for a large table (documented); reads are eventually consistent |
  | Cosmos   | one partition per batch; the marker cannot share the business partition        | refused at startup by name                                                                                                                                                                                   |
  | Bigtable | no — one row per transaction                                                   | refused at startup by name                                                                                                                                                                                   |
  | D1       | yes — one `db.batch()`; the marker carries an explicit key                     | supported; table must exist                                                                                                                                                                                  |

- **Why:** the startup check turns an unusable backend into a named startup failure rather than a
  subscription that fails every delivery (the M52c binding-guard shape). Cosmos was "supported
  through an `aggregateId` partition path" in the first draft; the verification round showed the
  probe rows and the attempts row carry no partition key, so `create` throws there (§1) and Cosmos
  could never pass `verify` — and an envelope without `aggregateId` could never be keyed. Supporting
  it needs a per-application partition selector, which is follow-up work.
- **Test home:** `packages/database-plugin/test/unit/inbox/inbox-verify.test.ts`;
  `inbox-store-ops.test.ts`; `inbox-store-contract.test.ts` (the port contract against the bridge,
  through an internal test helper, not an export — the M107 precedent).

### 3.11 Plugin composition, retention, close and health

- **Decision:**
  - `resolveInboxOptions` validates at plugin construction (synchronous refusals naming the option;
    every number a finite integer in range — the M90a fail-open class): `store` (required, an
    `IInboxStore` or a `RegistryFactory`), `maxAttempts` (1–1000), `retainMs` (default 7 days,
    minimum 60 000), `storeTimeoutMs` (default 5000, 1–2 147 483 647), `maxParkedEnvelopeBytes`
    (default 262 144, 0–67 108 864), `purge.schedule` (default `true`), `purge.intervalMs` (default
    60 000), `purge.batch` (default 100, 1–100 000).
  - `register()` registers the `IInbox` under `inbox` / `inbox.<name>` and the `inbox` health
    indicator under the same token, and registers its `onInit` hook BEFORE the subscription hook (so
    the store is verified first). `provides` gains the token; `optionalDependencies` gains
    `CAPABILITIES.SCHEDULER` only when an inbox is configured.
  - `onInit`: with `purge.schedule`, refuse with `InboxPurgeUnscheduledError` when no scheduler is
    registered; resolve the store; `verify()` bounded by `storeTimeoutMs`
    (`InboxStoreVerifyTimeoutError`); activate; schedule `inbox-purge` (`inbox-purge.<name>`) with
    `every(purge.intervalMs)` calling `IInbox.purge()`, which deletes up to `purge.batch` rows per
    status settled before `now - retainMs`.
  - **Close.** The purge job is removed in `onShutdown`. The service closes in an `onClose` hook
    registered AFTER the broker's own `onClose` hook (`messaging-plugin.ts:487`), so consumption has
    stopped before the inbox refuses deliveries. Closing in `onShutdown` — the outbox drain's phase
    — was rejected: `onShutdown` runs before every `onClose`, so the broker would keep consuming
    into a closed inbox and every in-flight message on a rolling deploy would be refused (a burned
    retry on RabbitMQ, a discard on the in-memory broker).
  - **Health (`inbox`, `live-state`):** `down` before activation and once closed; otherwise
    `store.stats()` through `createCachedProbe` (TTL 5 s, bound 2 s, fallback `undefined`) — `down`
    with `reachable: false` when the store rejects; `up` with `reachable: 'unknown'` when the bound
    expires (the messaging-indicator V5-2 rule: a slow count is not an outage, which matters on a
    DynamoDB `Scan`); `degraded` with reason `parked-rows` when `parked > 0`; `data` carries the
    count only — never a consumer, topic, envelope id or error text.
- **Why:** retention must exceed broker redelivery plus the outbox's re-send window, or a re-send
  older than the marker is processed again; the README states it with M107's crash table. Parked
  rows are the operator's evidence and are never purged automatically.
- **Test home:** `packages/messaging-plugin/test/unit/inbox/inbox-options.test.ts`;
  `inbox-plugin.test.ts` (a real kernel app with the real `SchedulerPlugin` and memory database);
  `inbox-health.test.ts`.

### 3.12 Effects outside the database

- **Decision:** nothing in code; the README names the three choices with one example each: record
  BEFORE the effect (at most once — send inside the handler after the inbox insert, accepting a lost
  send if the transaction then fails); record AFTER (at least once — the default shape); or forward
  a derived key the provider de-duplicates (`${consumer}:${envelope.id}` as the provider's
  idempotency key), which is once where the provider supports it. It also states the caveats from
  §3.6: a concurrent duplicate on memory, DynamoDB or D1 runs the handler before the commit refuses
  it, and DynamoDB's eventually consistent pre-read can miss a just-committed marker.
- **Test home:** the README fences compile under `test/package-readme-fence-compiler.test.ts`.

### 3.13 The promise

Stated once, in the README and the `onIntegrationEvent` JSDoc: for one consumer name, the handler's
writes through the supplied unit of work are committed at most once per envelope id while the marker
is retained; a delivery after the marker is purged is processed again. Nothing is promised about
effects outside that unit of work (§3.12), about two processes using one consumer name with
different handlers (§3.4), or about a database other than the store's.

### 3.14 Provisioning

- **Decision:** DDL templates in the messaging README for PostgreSQL and SQLite/D1 (the M107
  precedent), sized from §3.5 (`id` 73 characters), committed as
  `packages/database-plugin/test/fixtures/inbox-postgres.sql` and `inbox-sqlite.sql` and executed by
  the real-backend tests, so the documented DDL is the tested DDL.
- **Test home:** `inbox-real.test.ts`, `inbox-backends-real.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `CAPABILITIES` gains a member; `MessagingCommonOptions` gains
an optional arm; `onIntegrationEvent` gains an overload, and the legacy signature (still the last
declared) only adds `inbox?: never` to its options.

| Exported symbol                                                                                                                                                   | Kind      | Consumer / real code path that READS it                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.INBOX` (`common`)                                                                                                                                   | token     | `messaging-plugin` registers under it; the `onIntegrationEvent` factory resolves it                     |
| `INBOX_RECORD_KIND` (`common`)                                                                                                                                    | const     | the bridge writes and filters on it                                                                     |
| `InboxRecord`, `InboxStatus`, `InboxIds`, `InboxFailureUpdate`, `InboxReleaseOutcome`, `InboxStoreStats` (`common`)                                               | types     | port signatures; the service builds records and ids; the bridge maps rows                               |
| `IInboxStore` (`common`)                                                                                                                                          | interface | implemented by the bridge; called by `InboxService`                                                     |
| `createDatabaseInboxStore`, `DatabaseInboxStoreOptions` (`database-plugin`)                                                                                       | fn, type  | an application's `MessagingPlugin({ inbox: { store } })`                                                |
| `InboxStoreUnavailableError` (`database-plugin`)                                                                                                                  | class     | thrown by the bridge's `verify()`, rejecting `start()`                                                  |
| `IInbox` (`messaging-plugin`)                                                                                                                                     | interface | an operator resolves `CAPABILITIES.INBOX` and calls `parked`/`release`/`purge`; the scheduled purge job |
| `InboxOptions`, `InboxStoreEntry`, `ParkedInboxEntry`, `InboxReleaseResult`                                                                                       | types     | `MessagingCommonOptions.inbox`; the returns of `IInbox.parked` and `IInbox.release`                     |
| `IntegrationEventInboxHandler`, `IntegrationEventInboxOptions`, `IntegrationEventSubscribeOptions`                                                                | types     | the `onIntegrationEvent` inbox overload                                                                 |
| `InboxNotConfiguredError`, `InboxConsumerConflictError`, `InboxNotReadyError`, `InboxPurgeUnscheduledError`, `InboxStoreVerifyTimeoutError`, `InboxRowStateError` | classes   | each thrown on exactly one path named in §3; `instanceof` by applications                               |

### 4.1 Options — every option names its consumer

| Option                                            | Consumer                                                     | Behavior (per implementation)                                   |
| ------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `inbox.store`                                     | `onInit` resolve + `verify`                                  | every delivery, purge, listing, stats and release               |
| `inbox.maxAttempts`                               | `InboxService` failure path                                  | absent → rethrow; set → count and park (§3.8)                   |
| `inbox.retainMs`                                  | `IInbox.purge`                                               | `before = now - retainMs`                                       |
| `inbox.storeTimeoutMs`                            | `withDeadline` around every store call but `run` and `stats` | §3.7                                                            |
| `inbox.maxParkedEnvelopeBytes`                    | `park` record building                                       | larger envelopes are parked without `envelope`                  |
| `inbox.purge.schedule` / `.intervalMs` / `.batch` | `onInit` scheduling; `purge`                                 | §3.11                                                           |
| `IntegrationEventInboxOptions.consumer`           | the key; the default queue; the conflict registry            | §3.4                                                            |
| `IntegrationEventInboxOptions.instance`           | the factory's token choice                                   | resolves `inbox.<instance>`                                     |
| `DatabaseInboxStoreOptions.entity` / `.database`  | the bridge                                                   | entity name (default `'Inbox'`); `database` / `database.<name>` |

## 5. Implementation files

| File                                                         | Purpose                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/common/src/services/inbox.ts`                      | port, records, discriminator                                                   |
| `packages/common/src/tokens.ts`                              | `INBOX`                                                                        |
| `packages/common/src/index.ts`                               | barrel                                                                         |
| `packages/database-plugin/src/inbox/database-inbox-store.ts` | the bridge and `createDatabaseInboxStore`                                      |
| `packages/database-plugin/src/inbox/errors.ts`               | `InboxStoreUnavailableError`                                                   |
| `packages/database-plugin/src/services/database-service.ts`  | internal `adapterTypeOf`                                                       |
| `packages/database-plugin/src/index.ts`                      | barrel                                                                         |
| `packages/messaging-plugin/src/inbox/options.ts`             | `resolveInboxOptions`                                                          |
| `packages/messaging-plugin/src/inbox/inbox-key.ts`           | hashed id derivation (internal)                                                |
| `packages/messaging-plugin/src/inbox/inbox-service.ts`       | `InboxService` (`IInbox`), the delivery path, the conflict registry, `WeakMap` |
| `packages/messaging-plugin/src/inbox/inbox-health.ts`        | the `inbox` indicator                                                          |
| `packages/messaging-plugin/src/inbox/errors.ts`              | the six error classes                                                          |
| `packages/messaging-plugin/src/integration/subscribe.ts`     | the overloads and the inbox factory                                            |
| `packages/messaging-plugin/src/interfaces/index.ts`          | `InboxOptions`, `IInbox`, the handler and option types                         |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`   | `registerInbox`, provides/dependencies, close ordering                         |
| `packages/messaging-plugin/src/index.ts`                     | barrel                                                                         |
| `packages/cli/src/utils/plugin-claims.ts`                    | messaging-plugin claims `['messaging', 'outbox', 'inbox']`                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Real-backend suites guard with `ignore:` on their env vars — never an early return (M70c). CI
already runs PostgreSQL (`OUTBOX_POSTGRES_URL`, port 5433), the MongoDB replica set
(`MONGODB_RS_URI`, 27018), RabbitMQ, Redis and the Bigtable emulator (M107), so no workflow change
is needed. The real suites live in `messaging-plugin`, whose grants already cover those endpoints
(the M107 decision), and no `deno.json` changes are needed.

| Test file                                                                                                                            | src covered                                             | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/inbox-contract.test.ts`                                                                                   | `services/inbox.ts`                                     | type-level: a minimal store implements `IInboxStore`; `INBOX_RECORD_KIND` value                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                                                                        | `index.ts`, `tokens.ts`                                 | new exports present; `CAPABILITIES.INBOX === 'inbox'`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/database-plugin/test/unit/inbox/inbox-columns.test.ts`                                                                     | `database-inbox-store.ts`                               | round trip; optionals written `null`, read back absent; `kind` written                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/database-plugin/test/unit/inbox/inbox-discriminator.test.ts`                                                               | `database-inbox-store.ts`                               | business rows with `status: 'processed'`/`'parked'` in the SAME entity are never found, listed, counted, released or purged                                                                                                                                                                                                                                                                                                                            |
| `packages/database-plugin/test/unit/inbox/inbox-store-ops.test.ts`                                                                   | `database-inbox-store.ts`                               | every port method, every missing / wrong-status branch; `run` rolls back the marker when work rejects; `park` → `'exists'` on a present marker; `parked` never selects `envelope`                                                                                                                                                                                                                                                                      |
| `packages/database-plugin/test/unit/inbox/inbox-verify.test.ts`                                                                      | `database-inbox-store.ts`, `errors.ts`, `adapterTypeOf` | each reason: Cosmos and Bigtable services refused by type; the real `BigtableTransactionScopeError` and the measured Mongo code-20 shape refused through the probe; the sentinel rollback leaves no row (memory); a non-`DatabaseService` implementation skips the type check                                                                                                                                                                          |
| `packages/database-plugin/test/unit/inbox/inbox-store-contract.test.ts`                                                              | the bridge                                              | the port contract helper against the memory bridge                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/messaging-plugin/test/unit/inbox/inbox-key.test.ts`                                                                        | `inbox/inbox-key.ts`                                    | §3.5 rows                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/messaging-plugin/test/unit/inbox/inbox-options.test.ts`                                                                    | `inbox/options.ts`                                      | every option's range, `NaN`, fractions, the store form                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/messaging-plugin/test/unit/inbox/inbox-types.test.ts`                                                                      | `subscribe.ts` (types)                                  | §3.3 type-level rows                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/messaging-plugin/test/unit/inbox/inbox-subscribe.test.ts`                                                                  | `subscribe.ts`, `inbox-service.ts`                      | token missing / foreign provider → `InboxNotConfiguredError`; resolution before verification → `InboxNotReadyError`; `(consumer, topic)` conflict; `inbox` not forwarded; `queue` defaults to `consumer` and an explicit `queue` wins; `instance` resolves `inbox.<name>`; a bad `consumer` refused at the call                                                                                                                                        |
| `packages/messaging-plugin/test/unit/inbox/inbox-delivery.test.ts`                                                                   | `inbox-service.ts`                                      | §3.6 every step: duplicate, conflict and arbitrary `run` rejections each with and without a marker; a business duplicate with no marker is a failure; closed → `InboxNotReadyError`; bound on `find`                                                                                                                                                                                                                                                   |
| `packages/messaging-plugin/test/unit/inbox/inbox-failure.test.ts`                                                                    | `inbox-service.ts`                                      | §3.8: absent → rethrow; set → count, park at the limit, acknowledge; parse rejection parks at once; failing `recordFailure`/`park` rethrows the original; oversized envelope parked without it; a refused envelope id parked without `envelopeId`                                                                                                                                                                                                      |
| `packages/messaging-plugin/test/unit/inbox/inbox-release.test.ts`                                                                    | `inbox-service.ts`, `errors.ts`                         | `parked` shape and limit; retry/discard outcomes; `InboxRowStateError`; a malformed `rowId` refused; bounds                                                                                                                                                                                                                                                                                                                                            |
| `packages/messaging-plugin/test/unit/inbox/inbox-health.test.ts`                                                                     | `inbox-health.ts`                                       | down before activation and after close; `parked-rows`; store rejection → `down`; bound expiry → `up`/`unknown`; `data` has no consumer, topic or id                                                                                                                                                                                                                                                                                                    |
| `packages/messaging-plugin/test/integration/inbox-plugin.test.ts`                                                                    | `messaging-plugin.ts`                                   | real kernel app + `SchedulerPlugin` + memory database: duplicate skipped; two consumer names each run once; failure rolls back the business row AND the marker, then a second delivery of the same envelope succeeds (the in-memory broker does not redeliver); purge job removes old markers; `InboxPurgeUnscheduledError`; `verify` runs before the subscription is established; a delivery during `stop()` still runs while the broker is connected |
| `packages/messaging-plugin/test/integration/inbox-real.test.ts`                                                                      | the whole path                                          | real PostgreSQL + real RabbitMQ 4, and + real Redis Streams: a duplicate delivery skipped and acknowledged; a handler failure rolls back both, then succeeds on redelivery; two consumer groups each process once; end to end with M107 — an outbox row published twice (the §3.13 crash shape) is handled once                                                                                                                                        |
| `packages/messaging-plugin/test/integration/inbox-backends-real.test.ts`                                                             | the bridge on real backends                             | PostgreSQL: two concurrent `run`s for one key → one commits, the other rejects and the re-read finds the marker; MongoDB replica set: the same, the loser rejecting with a conflict or a duplicate; Bigtable emulator refused at `verify`; standalone MongoDB refused                                                                                                                                                                                  |
| `packages/messaging-plugin/test/unit/barrel-exports.test.ts`, `packages/database-plugin/test/unit/barrel-exports.test.ts` (extended) | `index.ts`                                              | new exports present; `InboxService`, `adapterTypeOf` and the key derivation absent                                                                                                                                                                                                                                                                                                                                                                     |
| `test/plugin-claims-gate.test.ts`, `test/health-indicator-audit.test.ts`                                                             | the claim table, the docs                               | the new derived name (`inboxToken`) and site                                                                                                                                                                                                                                                                                                                                                                                                           |

**Negative controls (each observed failing, then reverted):** re-read only on `DuplicateKeyError`
(the conflict-with-marker case is counted as a failure); no re-read at all (a business duplicate is
acknowledged); remove the pre-read (a deferred-backend sequential duplicate re-runs the handler);
forward `inbox` to `broker.subscribe`; drop the queue default; drop `kind` from one read (the
discriminator test fails); remove the `(consumer, topic)` refusal; let `verify` ignore the second
probe row (the one-row-per-transaction double passes); close the inbox in `onShutdown` (the
delivery-during-stop case is refused); swap the overload order (the options-variable type row
fails).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m108-consumer-inbox
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task check:docs
deno task test              # with the full-backend env block, once, to a log
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree
deno task release:verify 0.8.0
```

## 8. Risks & mitigations

- A long handler holds a PostgreSQL connection while a concurrent duplicate waits on the unique
  index → documented; the broker's prefetch bounds the waiters.
- The transactional probe in `verify()` writes, unlike M107's → every backend rolls it back and the
  deferred backends send nothing; the test asserts no probe row survives on the memory adapter and
  on PostgreSQL.
- A parked envelope may carry personal data at rest indefinitely → `discard` clears it; the README
  states that parked rows count toward erasure and are never purged automatically.
- A team deploys two services with one consumer name on one topic → refused in process; documented
  across processes.
- `adapterTypeOf` reads a TypeScript-`private` field → it lives in `database-service.ts` beside the
  class, so no cast crosses a module boundary.

## 9. Out of scope

- Tier C `within()` — M109b.
- Cosmos (a partition selector) and Bigtable — refused at startup; unowned.
- Per-tenant inbox stores — unowned; the envelope carries no tenant.
- Inbox metrics instruments — unowned additive follow-up.
- A conditional failure counter — M105.
- A strongly consistent DynamoDB inbox read — the adapter sets no `ConsistentRead`; unowned.
- Re-running a parked delivery in process — rejected (§3.9: it would bypass the behaviour chain).
- Workers-specific wiring: D1 works through the bridge as a `'custom'` adapter with no
  `cloudflare-plugin` change, and the purge runs from a Cron Trigger with `purge.schedule: false`;
  not driven on workerd in this milestone (§12).

## 10. Design security review (recorded before implementation)

Recorded 2026-10-09, before any implementation, and revised the same day after one independent
verification of this plan against source.

**Flows reviewed.** A delivered envelope (from any producer that can publish to the topic) entering
the wrapper; its id hashed into a database key; the marker and the application's writes in one
transaction; the failure count and the parked envelope written outside it; the operator `parked`
listing and `release`; the purge job; the health payload and log lines leaving the process.

**Assets.** The once-only guarantee per consumer; business data in a shared entity or container;
parked payloads at rest; availability of the subscription; log and health integrity.

**Attackers.**

- (A1) A producer — or anyone with broker publish rights — choosing an envelope `id`.
- (A2) Someone with write access to the inbox table but not the broker.
- (A3) A reader of logs and health.
- (A4) A flood of distinct envelopes.

**Approved budgets.** Per delivery: one hash, one bounded read; one transaction holding one insert
plus the handler; on any `run` rejection one more bounded read; on failure with parking enabled, one
bounded upsert and at most one bounded insert. Per purge interval: at most `purge.batch` deletes per
status. In memory: the `(consumer, topic)` registry, bounded by the number of declared
subscriptions. Nothing in memory grows with traffic.

**Design-time findings.**

| #   | Finding                                                                                                                        | Disposition                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | An unbounded or control-character envelope id bloats rows or forges log lines (A1)                                             | Only its SHA-256 reaches the key; the raw id is stored only when it passes `publishIdProblem`, and never logged (§3.5)                                                                                                                            |
| D2  | A producer pre-claims a victim event's id so the real event is skipped (A1)                                                    | Accepted: ids are producer-assigned random v4 UUIDs, and a party able to publish to the topic can already inject arbitrary events; the README says the inbox is not authentication                                                                |
| D3  | Two different (consumer, id) pairs whose naive concatenation is equal merge two consumers' records                             | JSON-array encoding before hashing (§3.5); tested with separator-bearing pairs                                                                                                                                                                    |
| D4  | A business error read as "already handled", acknowledging a delivery whose writes never happened                               | Acknowledge only when a re-read finds the marker (§3.6), with a negative control                                                                                                                                                                  |
| D5  | Business documents in a shared entity read, listed, counted, released or purged as inbox rows                                  | Discriminator on every read (§3.5)                                                                                                                                                                                                                |
| D6  | An edited row marks an event handled, or plants a parked envelope that `release('retry')` hands an operator to re-publish (A2) | Accepted as M107 D9: write access to the inbox table is a stronger capability than the broker boundary; the README says protect it like the broker credentials. `release` returns the envelope for the operator's decision and never publishes it |
| D7  | Health, listings or logs expose payloads (A3)                                                                                  | Health `data` carries a count only; `parked()` never returns the envelope; logs carry consumer and topic (application-chosen, validated), never ids, envelopes or `lastError` beyond `describeError`                                              |
| D8  | Store growth from a flood of distinct envelopes (A4)                                                                           | Bounded by broker throughput and `retainMs`; documented as a capacity cost                                                                                                                                                                        |
| D9  | Parked payloads retained forever (privacy)                                                                                     | `discard` clears the envelope; parked rows count toward erasure; documented                                                                                                                                                                       |
| D10 | Two subscriptions sharing a consumer name suppress each other's work                                                           | Refused in process (§3.4); documented across processes                                                                                                                                                                                            |
| D11 | A local re-run on `release` bypasses the tenant/audit behaviour chain                                                          | Not offered (§3.9)                                                                                                                                                                                                                                |
| D12 | An unkeyable envelope loops for ever on NATS or Kafka (A1)                                                                     | No envelope id is refused: any string hashes (§3.5)                                                                                                                                                                                               |

**Obligations for the committed-tree audit.** Probe each of D1, D3, D4, D5, D7, D10 and D12 with a
positive control; show the re-read and discriminator negative controls failing; confirm no inbox row
survives `verify()`; confirm a parked envelope is cleared by `discard`.

## 11. Documentation deliverables

- `packages/messaging-plugin/README.md`: an "Inbox" section — the promise (§3.13), the algorithm,
  the per-backend table, the discriminator rule, the DDL templates, retention against the outbox
  crash table, the three outside-effect choices (§3.12), the per-broker delivery budgets and when to
  set `maxAttempts`, the queue default, operator `parked` and `release` (and why the re-publish
  carries no `deduplicationId`), the custom-store contract, D2, D6 and D10.
- `packages/database-plugin/README.md`: `createDatabaseInboxStore` and its backend requirements.
- `PUBLIC_API.md`: the `common` port and token; the bridge; `IInbox`, the options and the overloads,
  each export with JSDoc.
- `CHANGELOG.md` `Unreleased` → Added.
- `docs/health-indicators.md`: the new site classified `live-state`, and the messaging-plugin rows
  whose lines move.
- `ROADMAP.md`: C1–C6 corrections; M108 row and deliverables flipped at completion.
- `docs/upgrading.md`: nothing — no breaking change (§4).

## 12. Claims NOT verified at plan time

Each is an obligation for implementation, measured before the code relies on it.

- **PostgreSQL concurrent-insert behaviour** through the Drizzle adapter: that the second
  transaction's insert blocks and then fails with `23505` once the first commits.
- **DynamoDB purge as a `Scan` with `limit`.** Whether `findAll` fills `limit` across scan pages
  when the filter discards rows; read, not measured.
- **D1 and Workers.** Not driven on workerd (§9).
