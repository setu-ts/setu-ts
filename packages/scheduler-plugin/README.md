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

## Options

| Option            | Type                                                                 | Default  | Description                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timezone`        | `string`                                                             | `'UTC'`  | Only `'UTC'` is supported in this release.                                                                                                         |
| `distributedLock` | `DistributedLockOptions`                                             | disabled | Multi-instance safety; see below.                                                                                                                  |
| `jobs`            | `readonly SchedulerJobEntry[]`                                       | —        | Declarative `cron()` / `every()` / `delay()` registrations. `SchedulerJobDefinition` is discriminated by `trigger`; factories resolve at `onInit`. |
| `behaviors`       | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | —        | Chain around every handler. It sees `kind: 'scheduler'`, job name, the delivered job, and its 1-based attempt.                                     |

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
```

## Distributed locking

Without `distributedLock`, a process-local `MemoryLock` is used — fine for a single instance, but
**every replica will run every job**. Set `{ enabled: true, storage: 'redis' }` to use `RedisLock`
(over `npm:ioredis`, lazily imported or injected) so only one replica executes each firing.

Behaviours run inside that lock. A replica that does not acquire it runs neither the behaviour chain
nor the job handler; a behaviour throw follows the job's existing retry policy. With no behaviours,
the handler receives its original job directly and no chain is allocated.

## Exports

| Export                      | Kind      |
| --------------------------- | --------- |
| `SchedulerPlugin`           | function  |
| `SchedulerUnavailableError` | class     |
| `DistributedLockOptions`    | interface |
| `IDistributedLock`          | interface |
| `IRedisLockClient`          | interface |
| `IScheduler`                | interface |
| `RetryOptions`              | interface |
| `ScheduledJob`              | interface |
| `ScheduleOptions`           | interface |
| `SchedulerPluginOptions`    | interface |
| `SchedulerBackoff`          | type      |
| `SchedulerJobDefinition`    | type      |
| `SchedulerJobEntry`         | type      |
| `SchedulerJobHandler`       | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#scheduler-setu-tsscheduler-plugin).
