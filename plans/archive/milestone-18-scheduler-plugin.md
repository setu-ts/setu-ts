# Milestone 18 — Scheduler Plugin (`@hono-enterprise/scheduler-plugin`)

> **Status:** Planning. Branch: `feat/milestone-18-scheduler-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

This milestone delivers an in-process job scheduler under the existing `CAPABILITIES.SCHEDULER`
(`'scheduler'`) token. It commits the missing `IScheduler` port to `@hono-enterprise/common` (today
only the token exists — see §2 C1), then implements it with three schedule kinds — cron expressions,
fixed-interval recurring jobs, and one-shot delayed jobs — plus retry with backoff and optional
distributed locking so a fire runs on at most one instance in a multi-instance deployment. The
boundary: scheduling is **process-local and time-driven** (no durable persistence); it does not
re-implement the queue plugin's at-least-once delivery, durability, or dead-letter storage.

- **In scope:** the `IScheduler` contract + supporting types added to `common`; `SchedulerPlugin`
  factory; cron / recurring (`every`) / delayed (`delay`) jobs; pause / resume / remove /
  `getNextRun`; retry with fixed and exponential backoff; a `MemoryLock` (default, single-instance)
  and a `RedisLock` (inject-or-lazy `npm:ioredis@5.x`) behind an `IDistributedLock` seam; health
  indicator and lifecycle cleanup mirroring the queue plugin.
- **NOT this milestone:** durable / restart-surviving schedules (owned by the queue plugin,
  `@hono-enterprise/queue-plugin`, Milestone 15, and a future durable-scheduler milestone); timezone
  support beyond UTC (future); lock watchdog / TTL renewal (future); `@Cron` / `@Every` / `@Delay`
  decorators (decorator-plugin integration, a later milestone); named scheduler instances
  (queue-style `queue.<name>`); a Redis-backed schedule _store_ (the lock is Redis, the schedule
  registry stays in-memory).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.SCHEDULER`          | `packages/common/src/tokens.ts:63`                           | Token value `'scheduler'`; already committed. No `IScheduler` interface ships in `common` today (see C1).                                                                                                                                                                                                                                                |
