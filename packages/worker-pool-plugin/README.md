# @setu-ts/worker-pool-plugin

Run CPU-bound work on **real worker threads**, off the event loop, behind the Setu-TS capability
model. Registers an `IWorkerPool` under `CAPABILITIES.WORKER_POOL`.

Task handlers are addressed by **module specifier**, never by closure — closures cannot cross a
thread boundary. Task inputs and outputs travel by **structured clone** (plain data only).

## When to use it

The framework's request path is I/O-bound and the event loop handles it well. Reach for a worker
pool only for genuinely CPU-bound work that would otherwise block the loop: image/video processing,
PDF or report generation, cryptographic hashing at volume, large in-memory data transforms.

## Runtime support

Threads come from the runtime's `IRuntimeServices.workers` host:

| Runtime            | Backing primitive          | Supported |
| ------------------ | -------------------------- | --------- |
| Node               | `node:worker_threads`      | yes       |
| Deno               | web `Worker`               | yes       |
| Bun                | web `Worker`               | yes       |
| Cloudflare Workers | — (no threads on the edge) | no        |

On Cloudflare Workers the plugin still registers, but `run()` rejects with
`WorkerPoolUnavailableError` and the health indicator reports `available: false`. The same codebase
deploys everywhere.

## Installation

```typescript
import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';
```

No third-party dependency. Threads are provided by the runtime adapter.

## Authoring a task module

A task module is an ES module **your application owns**. It registers its handler at module top
level with `defineWorkerTask` from the runtime package's `./worker` subpath:

```typescript
// tasks/resize-image.ts — runs on a worker thread
import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<Uint8Array, Uint8Array>(async (imageBytes) => {
  return await resize(imageBytes);
});
```

> On **Node**, a `.ts` task module needs a loader/build to execute — that is your application's
> build concern, exactly as installing a database driver is. Deno and Bun run `.ts` workers
> directly. The plugin consumes the module specifier as given.

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IWorkerPool } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    WorkerPoolPlugin({ taskTimeoutMs: 10_000 }),
  ],
});
await app.start();

const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
const thumb = await pool.run<Uint8Array, Uint8Array>(
  new URL('./tasks/resize-image.ts', import.meta.url).href,
  imageBytes,
);
```

## Options

| Option            | Type                              | Default                  | Description                                            |
| ----------------- | --------------------------------- | ------------------------ | ------------------------------------------------------ |
| `defaultPoolSize` | `number`                          | `availableParallelism()` | Workers per pool.                                      |
| `maxQueue`        | `number`                          | `1024`                   | Pending-task bound per pool; exceeding it throws.      |
| `taskTimeoutMs`   | `number`                          | `30000`                  | Per-task timeout; `0` disables. Timed-out worker dies. |
| `pools`           | `Record<string, TaskPoolOptions>` | `{}`                     | Per-module `{ size?, maxQueue?, taskTimeoutMs? }`.     |
| `host`            | `IWorkerHost`                     | `runtime.workers`        | Injected host, wins over the runtime's; for tests.     |

## Semantics

- **One pool per task-module specifier**, created lazily on first `run()`. Workers spawn on demand
  up to the pool size; an idle worker is reused before a new one spawns; pending tasks wait in a
  bounded FIFO queue.
- **Handler error vs worker crash.** A thrown handler is a healthy worker reporting failure: the
  task rejects with `WorkerTaskError` and the worker is retained. A worker-level crash rejects its
  in-flight task, drops the worker, and re-dispatches its queued work to survivors.
- **Timeout.** A task exceeding its timeout rejects with `WorkerTaskTimeoutError`; the worker is
  terminated and replaced (in-flight JavaScript cannot be cancelled).
- **Overload.** When the pending queue is at its bound, `run()` rejects with `WorkerQueueFullError`
  instead of growing memory without limit.
- **Shutdown.** The plugin's `onClose` hook terminates every worker and rejects pending tasks.

## Errors

All four are exported for `instanceof` handling: `WorkerPoolUnavailableError`, `WorkerTaskError`,
`WorkerTaskTimeoutError`, `WorkerQueueFullError`.

## Health

Registers a `worker-pool` health indicator reporting `{ available, pools }`, where `pools` is one
`{ taskModule, workers, busy, queued, completed, failed }` snapshot per pool.
