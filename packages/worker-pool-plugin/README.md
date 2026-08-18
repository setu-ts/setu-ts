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
- **`taskTimeoutMs: 0` also disables crash detection for a self-terminated worker.** A worker that
  ends itself is not reported through any host event, so the timeout is the only thing that settles
  its task; with the timeout off, that `run()` never settles and its pool slot is not released. Set
  a timeout on any pool whose task module can call `self.close()`. (Tracked as smoke finding X8-7;
  the durable fix needs a worker exit signal on `IWorkerHandle` and is owned by M70k.)
- **Overload.** When the pending queue is at its bound, `run()` rejects with `WorkerQueueFullError`
  instead of growing memory without limit.
- **Shutdown.** The plugin's `onClose` hook terminates every worker and rejects pending tasks.

## Errors

All four are exported for `instanceof` handling: `WorkerPoolUnavailableError`, `WorkerTaskError`,
`WorkerTaskTimeoutError`, `WorkerQueueFullError`.

## Health

Registers a `worker-pool` health indicator reporting `{ available, pools }`, where `pools` is one
`{ taskModule, workers, busy, queued, completed, failed }` snapshot per pool.

## Metrics

When the application also registers `@setu-ts/metrics-plugin`, the pool publishes six Prometheus
series. Nothing is configured and nothing changes without that plugin — the instruments exist only
if `CAPABILITIES.METRICS` does.

| Metric                              | Type    | Labels                 | Meaning                           |
| ----------------------------------- | ------- | ---------------------- | --------------------------------- |
| `worker_pool_workers`               | gauge   | `task_module`          | Worker threads alive              |
| `worker_pool_busy_workers`          | gauge   | `task_module`          | Workers executing a task          |
| `worker_pool_queued_tasks`          | gauge   | `task_module`          | Tasks waiting in the queue        |
| `worker_pool_tasks_completed_total` | counter | `task_module`          | Tasks that completed successfully |
| `worker_pool_tasks_failed_total`    | counter | `task_module`,`reason` | Admitted tasks that then failed   |
| `worker_pool_tasks_rejected_total`  | counter | `task_module`,`reason` | Tasks refused before admission    |

`reason` is `handler` | `timeout` | `crash` | `clone` | `shutdown` on the failure counter, and
`queue_full` | `pool_closed` | `unavailable` on the rejection counter.

**Saturation** — the question a pool exists to raise — reads as `worker_pool_queued_tasks` rising
while `worker_pool_busy_workers` sits at `worker_pool_workers`, with
`worker_pool_tasks_rejected_total{reason="queue_full"}` marking the point where the queue
overflowed.

The two counters are deliberately separate. `..._failed_total` summed over `reason` always equals
the `failed` count in the health payload; `..._rejected_total` covers refusals that never became
tasks, which the health payload cannot see at all.

The gauges are written from the same snapshot the health indicator reads, on every pool state change
— no polling interval is armed, so there is no timer to leak at shutdown.

## Exports

| Export                       | Kind      |
| ---------------------------- | --------- |
| `WorkerPoolPlugin`           | function  |
| `WorkerPoolService`          | class     |
| `WorkerPoolUnavailableError` | class     |
| `WorkerQueueFullError`       | class     |
| `WorkerTaskError`            | class     |
| `WorkerTaskTimeoutError`     | class     |
| `TaskPoolOptions`            | interface |
| `WorkerPoolPluginOptions`    | interface |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#workerpoolplugin-setu-tsworker-pool-plugin).
