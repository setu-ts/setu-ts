# Milestone 15 — Queue Plugin (`@hono-enterprise/queue-plugin`)

> **Status:** Planning. Branch: `feat/m15-queue-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Tooling note (read before review).** This pass was produced in an Architect session with file
> tools only — no shell was available, so `git branch --show-current` and `deno task check:plan`
> could not be executed by the assistant. The plan was authored to satisfy
> [`scripts/plan-lint.ts`](scripts/plan-lint.ts) by construction (all nine required section headings
> present; no template placeholders; no non-canonical file at `plans/` root). The human reviewer
> must (1) confirm or create the branch per Step 0 below, and (2) run `deno task check:plan` and
> paste the output; any lint finding is fixed as a plan first.

## 0. Objective & scope

Milestone 15 adds the background job queue capability to the **existing** (currently stub)
`@hono-enterprise/queue-plugin` package. A single `QueueService` implements the committed, unchanged
[`IQueue`](packages/common/src/services/queue.ts:79) contract from `@hono-enterprise/common` (`add`
/ `process` / `addRecurring`) and is registered under `CAPABILITIES.QUEUE` (`'queue'`). The service
owns the backend-agnostic machinery — a worker poll loop, retry with exponential backoff, per-name
concurrency, and cron-driven recurring scheduling — and delegates storage to a thin internal
[`QueueAdapter`](packages/queue-plugin/src/adapters/queue-adapter.ts) transport seam.

Two transports ship in M15 and are fully real (no stubs): `MemoryQueue` (in-process, for tests and
local dev) and `RedisQueue` (Redis delayed-queue via the proven `npm:ioredis@5` inject-or-lazy seam,
mirroring [`RedisStreamsBroker`](packages/messaging-plugin/src/brokers/redis-streams-broker.ts)).
The Redis queue is driven through a recording fake that asserts the real Redis calls and reads the
written job back, plus one guarded real-import test that enters `loadIoredis()` — the M10
"echo-input adapters at 90% coverage" failure mode is the explicit anti-goal.

- **In scope:**
  - `QueueService` implementing [`IQueue`](packages/common/src/services/queue.ts:79): `add` (with
    [`AddJobOptions`](packages/common/src/services/queue.ts:39) `delayMs` / `maxAttempts`),
    `process` (with [`ProcessOptions`](packages/common/src/services/queue.ts:51) `concurrency`),
    `addRecurring` (with [`RecurringOptions`](packages/common/src/services/queue.ts:61) `cron`).
  - Internal [`QueueAdapter`](packages/queue-plugin/src/adapters/queue-adapter.ts) transport seam
    (connect / disconnect / isReady + delayed-job storage primitives).
  - `MemoryQueue` and `RedisQueue` (ioredis inject-or-lazy) transports.
  - Shared machinery: `JobRunner` (dispatch + retry decision), `computeBackoffMs` (exponential
    backoff), `cronNextMs` (zero-dependency 5-field cron next-fire calculator).
  - `QueuePlugin({ adapter, … })` factory mirroring
    [`MessagingPlugin`](packages/messaging-plugin/src/plugin/messaging-plugin.ts:74) (backend
    selection, multi-instance via `name`, health via `isReady()`, `onClose` disconnect).
  - Barrel exports + per-file unit tests + one integration test + fixtures, all at the per-file 90%
    bar.
  - Documentation corrections in `PUBLIC_API.md`, `ROADMAP.md` (and a `README.md` for the package)
    in the **same PR** (resolving the §2 conflicts).
- **NOT this milestone:**
  - `RabbitMqQueue` adapter — deferred to **M15b**. RabbitMQ is push-based (`consume`), and faithful
    retry-with-backoff needs a dead-letter-exchange plus per-attempt TTL queue machinery that does
    not map onto the polling-based
    [`QueueAdapter`](packages/queue-plugin/src/adapters/queue-adapter.ts) primitives. This mirrors
    the proven M14 → M14b split for messaging brokers (owned by a named follow-up milestone, see
    §9).
  - `BullMQ` — not used. ROADMAP says "RedisQueue — BullMQ-based", but the committed
    [`IQueue`](packages/common/src/services/queue.ts:79) surface is minimal and BullMQ's rich model
    (priority / named backoff strategies / removeOnComplete) fights it while pulling a heavy bundle
    (AI_GUIDELINES §12.2 / §14.4). M15 ships an ioredis-based delayed queue instead (§2 C2).
  - Live-Redis integration test — deferred; the project bar for transport adapters is recording-fake
    plus guarded real-import (M14's RedisStreams precedent, see §9).
  - cron extensions (`L`, `W`, `#`, seconds field, timezone), priority, `removeOnComplete` /
    `removeOnFail`, configurable backoff type — none exist in the committed contract; out of scope
    (§9).
  - Distributed / leader-elected recurring across instances — single-process recurring only;
    distributed locking belongs to the scheduler-plugin's distributed-lock milestone (§9).

## 1. Contracts verified from SOURCE (not names)

Every reference below was opened in the committed source and cited at file:line. The committed
contract is the truth, not the aspirational `PUBLIC_API.md` Queue section (§2 C1).

