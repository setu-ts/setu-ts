# @setu-ts/worker-pool-plugin — run CPU work on threads

**Add it:** `setu add worker-pool` adds it and inserts `WorkerPoolPlugin()` into a recognized
functional or full-stack `setu.config.ts`. It provides `CAPABILITIES.WORKER_POOL` (`IWorkerPool`).

## Submit an existing task from a route

The task module registers its handler with `@setu-ts/runtime/worker` before it receives work.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IWorkerPool } from '@setu-ts/common';

export function registerThumbnailRoutes(router: IRouterApi): void {
  router.post('/thumbnail', {
    handler: async (ctx) => {
      const pool = ctx.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
      const image = await pool.run<Uint8Array, Uint8Array>(
        new URL('./tasks/resize-image.task.ts', import.meta.url).href,
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
- Payloads cross by structured clone (no functions); shared memory stays shared.
- `taskTimeoutMs` defaults to 30000 ms; `0` disables it; per-call `timeoutMs` overrides it.
- Per-call `signal` rejects with `signal.reason`: queued work is withdrawn, a running worker
  terminated; counted as rejected, reason `aborted`.
- `maxQueue` defaults to 1024; `startupTimeoutMs` defaults to 10000 ms and cannot be disabled.
- Without worker support, `run` rejects with `WorkerPoolUnavailableError`; health is up with
  `available: false`.
- Shutdown terminates workers and rejects pending tasks.

## Other options

- `maxWorkers` caps all pools' slots (`Infinity`: no cap); threads may briefly exceed it.
- `defaultPoolSize` sets per-module sizing; `pools` overrides `size`, `maxQueue` and `taskTimeoutMs`
  by specifier.
- `host` injects a worker host; `WorkerQueueFullError`/`WorkerTaskTimeoutError` mark overload and
  deadlines.

<!-- card-allow: Infinity -->

## Building with `setu build`

Keep the specifier a literal in the call (`new URL('./tasks/x.task.ts', import.meta.url)`):
`setu build` bundles each `*.task.ts` and rewrites it to the emitted `.js`; it cannot see a path in
a variable.