| `createCapabilityToken` grammar   | `packages/common/src/tokens.ts:139-149`                      | Lowercase kebab-case segments, dot namespacing; colons illegal. The bare `'scheduler'` token is already valid.                                                                                                                                                                                                                                           |
| `IPlugin`                         | `packages/common/src/plugin.ts:437-458`                      | `{ name; version; dependencies?; optionalDependencies?; provides?; consumes?; priority?; register(ctx) }`; `register` may return a `Promise`.                                                                                                                                                                                                            |
| `IPluginContext`                  | `packages/common/src/plugin.ts:376-415`                      | Exposes `services`, `health`, `lifecycle`, `runtime` (non-optional), `config?`, `logger?`. These are the surfaces the plugin touches.                                                                                                                                                                                                                    |
| `ILifecycleApi.onClose`           | `packages/common/src/plugin.ts:304`                          | `onClose(fn: () => void \| Promise<void>)` — where scheduler timers + redis client are torn down.                                                                                                                                                                                                                                                        |
| `IHealthApi.register`             | `packages/common/src/plugin.ts:163`                          | `register(name, indicator: HealthIndicatorFn)` — used for the scheduler health indicator.                                                                                                                                                                                                                                                                |
| `IRuntimeServices` clock + timers | `packages/common/src/runtime.ts:131-182`                     | `now(): number` (epoch ms), `hrtime()` (monotonic ms), `setTimeout(fn,ms)`, `clearTimeout`, `setInterval(fn,ms)`, `clearInterval`, `uuid()` (`:131`). The scheduler computes fire times from `now()` and drives loops with these timers — never `Date.now()` (CLAUDE.md "Never mix clocks").                                                             |
| `IJob<T>` (queue)                 | `packages/common/src/services/queue.ts:14-23`                | `{ id; name; data; attempts }`. The scheduler's `ScheduledJob<T>` mirrors this shape so handlers see a familiar object; it is a distinct type because the scheduler is not a queue.                                                                                                                                                                      |
| `common` barrel pattern           | `packages/common/src/index.ts:125-132`                       | Service contracts are re-exported as `export type { … } from './services/<name>.ts'`. M18 adds the scheduler block here (C1 deliverable).                                                                                                                                                                                                                |
| QueuePlugin factory precedent     | `packages/queue-plugin/src/plugin/queue-plugin.ts:38-108`    | Factory `XPlugin(options?): IPlugin`; `provides: [token]`; `priority: 100`; `async register(ctx)` builds service, `await service.connect()`, `ctx.services.register<IX>(token, service)`, `ctx.health.register(token, service.createHealthIndicator())`, `ctx.lifecycle.onClose(() => service.disconnect())`. The scheduler plugin mirrors this exactly. |
| QueueService timer-loop precedent | `packages/queue-plugin/src/services/queue-service.ts:69-98`  | `connect()` starts loops via `runtime.setInterval`; `disconnect()` clears them via `runtime.clearInterval`; `isReady()`; `createHealthIndicator(): HealthIndicatorFn`. The scheduler service reuses this shape with cron-driven `setTimeout` self-rescheduling.                                                                                          |
| Redis inject-or-lazy precedent    | `packages/queue-plugin/src/adapters/redis-queue.ts:24-73`    | `loadIoredis()` does `await import('npm:ioredis@5.x')` and returns `mod.Redis`; `validateClient` structural check; `resolveClient(url, injected)` prefers an injected client. `RedisLock` follows the same pattern.                                                                                                                                      |
| Cron next-fire precedent          | `packages/queue-plugin/src/scheduler/cron-calculator.ts:140` | `cronNextMs(cron, fromMs): number` — pure, UTC-based, 5-field, throws on invalid. The scheduler ships its own copy (3.7); it cannot import another plugin.                                                                                                                                                                                               |
| ROADMAP M18                       | `ROADMAP.md:2066-2142`                                       | Scope, file list, deliverables; uses `addCron/addDelayed/addRecurring` (superseded — see C2).                                                                                                                                                                                                                                                            |
| PUBLIC_API Scheduler              | `PUBLIC_API.md:1875-1949`                                    | Consumer surface `cron/every/delay/pause/resume/remove/getNextRun`; adopted verbatim (3.2).                                                                                                                                                                                                                                                              |
| ARCHITECTURE scheduler            | `ARCHITECTURE.md:1251-1260`                                  | Responsibilities (cron, delayed, recurring, retry, distributed locking); extension points: custom distributed lock, custom cron parser; rule: Redis lock optional, injected or lazy-loaded.                                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                                            | Doc deliverable (same PR)                                                                                                                     |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `IScheduler` is consumed in `PUBLIC_API.md:1902` and `ROADMAP.md:2088` as `ctx.services.get<IScheduler>('scheduler')`, but no `IScheduler` contract exists in `packages/common/src/services/` (verified: only `queue.ts` ships `IJob`/`IQueue`; the `scheduler` token at `tokens.ts:63` has no matching interface). A capability token without a committed port leaves the consumer seam undefined (the M10 `IOrmAdapter` lesson). | M18 **adds** `packages/common/src/services/scheduler.ts` defining `IScheduler`, `ScheduledJob`, `SchedulerJobHandler`, `ScheduleOptions`, `RetryOptions`, `SchedulerBackoff`, and re-exports them from `packages/common/src/index.ts` (the M12/M13/M14/M15 precedent: the implementing milestone commits its port). | Edit `PUBLIC_API.md` Scheduler section to show the committed `IScheduler` signature block; ship the new `common` source file + barrel export. |
| C2 | `ROADMAP.md:2091-2108` names the API `addCron` / `addDelayed` / `addRecurring`, while `PUBLIC_API.md:1905-1928` names it `cron` / `every` / `delay`. Two committed docs disagree on the public method names.                                                                                                                                                                                                                       | Adopt the `PUBLIC_API.md` surface (`cron` / `every` / `delay` / `pause` / `resume` / `remove` / `getNextRun`) in the committed `IScheduler` contract. PUBLIC_API is the canonical consumer-contract doc (CLAUDE.md §"PUBLIC_API.md — consume existing interfaces instead of inventing new ones").                   | Edit the `ROADMAP.md` M18 Programmatic API block to match PUBLIC_API (`cron`/`every`/`delay`).                                                |