| Reference                                        | Source (file:line)                                                                                                                                                                                                                                                            | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IQueue`                                         | [`packages/common/src/services/queue.ts:79`](packages/common/src/services/queue.ts)                                                                                                                                                                                           | Exactly `add<T>(name: string, data: T, options?: AddJobOptions): Promise<string>` (:89), `process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void` (:98), `addRecurring<T>(name: string, data: T, options: RecurringOptions): Promise<void>` (:107). No `delay`, no `priority`, no `backoff`, no `removeOnComplete`, no `every` — those are aspirational in PUBLIC_API and **must not** be implemented (§2 C1). No widening. |
| `IJob<T>`                                        | [`packages/common/src/services/queue.ts:14`](packages/common/src/services/queue.ts)                                                                                                                                                                                           | `readonly id: string`, `readonly name: string`, `readonly data: T`, `readonly attempts: number` (1 on first delivery). The transport stores `maxAttempts` alongside these; it is an internal field, not part of `IJob`.                                                                                                                                                                                                                                   |
| `JobProcessor<T>`                                | [`packages/common/src/services/queue.ts:32`](packages/common/src/services/queue.ts)                                                                                                                                                                                           | `(job: IJob<T>) => void \| Promise<void>`. `QueueService.process` registers it; `JobRunner` `await`s it and gates ack / requeue / deadLetter on resolution vs rejection.                                                                                                                                                                                                                                                                                  |
| `AddJobOptions`                                  | [`packages/common/src/services/queue.ts:39`](packages/common/src/services/queue.ts)                                                                                                                                                                                           | Only `readonly delayMs?: number` and `readonly maxAttempts?: number`. `QueueService.add` maps `delayMs` to the transport `availableAtMs = now + delayMs` and `maxAttempts` to the per-job retry cap.                                                                                                                                                                                                                                                      |
| `ProcessOptions`                                 | [`packages/common/src/services/queue.ts:51`](packages/common/src/services/queue.ts)                                                                                                                                                                                           | Only `readonly concurrency?: number`. `QueueService.process` reads it as the per-name in-flight cap.                                                                                                                                                                                                                                                                                                                                                      |
| `RecurringOptions`                               | [`packages/common/src/services/queue.ts:61`](packages/common/src/services/queue.ts)                                                                                                                                                                                           | Only `readonly cron: string` (required). There is no `every` in source. `addRecurring` parses it with the internal cron calculator and throws on an invalid expression.                                                                                                                                                                                                                                                                                   |
| `CAPABILITIES.QUEUE`                             | [`packages/common/src/tokens.ts:87`](packages/common/src/tokens.ts)                                                                                                                                                                                                           | `'queue'`. The bare token; named instances use `createCapabilityToken('queue.<name>')`.                                                                                                                                                                                                                                                                                                                                                                   |
| `createCapabilityToken` grammar                  | [`packages/common/src/tokens.ts:139`](packages/common/src/tokens.ts)                                                                                                                                                                                                          | lowercase kebab segments + dot namespacing; colons illegal. `queue.<name>` passes for any lowercase-kebab `name`; the plan exercises one named instance in a test.                                                                                                                                                                                                                                                                                        |
| `IPlugin` / `IPluginContext`                     | [`packages/common/src/plugin.ts:437`](packages/common/src/plugin.ts) (IPlugin) and [`:376`](packages/common/src/plugin.ts) (IPluginContext)                                                                                                                                   | `IPlugin`: `name`, `version`, `provides?`, `optionalDependencies?`, `priority?`, `register(ctx): void \| Promise<void>` (:437-458). `IPluginContext`: `services` (:378), `health` (:386), `lifecycle` (:396), `runtime` (:402 — non-optional `IRuntimeServices`). `lifecycle.onClose(fn)` (:304) is the shutdown hook.                                                                                                                                    |
| `IRuntimeServices` (clock / timers / uuid)       | [`packages/common/src/runtime.ts:147`](packages/common/src/runtime.ts)                                                                                                                                                                                                        | `now()` (:147), `setInterval(fn, ms)` (:176), `clearInterval(handle)` (:182), `uuid()` (:131). Worker poll loop, recurring loop, job ids, and available-at timestamps go through these — no `Date.now()`, no global timers (CLAUDE.md "Never mix clocks"; AI_GUIDELINES §4).                                                                                                                                                                              |
| `MessagingPlugin` wiring precedent               | [`packages/messaging-plugin/src/plugin/messaging-plugin.ts:74`](packages/messaging-plugin/src/plugin/messaging-plugin.ts)                                                                                                                                                     | Factory returns `IPlugin`; backend switch builds the adapter (:103-145); `await adapter.connect()` (:148); `ctx.services.register<IMessageBroker>(token, adapter)` (:151); health `isReady()` (:155-161); `ctx.lifecycle.onClose(async () => adapter.disconnect())` (:164-166); multi-instance via `name` → dot-namespaced token (:82). `QueuePlugin` reuses this exact wiring with `QueueService` as the registered service.                             |
| `MessageBrokerAdapter` (internal interface)      | [`packages/messaging-plugin/src/brokers/message-broker.ts:11`](packages/messaging-plugin/src/brokers/message-broker.ts)                                                                                                                                                       | `extends IMessageBroker` + `isReady(): boolean` (:18). Precedent for an internal adapter interface that adds lifecycle/readiness not in the public contract, **not** barrel-exported. [`QueueAdapter`](packages/queue-plugin/src/adapters/queue-adapter.ts) follows this: lifecycle + storage primitives, internal, not exported.                                                                                                                         |
| `RedisStreamsBroker` inject-or-lazy seam         | [`packages/messaging-plugin/src/brokers/redis-streams-broker.ts`](packages/messaging-plugin/src/brokers/redis-streams-broker.ts)                                                                                                                                              | `loadIoredis()` doing `await import('npm:ioredis@5.x')`; `validateClient(client): client is IRedisStreamsClient` checking the exact methods; file-local `resolveClient(url, injected?)` preferring injected then lazy-loading; `implements MessageBrokerAdapter` with ack-on-success / no-ack-on-failure. `RedisQueue` mirrors this shape (load / validate / resolve + class).                                                                            |
| Recording-fake + guarded real-import precedent   | [`packages/messaging-plugin/test/fixtures/fake-ioredis-client.ts`](packages/messaging-plugin/test/fixtures/fake-ioredis-client.ts) and [`packages/messaging-plugin/test/unit/redis-streams-broker.test.ts`](packages/messaging-plugin/test/unit/redis-streams-broker.test.ts) | Fake records every Redis call; tests assert the real command, read back seeded payloads, and assert ack-on-success / no-ack-on-failure; one guarded test builds the broker with no injected client + a non-existent endpoint and asserts `connect()` rejects, which enters the real `await import('npm:ioredis@5.x')` path so the lazy-load function is covered whether or not the package is installed. `RedisQueue` gets exactly this pair.             |
| `MessagingPluginOptions` / structural client     | [`packages/messaging-plugin/src/interfaces/index.ts:95`](packages/messaging-plugin/src/interfaces/index.ts) (:16 `IRedisStreamsClient`, :88 `MessagingBrokerType`)                                                                                                            | Precedent for: optional `broker`/`name`/`url`/`client` fields; an internal structural client type (`IRedisStreamsClient`) used by `validateClient` and **not** barrel-exported; a `XxxBrokerType` union feeding the plugin switch. `QueuePluginOptions` / `IRedisQueueClient` / `QueueAdapterType` follow it.                                                                                                                                             |
| Barrel-export precedent                          | [`packages/messaging-plugin/src/index.ts:53`](packages/messaging-plugin/src/index.ts)                                                                                                                                                                                         | Plugin factory + adapter classes + option types are exported; re-export the `common` contract types; internal structural client types and the internal adapter interface are **not** exported. `src/index.ts` follows this exactly.                                                                                                                                                                                                                       |
| ioredis npm specifier                            | [`deno.lock:20`](deno.lock)                                                                                                                                                                                                                                                   | `npm:ioredis@5` → resolves to `5.11.1` (already locked, used by messaging). `RedisQueue` reuses `npm:ioredis@5.x` — no new dependency, no fabricated version.                                                                                                                                                                                                                                                                                             |
| `exactOptionalPropertyTypes`                     | [`deno.json:57`](deno.json)                                                                                                                                                                                                                                                   | On. Per-adapter option objects in `register()` are built by assigning only defined values, mirroring [`messaging-plugin.ts:107`](packages/messaging-plugin/src/plugin/messaging-plugin.ts).                                                                                                                                                                                                                                                               |
| AI_GUIDELINES: inject-or-lazy / runtime / no-any | [`AI_GUIDELINES.md:685`](AI_GUIDELINES.md) (§12.2), [`:221`](AI_GUIDELINES.md) (§4), [`:278`](AI_GUIDELINES.md) (§5.2)                                                                                                                                                        | Heavy deps never bundled; adapters accept an injected client and otherwise lazily `import()` an `npm:` specifier; no `process`/`Deno`/`Bun`/`globalThis` in plugins; runtime ops via `IRuntimeServices`; no `any`.                                                                                                                                                                                                                                        |
| ROADMAP M15 scope                                | [`ROADMAP.md:1784`](ROADMAP.md)                                                                                                                                                                                                                                               | Deliverables: QueuePlugin; Redis / RabbitMQ / Memory adapters; job processor; full coverage. M15 ships Memory + Redis + processor; RabbitMqQueue is split to M15b and BullMQ is reconciled to ioredis (§2 C2).                                                                                                                                                                                                                                            |
| PUBLIC_API Queue (stale)                         | [`PUBLIC_API.md:1450`](PUBLIC_API.md)                                                                                                                                                                                                                                         | Documents `delay`, `priority`, `attempts`, `backoff { type, delay }`, `removeOnComplete`, `removeOnFail`, and a recurring `every` — **none** exist in source. Corrected as a named same-PR deliverable (§2 C1).                                                                                                                                                                                                                                           |
| ARCHITECTURE queue row                           | [`ARCHITECTURE.md:1210`](ARCHITECTURE.md)                                                                                                                                                                                                                                     | Consistent with the design (Public API `QueuePlugin()` + `IQueue`; Redis and RabbitMQ clients optional via `npm:`; Memory for testing). No conflict; the RabbitMqQueue deferral does not contradict this row (it describes the package's rules, not which adapter ships in which milestone).                                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                       | Doc deliverable (same PR)                                            |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` Queue section ([`PUBLIC_API.md:1468`](PUBLIC_API.md) Adding Jobs, :1528 Job Options, :1516 Recurring) documents an API that does **not** exist in the committed source: `queue.add(name, data, { delay })`, `queue.add(name, data, { priority, attempts, backoff: { type, delay }, removeOnComplete, removeOnFail })`, and `queue.addRecurring(name, data, { every })`. The committed [`IQueue`](packages/common/src/services/queue.ts:79) surface is `add(name, data, { delayMs?, maxAttempts? })`, `process(name, processor, { concurrency? })`, `addRecurring(name, data, { cron })` — only. | The **source is the truth**; `PUBLIC_API.md` was aspirational. Rewrite the Queue section to match the committed contract: the three methods, `AddJobOptions` (`delayMs` / `maxAttempts`), `ProcessOptions` (`concurrency`), `RecurringOptions` (`cron`), the `IJob` shape, and the `CAPABILITIES.QUEUE` token. All examples use the real option names.                                                                         | `PUBLIC_API.md` "Queue" rewrite (same PR).                           |
| C2 | `ROADMAP.md` M15 ([`ROADMAP.md:1819`](ROADMAP.md)) says "RedisQueue — BullMQ-based" and lists `RabbitMqQueue` as an M15 deliverable ([`:1830`](ROADMAP.md)). The committed [`IQueue`](packages/common/src/services/queue.ts:79) contract is minimal (no priority / named backoff / removeOnComplete that BullMQ centers on), BullMQ is a heavy bundle (AI_GUIDELINES §12.2 / §14.4), and RabbitMQ's push model + delayed-retry DLE/TTL machinery does not fit the polling-based transport seam.                                                                                                                 | M15 ships **Memory + Redis (ioredis-based delayed queue)** and a `RabbitMqQueue` is split to **M15b**, mirroring the M14 → M14b messaging split. `npm:ioredis@5` (already locked) replaces BullMQ. ROADMAP is reconciled: M15 deliverables narrowed to Memory + Redis + processor + retry + recurring; a new M15b sub-section is added for `RabbitMqQueue`, exactly as M14b was added for the RabbitMQ / NATS / Kafka brokers. | `ROADMAP.md` M15 reconcile + add M15b sub-section (same PR).         |
| C3 | `PUBLIC_API.md` Queue "Registration" shows `QueuePlugin({ adapter: 'redis', options: { url, concurrency } })` — a nested `options` object. The messaging precedent ([`MessagingPluginOptions`](packages/messaging-plugin/src/interfaces/index.ts:95)) and the chosen design use **flat** plugin options, and `concurrency` is a per-`process()` knob ([`ProcessOptions`](packages/common/src/services/queue.ts:51)), not a plugin option.                                                                                                                                                                       | `QueuePluginOptions` is **flat** (`adapter`, `name`, `url`, `client`, `defaultMaxAttempts`, `pollIntervalMs`); no nested `options` field; no plugin-level `concurrency` option. Folded into the §2 C1 `PUBLIC_API.md` rewrite.                                                                                                                                                                                                 | `PUBLIC_API.md` "Queue → Registration" (folded into the C1 rewrite). |

