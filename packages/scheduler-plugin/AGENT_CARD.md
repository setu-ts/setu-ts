# @setu-ts/scheduler-plugin — timed and recurring background jobs

**Add it:** `setu add scheduler` adds it and wires `SchedulerPlugin()` in a recognized functional
config. It provides `CAPABILITIES.SCHEDULER` (`IScheduler`).

## Send a nightly report

With mail configured, put this registration in `setu.config.ts`:

```ts
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMailer } from '@setu-ts/common';

export const scheduler = SchedulerPlugin({
  jobs: [(services) => ({
    trigger: 'cron', name: 'nightly-report', expression: '0 2 * * *',
    handler: async () => {
      await services.get<IMailer>(CAPABILITIES.MAIL).send({
        to: 'ops@example.com', subject: 'Daily report', text: 'Report ready',
      });
    },
  })],
});
```

## Schedule one delayed follow-up

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IScheduler } from '@setu-ts/common';

const scheduler = ctx.services.get<IScheduler>(CAPABILITIES.SCHEDULER);
await scheduler.delay('warmup', 5000, () => { console.log('Warmup due'); });
```

## Behaviour the types do not show

- Cron has five fields and runs in UTC; any other `timezone` is refused.
- Jobs are process-local and not durable. Without a distributed lock, each replica runs its own
  copy. Cloudflare Workers registration throws `SchedulerUnavailableError`.
- `every` intervals and `delay` delays are milliseconds. Recurring intervals align to epoch grid
  boundaries, including after resume; delayed jobs are removed after their fire completes.
- Reusing a scheduled name rejects. `pause` preserves configuration; resuming a delayed job re-arms
  its full original delay.
- Job factories resolve at `onInit`. A timed-out lock acquisition skips that fire; the default
  `acquireTimeoutMs` is 5000 and `0` disables the bound.

## Other options

- `every` schedules a fixed interval; `pause`, `resume`, `remove` and `getNextRun` use the job name.
- `distributedLock: { enabled: true, storage: 'redis', url }` enables cross-process locking.
- The scheduling methods' fourth argument accepts `data` and `retry: { limit, delay, backoff }`;
  `behaviors` wraps all handlers and `diagnostics` observes an explicit job allowlist.