## 3. Design decisions

### 3.1 The `IScheduler` contract is committed to `common` by this milestone

- **Decision:** Add `packages/common/src/services/scheduler.ts` with the port below and re-export it
  from the `common` barrel. The `SchedulerService` registers under `CAPABILITIES.SCHEDULER`.

  ```typescript
  export interface ScheduledJob<T = unknown> {
    readonly id: string;
    readonly name: string;
    readonly data: T;
    readonly attempts: number;
  }
  export type SchedulerJobHandler<T = unknown> = (job: ScheduledJob<T>) => void | Promise<void>;
  export type SchedulerBackoff = 'fixed' | 'exponential';
  export interface RetryOptions {
    readonly limit: number;
    readonly delay: number;
    readonly backoff: SchedulerBackoff;
  }
  export interface ScheduleOptions<T = unknown> {
    readonly data?: T;
    readonly retry?: RetryOptions;
  }
  export interface IScheduler {
    cron<T = unknown>(
      name: string,
      expression: string,
      handler: SchedulerJobHandler<T>,
      options?: ScheduleOptions<T>,
    ): Promise<void>;
    every<T = unknown>(
      name: string,
      intervalMs: number,
      handler: SchedulerJobHandler<T>,
      options?: ScheduleOptions<T>,
    ): Promise<void>;
    delay<T = unknown>(
      name: string,
      delayMs: number,
      handler: SchedulerJobHandler<T>,
      options?: ScheduleOptions<T>,
    ): Promise<void>;
    pause(name: string): Promise<void>;
    resume(name: string): Promise<void>;
    remove(name: string): Promise<void>;
    getNextRun(name: string): Promise<number>;
  }
  ```

- **Why:** Consumers register `dependencies: ['scheduler']` and resolve a typed service; a bare
  token with no contract is the undefined-seam defect (M10). The M12 `publishBatch`, M13 CQRS, M14
  messaging, and M15 queue contracts all established that the implementing milestone commits its
  port.
- **Test home:** `packages/common/test/unit/index.test.ts` asserts the new types compile-resolve
  from the barrel; `scheduler-service.test.ts` asserts the registered object satisfies `IScheduler`.

### 3.2 Public method surface = PUBLIC_API names

- **Decision:** The contract uses `cron` / `every` / `delay` / `pause` / `resume` / `remove` /
  `getNextRun` exactly as `PUBLIC_API.md:1905-1948` shows. ROADMAP's
  `addCron/addDelayed/addRecurring` are superseded (C2).
- **Why:** Resolves the C2 conflict to one mechanism; PUBLIC_API is the consumer contract of record.
- **Test home:** each method's behavior is asserted in `scheduler-service.test.ts` against the
  signature in 3.1.

### 3.3 Execution model — in-process, runtime-timer driven, single-instance semantics

- **Decision:** `SchedulerService` keeps an in-memory `JobRegistry` (`Map<name, entry>`). `cron`
  computes the first fire with `cronNextMs(expr, runtime.now())` and arms `runtime.setTimeout`,
  re-arming on each fire for the next computed time. `every` arms `runtime.setInterval`. `delay`
  arms a one-shot `runtime.setTimeout` and auto-removes the entry after it fires. `pause` clears the
  armed timer without dropping the entry; `resume` re-arms from `now()` (cron), the interval
  (every), or the FULL original `delayMs` from `now()` (delay — the remaining-time bookkeeping is
  not worth its complexity for a one-shot). `remove` clears the timer and deletes the entry.
  `getNextRun(name)` returns the next armed fire as epoch ms. **Edge behaviors (all specified here
  so no test improvises them):** scheduling `cron`/`every`/ `delay` under a name that already exists
  throws `Error("Job '<name>' is already scheduled")` — replace-by-name is a silent-footgun, callers
  `remove` first; `pause`/`resume`/`remove`/ `getNextRun` on an unknown name throw
  `Error("No scheduled job named '<name>'")`; `pause` on an already-paused job and `resume` on a
  running job are no-ops (idempotent); `getNextRun` on a paused job throws
  `Error("Job '<name>' is paused")` — a paused entry has no armed fire, and a stale or hypothetical
  time would be a lie.