No other committed-doc conflicts were found (checked [`ARCHITECTURE.md:1210`](ARCHITECTURE.md) queue
row — consistent with the design).

## 3. Design decisions

### 3.1 A shared `QueueService` implements `IQueue`; adapters are thin transports

- **Decision:** `QueueService` is the single registered `IQueue`. It owns the backend-agnostic
  machinery — the worker poll loop, retry with backoff, per-name concurrency, and cron-driven
  recurring scheduling — and delegates storage to an internal
  [`QueueAdapter`](packages/queue-plugin/src/adapters/queue-adapter.ts) (connect / disconnect /
  isReady + a fixed set of delayed-job storage primitives). The adapters (`MemoryQueue`,
  `RedisQueue`) implement only that transport interface; they do **not** implement `IQueue`
  directly.
- **Why:** The worker loop, retry policy, and cron scheduling are identical across backends;
  duplicating them in each adapter would be a DRY violation (AI_GUIDELINES §11.1) and the place
  where coverage quietly drops. Keeping that logic in one tested `QueueService` keeps each adapter
  small and makes the recording fakes faithful to a tiny, real surface. (The rejected alternative —
  each adapter implementing `IQueue` directly, as brokers implement `IMessageBroker` — does not fit,
  because `IQueue.process` registers a handler that the transport must feed through shared
  retry/concurrency/cron logic.)
- **Test home:** `test/unit/queue-service.test.ts` drives `add` / `process` / `addRecurring` through
  `MemoryQueue` with a fake runtime clock, asserting end-to-end dispatch, retry, and recurring
  behavior; `test/integration/queue-integration.test.ts` exercises the same path through the real
  `QueuePlugin` registration.

### 3.2 The internal `QueueAdapter` transport contract (storage primitives)

