# @setu-ts/scheduler-plugin

Job scheduling. Registers an `IScheduler` under `CAPABILITIES.SCHEDULER` (`'scheduler'`).

Cron, fixed-interval, and one-shot delayed jobs, with retry/backoff, pause/resume, and optional
distributed locking. The 5-field UTC cron parser is implemented here — no dependency.

## Installation

```typescript
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { CAPABILITIES, type IScheduler } from '@setu-ts/common';

// Your application's own work — stand-ins so this example compiles as written.
declare function buildReport(): Promise<void>;
declare function pollInbox(): Promise<void>;
declare function warmCaches(): Promise<void>;

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SchedulerPlugin({ distributedLock: { enabled: true, storage: 'redis' } }),
  ],
});
await app.start({ port: 3000 });

const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);

// 5-field UTC cron
await scheduler.cron('nightly-report', '0 2 * * *', async () => {
  await buildReport();
});

// Fixed interval, and a one-shot delay
await scheduler.every('poll-inbox', 30_000, async () => await pollInbox());
await scheduler.delay('warmup', 5_000, async () => await warmCaches());

await scheduler.pause('poll-inbox');
await scheduler.resume('poll-inbox');
```

## Timing and registration refusals

`delay`, `every`, `cron` and retry backoff honour long waits in timer chunks of at most 2147483647
ms, checking the wall clock on every wake. A job never runs before its due time, even after an early
wake or a clock step backwards. There is no upper limit on a delay or interval: `delay(30 days)`
waits the full 30 days, and monthly cron jobs wait until their next due instant. Previously, Node,
Deno and Bun clamped an over-limit timer to about 1 ms, so these jobs could fire early.

Invalid time values now make the async registration call reject with a `RangeError`:

| Registration             | Refused value                   | Message fragment                           |
| ------------------------ | ------------------------------- | ------------------------------------------ |
| `delay`                  | `delayMs` not finite or < 0     | `delayMs must be a finite number >= 0`     |
| `every`                  | `intervalMs` not finite or <= 0 | `intervalMs must be a finite number > 0`   |
| `delay`, `every`, `cron` | `retry.delay` not finite or < 0 | `retry.delay must be a finite number >= 0` |

Each message names the job, option and rule without echoing the rejected value. Zero `delayMs` and
zero `retry.delay` are accepted; large finite values are accepted. Fix invalid values before
registering jobs.

An exponential backoff that overflows to `Infinity` with an enormous retry limit now waits forever
instead of retrying after about 1 ms.

Disconnect, remove and pause cancel pending retry backoff without another attempt. A one-shot that
already succeeded or exhausted its retries is removed even while paused and is not re-run. A
one-shot paused mid-retry stays registered; resume starts it from attempt 1 using the original
delay. Recurring jobs resume at the next cron/interval boundary. Remaining backoff is discarded. A
cancelled fire is not reported as success: diagnostics settle it with `false`, counting it in
`failed` because there is no separate cancellation counter. An in-flight handler may still reach a
final success or failure after cancellation. If a job is resumed while that handler is still
running, it is armed only once the handler settles, so the two never overlap. Disconnect releases
every one-shot `:once` slot this service holds, each release bounded by `acquireTimeoutMs`;
`resume()` rejects on a disconnected service, and after reconnecting a one-shot re-claims its slot,
so a replica that claimed it meanwhile runs the job instead. A pause, remove or disconnect during
that re-claim wins over the resume, and a second `resume()` waits for the first.

## Options

| Option            | Type                                                                 | Default  | Description                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`        | `string`                                                             | `'UTC'`  | Only `'UTC'` is supported in this release.                                                                                                                                                      |
| `distributedLock` | `DistributedLockOptions`                                             | disabled | Multi-instance safety; see below.                                                                                                                                                               |
| `jobs`            | `readonly SchedulerJobEntry[]`                                       | —        | Declarative `cron()` / `every()` / `delay()` registrations. `SchedulerJobDefinition` is discriminated by `trigger`; factories resolve at `onInit`.                                              |
| `behaviors`       | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | —        | Chain around every handler. It sees `kind: 'scheduler'`, job name, the delivered job, and its 1-based attempt.                                                                                  |
| `diagnostics`     | `SchedulerDiagnosticsOptions`                                        | —        | Opt-in execution observations (M98k): `{ enabled: true, alias, jobs }`, `jobs` mapping exact job names to approved aliases (at most 64). Absent — an inert `disabled` source, nothing observed. |

Declare jobs where the plugin is composed, instead of resolving the scheduler after `start()`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import type { IIngressBehavior } from '@setu-ts/common';

/** Runs ahead of every job handler; `next()` continues the chain. */
const auditEveryRun: IIngressBehavior = {
  handle: (ctx, next) => {
    console.log(`${ctx.kind} ${ctx.name} attempt ${ctx.attempt ?? 1}`);
    return next();
  },
};

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SchedulerPlugin({
      behaviors: [auditEveryRun],
      jobs: [
        {
          trigger: 'every',
          name: 'send-email',
          intervalMs: 60_000,
          data: { to: 'ada@example.com' },
          handler: (job) => {
            console.log('sending to', job.data);
          },
        },
      ],
    }),
  ],
});

// Declared jobs register during startup, so nothing is scheduled until now.
await app.start({ port: 3000 });
```