- **Why:** Mirrors the QueueService runtime-timer loop precedent
  (`packages/queue-plugin/src/services/queue-service.ts:69-98`) and the CLAUDE.md "Never mix clocks"
  rule: all times come from `runtime.now()`, all timers from `runtime.set*`.
- **Test home:** `scheduler-service.test.ts` (with a fake runtime that controls `now()` and fires
  timers deterministically) asserts: cron fires at the computed next minute boundary and re-arms;
  `every` fires on the interval; `delay` fires once then is gone; `pause`/`resume`/`remove` behave
  as specified; `getNextRun` returns the armed time; every edge behavior above (duplicate-name
  throw, unknown-name throw on all four management methods, pause/resume idempotence, paused
  `getNextRun` throw, resume-of-paused-delay re-arms the full `delayMs`).

### 3.4 Distributed locking — `IDistributedLock` seam with `MemoryLock` + `RedisLock`

- **Decision:** Each fire acquires `lock.acquire('scheduler:job:<name>', ttlMs)` before running the
  handler and releases it after. `MemoryLock` is the default (used when `distributedLock` is
  disabled) and is a REAL lock with the same contract as `RedisLock`, not a yes-stub: it keeps a
  process-local `Map<key, { token, expiresAtMs }>`; `acquire` returns a fresh `runtime.uuid()` token
  for an absent key and likewise for an expired one (`expiresAtMs <= runtime.now()` — the `ttlMs`
  expiry, same semantics as Redis `PX`), and returns `null` while the key is held and unexpired;
  `release` deletes only on a matching token (token-checked, like Redis). It takes the runtime clock
  via its constructor — never `Date.now()`. This makes the single-process semantics identical to the
  Redis path: a fire that overlaps a still-running previous fire of the same job is skipped, and the
  lock self-heals via TTL if a handler dies without releasing. `RedisLock` is selected when
  `distributedLock: { enabled: true, storage: 'redis' }`; it acquires with `SET key token NX PX ttl`
  and releases with a token-checked delete (the standard Redis lock), and follows the inject-or-lazy
  pattern: an injected `client` is validated structurally, otherwise `npm:ioredis@5.x` is
  lazy-loaded via `await import(...)` (`packages/queue-plugin/src/adapters/redis-queue.ts:24-73`). A
  custom lock can be injected through `distributedLock.lock` (the ARCHITECTURE-advertised extension
  point, `ARCHITECTURE.md:1259`). When `acquire` returns null (another instance holds the lock) the
  fire is skipped.

  ```mermaid
  sequenceDiagram
    participant Timer as runtime timer
    participant Svc as SchedulerService
    participant Lock as IDistributedLock
    participant Exec as JobExecutor
    Timer->>Svc: fire(name)
    Svc->>Lock: acquire scheduler:job:name, ttl
    alt lock granted
      Lock-->>Svc: token
      Svc->>Exec: run(handler, retry)
      Exec-->>Svc: settled
      Svc->>Lock: release name, token
    else lock held by another instance
      Lock-->>Svc: null
      Svc->>Svc: skip this fire
    end
  ```

- **Why:** ARCHITECTURE mandates Redis-backed locking for multi-instance deployments and names the
  lock as an extension point. The `MemoryLock` makes the no-Redis path real (not skipped),
  satisfying the "lazily-loaded optional dep must actually load" + "hard-to-cover is not a reason"
  rules; the Redis path gets a guarded real-import test.
- **Test home:** `memory-lock.test.ts`; `redis-lock.test.ts` (fake-ioredis: `SET NX` grants, a
  second acquire returns null, token-matched release deletes, token-mismatched release does not);
  one guarded real-import test (`npm:ioredis@5.x`) skipped when the package is absent; the
  integration test asserts a fire runs exactly once under the lock.

### 3.5 `SchedulerPlugin` is a single provider; `timezone` honors only UTC in this release

- **Decision:** The plugin registers exactly one provider of `CAPABILITIES.SCHEDULER` (no named
  instances — PUBLIC_API shows only the bare token). A second `SchedulerPlugin` registration throws
  at startup via the kernel's duplicate-capability-provider guard (read at
  `packages/kernel/src/registry/plugin-resolver.ts`), which is the correct, expected behavior. The
  `timezone?: string` option (default `'UTC'`) is read at registration; a value other than `'UTC'`
  throws `Error('Non-UTC timezones are not supported in this release')`, so the option is live
  rather than dead surface.
