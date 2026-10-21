# @setu-ts/worker-pool-plugin — CPU-bound work off the event loop

`setu add worker-pool` adds the package and, in a recognized functional config, inserts
`WorkerPoolPlugin()` after the devtool spread. It registers `CAPABILITIES.WORKER_POOL` during
`app.start()`. A task is a module your application owns that calls `defineWorkerTask` at top level;
the pool addresses it by specifier and payloads cross by structured clone.

```ts
import { defineWorkerTask } from '@setu-ts/runtime/worker';

declare function resize(imageBytes: Uint8Array): Promise<Uint8Array>;

defineWorkerTask<Uint8Array, Uint8Array>(async (imageBytes) => await resize(imageBytes));
```

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IWorkerPool } from '@setu-ts/common';

export const app = createApplication({
  plugins: [RuntimePlugin(), WorkerPoolPlugin({ maxWorkers: 4, taskTimeoutMs: 10_000 })],
});

app.router.post('/thumbnail', async (ctx) => {
  const pool = ctx.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
  const thumb = await pool.run<Uint8Array, Uint8Array>(
    new URL('./tasks/resize-image.ts', import.meta.url).href,
    await ctx.request.bytes(),
    { timeoutMs: 15_000 },
  );
  return ctx.response.header('content-type', 'image/png').send(thumb);
});
```

- Options: `maxWorkers` (Infinity disables the cap), `startupTimeoutMs` (10000; cannot be disabled),
  `defaultPoolSize`, `maxQueue` (1024), `taskTimeoutMs` (30000; `0` disables), `pools` keyed by
  module specifier with `{ size, maxQueue, taskTimeoutMs }`, and `host`.
- One pool per module specifier, created on first use. `run` takes an optional `{ timeoutMs }` and
  `stats` reports one `{ taskModule, workers, busy, queued, completed, failed }` per pool.
- Errors: `WorkerPoolUnavailableError`, `WorkerTaskError`, `WorkerTaskTimeoutError`,
  `WorkerQueueFullError`, `WorkerExitError`.
- No threads on Cloudflare Workers: it registers, `run` rejects with `WorkerPoolUnavailableError`,
  and the `worker-pool` health indicator reports `available: false`.
- Deno cannot report a worker that ended its own thread (`exitDetection`), so keep a timeout there;
  a timed-out CPU-bound worker can hold its thread after its slot is released.
- Payloads are structured-clone data: no functions or class instances. A SharedArrayBuffer is
  shared, not copied — do not reuse it after a rejected run.