- **Decision:** `QueueAdapter` (in
  [`src/adapters/queue-adapter.ts`](packages/queue-plugin/src/adapters/queue-adapter.ts), parallel
  to [`MessageBrokerAdapter`](packages/messaging-plugin/src/brokers/message-broker.ts:11)) exposes:
  `connect(): Promise<void>`, `disconnect(): Promise<void>`, `isReady(): boolean`,
  `enqueue(job): Promise<void>`, `reserve(name, limit, nowMs): Promise<readonly StoredJob[]>`,
  `ack(name, id): Promise<void>`, `requeue(name, id, availableAtMs, attempts): Promise<void>`,
  `deadLetter(name, id): Promise<void>`, `storeRecurring(rec): Promise<void>`,
  `fetchRecurringDue(nowMs): Promise<readonly StoredRecurring[]>`,
  `advanceRecurring(id, nextRunAtMs): Promise<void>`. `StoredJob` carries
  `{ id, name, data, attempts, maxAttempts }` (the first four map to
  [`IJob`](packages/common/src/services/queue.ts:14)); `StoredRecurring` carries
  `{ id, name, data, cron, nextRunAtMs }`. It is **not** barrel-exported.
- **`reserve` CLAIMS, it does not merely read (this is the correctness core).** `reserve` atomically
  MOVES up to `limit` due jobs (`availableAtMs <= nowMs`) out of the per-name _ready_ set into a
  per-name _processing_ set and returns them; a reserved job is no longer visible to a subsequent
  `reserve`. `ack` removes the job from the processing set (success); `requeue` moves it from
  processing back to ready with a new `availableAtMs` and bumped `attempts`; `deadLetter` moves it
  from processing to the dead set. A job is therefore in exactly one of {ready, processing, dead} at
  any instant. This is what prevents the same in-flight job from being dispatched twice (see §3.5):
  a read-only `fetchReady` that left the job in the ready set until `ack` would re-dispatch any job
  whose processor outlives one poll tick.
- **Why:** This is the minimal, backend-agnostic surface the worker and recurring loops need; it
  keeps `MemoryQueue` and `RedisQueue` parallel and makes every Redis call assertable by name. The
  claim semantic mirrors the messaging precedent, whose `RedisStreamsBroker` uses consumer-group
  `XREADGROUP` + a pending-entries list + `XACK` for exactly this reason
  ([`redis-streams-broker.ts:236`](packages/messaging-plugin/src/brokers/redis-streams-broker.ts));
  a ZSET queue has no built-in pending list, so the move-to-processing set supplies it.
- **Test home:** `memory-queue.test.ts` and `redis-queue.test.ts` assert each primitive (enqueue
  then `reserve` returns the job AND a second `reserve` does NOT return it again, `ack` removes it
  from processing, `requeue` moves it back to ready with a new score and bumped `attempts`,
  `deadLetter` moves it from processing to the dead set, recurring primitives schedule and advance).

### 3.3 Redis delayed-queue storage model (ZSET + HASH) and the ioredis seam

- **Decision:** `RedisQueue` keeps, per job name, a _ready_ ZSET `queue:<name>:ready`
  (`member = jobId`, `score = availableAtMs`), a _processing_ ZSET `queue:<name>:processing`
  (`member = jobId`, `score = reservedAtMs`), a _dead_ ZSET `queue:<name>:dead`, and one HASH
  `queue:<name>:jobs` (`field = jobId`, `value = JSON.stringify(StoredJob)`) holding the payload of
  a job in any of the three sets; recurring jobs live in a ZSET `queue:recurring:due`
  (`member = recurringId`, `score = nextRunAtMs`) and a HASH `queue:recurring:jobs`. The primitives:
  `enqueue` = `HSET` + `ZADD` ready; `reserve` = `ZRANGEBYSCORE ready 0 nowMs LIMIT 0 limit`, then
  for the returned ids `ZREM ready` + `ZADD processing` (the claim) + `HGET` each payload; `ack` =
  `ZREM processing` + `HDEL`; `requeue` = `HSET` (bumped attempts) + `ZREM processing` +
  `ZADD ready` (new score); `deadLetter` = `ZREM processing` + `ZADD dead` (payload preserved in the
  HASH, not dropped, so a test can read it back). Job payloads are serialized with inline
  `JSON.stringify` / `JSON.parse` (no serializer option — see §3.9). The client follows the
  [`RedisStreamsBroker`](packages/messaging-plugin/src/brokers/redis-streams-broker.ts) seam:
  `loadIoredis()` does `await import('npm:ioredis@5.x')`;
  `validateClient(client): client is IRedisQueueClient` checks the exact Redis commands used
  (`zadd`, `zrangebyscore`, `zrem`, `hset`, `hget`, `hdel`, `del`, `connect`, `quit`); a file-local
  `resolveClient(options, injected?)` prefers an injected client then lazy-loads.
- **Single-process claim scope (honest about what the move guarantees).** M15 targets single-process
  queues; distributed / leader-elected work is out of scope (§9). The worker loop never runs two
  overlapping `reserve` calls for the same name (§3.5), so the
  `ZRANGEBYSCORE`→`ZREM`/`ZADD processing` sequence claims each job exactly once within a process
  even though it is not wrapped in a single atomic `MULTI`/Lua round trip. Making the claim atomic
  across _processes_ (a Lua `EVAL` doing range-and-move in one step, which would add `eval` to the
  client contract) is deferred to the distributed milestone (§9) alongside cross-instance recurring;
  the current design does not claim cross-process exactly-once and says so.
- **Why:** A ZSET-by-availableAt is the canonical Redis delayed-queue shape and honors `delayMs` and
  retry-backoff exactly. Reusing the locked `npm:ioredis@5` keeps zero new dependencies and mirrors
  a shipped, tested pattern.
- **When the lazy import succeeds / fails:** `loadIoredis()` resolves when `npm:ioredis@5` is in the
  workspace cache; when absent, the dynamic `import('npm:ioredis@5.x')` rejects with a
  module-resolution error. With no injected client and a non-existent endpoint, `connect()` also
  rejects during the real ioredis handshake, so the guarded real-import test always enters
  `loadIoredis()` and covers the lazy-load branch whether or not the package is installed.
- **Test home:** `redis-queue.test.ts` drives every primitive through the recording fake (asserting
  the real `ZADD` / `ZRANGEBYSCORE` / `ZREM` / `HSET` / `HGET` / `HDEL` calls and reading the job
  back), that `reserve` moves ready→processing (a second `reserve` returns nothing until `ack` /
  `requeue`), the `validateClient` edge cases (rejects null / non-object / partial; accepts the full
  command set), `resolveClient` preferring the injected client, `isReady()` transitions,
  not-connected throws, and one guarded real-import test (no injected client +
  `url: 'redis://localhost:9999'` → `connect()` rejects, entering `loadIoredis()`).