- **Why:** Avoids inventing unrequested named-instance surface (dead-surface rule) while keeping the
  documented `timezone` option honest (it is read and enforced). The cron engine evaluates in UTC
  (3.7).
- **Test home:** `scheduler-plugin.test.ts` asserts registration under `'scheduler'`, the health
  indicator, `onClose` disconnect, and that a non-UTC `timezone` throws.

### 3.6 Retry / backoff via a pure helper, matching the committed `RetryOptions` shape

- **Decision:** `computeBackoffMs(attempt, retry)` in `src/retry/retry-handler.ts` is pure: fixed ⇒
  `retry.delay`; exponential ⇒ `retry.delay * 2 ** (attempt - 1)`. `JobExecutor` calls the handler,
  and on rejection with `attempt < retry.limit` waits the computed backoff (via
  `runtime.setTimeout`, advanced deterministically in tests) and retries; at
  `attempt === retry.limit` it gives up (logs via the optional logger) and, for recurring schedules,
  leaves the schedule armed for its next fire. No separate cap field — the committed `RetryOptions`
  is exactly `{ limit, delay, backoff }` (`PUBLIC_API.md:1923-1927`).
- **Why:** Mirrors the queue plugin's `retry-strategy.ts` / `job-processor.ts` separation; keeps the
  retry math unit-testable in isolation.
- **Test home:** `retry-handler.test.ts` (fixed and exponential values, attempt boundaries);
  `job-executor.test.ts` (success first try; reject-then-success; reject-until-limit-exhausted).

### 3.7 Own cron parser copy — no cross-plugin import

- **Decision:** `src/cron/cron-parser.ts` exports `cronNextMs(expression, fromMs): number`, a
  zero-dependency 5-field UTC parser with the same semantics as
  `packages/queue-plugin/src/scheduler/cron-calculator.ts:140` (asterisk, lists, ranges, steps,
  day-of-month/day-of-week combination rule, throws on invalid). It is a fresh file inside this
  package because no plugin may import another plugin (CLAUDE.md key conventions).
- **Why:** The scheduler needs cron next-fire math and cannot reach queue's copy; the M15 plan
  already accepted this duplication as the cost of plugin isolation.
- **Test home:** `cron-parser.test.ts` mirrors the queue `cron-calculator.test.ts` coverage
  (`* * * * *` next minute, fixed fields, lists, ranges, `*/5` step, the DOM/DOW combination rule,
  month/year wrap, and invalid-expression throws).

## 4. Exported surface — every symbol names its consumer