## Distributed locking

Without `distributedLock`, a process-local `MemoryLock` is used — fine for a single instance, but
**every replica will run every job**. Set `{ enabled: true, storage: 'redis' }` to use `RedisLock`
(over `ioredis`, lazily imported or injected) so only one replica executes each firing.

Every lock acquire is bounded, whichever lock is in use. An acquire still unsettled after
`acquireTimeoutMs` is a skipped fire: it is logged, counted as `lockFailed` in the execution
observations, and the job is re-armed for its next slot, so a paused or unreachable lock backend
skips fires instead of stopping the schedule. Keep the bound below the job's interval. An acquire
that returns a token after the bound has its lock released, so the abandoned token does not block
the next fire until its TTL expires.

| `DistributedLockOptions` | Default            | Meaning                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acquireTimeoutMs`       | `5000`             | Bound on each lock acquire. `0` waits indefinitely. A value outside `0`–`2147483647` is refused with a `RangeError` when `SchedulerPlugin(...)` is called.                                                                                                                                                             |
| `commandTimeoutMs`       | `acquireTimeoutMs` | ioredis `commandTimeout` on the client `RedisLock` builds; `15000` when `acquireTimeoutMs` is `0`. Refused when it exceeds a non-zero `acquireTimeoutMs`. Not applied to an injected client or lock. A timed-out `SET` can still apply once Redis answers, so `RedisLock` releases that exact token before rethrowing. |

Connection errors of the `ioredis` client the lock builds go to the application logger — the first
error of an outage at `warn`, identical repeats at `debug`, the recovery at `info` — instead of
`ioredis` printing every reconnect failure to `console.error`. An injected client gets no listener:
it belongs to the caller.

**node-redis.** To use node-redis instead of ioredis, pass
`distributedLock: { enabled: true, storage: 'redis', client: fromNodeRedis(createClient({ url })) }`
(`fromNodeRedis` from `@setu-ts/common`, `createClient` from `redis`, installed in your
application). See
[Using node-redis](https://github.com/setu-ts/setu-ts/blob/main/packages/common/README.md#using-node-redis-0110).

Behaviours run inside that lock. A replica that does not acquire it runs neither the behaviour chain
nor the job handler; a behaviour throw follows the job's existing retry policy. With no behaviours,
the handler receives its original job directly and no chain is allocated.

## Health

The `scheduler` indicator reports `up` while the scheduler is connected and `down` after disconnect.
Its `data` includes `connected` and `lock: { reachable }`, where `reachable` is `true`, `false`, or
`'unknown'`. A shared lock outage stops job fires while request serving can continue, so
reachability does not change lifecycle status or remove the replica from readiness. Alert on
`data.lock.reachable` to detect lock outages.

`IDistributedLock.isHealthy?(): Promise<boolean | undefined>` is optional: an absent probe, an
`undefined` answer, or a probe that does not settle within 2 s reports `'unknown'`. The indicator
caches each answer for 5 s, uses runtime clocks and timers, and probes only while connected.
`MemoryLock` always answers `true`. `RedisLock` answers `false` before connect and after disconnect;
while connected it calls the optional `IRedisLockClient.ping?(): Promise<unknown>`. A resolved PING
means `true`, a rejected PING means `false`, and a client without PING means `'unknown'`. A built
client's PING also uses its configured `commandTimeout`.

## Execution observations

`SchedulerPlugin({ diagnostics: { enabled: true, alias, jobs } })` registers one
`ISchedulerDiagnosticsSource` under `CAPABILITIES.SCHEDULER_DIAGNOSTICS` (as a multi provider, one
per instance) that the local diagnostics connector reads to serve `GET /v1/scheduler`. Only exact
job names listed in `jobs` are observed, each under its approved alias; counters distinguish
contended fires (a lock held elsewhere), lock-failed fires, dispatched fires and handler attempts
(including retries; a `behaviors` entry that declines a dispatch invokes no handler, so it records
no attempt), plus the wall-clock lateness each fire started late. A skipped local fire is never
reported as a globally missed execution. Job names, cron expressions, payloads, job ids, lock keys
and thrown errors are never captured; without the option nothing is observed at all.

## Exports

| Export                        | Kind      |
| ----------------------------- | --------- |
| `SchedulerPlugin`             | function  |
| `SchedulerUnavailableError`   | class     |
| `DistributedLockOptions`      | interface |
| `IDistributedLock`            | interface |
| `IRedisLockClient`            | interface |
| `IScheduler`                  | interface |
| `RetryOptions`                | interface |
| `ScheduledJob`                | interface |
| `ScheduleOptions`             | interface |
| `SchedulerDiagnosticsOptions` | interface |
| `SchedulerPluginOptions`      | interface |
| `SchedulerBackoff`            | type      |
| `SchedulerJobDefinition`      | type      |
| `SchedulerJobEntry`           | type      |
| `SchedulerJobHandler`         | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#scheduler-setu-tsscheduler-plugin).