### 3.4 Retry with exponential backoff, gated on `maxAttempts`

- **Decision:** `computeBackoffMs(attempts)` (pure, in
  [`src/retry/retry-strategy.ts`](packages/queue-plugin/src/retry/retry-strategy.ts)) returns a
  capped exponential delay: `min(baseDelay * 2 ** (attempts - 1), maxDelay)` with
  `baseDelay = 1000`, `maxDelay = 30000`. `JobRunner` runs the registered
  [`JobProcessor`](packages/common/src/services/queue.ts:32); on resolve → `adapter.ack`; on reject,
  if `job.attempts < job.maxAttempts` →
  `adapter.requeue(name, id, now + computeBackoffMs(attempts),
  attempts + 1)`; else →
  `adapter.deadLetter`. The cap is the per-job
  [`AddJobOptions.maxAttempts`](packages/common/src/services/queue.ts:39) when present, else the
  plugin `defaultMaxAttempts` (default `3`).
- **Why:** The contract exposes only `maxAttempts`, so backoff is internal policy; a pure,
  deterministic function is trivially unit-testable and identical across backends. The resolve /
  reject → ack / requeue / deadLetter mapping is the place a test must assert real behavior (a
  failing processor requeues until the cap, then dead-letters; a succeeding processor acks and never
  requeues).
- **Test home:** `retry-strategy.test.ts` (pure input → output for attempts 1..n, the cap, and the
  base boundary); `job-processor.test.ts` (resolve → ack; reject-under-cap → requeue with the
  computed next-attempts; reject-at-cap → deadLetter); `queue-service.test.ts` asserts the same
  end-to-end through `MemoryQueue`.

### 3.5 Per-name concurrency (claim-based, not count-only)

- **Decision:** `QueueService` keeps, per registered name, an in-flight counter AND a
  "reserve-in-progress" guard. The worker poll loop, for each name: skips the name while a `reserve`
  for it is already outstanding (the guard); otherwise computes `limit = concurrency - inFlight`
  (concurrency from [`ProcessOptions`](packages/common/src/services/queue.ts:51), default `1`) and,
  when `limit > 0`, `await`s `reserve(name, limit, now)`. Each returned job is dispatched through
  `JobRunner`, incrementing `inFlight`; a slot frees (and `inFlight` decrements) when the
  `JobRunner` settles (ack / requeue / deadLetter). Because `reserve` CLAIMS jobs out of the ready
  set (§3.2) and the per-name guard prevents overlapping reserves, a job that is still being
  processed is neither returned by a later `reserve` nor counted twice — so no job is dispatched
  concurrently with itself, even when its processor outlives a poll tick. `process` registers the
  one processor for a name; registering a second processor for the same name overwrites the first
  (documented, tested) rather than throwing, matching a single-handler-per-name queue model.
- **Why:** Honors the contract's `concurrency` knob with a deterministic claim + semaphore. A
  count-only gate (`limit = concurrency - inFlight` over a read-only `fetchReady`) is NOT enough: at
  `concurrency = 2` with one slow job left in the ready set, a free slot re-fetches and
  re-dispatches the same job. The claim (move-to-processing) plus the reserve guard is what closes
  that gap, and a count-only test would pass while the bug ships.
- **Test home:** `queue-service.test.ts` — (1) enqueues N jobs for one name, registers a processor
  with `concurrency: 2` that resolves on a deferred it controls, and asserts at most two are
  simultaneously in flight; (2) **double-dispatch regression test:** a single job whose processor
  stays pending across MULTIPLE poll ticks (fake clock advanced by several `pollIntervalMs` while
  the deferred is unresolved) is dispatched EXACTLY ONCE — the processor is invoked once and no
  second copy of the job is claimed; (3) the short-circuit behavior (a processor that throws does
  not block later jobs) is also asserted.

### 3.6 Recurring jobs via a zero-dependency 5-field cron calculator

- **Decision:** `cronNextMs(cron, fromMs)` (pure, in
  [`src/scheduler/cron-calculator.ts`](packages/queue-plugin/src/scheduler/cron-calculator.ts))
  computes the next fire time of a standard 5-field expression
  (`minute hour day-of-month month day-of-week`, with `*`, lists, ranges, and `*/step`). It throws
  on a structurally invalid expression. `addRecurring(name, data, { cron })` validates by calling it
  once, then
  `adapter.storeRecurring({ id: runtime.uuid(), name, data, cron, nextRunAtMs:
  cronNextMs(cron, now) })`.
  A separate recurring loop (see §3.7) periodically calls `fetchRecurringDue(now)`; for each due
  entry it `enqueue`s a concrete job (available now) and
  `advanceRecurring(id, cronNextMs(cron, now))`. A recurring job is processed by the same-name
  processor registered via `process`.
- **Why:** No cron parser exists in-tree
  ([`scheduler-plugin`](packages/scheduler-plugin/src/index.ts) is still a stub) and no plugin may
  import another plugin; `cron-parser` is **not** in [`deno.lock`](deno.lock), so adding it would
  mean an unverified dependency (AI_GUIDELINES §12.1, §16.3). A focused internal calculator keeps
  the milestone dependency-free and fully unit-testable. Day-of-month and day-of-week match when one
  or both sides match (standard cron semantics). L / W / `#`, a seconds field, and timezones are out
  of scope (§9).
- **Test home:** `cron-calculator.test.ts` asserts next-fire for wildcards, fixed values, lists,
  ranges, `*/step`, the DOM/DOW combination rule, month wrap, and that an invalid expression throws;
  `queue-service.test.ts` asserts `addRecurring` with a sub-minute-friendly expression enqueues a
  job on the recurring tick and advances the schedule (fake clock).

### 3.7 Clock, timers, lifecycle, and health wiring

- **Decision:** The worker poll loop and the recurring loop each run on a handle from
  `runtime.setInterval(fn, pollIntervalMs)` (`pollIntervalMs` default `1000`); both are cleared with
  `runtime.clearInterval` in `QueueService.disconnect()`. All timestamps use `runtime.now()`; job
  ids use `runtime.uuid()`. No `Date.now()` and no global timers anywhere in `src/`.
  `QueueService.connect()` connects the adapter then starts the loops; `disconnect()` clears the
  loops then disconnects the adapter. Health is registered as a `HealthIndicatorFn` — an `async`
  indicator returning `{ status: service.isReady() ? 'up' : 'down', data: { adapter: <type> } }`,
  NOT a bare boolean — mirroring
  [`messaging-plugin.ts:155`](packages/messaging-plugin/src/plugin/messaging-plugin.ts), where
  `service.isReady()` delegates to `adapter.isReady()`;
  `ctx.lifecycle.onClose(() => service.disconnect())`.
- **Why:** CLAUDE.md "Never mix clocks" + AI_GUIDELINES §4 runtime confinement; reuses the messaging
  wiring exactly.