| Exported symbol          | Kind                          | Consumer / real code path that READS it                                                                                                                      |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IScheduler`             | interface (common)            | Any plugin declaring `dependencies: ['scheduler']`; resolved via `ctx.services.get<IScheduler>(CAPABILITIES.SCHEDULER)` (PUBLIC_API.md:1902).                |
| `ScheduledJob<T>`        | interface (common)            | The `job` argument of `SchedulerJobHandler`; read in handler bodies (PUBLIC_API.md:1905-1917).                                                               |
| `SchedulerJobHandler<T>` | type (common)                 | The handler parameter of `IScheduler.cron/every/delay`.                                                                                                      |
| `ScheduleOptions<T>`     | interface (common)            | The options parameter of `IScheduler.cron/every/delay` (carries `data`, `retry`).                                                                            |
| `RetryOptions`           | interface (common)            | The `retry` field of `ScheduleOptions`; read by `computeBackoffMs` and `JobExecutor`.                                                                        |
| `SchedulerBackoff`       | type (common)                 | The `backoff` field of `RetryOptions`.                                                                                                                       |
| `SchedulerPlugin`        | factory fn (scheduler-plugin) | `app.register(SchedulerPlugin({ … }))` (PUBLIC_API.md:1884; ROADMAP.md:2075).                                                                                |
| `SchedulerPluginOptions` | type (scheduler-plugin)       | Callers of `SchedulerPlugin(options)`; read by the factory to build the service + lock.                                                                      |
| `IDistributedLock`       | interface (scheduler-plugin)  | The custom-lock extension point; read as `SchedulerPluginOptions.distributedLock.lock` and implemented by `MemoryLock` / `RedisLock` (ARCHITECTURE.md:1259). |

Internal (intentionally NOT exported from `src/index.ts`, so they stay non-public seams):
`SchedulerService`, `JobRegistry`, `JobExecutor`, `MemoryLock`, `RedisLock`, `cronNextMs`,
`computeBackoffMs`, and the `resolveLock` factory.

### 4.1 Options — every option names its consumer

| Option                                                   | Consumer                                                  | Behavior (per implementation)                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone` (default `'UTC'`)                             | `SchedulerPlugin.register`                                | Read at registration; non-`'UTC'` throws (3.5).                                                                                                      |
| `distributedLock.enabled` (default `false`)              | `SchedulerPlugin.register` → `resolveLock`                | `false` selects `MemoryLock`; `true` requires a `storage` of `'redis'` or an injected `lock`.                                                        |
| `distributedLock.storage: 'redis'`                       | `resolveLock`                                             | Selects `RedisLock`.                                                                                                                                 |
| `distributedLock.url` (default `redis://localhost:6379`) | `RedisLock`                                               | Connection URL for the lazy-loaded ioredis client.                                                                                                   |
| `distributedLock.client`                                 | `RedisLock` (`validateClient`)                            | An injected ioredis-compatible client; preferred over lazy load.                                                                                     |
| `distributedLock.lock: IDistributedLock`                 | `resolveLock`                                             | A custom lock implementation; preferred when present.                                                                                                |
| `distributedLock.ttlMs` (default `30000`)                | `SchedulerService` fire path → `lock.acquire(key, ttlMs)` | Lock TTL, honored by BOTH implementations (`MemoryLock` expiry via `runtime.now()`, `RedisLock` via `PX`); must exceed the job's worst-case runtime. |
| `ScheduleOptions.data`                                   | `SchedulerService` → `ScheduledJob.data`                  | Payload handed to the handler.                                                                                                                       |
| `ScheduleOptions.retry.limit`                            | `JobExecutor`                                             | Max attempts before giving up.                                                                                                                       |
| `ScheduleOptions.retry.delay`                            | `computeBackoffMs`                                        | Base backoff in ms.                                                                                                                                  |
| `ScheduleOptions.retry.backoff`                          | `computeBackoffMs`                                        | `'fixed'` or `'exponential'`.                                                                                                                        |

## 5. Implementation files

