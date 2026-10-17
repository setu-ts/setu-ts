# Milestone 113c — Connections and Jobs That Never Recover, and a Shutdown With No Bound

> **Status:** Planning. Branch: `feat/m113c-recovery-and-shutdown-bounds`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Five `v0.9.0` smoke findings share one shape: a fault leaves the system in a state it never leaves
without a process restart, while the health probes stay green or the orchestrator has no reason to
act. M113c makes each of them recover, or bounds it.

- **In scope:**
  - **V9-18 (High).** `RabbitMqQueue` reconnects after a broker restart, through the
    `ReconnectSupervisor` promoted from `messaging-plugin` into `common`.
  - **V9-64 (High).** The Redis queue reclaims a job whose worker died mid-run, through a renewed
    claim (lease) with per-delivery claim tokens.
  - **V9-71.** `RedisQueueOptions.keyPrefix`, so two applications sharing one Redis are isolated.
  - **V9-76.** A typed processor `(job: IJob<T>) => …` type-checks inside a
    `QueueProcessorDefinition`.
  - **V9-31.** On Deno, `app.stop()` is bounded the way it is on Node and Bun.
  - **Folded in at the maintainer's direction (2026-10-17):** a Redis client a package builds with
    no `connectionErrorReporter` now carries an `'error'` listener that drops events, instead of
    none. Found during verification as the `[ioredis] Unhandled error event` a queue test printed;
    it predates M113c (PR #378 attached the listener only when a reporter was given). The fix is in
    `common`'s `attachConnectionErrorReporter`, whose `reporter` becomes optional, and removes the
    `if (reporter !== undefined)` guard from eight call sites in seven packages: `queue-plugin`,
    `cache-plugin`, `messaging-plugin`, `realtime-backplane-plugin`, `auth-plugin`,
    `scheduler-plugin` and `idempotency-plugin`.
- **Packages:** `queue-plugin`, `runtime`, `common` and `messaging-plugin`. The ROADMAP row named
  only `queue-plugin` and `runtime`. `common` and `messaging-plugin` join because the maintainer
  chose, on 2026-10-17, to move the reconnect supervisor into `common` rather than write a second
  backoff loop (§3.1). This follows the M90a matcher promotion: it deletes a copy rather than
  creating one.
- **NOT this milestone:**
  - SQS lease renewal (`ChangeMessageVisibility`). SQS already has a visibility timeout, so a dead
    worker's job returns. A job running longer than the timeout is redelivered, which is existing
    behaviour and outside the five rows. Unowned.
  - Redis queue reclaim for an alive but stuck processor (one that awaits forever). The lease is
    renewed while the process runs, so such a job is never reclaimed. BullMQ behaves the same way.
    Recorded in §9.
  - V9-36 (NATS reconnect budget). M113a shipped it.

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RabbitMqQueue` fault handling             | `packages/queue-plugin/src/adapters/rabbitmq-queue.ts`, `connect()` and the fault listeners                                     | `connect()` returns early once `#ready`. The `'error'` and `'close'` listeners only set `#faulted = true`. No reconnect path exists anywhere in the file. `#channel` stays the dead channel, so every later `enqueue`/`reserve` fails with `Channel closed`. This is V9-18 exactly.                                                                                                                             |
| `RabbitMqQueue` processing map             | same file, `#processing`, `reserve`, `ack`                                                                                      | Reserved messages are held per name, keyed by job id with the `amqplib` message object. `ack` on a missing entry returns silently.                                                                                                                                                                                                                                                                              |
| `ReconnectSupervisor`, `fullJitterDelay`   | `packages/messaging-plugin/src/brokers/reconnect.ts:1-266`                                                                      | Pure apart from `IRuntimeServices.setTimeout`/`clearTimeout`. `drive` mode requires `reconnect` and `replay`; `reassert` is optional. `attachFaultListener` returns a disposer. There is one attempt loop per fault window, and backoff is unbounded full jitter (500 ms to 30 000 ms). It is not barrel-exported, and it is imported by `rabbitmq-broker.ts:21`, `nats-broker.ts:17` and `kafka-broker.ts:27`. |
| RabbitMQ broker drive wiring               | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:515-522, 1289-1300`                                                   | `#reconnect` reconnects the connection only when it is not injected; an injected connection only gets a fresh channel. This is the precedent §3.1 follows.                                                                                                                                                                                                                                                      |
| Redis queue keys                           | `packages/queue-plugin/src/adapters/redis-queue.ts:171-184, 280-306`                                                            | The keys are `queue:<name>:{ready,processing,dead,jobs,dead:jobs}` and `queue:recurring:{due,jobs}`. There is no prefix option (V9-71). The processing score is `nowMs` at reserve, the reserved-at time.                                                                                                                                                                                                       |
| Redis queue scripts                        | `packages/queue-plugin/src/adapters/redis-queue-scripts.ts:1-90`                                                                | `RESERVE_SCRIPT` moves due ids into processing at score `ARGV[1]` (now). `ACK`, `REQUEUE` and `DEAD_LETTER` remove from processing unconditionally. Nothing ever moves a processing member back to ready, which is V9-64. The comment rule: scripts never re-encode job data.                                                                                                                                   |
| Non-`eval` fallback                        | `redis-queue.ts:449-464, 312-330`                                                                                               | `#atomic` returns `null` when the injected client has no `eval`. Every operation then has a multi-command fallback.                                                                                                                                                                                                                                                                                             |
| Claim tokens                               | `packages/queue-plugin/src/interfaces/index.ts:172-181`; `processors/job-processor.ts:136`; `adapters/queue-adapter.ts:135-173` | `StoredJob.claimToken?` is set by `reserve` on adapters with a per-delivery claim; today only SQS does. `runJob` passes `claimToken ?? id` to every settlement. The `QueueAdapter` settlement methods take `claimToken`.                                                                                                                                                                                        |
| Attempt accounting                         | `services/queue-service.ts:452-459`; `processors/job-processor.ts:140-197`                                                      | Reserve dispatches with `attempts: attempts === 0 ? 1 : attempts`. `runJob` requeues while `attempts < maxAttempts`, otherwise it dead-letters. A crash never increments `attempts`.                                                                                                                                                                                                                            |
| Processor dispatch                         | `services/queue-service.ts:471-500`                                                                                             | `#dispatchJob` → `runJob(runtime, adapter, storedJob, reg.processor, report, hooks)`. This is where a lease-renewal timer can wrap the processor.                                                                                                                                                                                                                                                               |
| `IRuntimeServices` timers                  | `packages/common/src/runtime.ts:371-373`                                                                                        | Provides `setInterval`/`clearInterval` and `setTimeout`/`clearTimeout`, all over the opaque `TimerHandle`.                                                                                                                                                                                                                                                                                                      |
| `QueueProcessorDefinition`, `JobProcessor` | `queue-plugin/src/interfaces/index.ts:463-480`; `common/src/services/queue.ts:52`                                               | `readonly processor: JobProcessor` is a property, so it is checked contravariantly. `JobProcessor<Order>` is not assignable to `JobProcessor<unknown>`, which is V9-76. **Probed (TypeScript 6.0.3, strict):** the shipped property shape refuses a typed processor, and a method-signature member admits it, including in a `readonly Def[]` list.                                                             |
| Deno close                                 | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:300-309`                                                               | `close()` awaits `handle.server.shutdown()`.                                                                                                                                                                                                                                                                                                                                                                    |
| Node, Bun close                            | `node-http-adapter.ts:493-504`; `bun-http-adapter.ts:327-337`                                                                   | Both call `server.close()`/`stop()` without awaiting it, then resolve.                                                                                                                                                                                                                                                                                                                                          |
| Kernel stop order                          | `packages/kernel/src/application/application.ts:877-890, 2240-2250`                                                             | Drain (at most 10 s) → `adapter.close` → `runShutdown` → `runClose`. A `close` that does not return blocks every `onClose` hook, including the worker pool's termination. This is V9-31.                                                                                                                                                                                                                        |
| `Deno.serve().shutdown()`                  | **Measured, Deno 2.9.6**                                                                                                        | With one request in flight: the port can be re-bound 300 ms after `shutdown()` is called, so the listener is released immediately. The `shutdown()` promise settles only once the in-flight request finishes (303 ms after release). Not awaiting it is therefore safe for the port and matches Node and Bun.                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                             | Resolution (picked side)                                              | Doc deliverable (same PR)                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP's M113c section and its table row list `queue-plugin` and `runtime` only.                                                                    | The supervisor promotion (§3.1) adds `common` and `messaging-plugin`. | Correct both package lists in ROADMAP.                                                                                  |
| C2  | The queue-plugin README describes job stranding only for the command-timeout case (the V9-64 report), and says nothing about a worker dying mid-run. | The lease (§3.2) closes the stranding.                                | Replace the stranding note with a "Claims and dead workers" section: lease length, renewal, and at-least-once delivery. |
| C3  | `StoredJob.claimToken`'s JSDoc says Redis leaves the token unset.                                                                                    | After §3.2, Redis sets it.                                            | Update the JSDoc and the `runJob` comment that lists "memory, redis, rabbitmq".                                         |

## 3. Design decisions

### 3.1 V9-18 — RabbitMQ queue reconnect through a supervisor promoted to `common`

- **Decision:**
  - **Move to `common`.** `ReconnectSupervisor`, `ReconnectSupervisorOptions`, `ReconnectMode` and
    `fullJitterDelay` move verbatim to `packages/common/src/reconnect/reconnect-supervisor.ts` and
    are exported from the `common` barrel (`@since 0.10.0`). `messaging-plugin` deletes
    `src/brokers/reconnect.ts`, its three brokers import from `@setu-ts/common`, and the file's test
    moves to `common`.
  - **Drive mode in `RabbitMqQueue`.** `reconnect` closes a non-injected connection, then opens a
    fresh connection, re-installs both fault listeners and opens a new channel. An injected
    connection only gets a new channel, as the broker does. `reassert` clears `#asserted` so queues
    are re-declared lazily. `replay` is a no-op: the adapter polls with `basicGet` and holds no
    consumers.
  - **Fault flag.** The fault listener calls `supervisor.fault()`. `isHealthy` reads
    `!supervisor.faulted`. `#faulted` is deleted.
  - **The `#processing` map is cleared on a successful reconnect.** RabbitMQ requeues every unacked
    message on a closed channel, so those entries name deliveries the broker has already taken back.
    The job is redelivered: at-least-once delivery, stated in the README.
  - **Each delivery carries its own claim token** (amended after implementation stopped on it). The
    map is keyed by job id, and RabbitMQ redelivers a job under the same id, so a late settlement
    from the pre-outage delivery found the NEW entry and settled it. Codex measured this: the old
    delivery's ack acknowledged the redelivered message (new-channel acks 0 → 1), and a late
    `deadLetter` would dead-letter a job a second worker is still running. `reserve` now sets
    `StoredJob.claimToken` to a fresh `runtime.uuid()` stored on the entry, and `ack`, `requeue` and
    `deadLetter` act only when the entry's token matches. On a mismatch they reject with
    `StaleClaimError`, exactly as the Redis adapter does (§3.2), so one rule covers both adapters.
  - **`disconnect()` calls `supervisor.stop()` first**, so no attempt runs after shutdown.
- **Why:** this is the maintainer's decision (2026-10-17). One backoff and one attempt-loop
  implementation serves both plugins. The supervisor already handles the two traps a second copy
  would have to rediscover: one loop per fault window, and listener disposal.
- **Test home:** `common/test/unit/reconnect-supervisor.test.ts` (moved);
  `queue-plugin/test/unit/rabbitmq-reconnect.test.ts`;
  `queue-plugin/test/integration/rabbitmq-restart-real.test.ts` (real RabbitMQ 4, guarded on
  `RABBITMQ_URL`): `docker restart` the broker, then `add`, `reserve` and `ack` succeed with no
  process restart, and `/ready` returns to 200.

### 3.2 V9-64 — Redis queue: a renewed claim, 30 s by default

- **Decision:** the maintainer chose a renewed claim with a 30 s default, on by default
  (2026-10-17).
  - **`RedisQueueOptions.visibilityTimeoutMs`**: default `30_000`, validated through
    `deadlineRangeError`. `0` is refused, because a zero lease would reclaim every job at once.
  - **`reserve`** runs one script. It first reclaims up to `limit` expired claims (processing score
    at or below the server's now), then reserves due jobs.
    - **Each reserved job** gets processing score `now + visibilityTimeoutMs` and a claim token. The
      token is minted inside the script from `INCR <prefix><name>:claimseq`, so it is unique across
      replicas and needs no runtime (amended: `RedisQueue`'s published constructor takes options
      only and has no `IRuntimeServices`, so `runtime.uuid()` was unreachable without a breaking
      signature change). It is stored in `<prefix><name>:claims` (id → token), and each returned
      `StoredJob` carries its `claimToken`.
    - **A reclaimed job** is removed from processing and its claim is deleted.
      `HINCRBY queue:<name>:stalls id 1` records the stall, and the job goes back to ready at score
      now.
    - **An orphaned id** (in the ready or processing set, with no payload in the jobs hash) is
      removed from processing and its `claims`/`stalls` fields deleted, rather than being added to
      processing as today. With reclaim in place, keeping it would cycle it between ready and
      processing on every lease, forever.
    - **Reserve output:** the script returns `[payload, stalls]` pairs. The adapter sets
      `attempts = max(attempts, 1) + stalls`, so a crash counts as an attempt and a poison job that
      kills its worker every time cannot loop forever. The script never re-encodes the payload,
      keeping the rule in `redis-queue-scripts.ts`.
  - **The lease uses the Redis server's clock** (`redis.call('TIME')`), not the replica's
    `runtime.now()`, so clock skew between replicas cannot reclaim a live job early. This follows
    `idempotency-plugin/src/stores/redis-scripts.ts:13`, and carries its stated floor: Redis 5 or
    later, where script-effects replication is the default and `TIME` before a write is safe. The
    queue README states the floor.
  - **Deviation recorded at implementation (2026-10-17):** the reserve script selects DUE ready jobs
    by the server clock too, not only the lease. Before M113c, `reserve` compared the ready set
    against the reserving replica's `runtime.now()`; one clock per script is simpler and keeps
    reclaim and due selection consistent. Ready-set scores are still written by the enqueuing
    replica (`availableAtMs`), so a delayed or backed-off job's readiness shifts by that replica's
    skew against Redis. Before, it shifted by the skew between the two replicas, so the bound is no
    worse. **Reversed after the committed-tree audit (finding L2):** "no worse" held only across
    replicas; a single replica had zero skew before and gained its full skew against Redis, so a
    delayed job ran early. Due selection and reclaim rescoring use the caller's `nowMs` again
    (passed as `ARGV[3]`); only leases use `TIME`. The script also returns
    `[payload, stalls, token]` triples, not the pairs described above, because the claim token is
    minted inside it.
  - **`ack`, `requeue` and `deadLetter` scripts check the claim.** They act only when
    `HGET claims id` equals the token passed in, and return `0` otherwise. A slow worker whose claim
    was reclaimed therefore cannot delete the new delivery. On success they also clear the `claims`
    and `stalls` fields.
  - **A stale settlement rejects.** When a script returns `0`, the adapter rejects with an internal
    `StaleClaimError` ("the job's claim was taken by another delivery"; not barrel-exported). This
    matters because `runJob`'s `settle` already turns a rejection into a `failed` settlement for
    diagnostics and rethrows it to the dispatcher's settlement-failure report
    (`job-processor.ts:213-227`). A silent return would record `acknowledged` for a settlement that
    did not happen. SQS logs and returns instead; it holds a logger, and `RedisQueue` holds none.
  - **New optional adapter member `claimRenewal?`** on the internal `QueueAdapter` (not
    barrel-exported):
    `{ readonly intervalMs: number; extend(name, id, claimToken): Promise<boolean> }`. One member
    carries both, so the service never needs to know the lease length. `RedisQueue` sets
    `intervalMs` to `Math.floor(visibilityTimeoutMs / 3)`. Its `extend` script re-scores the
    processing member to server-now plus the lease, only while the token matches, and answers
    whether it did.
  - **Renewal.** `QueueService.#dispatchJob` arms a `runtime.setInterval` every
    `claimRenewal.intervalMs` (10 s by default) while the processor runs, and clears it in
    `finally`. The interval is armed only when the adapter has `claimRenewal` and the job carries a
    `claimToken`.
    - **A failed or `false` renewal** is reported once through the service's `#report`. The
      processor is not cancelled (it cannot be), and its settlement becomes a no-op if another
      delivery took the job.
    - **Overlap guard.** Renewal calls never overlap: a still-pending call skips the next tick.
  - **Dead-letter on reserve.** When `attempts > maxAttempts` at dispatch, the service dead-letters
    the job without running it and reports `'queue job abandoned by a dead worker — dead-lettered'`.
    This is the first place a reclaim can exceed the budget.
  - **The lease requires `eval`** (amended). Without a script there is no server clock and no atomic
    token, so a best-effort lease would hand a live job to a second worker on clock skew. A client
    with no `eval` (only a minimal injected facade; a real ioredis client always has it) keeps the
    pre-M113c behaviour: no claims, no reclaim. `connect()` reports this once through the
    connection-error reporter, naming `visibilityTimeoutMs` as inactive, so the option is never
    silently dropped. A test pins both the warning and the unchanged fallback.
  - **Upgrade path.** A member reserved before M113c has score equal to its reserved-at time, which
    is already in the past, and no claim entry. The first reserve after upgrade reclaims it: the
    stuck jobs V9-64 describes come back. A replica still on the old version that is running such a
    job is not renewing it. Drain old replicas before upgrading; stated in `docs/upgrading.md`.
- **Why:** this is the maintainer's decision. A renewed lease is what BullMQ does
  (`lockDuration`/`lockRenewTime`). It reclaims a dead worker's job without handing a long-running
  job to a second worker. The claim tokens make the remaining race, a GC pause past the lease,
  harmless at settlement.
- **Test home:** `queue-plugin/test/unit/redis-lease.test.ts` (fake client with `eval` executing
  each script's logic, plus a client with no `eval`, which keeps the pre-M113c behaviour and warns
  once); `queue-plugin/test/unit/lease-renewal.test.ts` (service timer, overlap guard, `false`
  renewal reported); `queue-plugin/test/integration/redis-lease-real.test.ts` (real Redis 7, guarded
  on `REDIS_URL`, cases below).
  - **A dead worker.** Reserve, never settle, advance past the lease, and a second reserve returns
    the job with `attempts` incremented.
  - **A long job.** A renewed job stays claimed past 3× the lease.
  - **A stale ack** after a reclaim leaves the new delivery intact.
  - **A poison job** reaches dead after `maxAttempts` stalls.

### 3.3 V9-71 — `RedisQueueOptions.keyPrefix`

- **Decision:**
  - **The default stays `queue:`**, so existing jobs are still found after the upgrade (maintainer
    decision, 2026-10-17).
  - **`keyPrefix`** replaces the literal `queue:` everywhere, including the recurring keys and the
    new `claims`/`stalls` keys. One private `#key(...parts)` builds every key, so no literal
    survives.
  - **Validation.** The prefix must be a non-empty string of at most 128 characters with no control
    characters, refused at construction.
  - **Plumbing.** `QueuePluginOptions` is flat (`queue-plugin.ts:183-200` forwards `url`, `client`,
    `deadLetterTtlMs` and `commandTimeoutMs` field by field). `keyPrefix` and `visibilityTimeoutMs`
    are added to `QueuePluginOptions` and forwarded the same way. Both are validated in
    `QueuePlugin(...)` at construction when `adapter === 'redis'`, as `commandTimeoutMs` is
    (`queue-plugin.ts:90`), through one exported-internal resolver per option shared with the
    `RedisQueue` constructor.
  - **Not the existing `prefix` option.** `QueuePluginOptions.prefix` is documented RabbitMQ-only
    (`interfaces/index.ts:235-240`), and `RedisQueue` ignores it today. Reusing it would silently
    move the keys of any Redis deployment that already sets it, orphaning its queued jobs. A
    separate name has no such reader.
- **Why:** this is the maintainer's choice. A new default would orphan every job already queued.
- **Test home:** `queue-plugin/test/unit/redis-key-prefix.test.ts` (every command's key carries the
  prefix: a test enumerates the keys the fake client saw); the real-Redis suite above. Two adapters
  with different prefixes and one job name never see each other's jobs.

### 3.4 V9-76 — typed processors in `QueueProcessorDefinition`

- **Decision:**
  - **Generic interface.** `QueueProcessorDefinition<T = unknown>` declares its processor with
    method syntax: `processor(job: IJob<T>): void | Promise<void>`. TypeScript checks method
    parameters bivariantly, so `QueueProcessorDefinition<Order>` assigns to
    `QueueProcessorDefinition`, and a typed literal assigns into the `processors` list.
  - **`readonly` is lost.** A method member cannot carry `readonly`, so the `processor` member loses
    it. Nothing in-repo reassigns it.
  - **Called as a method.** `queue-plugin.ts` registers `(job) => definition.processor(job)` rather
    than passing `definition.processor` detached. A processor written with method syntax may read
    `this`, and a detached call would lose it.
  - **`QueueProcessorEntry` is unchanged.**
- **Why:** the measured probe (§1) shows the method form admits a typed processor and the property
  form refuses it. A cast at every call site is what V9-76 complains about.
- **Test home:** `queue-plugin/test/unit/processor-definition.types.test.ts`, which is type-checked
  by `pnpm run check`.
  - **Admitted:** a `QueueProcessorDefinition<Order>` literal and an inline `(job: IJob<Order>)`
    processor inside `QueuePlugin({ processors: [...] })`.
  - **Refused:** a `@ts-expect-error` row for a processor whose payload type contradicts a declared
    `QueueProcessorDefinition<Order>`.

### 3.5 V9-31 — Deno `close()` does not wait for in-flight requests

- **Decision (amended after implementation stopped on it):** `DenoHttpAdapter.close()` waits for the
  first of `shutdown()` and a 1000 ms grace. A rejected `shutdown()` is caught. Without in-flight
  requests `shutdown()` wins at once, as today; with a request that never settles, `close()` returns
  after the grace, the `onClose` hooks run, and the worker pool's termination lets the handler
  return.
- **Why:** not awaiting at all broke the existing port-rebind test
  (`runtime/test/integration/deno-http-adapter.test.ts:56`) with `AddrInUse`. Measured on Deno 2.9.6
  over three runs with a request in flight: after `shutdown()` the port is still taken synchronously
  and after a microtask, and free after one macrotask. The grace is far longer than that, so the
  port is free when `close()` returns. A stop is bounded at the kernel's 10 s drain plus 1 s, beside
  Node and Bun's 10.5 s.
- **Test home:**
  - **Unit:** added to the existing `runtime/test/unit/deno-http-adapter.test.ts`, which is already
    in `DENO_LANE_TESTS` (`scripts/test-lanes.ts`). `deno-http-adapter.ts` is a `DENO_ONLY_SOURCES`
    file, so its coverage is measured by the Deno lane. A fake host whose `shutdown()` never settles
    still lets `close()` resolve after the grace; a prompt `shutdown()` returns without waiting for
    it; a rejected `shutdown()` raises no unhandled rejection; and the existing port-rebind
    integration test passes unchanged.
  - **Deno lane e2e:** a new `runtime/test/e2e/deno-stop-bounded.test.ts`, added to
    `DENO_LANE_TESTS` and the generated lane config regenerated with
    `node scripts/node-manifests.ts`. A real `Deno.serve` with a request awaiting a 25 s promise:
    `app.stop()` resolves in under 12 s, and an `onClose` hook ran before the request settled.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** two source-level changes, both shipping in minor 0.10.0.

- **`QueueProcessorDefinition.processor`** changes from a `readonly` property to a method. Code that
  reads it is unaffected; code that relied on `readonly` to forbid reassignment loses that.
- **Redis and RabbitMQ queue claim checks.** `ack`, `requeue` and `deadLetter` now reject with
  `StaleClaimError` when the claim token does not match (§3.1, §3.2). The adapters are internal and
  every public path goes through `runJob`, which passes the token and reports the rejection as a
  failed settlement.

The visible behaviour changes go to CHANGELOG as breaking and to `docs/upgrading.md`: a reclaimed
job counts as an attempt, and pre-upgrade stuck jobs come back.

| Exported symbol                                          | Kind                | Consumer / real code path that READS it                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReconnectSupervisor` (`common`)                         | class               | `RabbitMqQueue` (queue-plugin), and `RabbitMqBroker`, `NatsBroker` and `KafkaBroker` (messaging-plugin).                                                                                                                        |
| `ReconnectSupervisorOptions`, `ReconnectMode` (`common`) | type                | The constructor parameter of the class above, used by the same four callers.                                                                                                                                                    |
| `fullJitterDelay` (`common`)                             | function            | `ReconnectSupervisor` itself. It is exported because the moved bounds test reads it, and it was exported in messaging-plugin's module before the move. Its consumer beyond its own test is the supervisor's attempt scheduling. |
| `QueueProcessorDefinition<T>` (`queue-plugin`)           | interface (changed) | `QueuePluginOptions.processors`, read in `queue-plugin.ts:117-128`.                                                                                                                                                             |
| `RedisQueueOptions.visibilityTimeoutMs`, `.keyPrefix`    | option fields       | `RedisQueue` constructor (§4.1).                                                                                                                                                                                                |
| `QueuePluginOptions.visibilityTimeoutMs`, `.keyPrefix`   | option fields       | `QueuePlugin(...)` validation and forwarding to `RedisQueue` (`queue-plugin.ts`).                                                                                                                                               |

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                                                                                                | Behavior (per implementation)                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedisQueueOptions.visibilityTimeoutMs` | `RedisQueue` reserve/extend scripts, and the service renewal interval through `claimRenewal.intervalMs` | Lease length (default 30 000 ms; refused when `0`, negative, non-finite or above `2147483647`). Renewal every third of it. Memory, RabbitMQ and SQS do not read it; SQS has its own `visibilityTimeoutSeconds`. |
| `RedisQueueOptions.keyPrefix`           | `RedisQueue#key`                                                                                        | Prefix for every Redis key (default `queue:`). Refused when empty, over 128 characters, or containing control characters.                                                                                       |

## 5. Implementation files

| File                                                                    | Purpose                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/reconnect/reconnect-supervisor.ts`                 | Moved supervisor (new location).                                                                                                                                                                                |
| `packages/common/src/index.ts`                                          | Export the supervisor, its types and `fullJitterDelay`.                                                                                                                                                         |
| `packages/messaging-plugin/src/brokers/reconnect.ts`                    | Deleted.                                                                                                                                                                                                        |
| `packages/messaging-plugin/src/brokers/{rabbitmq,nats,kafka}-broker.ts` | Import from `@setu-ts/common`.                                                                                                                                                                                  |
| `packages/queue-plugin/src/adapters/rabbitmq-queue.ts`                  | Drive-mode supervisor, reconnect, processing reset.                                                                                                                                                             |
| `packages/queue-plugin/src/adapters/redis-queue.ts`                     | `#key`, `keyPrefix`, lease, claim tokens, stall counts, `claimRenewal`, the no-`eval` warning.                                                                                                                  |
| `packages/queue-plugin/src/adapters/redis-queue-scripts.ts`             | Reserve (reclaim + lease), claim-checked ack/requeue/dead-letter, extend.                                                                                                                                       |
| `packages/queue-plugin/src/adapters/queue-adapter.ts`                   | Optional `claimRenewal?`.                                                                                                                                                                                       |
| `packages/queue-plugin/src/plugin/queue-plugin.ts`                      | Forward and validate `keyPrefix`/`visibilityTimeoutMs`; call the processor as a method.                                                                                                                         |
| `packages/queue-plugin/src/errors.ts`                                   | Internal `StaleClaimError` (not barrel-exported).                                                                                                                                                               |
| `scripts/test-lanes.ts`, `test/deno-lane/lane.config.json`              | Register the Deno e2e; regenerate the lane config.                                                                                                                                                              |
| `packages/queue-plugin/src/services/queue-service.ts`                   | Renewal interval; dead-letter of jobs over budget at dispatch.                                                                                                                                                  |
| `packages/queue-plugin/src/processors/job-processor.ts`                 | Comment update (C3).                                                                                                                                                                                            |
| `packages/queue-plugin/src/interfaces/index.ts`                         | `QueueProcessorDefinition<T>`, the two Redis options, `claimToken` JSDoc.                                                                                                                                       |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`               | Non-awaiting `close()`.                                                                                                                                                                                         |
| Docs                                                                    | queue-plugin README, messaging-plugin README if it mentions the supervisor location, `PUBLIC_API.md`, `CHANGELOG.md` `## Unreleased`, `docs/upgrading.md`, `ROADMAP.md` (C1, progress row), `CLAUDE.md` status. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                           | src covered                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/reconnect-supervisor.test.ts` (moved)             | `reconnect-supervisor.ts`                  | The existing assertions unchanged, imported from the `common` barrel.                                                                                                                                                                                                                                                   |
| `common/test/unit/barrel-exports.test.ts`                           | `index.ts`                                 | The four symbols are exported.                                                                                                                                                                                                                                                                                          |
| `messaging-plugin` existing broker tests                            | the three brokers                          | Pass unchanged; a barrel test asserts messaging-plugin does not re-export the supervisor.                                                                                                                                                                                                                               |
| `queue-plugin/test/unit/rabbitmq-reconnect.test.ts`                 | `rabbitmq-queue.ts`                        | Fault → supervisor attempt → new channel; `#processing` cleared; a late ack, requeue or deadLetter from the pre-outage delivery rejects `StaleClaimError` and leaves the redelivered message unacked; `disconnect` stops the supervisor; an injected connection gets a new channel only; `isHealthy` follows `faulted`. |
| `queue-plugin/test/integration/rabbitmq-restart-real.test.ts`       | the same, against a real broker            | §3.1.                                                                                                                                                                                                                                                                                                                   |
| `queue-plugin/test/unit/redis-lease.test.ts`                        | `redis-queue.ts`, `redis-queue-scripts.ts` | Lease score, reclaim, stall increment, orphan removal, claim-checked settlements rejecting `StaleClaimError`, extend, the no-`eval` client keeping the old behaviour with one warning, option validation.                                                                                                               |
| `queue-plugin/test/unit/redis-key-prefix.test.ts`                   | `redis-queue.ts`                           | Every key the fake client sees starts with the prefix; the default prefix keys are byte-identical to today's.                                                                                                                                                                                                           |
| `queue-plugin/test/integration/redis-lease-real.test.ts`            | the same, against a real Redis 7           | §3.2 and §3.3 real cases.                                                                                                                                                                                                                                                                                               |
| `queue-plugin/test/unit/lease-renewal.test.ts`                      | `queue-service.ts`, `job-processor.ts`     | Interval armed only with `claimRenewal` and a token; cleared on settle and on throw; no overlap; a `false` renewal is reported once; attempts over budget are dead-lettered without running; a `StaleClaimError` settlement is observed as `failed` and reported.                                                       |
| `queue-plugin/test/unit/queue-plugin-redis-options.test.ts`         | `queue-plugin.ts`                          | `keyPrefix` and `visibilityTimeoutMs` are forwarded to `RedisQueue` and refused at `QueuePlugin(...)` construction for bad values; `prefix` set with `adapter: 'redis'` does not move the keys; a method-syntax processor that reads `this` receives the job.                                                           |
| `queue-plugin/test/unit/processor-definition.types.test.ts`         | `interfaces/index.ts`                      | §3.4 (compile-time).                                                                                                                                                                                                                                                                                                    |
| `runtime/test/unit/deno-http-adapter.test.ts` (existing, Deno lane) | `deno-http-adapter.ts`                     | §3.5 unit.                                                                                                                                                                                                                                                                                                              |
| `runtime/test/e2e/deno-stop-bounded.test.ts` (Deno lane)            | `deno-http-adapter.ts`, real `Deno.serve`  | §3.5 e2e.                                                                                                                                                                                                                                                                                                               |

**Negative controls**, each observed failing then reverted:

1. Remove the supervisor's `fault()` call in `RabbitMqQueue`: the real restart test fails with
   `Channel closed`.
2. Make the reserve script skip reclaim: the dead-worker case fails.
3. Remove the claim check from `ACK_SCRIPT`: the stale-ack case deletes the new delivery.
4. Disable the renewal interval: the long-job case is reclaimed.
5. Hard-code `queue:` in one key: the prefix test names that key.
6. Revert `processor` to a property: the type test fails `pnpm run check`.
7. Restore `await handle.server.shutdown()`: the Deno e2e exceeds its bound.
8. Drop the RabbitMQ token check: the late-settlement test acknowledges the redelivered message.
9. Remove the grace and return without waiting: the port-rebind test fails with `AddrInUse`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113c-recovery-and-shutdown-bounds
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling
pnpm test
pnpm test:coverage          # read the ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

The real-backend suites need `RABBITMQ_URL` and `REDIS_URL`, against throwaway containers only.

## 8. Risks & mitigations

- **A GC pause or event-loop stall longer than the lease** reclaims a live job, so it runs twice.
  Mitigation: claim tokens turn the late settlement into a no-op. The duplicate run is documented as
  at-least-once delivery, and `visibilityTimeoutMs` can be raised.
- **Mixed-version replicas during an upgrade.** An old replica does not renew, so the new one
  reclaims its in-flight jobs. Mitigation: documented in `docs/upgrading.md` (drain before
  upgrading).
- **Reconnect replays nothing, but the `#processing` reset can cause a retry without an attempt
  increment.** A job reserved before the outage is redelivered by RabbitMQ with its original
  attempts. Mitigation: documented; bounded by the number of outages.
- **Moving the supervisor changes `messaging-plugin`'s import graph.** Mitigation: the code moves
  verbatim, the broker suites run unchanged, and the publish dry run confirms the dependency on
  `common` is already declared.
- **The Deno fix could leave a shutdown rejection unhandled.** Mitigation: a no-op `.catch` and a
  unit test with a rejecting fake.

## 9. Out of scope

- **SQS lease renewal and long-job redelivery.** Unowned; it is an existing behaviour, not one of
  the five rows.
- **Reclaiming an alive but stuck processor.** The lease renews while the process lives; detecting a
  hang is a different signal.
- **Changing the Redis key default.** Declined by the maintainer (§3.3).

## 10. Design security review

**Status.** The flow, assets, attackers, obligations 1–6 and findings S1–S2 were written before
implementation (`c4ec403c`). Implementation added surfaces that review did not cover, so on
2026-10-17, before the committed-tree audit, it was extended with the rows marked _(added)_. That
part is recorded after implementation, the M101a precedent: it describes the design as built.

**Flows changed:**

- Redis keys now carry a configurable prefix and two new hashes, `claims` and `stalls`.
- Claim tokens are minted per delivery (a Redis `INCR` sequence; `runtime.uuid()` for RabbitMQ) and
  passed back on settlement.
- A RabbitMQ reconnect loop opens new connections after a fault.
- Deno shutdown no longer waits for in-flight requests.
- _(added)_ The reserve script reclaims expired claims, counts each reclaim as an attempt, removes
  orphaned ids, and selects due jobs by the Redis server clock.
- _(added)_ A delivery over its attempt budget is passed to `onFailed`, then dead-lettered without
  running the processor.
- _(added)_ While a processor runs, the service renews its claim every `visibilityTimeoutMs / 3` and
  reports one failed renewal per delivery to the logger.
- _(added)_ A settlement whose token no longer matches rejects with the internal `StaleClaimError`,
  on Redis and on RabbitMQ; the dispatcher reports it as a failed settlement.
- _(added)_ `ReconnectSupervisor` moved from `messaging-plugin` into `common`; the RabbitMQ, NATS
  and Kafka brokers and `RabbitMqQueue` now import it from there.

**Assets:**

- Job payloads.
- Isolation between applications sharing one Redis.
- The at-least-once guarantee.
- The shutdown bound.
- _(added)_ The process: a queue adapter must not hot-loop, leak connections or timers, or let a
  callback's throw become an unhandled rejection.

**Attackers:**

- **Another application on the same Redis** with a colliding job name; this is V9-71.
- **A process able to write the queue's Redis keys** (any Redis client with access).
- **An operator misconfiguration:** `keyPrefix` or `visibilityTimeoutMs` read from a malformed
  environment variable.
- **A flapping broker** that drives the reconnect loop.
- _(added)_ **A poison job** whose processor kills its worker on every delivery.
- _(added)_ **Application callbacks** (`onFailed`, the processor) that throw, reject or never
  settle.

**Obligations for the committed-tree audit:**

1. **Prefix isolation.** With two prefixes, no command of one adapter touches a key of the other.
   Enumerate every key from the fake client and from a real Redis `MONITOR`.
2. **Validation.** Both at `QueuePlugin(...)` and at `new RedisQueue(...)`, `keyPrefix` and
   `visibilityTimeoutMs` are validated at construction, `NaN` included, and a refusal message does
   not echo the value.
3. **Claim tokens are not authorization.** A forged token can at worst settle or keep alive a job a
   Redis writer could already delete outright. State it; no stronger claim is made.
4. **Reconnect stays bounded in resources.** Each fault window runs one loop; listeners are disposed
   on every reconnect and on `disconnect()`; no connection is orphaned. Count open connections
   across 20 flaps.
5. **Shutdown.** Deno `stop()` returns within the drain bound plus 2 s while a request never
   settles, and no unhandled rejection appears.
6. **No payload re-encoding** in any new script; byte-compare a stored payload before and after a
   reclaim.
7. _(added)_ **Scripts take no caller data as code.** Every Lua script receives keys through `KEYS`
   and values through `ARGV`; no script text is assembled from a prefix, job name, id or payload.
8. _(added)_ **Stale settlements change nothing.** On Redis and on RabbitMQ, a settlement carrying a
   superseded token leaves the new delivery's state untouched (it is neither acked, requeued nor
   dead-lettered), and the rejection names no token, id or payload.
9. _(added)_ **Poison jobs terminate.** A job that kills its worker on every delivery reaches the
   dead set within `maxAttempts` deliveries and never runs again; prove it with real `SIGKILL`s.
10. _(added)_ **Callbacks cannot break dispatch.** An `onFailed` that throws or rejects still lets
    the job be dead-lettered and the slot be released; an unconvertible thrown value does not strand
    the job; no unhandled rejection appears.
11. _(added)_ **Renewal is bounded.** At most one renewal is in flight per delivery, the interval is
    cleared on every settlement path and on `disconnect()`, a failed renewal is logged once with the
    job id and name only, and the smallest accepted `visibilityTimeoutMs` cannot produce an interval
    under 333 ms.
12. _(added)_ **The shared supervisor changes no messaging behaviour.** The three brokers' reconnect
    tests pass unchanged against the `common` copy, and no second copy remains in
    `messaging-plugin`.

**Findings:**

| #   | Finding                                                                                                                                                                                                          | Disposition                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | V9-71 is itself a cross-application data exposure: with a shared job name, one application runs another's jobs.                                                                                                  | Fixed by §3.3, for a deployment that sets `keyPrefix`; the default is unchanged by maintainer decision and the README says so.                                                                                                                                            |
| S2  | A Redis writer can extend or settle another worker's job by reading its token from the `claims` hash.                                                                                                            | Accepted: such a writer can already delete the job; Redis ACLs are the boundary.                                                                                                                                                                                          |
| S3  | _(added)_ Keys are `prefix + name + ':' + suffix` and job names are not validated, so two prefixes collide when one is a string prefix of the other: `app:` with job `b:x` and `app:b:` with job `x` share keys. | **Documented, maintainer decision 2026-10-17:** the README and `RedisQueueOptions.keyPrefix` JSDoc state that no prefix on one Redis may be a string prefix of another. The code cannot check it across applications; refusing `:` in job names was declined as breaking. |
| S4  | _(added)_ `visibilityTimeoutMs` accepted any positive number, so a value below 3 gave a zero-delay renewal interval: a tight loop of Redis round trips for every running job.                                    | **Fixed, maintainer decision 2026-10-17:** values below 1 000 ms are refused at construction (`MIN_VISIBILITY_TIMEOUT_MS`, internal), keeping the renewal interval at 333 ms or more.                                                                                     |
| S5  | _(added)_ A Redis writer can raise a job's `stalls` count and force it to be dead-lettered.                                                                                                                      | Accepted under S2: the same writer can delete the job.                                                                                                                                                                                                                    |
| S6  | _(added)_ After the 1 000 ms Deno grace, `close()` returns while requests are still in flight. `shutdown()` is not cancelled, so they finish only if the process outlives them.                                  | Accepted: the bound is the point of V9-31; the CHANGELOG entry states it.                                                                                                                                                                                                 |
| S7  | _(added)_ The supervisor's shared state now spans packages, so a defect there reaches four transports at once.                                                                                                   | Covered by obligation 12.                                                                                                                                                                                                                                                 |
| S8  | _(added)_ A built Redis client given no reporter wrote every connection error, with its stack, to `console.error`, bypassing the application's logger and its redaction.                                         | **Fixed (folded in, see §0):** the listener is always attached and drops events without a reporter. Cost: an application that builds `RedisRateLimitStore` or a store directly, without a reporter, loses the console lines; its health probe still reports the outage.   |

### Committed-tree audit, round 1 (2026-10-17, on `0424e49d`): failed

A fresh-context audit probed all twelve obligations against real Redis 7 and RabbitMQ 4 and failed
on one Medium and four Low findings, all fixed on this branch with a test that fails when the fix is
reverted:

- **M1 (Medium):** the over-budget path awaited `onFailed` before lease renewal started, so a
  callback slower than the lease was reclaimed and handed to `onFailed` again every period and the
  job never reached the dead set (obligation 9). Renewal now starts before both paths.
- **L1:** `amqplib.connect` had no socket timeout, so a broker accepting TCP and never answering
  hung one reconnect attempt forever. Each attempt now passes `{ timeout: 10_000 }`.
- **L2:** due selection by server `TIME` shifted delays by a single replica's skew; reversed, see
  the deviation note in §3.
- **L3:** the `visibilityTimeoutMs` refusal said "0 disables the bound" while refusing 0.
- **L4:** a ready-queue body that was JSON but not an object threw out of `reserve`, stranding the
  batch. Such bodies (and non-JSON ones, which already did this) move to the dead queue unchanged.