- **Test home:** each adapter test asserts `isReady()` is `false` before `connect()`, `true` after,
  `false` after `disconnect()`; the storage primitives (`enqueue` / `reserve`) throw when not
  connected; `queue-service.test.ts` asserts the loops start on `connect()` and stop on
  `disconnect()` (no timer fires after disconnect).

### 3.8 Multi-instance and token grammar

- **Decision:** `QueuePlugin({ name })` mirrors messaging: when `name` is given, the plugin
  registers under `createCapabilityToken('queue.<name>')` and its plugin name is
  `queue-plugin.<name>`; otherwise it registers under the bare `CAPABILITIES.QUEUE` (`'queue'`) with
  plugin name `queue-plugin`. This makes multiple queue instances (for example a foreground and a
  background queue) addressable by distinct tokens.
- **Why:** The kernel's plugin resolver throws on a duplicate bare-token provider or a duplicate
  same-name instance at startup, so the plan states each instance's derived name and token. The
  `queue.<name>` form passes the committed grammar
  ([`createCapabilityToken`](packages/common/src/tokens.ts:139)) for any lowercase-kebab `name`.
- **Test home:** `queue-plugin.test.ts` registers two named instances and resolves each under its
  own token, and asserts the bare-token path resolves under `CAPABILITIES.QUEUE`.

### 3.9 Serialization is inline JSON (no serializer option)

- **Decision:** `RedisQueue` serializes `StoredJob` / `StoredRecurring` with inline `JSON.stringify`
  / `JSON.parse`. There is **no** `serializer` option on `QueuePluginOptions`.