| File                                                          | Purpose                                                                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/scheduler.ts`                   | New committed port: `IScheduler`, `ScheduledJob`, `SchedulerJobHandler`, `ScheduleOptions`, `RetryOptions`, `SchedulerBackoff` (C1).                                  |
| `packages/common/src/index.ts`                                | Edit: re-export the scheduler contract block (beside the queue block at lines 125-132).                                                                               |
| `packages/scheduler-plugin/src/cron/cron-parser.ts`           | Pure `cronNextMs(expr, fromMs)` 5-field UTC next-fire; throws on invalid (3.7).                                                                                       |
| `packages/scheduler-plugin/src/retry/retry-handler.ts`        | Pure `computeBackoffMs(attempt, retry)` fixed/exponential (3.6).                                                                                                      |
| `packages/scheduler-plugin/src/lock/distributed-lock.ts`      | Exported `IDistributedLock` seam + `resolveLock(options)` factory (3.4).                                                                                              |
| `packages/scheduler-plugin/src/lock/memory-lock.ts`           | `MemoryLock` — process-local held-key map with token-checked release and TTL expiry via `runtime.now()` (default; 3.4).                                               |
| `packages/scheduler-plugin/src/lock/redis-lock.ts`            | `RedisLock` — `SET NX PX` + token-checked release; inject-or-lazy `npm:ioredis@5.x`; `validateClient`.                                                                |
| `packages/scheduler-plugin/src/jobs/job-registry.ts`          | `JobRegistry` — `Map<name, entry>` with add/get/has/remove/pause/resume/getNextRun + armed-timer tracking.                                                            |
| `packages/scheduler-plugin/src/jobs/job-executor.ts`          | `JobExecutor.run(entry)` — runs the handler with retry/backoff using the runtime clock + optional logger (3.6).                                                       |
| `packages/scheduler-plugin/src/services/scheduler-service.ts` | `SchedulerService implements IScheduler` — owns registry + timers + executor + lock; `connect`/`disconnect`/`isReady`/`createHealthIndicator` (mirrors QueueService). |
| `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts`    | `SchedulerPlugin(options?): IPlugin` factory — builds lock + service, `connect`, registers under `CAPABILITIES.SCHEDULER`, health, `onClose` (mirrors QueuePlugin).   |
| `packages/scheduler-plugin/src/interfaces/index.ts`           | Internal option/type barrel (`SchedulerPluginOptions`, lock options, registry entry).                                                                                 |
| `packages/scheduler-plugin/src/index.ts`                      | Public barrel: `SchedulerPlugin`, `SchedulerPluginOptions`, `IDistributedLock`.                                                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                          | src covered                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/index.test.ts` (extend) | `common/src/services/scheduler.ts` + barrel | The new types compile-resolve from `@hono-enterprise/common` (`import type { IScheduler, ScheduledJob, RetryOptions, ScheduleOptions }`).                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/cron-parser.test.ts`                    | `src/cron/cron-parser.ts`                   | `cronNextMs(expr, fromMs): number` for `* * * * *`, fixed fields, lists, ranges, `*/5`, the DOM/DOW combination rule, month/year wrap; invalid expr throws. Type-checks against `(cron: string, fromMs: number) => number`.                                                                                                                                                                                                                                                                                               |
| `test/unit/retry-handler.test.ts`                  | `src/retry/retry-handler.ts`                | `computeBackoffMs(attempt, retry)` fixed = `delay`; exponential = `delay * 2**(attempt-1)` at attempts 1..k. Type-checks against `(attempt: number, retry: RetryOptions) => number`.                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/distributed-lock.test.ts`               | `src/lock/distributed-lock.ts`              | `resolveLock` returns `MemoryLock` when disabled, `RedisLock` for `storage:'redis'`, and the injected custom `lock` when provided.                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/memory-lock.test.ts`                    | `src/lock/memory-lock.ts`                   | `acquire` on a free key returns a token; a second `acquire` on the held key returns `null`; re-acquire after `release` succeeds; `acquire` after the TTL expires (fake clock advanced past `expiresAtMs`) succeeds; `release` with a mismatched token does NOT free the key; distinct keys are independent.                                                                                                                                                                                                               |
| `test/unit/redis-lock.test.ts`                     | `src/lock/redis-lock.ts`                    | With a fake-ioredis client: `acquire` issues `SET key token NX PX ttl` and returns the token when OK; a held key returns null; `release` runs the token-checked delete (matched token deletes, mismatched token does not); `validateClient` rejects a malformed client.                                                                                                                                                                                                                                                   |
| `test/unit/job-registry.test.ts`                   | `src/jobs/job-registry.ts`                  | add/get/has/remove; pause/resume flip state (idempotent per 3.3); `getNextRun` returns the stored next fire; adding a duplicate name throws; get/remove of an unknown name per the 3.3 unknown-name contract.                                                                                                                                                                                                                                                                                                             |
| `test/unit/job-executor.test.ts`                   | `src/jobs/job-executor.ts`                  | Success on first try (no retry); reject-then-success retries once; reject-until-`limit` gives up; backoff wait uses the runtime timer (advanced by the fake runtime). Type-checks `run(entry)` against the entry shape.                                                                                                                                                                                                                                                                                                   |
| `test/unit/scheduler-service.test.ts`              | `src/services/scheduler-service.ts`         | `cron` arms a timer at `cronNextMs(now)` and re-arms after firing; `every` fires on the interval; `delay` fires once and is removed; `pause`/`resume`/`remove`; `getNextRun`; the 3.3 edge behaviors (duplicate-name throw; unknown-name throw on `pause`/`resume`/`remove`/`getNextRun`; pause/resume idempotence; paused `getNextRun` throws; resumed `delay` re-arms the full `delayMs`); a held lock skips the fire; `connect`/`disconnect`/`isReady`/`createHealthIndicator`. Calls type-check against `IScheduler`. |
| `test/unit/scheduler-plugin.test.ts`               | `src/plugin/scheduler-plugin.ts`            | `SchedulerPlugin()` returns an `IPlugin` with `provides: ['scheduler']`, `priority`; `register(ctx)` registers an `IScheduler` under `CAPABILITIES.SCHEDULER`, a health indicator, and an `onClose` that disconnects; non-UTC `timezone` throws; `distributedLock` wiring.                                                                                                                                                                                                                                                |
| `test/unit/barrel-exports.test.ts`                 | `src/index.ts`                              | `SchedulerPlugin`, `SchedulerPluginOptions`, `IDistributedLock` are exported; internal symbols (`SchedulerService`, `JobRegistry`, `RedisLock`, …) are NOT exported.                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/redis-lock-real-import.test.ts`         | `src/lock/redis-lock.ts`                    | Guarded real `await import('npm:ioredis@5.x')`; asserts the constructor loads (skipped when the package is absent), mirroring the redis-queue precedent.                                                                                                                                                                                                                                                                                                                                                                  |
| `test/fixtures/fake-runtime.ts`                    | —                                           | Reusable fake `IRuntimeServices` controlling `now()` and `setTimeout`/`setInterval` so fire timing is deterministic.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/fixtures/fake-ioredis-client.ts`             | —                                           | Fake redis client recording `SET`/`DEL`/`EVAL` for `RedisLock` tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/integration/scheduler-integration.test.ts`   | plugin + service + lock                     | Register `SchedulerPlugin`, resolve `IScheduler`, schedule a job, advance the fake clock, assert the handler runs exactly once (lock) and that `onClose` clears timers.                                                                                                                                                                                                                                                                                                                                                   |

