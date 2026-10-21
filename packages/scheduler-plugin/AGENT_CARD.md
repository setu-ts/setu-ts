# @setu-ts/scheduler-plugin — cron, interval and delayed jobs

`setu add scheduler` installs it and, in a recognized functional config, registers
`SchedulerPlugin()`; otherwise add that line in `setu.config.ts`. Scheduling is unavailable on
Cloudflare Workers (registration throws `SchedulerUnavailableError`). `CAPABILITIES.SCHEDULER`
resolves after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IScheduler } from '@setu-ts/common';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';

app.register(SchedulerPlugin({ distributedLock: { enabled: true, storage: 'redis' } }));

await app.start();
const scheduler = app.services.get<IScheduler>(CAPABILITIES.SCHEDULER);

await scheduler.cron('nightly-report', '0 2 * * *', async () => {
  // replace with real work
});
await scheduler.every('poll-inbox', 30_000, async () => {
  // replace with real work
});
await scheduler.delay('warmup', 5_000, async () => {
  // replace with real work
});
await scheduler.pause('poll-inbox');
await scheduler.resume('poll-inbox');
```

- Cron is 5-field and evaluated in UTC only; `timezone` accepts nothing else. Handlers are
  process-local: there is no durable store, so a restart loses pending one-shots.
- Without `distributedLock`, a process-local lock is used and **every replica runs every job**. Set
  `{ enabled: true, storage: 'redis', url }` (`url` defaults to `redis://localhost:6379`);
  `acquireTimeoutMs` (default `5000`, `0` waits forever) bounds each acquire, and a timed-out
  acquire skips that fire instead of stalling the schedule.
- `jobs: [{ trigger: 'cron', name, expression, handler }, { trigger: 'every', name, intervalMs, handler }, { trigger: 'delay', name, delayMs, handler }]`
  registers declaratively; each entry may be a factory receiving the service registry at `onInit`.
  `behaviors` wraps every handler.
- A non-finite or out-of-range `delayMs`, `intervalMs` or `retry.delay` makes the registration call
  reject with RangeError. Pass `{ retry: { limit, delay, backoff } }` as the fourth argument to
  retry.
- `pause`, `resume`, `remove` and `getNextRun` take the job name. Cancelling a fire during retry
  backoff discards the attempt; a paused one-shot resumes from attempt 1.
- `diagnostics: { enabled: true, alias, jobs }` observes only the exact job names listed; without it
  nothing is observed.
