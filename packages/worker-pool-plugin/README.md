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

// Whatever CPU-bound work belongs on a thread; your application owns it.
declare function resize(input: Uint8Array): Promise<Uint8Array>;

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

const imageBytes = new Uint8Array([137, 80, 78, 71]);

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
- **A worker that ends its own thread** — `process.exit()` inside the handler — settles its
  in-flight task with `WorkerExitError` and frees the slot, independently of the task timeout, **on
  Node and Bun**. On Deno nothing is emitted, so the task is settled only by
  `WorkerTaskTimeoutError` when a timeout is configured; see the table below. This is what the
  "worker crash" line above always promised; before M70k the only thing that settled such a task was
  the timeout, so `taskTimeoutMs: 0` left `run()` pending forever and wedged the pool permanently
  (smoke finding X8-7).

  **Whether it is detected depends on the runtime, and the pool tells you which you have.** The
  `worker-pool` health payload reports `exitDetection`, and `register()` warns once when
  `taskTimeoutMs` is `0` on a runtime that cannot report an exit:

  | Runtime            | Worker host           | Exit reported? | Mechanism                        |
  | ------------------ | --------------------- | -------------- | -------------------------------- |
  | Node               | `node:worker_threads` | yes            | the `'exit'` event               |
  | Bun                | web `Worker`          | yes            | Bun's non-standard `'close'`     |
  | Deno               | web `Worker`          | **no**         | nothing is emitted at all        |
  | Cloudflare Workers | none                  | n/a            | `run()` throws; no worker spawns |

  Deno's web `Worker` emits no host-side event when a worker ends its thread — not `close`, `exit`,
  `error` or `messageerror` — and a later `postMessage` still resolves, so the death is
  undetectable. (`self.close()` is named here only because it is the web spelling; on Bun
  `self.close` is `undefined` altogether, so `process.exit()` is the portable way to do this.) Keep
  a task timeout on any Deno pool whose task module can terminate itself; it remains the only
  backstop there.
- **Overload.** When the pending queue is at its bound, `run()` rejects with `WorkerQueueFullError`
  instead of growing memory without limit.
- **Shutdown.** The plugin's `onClose` hook terminates every worker and rejects pending tasks.

## Errors

All five are exported for `instanceof` handling: `WorkerPoolUnavailableError`, `WorkerTaskError`,
`WorkerTaskTimeoutError`, `WorkerQueueFullError`, `WorkerExitError`.

`WorkerExitError` is distinct from `WorkerTaskError` on purpose: the latter carries an error the
worker managed to report, while a thread that simply stops raises nothing at all.

## Health

Registers a `worker-pool` health indicator reporting `{ available, exitDetection, pools }`, where
`pools` is one `{ taskModule, workers, busy, queued, completed, failed }` snapshot per pool.

`exitDetection` reports whether this runtime can tell the pool that a worker's thread ended — see
the lifecycle table above. It is `false` on Deno and on any custom `IWorkerHost` that does not
implement `reportsExit`.

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
| `WorkerExitError`            | class     |
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