`packages/scheduler-plugin/src/interfaces/index.ts` is intentionally absent from the table: it is a
type-only barrel (interfaces and type aliases, zero runtime code), so `deno coverage` produces no
per-file entry for it; it is verified by `deno task check` and by every test that imports its types.
If any runtime code (a constant, a guard function) lands in it during implementation, that code
moves to a `src/` file with a named test row — this file stays type-only.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/milestone-18-scheduler-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- **Timer determinism in tests →** all timers and the clock come from `IRuntimeServices`; the
  fake-runtime fixture advances `now()` and fires `setTimeout`/`setInterval` synchronously so fire
  order is deterministic (queue-plugin precedent).
- **Redis lock correctness (lost release / stale lock) →** acquire uses `SET key token NX PX ttl`
  and release is token-checked; tests cover the token-matched delete and the token-mismatched
  no-delete. `ttlMs` is configurable and documented as "must exceed worst-case job runtime".
- **Lock TTL vs long jobs →** no watchdog renewal in this release (out of scope, §9); mitigation is
  a documented, configurable `ttlMs` and the test asserting a skipped fire when the lock is held.
- **Cron parser copy drift →** the copy is internal to this package; if its behavior diverges from
  queue's `cronNextMs` it is a defect. Mitigation: port the queue `cron-calculator.test.ts` coverage
  verbatim so the two stay behaviorally aligned.
- **`exactOptionalPropertyTypes` / `verbatim-module-syntax` →** never assign `undefined` to an
  optional (omit it); type-only imports use `import type`. Both are recurring gate failures
  (CLAUDE.md pitfalls).

## 9. Out of scope

- Durable / restart-surviving schedules and a Redis-backed schedule store — durability is the queue
  plugin's job (`@hono-enterprise/queue-plugin`, Milestone 15); a future durable-scheduler milestone
  may add persistence.
- Timezone support beyond UTC — future release (the `timezone` option throws on non-UTC in this
  release, 3.5).
- Lock watchdog / automatic TTL renewal — future.
- `@Cron` / `@Every` / `@Delay` decorators and decorator-plugin auto-discovery — a later
  decorator-integration milestone (the ARCHITECTURE review lists these but they are not in ROADMAP
  M18).
- Named scheduler instances (queue-style `scheduler.<name>`) — not in PUBLIC_API; the scheduler is a
  single provider of `CAPABILITIES.SCHEDULER` (3.5).
