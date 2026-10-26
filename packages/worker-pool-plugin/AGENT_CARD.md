# @setu-ts/worker-pool-plugin — run CPU work on threads

**Add it:** `setu add worker-pool` adds it and inserts `WorkerPoolPlugin()` into a recognized
functional `setu.config.ts`. It provides `CAPABILITIES.WORKER_POOL` (`IWorkerPool`).

## Submit an existing task from a route

The application-owned task module must register its worker handler through the worker-side helper
from `@setu-ts/runtime/worker` before it can receive work.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IWorkerPool } from '@setu-ts/common';

export function registerThumbnailRoutes(router: IRouterApi): void {
  router.post('/thumbnail', {
    handler: async (ctx) => {
      const pool = ctx.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const image = await pool.run<Uint8Array, Uint8Array>(
        new URL('./tasks/resize-image.ts', import.meta.url).href,
        await ctx.request.bytes(),
        { timeoutMs: 15_000 },
      );
      return ctx.response.header('content-type', 'image/png').send(image);
    },
  });
}
```

## Inspect pool load

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IWorkerPool } from '@setu-ts/common';

const pools = ctx.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL).stats();
ctx.response.json(pools);
```

## Behaviour the types do not show

- A pool is created on first use of each task-module specifier.
- Payloads cross by structured clone; functions cannot be sent. Shared memory remains shared.
- `taskTimeoutMs` defaults to 30000 milliseconds; `0` disables it. Per-call `timeoutMs` overrides
  it.
- `maxQueue` defaults to 1024; `startupTimeoutMs` defaults to 10000 milliseconds and cannot be
  disabled.
- Without runtime worker support, registration succeeds but `run` rejects with
  `WorkerPoolUnavailableError`; the health indicator reports up with `available: false`.
- Application shutdown terminates workers and rejects pending tasks.

## Other options

- `maxWorkers` caps all pools together; `Infinity` disables that cap.
- `defaultPoolSize` sets per-module sizing; `pools` overrides `size`, `maxQueue` and `taskTimeoutMs`
  by specifier.
- `host` injects a worker host; `WorkerQueueFullError` and `WorkerTaskTimeoutError` identify
  overload and deadlines.

<!-- card-allow: Infinity -->