- **Why:** The committed [`IQueue`](packages/common/src/services/queue.ts:79) contract does not
  expose serialization, and an option no implementation varies on is dead surface (CLAUDE.md "every
  symbol … must be read on a real code path"). Inline JSON keeps the file count and surface minimal.
- **Test home:** `redis-queue.test.ts` asserts the value written to the HASH is the JSON of the
  `StoredJob` and that `reserve` returns the round-tripped payload.

## 4. Exported surface — every symbol names its consumer

| Exported symbol      | Kind                       | Consumer / real code path that READS it                                                                                                                                                                                                            |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueuePlugin`        | factory (fn)               | `app.register(QueuePlugin({ … }))` — the user entry point; returns an `IPlugin`.                                                                                                                                                                   |
| `QueueAdapterType`   | type                       | `QueuePluginOptions.adapter` and the `QueuePlugin.register()` backend switch (selects `MemoryQueue` vs `RedisQueue`).                                                                                                                              |
| `QueuePluginOptions` | type                       | The `QueuePlugin(options)` parameter; user-typed configuration.                                                                                                                                                                                    |
| `MemoryQueue`        | class                      | `QueuePlugin.register()` instantiates it when `adapter === 'memory'`; also direct user instantiation in tests.                                                                                                                                     |
| `RedisQueue`         | class                      | `QueuePlugin.register()` instantiates it when `adapter === 'redis'`; also direct user instantiation with an injected client.                                                                                                                       |
| `RedisQueueOptions`  | type                       | `RedisQueue` constructor parameter and the `register()` option builder.                                                                                                                                                                            |
| `IQueue`, `IJob`, …  | re-exported `common` types | Re-exported so users import the contract from the plugin package, matching the [`messaging-plugin`](packages/messaging-plugin/src/index.ts:79) precedent: `IQueue`, `IJob`, `JobProcessor`, `AddJobOptions`, `ProcessOptions`, `RecurringOptions`. |

**Intentionally not exported** (internal, parallel to messaging's `MessageBrokerAdapter` /
`IRedisStreamsClient`): the [`QueueAdapter`](packages/queue-plugin/src/adapters/queue-adapter.ts)
interface, `IRedisQueueClient`, `StoredJob`, `StoredRecurring`, `QueueService`, `JobRunner`,
`computeBackoffMs`, `cronNextMs`, and each `loadIoredis` / `validateClient` / `resolveClient` helper
(`validateClient` is exported from its **file** for direct unit test, not from the barrel).

### 4.1 Options — every option names its consumer

| Option               | Consumer                                     | Behavior (per implementation)                                                                                          |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `adapter`            | `QueuePlugin.register()` switch              | `'memory'` → `MemoryQueue`; `'redis'` → `RedisQueue`; unknown id throws (mirrors messaging). Default `'memory'`.       |
| `name`               | `QueuePlugin` token / plugin-name derivation | Given → token `queue.<name>` + plugin name `queue-plugin.<name>`; absent → bare `CAPABILITIES.QUEUE` + `queue-plugin`. |
| `url`                | `RedisQueue.connect` via `resolveClient`     | Passed to the lazy-loaded ioredis client (`new (loadIoredis())(url)`). Default `'redis://localhost:6379'`.             |
| `client`             | `RedisQueue.resolveClient`                   | When present and `validateClient` passes, used directly and the lazy import is skipped.                                |
| `defaultMaxAttempts` | `QueueService.add`                           | Per-job retry cap when [`AddJobOptions.maxAttempts`](packages/common/src/services/queue.ts:39) is absent. Default `3`. |
| `pollIntervalMs`     | `QueueService` worker + recurring loops      | The `runtime.setInterval` period for both loops. Default `1000`.                                                       |

No option is declared without a reader. There is deliberately **no** `serializer` option (§3.9), no
plugin-level `concurrency` option (it is a per-`process` knob on
[`ProcessOptions`](packages/common/src/services/queue.ts:51)), and no nested `options` field (§2
C3).

## 5. Implementation files

| File                               | Purpose                                                                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/interfaces/index.ts`          | `QueueAdapterType`, `QueuePluginOptions`, `RedisQueueOptions`, internal `IRedisQueueClient`, `StoredJob`, `StoredRecurring`. types-only; no runtime branches.                                                                            |
| `src/adapters/queue-adapter.ts`    | Internal `QueueAdapter` interface (connect / disconnect / isReady + delayed-job storage primitives). interface-only; parallel to [`message-broker.ts`](packages/messaging-plugin/src/brokers/message-broker.ts).                         |
| `src/adapters/memory-queue.ts`     | `MemoryQueue implements QueueAdapter` — in-process Maps / arrays; synchronous primitives wrapped in Promises.                                                                                                                            |
| `src/adapters/redis-queue.ts`      | `loadIoredis()` / `validateClient()` / `resolveClient()` + `RedisQueue implements QueueAdapter` (ready/processing/dead ZSETs + payload HASH; `reserve` claims ready→processing; isReady).                                                |
| `src/services/queue-service.ts`    | `QueueService implements IQueue` — processor registry, worker poll loop, recurring loop, per-name concurrency, delegates dispatch to `JobRunner`; connect / disconnect / isReady. Internal (not barrel-exported).                        |
| `src/processors/job-processor.ts`  | `JobRunner` — runs a `JobProcessor`, and on resolve / reject decides ack / requeue / deadLetter via `computeBackoffMs` and `maxAttempts`.                                                                                                |
| `src/retry/retry-strategy.ts`      | `computeBackoffMs(attempts): number` — pure capped exponential backoff.                                                                                                                                                                  |
| `src/scheduler/cron-calculator.ts` | `cronNextMs(cron, fromMs): number` — pure zero-dependency 5-field cron next-fire; throws on invalid input.                                                                                                                               |
| `src/plugin/queue-plugin.ts`       | `QueuePlugin(options): IPlugin` factory — backend switch, builds adapter + `QueueService`, `await service.connect()`, `ctx.services.register<IQueue>(token, service)`, health via `isReady()`, `onClose` disconnect (mirrors messaging). |
| `src/index.ts`                     | Barrel: `QueuePlugin`, `QueueAdapterType`, `QueuePluginOptions`, `MemoryQueue`, `RedisQueue`, `RedisQueueOptions`; re-export `IQueue` / `IJob` / `JobProcessor` / `AddJobOptions` / `ProcessOptions` / `RecurringOptions` from `common`. |
| `packages/queue-plugin/deno.json`  | Already exists (`name`, `version`, `exports`); no change required (no dependencies field — `npm:ioredis@5` is a lazy import, not a manifest dep, matching [`messaging-plugin/deno.json`](packages/messaging-plugin/deno.json)).          |
| `packages/queue-plugin/README.md`  | New package README (purpose, install, usage, options, adapters) — AI_GUIDELINES §7.1 / §8.6.                                                                                                                                             |
| `PUBLIC_API.md`                    | Rewrite the Queue section to the committed contract; fix Registration / Job Options / Recurring (§2 C1, C3).                                                                                                                             |
| `ROADMAP.md`                       | Reconcile M15 (ioredis not BullMQ; Memory + Redis ship now) and add the M15b `RabbitMqQueue` sub-section (§2 C2).                                                                                                                        |
| `ARCHITECTURE.md`                  | The queue row ([`:1210`](ARCHITECTURE.md)) is already consistent; add a one-line note that M15 ships Memory + Redis and that `RabbitMqQueue` follows in M15b.                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Every test file's first framework import is `import { describe, it } from '@std/testing/bdd';` with
assertions from `@std/expect`. `Deno.test` is banned in this repo — do not scaffold in it and
convert later. Fixtures live under `test/fixtures/` and are excluded from coverage. Every test call
type-checks against the committed signatures from §1.

| Test file                                    | src covered                                                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/retry-strategy.test.ts`           | `src/retry/retry-strategy.ts`                                                    | `computeBackoffMs(attempts): number` returns `baseDelay * 2 ** (attempts-1)` for attempts 1..k, clamps at `maxDelay`, and hits the exact base at `attempts = 1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test/unit/cron-calculator.test.ts`          | `src/scheduler/cron-calculator.ts`                                               | `cronNextMs(cron, fromMs): number` for `* * * * *` (next minute), fixed fields, lists (`1,30`), ranges (`0-10`), `*/5` step, the day-of-month + day-of-week combination rule, and month/year wrap; an invalid expression (`'bad'`, wrong field count, out-of-range) throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/unit/job-processor.test.ts`            | `src/processors/job-processor.ts`                                                | Given a `StoredJob` and a `JobProcessor<T>` (the `(job: IJob<T>) => void \| Promise<void>` shape): resolve → calls `adapter.ack`; reject with `attempts < maxAttempts` → calls `adapter.requeue(name, id, now+backoff, attempts+1)` and not `ack`; reject with `attempts === maxAttempts` → calls `adapter.deadLetter`. The `IJob` handed to the processor carries `id`, `name`, `data`, `attempts` exactly.                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/memory-queue.test.ts`             | `src/adapters/memory-queue.ts`                                                   | `MemoryQueue implements QueueAdapter`: `isReady()` false/true/false across connect/disconnect; `enqueue` then `reserve(name, limit, now)` returns the job read-back (round-trips `data`) AND a second `reserve` does NOT return the same job (it was claimed into processing); `delayMs`/`requeue` honor `availableAtMs` (not returned before its time); `ack` removes it from processing; `requeue` bumps `attempts` and moves it back to ready; `deadLetter` moves it from processing to the dead set (readable); recurring `storeRecurring` / `fetchRecurringDue` / `advanceRecurring` behave; not-connected calls throw.                                                                                                                                                                             |
| `test/unit/redis-queue.test.ts`              | `src/adapters/redis-queue.ts`                                                    | `validateClient(client): client is IRedisQueueClient` rejects null / non-object / partial and accepts the full command set; `resolveClient` prefers the injected client; `enqueue` emits real `HSET` + `ZADD` ready; `reserve` emits `ZRANGEBYSCORE … LIMIT` then `ZREM` ready + `ZADD` processing + `HGET`, returns the round-tripped job, and a second `reserve` returns nothing (job is in processing); `ack` emits `ZREM` processing + `HDEL`; `requeue` emits `HSET` (bumped attempts) + `ZREM` processing + `ZADD` ready (new score); `deadLetter` emits `ZREM` processing + `ZADD` dead (payload readable); `isReady()` transitions; not-connected throws; **one guarded real-import test**: no injected client + `url: 'redis://localhost:9999'` → `connect()` rejects (enters `loadIoredis()`). |
| `test/unit/queue-service.test.ts`            | `src/services/queue-service.ts`                                                  | `add<T>(name, data, options?: AddJobOptions): Promise<string>` enqueues (returns the id); `process<T>(name, processor, options?: ProcessOptions): void` registers; the worker loop (fake-clock advanced by `pollIntervalMs`) dispatches a ready job to the processor, acks on resolve, requeues-on-backoff on reject under the cap, dead-letters at the cap; `concurrency: 2` caps in-flight at two; **a job whose processor stays pending across several poll ticks is dispatched EXACTLY ONCE** (double-dispatch regression, §3.5); `addRecurring(name, data, { cron }): Promise<void>` enqueues a job on the recurring tick and advances the schedule; an invalid `cron` throws; `disconnect()` stops the loops.                                                                                      |
| `test/unit/queue-plugin.test.ts`             | `src/plugin/queue-plugin.ts` (+ `src/interfaces/index.ts` types via compilation) | `QueuePlugin({ adapter: 'memory' \| 'redis', … }): IPlugin` builds the right adapter, `await service.connect()` runs, the service resolves under `CAPABILITIES.QUEUE` typed as `IQueue`, health `isReady()` is wired, `onClose` disconnects; `adapter: 'redis'` forwards `url`/`client`/options to `RedisQueue` (built by assigning only defined values, satisfying `exactOptionalPropertyTypes`); unknown adapter throws; named instance resolves under `queue.<name>` and a second named instance under its own token.                                                                                                                                                                                                                                                                                 |
| `test/unit/barrel-exports.test.ts`           | `src/index.ts`                                                                   | Asserts `QueuePlugin`, `QueueAdapterType`, `QueuePluginOptions`, `MemoryQueue`, `RedisQueue`, `RedisQueueOptions` and the re-exported `IQueue` / `IJob` / `JobProcessor` / `AddJobOptions` / `ProcessOptions` / `RecurringOptions` are exported, and that `QueueAdapter`, `IRedisQueueClient`, `StoredJob`, `StoredRecurring`, `QueueService` are **not**.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/integration/queue-integration.test.ts` | end-to-end through the plugin                                                    | Registers `QueuePlugin({ adapter: 'memory' })` against a fake runtime, resolves `IQueue`, calls `add('send-email', { to })`, registers a processor via `process`, advances the fake clock, and asserts the processor received the job with the read-back `data` and that the job is acked (not re-delivered); a second path asserts retry-then-dead-letter; a third asserts `addRecurring` produces a job per tick.                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/fixtures/fake-ioredis-client.ts`       | (fixture)                                                                        | Recording `FakeRedisClient` modeling the exact commands `RedisQueue` calls (`zadd`, `zrangebyscore`, `hset`, `hget`, `hdel`, `zrem`, `del`, `connect`, `quit`) over in-memory ZSETs / HASHes, so tests assert the real command name and read back the stored payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/fixtures/fake-runtime.ts`              | (fixture)                                                                        | Fake `IRuntimeServices` exposing a controllable monotonic clock (`now`), `setInterval`/`clearInterval` backed by manually-advanced handles (so tests step the worker + recurring loops deterministically), and `uuid` (sequenced). Values are cross-checked against how the real producer sets them (no `Date.now()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The two interface-only files — `src/interfaces/index.ts` and `src/adapters/queue-adapter.ts` — have
no runtime branches and are covered wherever the unit tests compile against `QueuePluginOptions`,
`QueueAdapterType`, `RedisQueueOptions`, `IRedisQueueClient`, `StoredJob`, and the `QueueAdapter`
interface (messaging precedent: `message-broker.ts` is interface-only and covered by the broker
tests).

Per-file bar: every new `src/*.ts` file targets ≥90% branch / function / line. The recording fakes
plus the guarded real-import test cover the `loadIoredis()` lazy-load line that a skipped-only test
would leave uncovered, and the pure `computeBackoffMs` / `cronNextMs` functions are driven directly
to full branch coverage.

## 7. Verification gates

```bash
git branch --show-current        # MUST be feat/m15-queue-plugin, never main
deno task check:plan             # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage          # read ANSI-stripped per-file table; >=90% branch/function/line on every src file
```

After implementation, also grep for constructs the gates miss (CLAUDE.md "Before reporting a task
done"):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/queue-plugin/src
```

Branch + lint hand-off: the assistant produced this plan in a file-tools-only Architect session (no
shell). Before review, the human confirms `git branch --show-current` is `feat/m15-queue-plugin`
(create it from `main` if absent: `git switch -c feat/m15-queue-plugin`) and runs
`deno task check:plan`; any finding is fixed as a plan first.

## 8. Risks & mitigations

- **Recording fake diverges from the real ioredis command set → tests lie.** Mitigation: the fake
  models the exact commands `RedisQueue` calls (`zadd` / `zrangebyscore` / `hset` / `hget` / `hdel`
  / `zrem` / `del`), and the one guarded real-import test exercises the real
  `import('npm:ioredis@5.x')` path so `loadIoredis()` is covered regardless of install (RedisStreams
  precedent at
  [`redis-streams-broker.test.ts`](packages/messaging-plugin/test/unit/redis-streams-broker.test.ts)).
- **Cron calculator correctness.** Mitigation: a focused unit suite covers wildcards, fixed values,
  lists, ranges, `*/step`, the DOM/DOW combination rule, month wrap, and invalid-input throws; the
  feature set is deliberately minimal (no L/W/`#`, no seconds, no timezone) to keep it auditable.
- **Same in-flight job dispatched twice.** A read-only fetch that leaves a job in the ready set
  until `ack` re-dispatches any job whose processor outlives one poll tick (a count-only concurrency
  gate does not catch it). Mitigation: `reserve` CLAIMS jobs (ready→processing set, §3.2/§3.3) and
  the worker loop never overlaps a `reserve` for the same name (§3.5); a regression test drives a
  processor pending across several poll ticks and asserts a single dispatch. Cross-_process_
  exactly-once claiming is explicitly deferred with the distributed milestone (§9).
- **Timer leak on shutdown.** Mitigation: both loops are cleared in `disconnect()` and the service
  test asserts no timer fires after disconnect.
- **`exactOptionalPropertyTypes` is on.** Mitigation: the `RedisQueueOptions` object in `register()`
  is built by assigning only defined values (mirrors
  [`messaging-plugin.ts:107`](packages/messaging-plugin/src/plugin/messaging-plugin.ts)).
- **RabbitMqQueue scope risk.** Mitigation: split to M15b up front (§0, §2 C2, §9) rather than
  shipping a degraded adapter; the [`ARCHITECTURE.md`](ARCHITECTURE.md) row already permits RabbitMQ
  as an optional client, so the deferral does not contradict committed docs.
- **Non-deterministic async timing in tests.** Mitigation: tests use the fake runtime's
  manually-advanced clock and `setInterval` handles, so the worker and recurring loops step
  deterministically (no real wall-clock waits).
- **`PUBLIC_API.md` is stale.** Mitigation: corrected as a named same-PR deliverable (§2 C1, C3).

## 9. Out of scope

- `RabbitMqQueue` adapter — deferred to **M15b**. RabbitMQ is push-based and faithful retry needs a
  dead-letter-exchange plus per-attempt TTL queue; that is a milestone's worth of work on its own,
  exactly as the messaging brokers were split M14 → M14b.
- `BullMQ` — not used; M15 ships an ioredis-based delayed queue (§2 C2, §3.3).
- Live-Redis integration test — deferred; the project bar for transport adapters is recording-fake
  plus guarded real-import (M14 RedisStreams precedent).
- cron extensions (`L`, `W`, `#`), a seconds field, timezone / DST handling, named holidays — out of
  scope for the minimal 5-field calculator (§3.6).
- Priority, `removeOnComplete` / `removeOnFail`, and a configurable backoff type — not present in
  the committed [`IQueue`](packages/common/src/services/queue.ts:79); the aspirational
  `PUBLIC_API.md` shapes are corrected, not implemented (§2 C1).
- Distributed / leader-elected recurring across instances — single-process recurring only;
  distributed locking belongs to the scheduler-plugin's distributed-lock milestone, and no plugin
  imports another plugin.
- Cross-plugin bridges (queue ↔ events, queue ↔ messaging) — none; plugins communicate only via
  capability tokens.
