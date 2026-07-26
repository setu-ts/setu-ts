# @hono-enterprise/scheduler-plugin

Job scheduling. Registers an `IScheduler` under `CAPABILITIES.SCHEDULER` (`'scheduler'`).

Cron, fixed-interval, and one-shot delayed jobs, with retry/backoff, pause/resume, and optional
distributed locking. The 5-field UTC cron parser is implemented here — no dependency.

## Installation

```typescript
import { SchedulerPlugin } from '@hono-enterprise/scheduler-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { SchedulerPlugin } from '@hono-enterprise/scheduler-plugin';
import { CAPABILITIES, type IScheduler } from '@hono-enterprise/common';

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

| Option            | Type                     | Default  | Description                                |
| ----------------- | ------------------------ | -------- | ------------------------------------------ |
| `timezone`        | `string`                 | `'UTC'`  | Only `'UTC'` is supported in this release. |
| `distributedLock` | `DistributedLockOptions` | disabled | Multi-instance safety; see below.          |

## Distributed locking

Without `distributedLock`, a process-local `MemoryLock` is used — fine for a single instance, but
**every replica will run every job**. Set `{ enabled: true, storage: 'redis' }` to use `RedisLock`
(over `npm:ioredis`, lazily imported or injected) so only one replica executes each firing.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
