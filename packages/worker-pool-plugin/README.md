# @setu-ts/worker-pool-plugin

Run CPU-bound work on **real worker threads**, off the event loop, behind the Setu-TS capability
model. Registers an `IWorkerPool` under `CAPABILITIES.WORKER_POOL`.

Task handlers are addressed by **module specifier**, never by closure — closures cannot cross a
thread boundary. Task inputs and outputs travel by **structured clone** (structured-clonable data,
including shared buffers).

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

| Option             | Type                              | Default                  | Description                                                                            |
| ------------------ | --------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `maxWorkers`       | `number`                          | See sizing below         | Total live worker slots across all modules; `Infinity` disables.                       |
| `startupTimeoutMs` | `number`                          | `10000`                  | Deadline for a spawned worker to signal ready; cannot be disabled; at most 2147483647. |
| `defaultPoolSize`  | `number`                          | `availableParallelism()` | Workers per pool.                                                                      |
| `maxQueue`         | `number`                          | `1024`                   | Pending-task bound per pool; exceeding it throws.                                      |
| `taskTimeoutMs`    | `number`                          | `30000`                  | Per-task timeout; `0` disables; at most 2147483647. Timed-out worker dies.             |
| `pools`            | `Record<string, TaskPoolOptions>` | `{}`                     | Per-module `{ size?, maxQueue?, taskTimeoutMs? }`.                                     |
| `host`             | `IWorkerHost`                     | `runtime.workers`        | Injected host, wins over the runtime's; for tests.                                     |

## Semantics

- **One pool per task-module specifier**, created lazily on first `run()`. Workers spawn on demand
  up to the pool size and shared `maxWorkers` cap; an idle worker is reused before a new one spawns;
  pending tasks wait in a bounded FIFO queue.
- **Handler error vs worker crash.** A thrown handler is a healthy worker reporting failure: the
  task rejects with `WorkerTaskError` and the worker remains eligible for reuse or budget hand-over.
  A worker-level crash rejects its in-flight task, drops the worker, and re-dispatches its queued
  work to survivors.
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

## Sizing and shared memory

Each module has its own pool; `size` bounds that pool and `maxWorkers` bounds their sum. The
service-wide default is `max(availableParallelism(), defaultPoolSize ?? 0, sum(pools[*].size))`.
Explicit pool sizes therefore fit concurrently; modules using fallback sizes share the budget.
`maxWorkers: Infinity` restores the previous unbounded sum. Other values must be positive safe
integers; `NaN`, zero, negative and fractional values throw `RangeError` at plugin or service
construction, naming the option and refused value.

When the budget is full, a requester evicts another module's ready idle worker; otherwise it waits.
Freed capacity is reserved for waiting modules, with modules that have queued tasks and no slots
served first, then FIFO among equals. A busy module hands over a worker after a task settles if
another module has no slot. Timeouts include time waiting for this budget. Rotation costs a worker
spawn; size `maxWorkers` at least as large as the number of task modules active concurrently when
that cost matters. Workers stay resident between bursts; there is no timed idle reaping.

**Timeouts are validated.** `taskTimeoutMs` (plugin-wide and per pool) and a per-call `timeoutMs`
must be `0` (disabled) or a positive integer no greater than 2 147 483 647, the largest delay a
runtime timer honours. Anything else throws `RangeError` at construction, or rejects that `run()`
call before admission: `NaN` and negative values used to disable the timeout silently, and larger
values overflowed the timer and timed every task out after about 1 ms. Each option is read once and
the pools use exactly the validated value; only the own enumerable keys of `pools` are read, so an
entry inherited through a prototype is ignored.

**Untimed tasks hold their slot.** With `taskTimeoutMs: 0`, or a per-call `run()` option of
`timeoutMs: 0`, a task that never settles keeps its worker. Once every slot is held that way, other
task modules wait (until their own timeouts, or forever if theirs are disabled too) until the
process restarts. The pool does not reclaim a running task the application allowed to run
indefinitely; `register()` warns when `taskTimeoutMs` is `0` under a finite `maxWorkers` (a per-call
`timeoutMs: 0` cannot be seen at registration, so it gets no warning). Keep a timeout on modules
that share the budget, or opt out of the bound with `maxWorkers: Infinity`.

**Containers:** CPU limits lower `availableParallelism()` (measured on Deno and Node with
`--cpus=2`); pods without CPU limits see all node cores. Set an explicit bound for the pod's memory
budget. A trivial module measured about 12 MB per worker on Deno, 13.5 MB on Node and 1.5 MB on Bun;
imports and task data increase that cost. **The bound counts pool slots, not threads or memory.** A
worker the pool terminates (on a timeout, a startup deadline or a hand-over) leaves the budget at
once, but on Deno `Worker.terminate()` does not stop a thread that never yields: a timed-out
CPU-bound task keeps its thread, memory and CPU until its code returns. Measured on Deno with
`maxWorkers: 1`: five timed-out busy-loop tasks left 0 slots and four extra threads at about 500%
CPU. Node and Bun were not measured. Treat a task timeout as a correctness bound rather than a
resource bound for CPU-bound code that can loop, and have long tasks check a deadline and return.

**Task granularity:** a measured trivial round trip takes about 7–17 µs. Batch very small work so
serialization and scheduling do not cost more than the computation.

**SharedArrayBuffer:** structured clone shares it instead of copying it. A buffer nested in the
input can be written by the worker and read by its caller after the promise settles. A task's
settlement does not mean its worker has stopped using the buffer: on Deno a task that times out
keeps running, and keeps writing, after its promise has rejected (measured: 50 of 200 bytes written
at the rejection, all 200 a second later). After a successful result the worker is done with the
buffer. After a rejection, a timeout especially, treat the buffer as still shared and do not reuse
it. While a task runs, do not touch the buffer unless coordinating access with Atomics. SAB-backed
views are refused by `BodyInit` and some `SubtleCrypto` operations: copy into an ordinary
ArrayBuffer-backed view first. An ordinary `ArrayBuffer` input is copied, so the caller's original
stays unchanged.

See [`apps/worker-pool`](../../apps/worker-pool) for a runnable off-thread, fairness and
shared-memory smoke check. A synchronous spawn failure rejects the oldest pending task as a crash,
clears its timer, and holds no worker budget. The pool continues scheduling the remaining queue;
repeated spawn failures settle one task per attempt rather than leaving queued tasks stranded.

A worker that does not signal ready within `startupTimeoutMs` (default 10 s, applied even with
`taskTimeoutMs: 0`) is terminated, its slot returns to the budget, and the oldest waiting task for
that module rejects with `WorkerTaskError` (`remoteName: 'WorkerStartupTimeout'`). When a queued
task expires while another module has work and no worker, the expiring module yields a starting
worker to it, so a module that never becomes ready cannot starve the others under steady demand.
Callbacks from removed slots are ignored. A worker error that settles no task (an idle worker
crashing, or a startup crash with nothing queued) is logged as a warning with its `taskModule`,
since it rejects nothing a caller could see. Termination throws/rejections are contained; shutdown
waits at most 1,000 ms per termination, including already-retired slots. This bounds waiting, not
physical thread exit: a failing host can leave a worker alive. Module metadata remains retained for
the service lifetime. `NaN` or `Infinity` legacy default/pool sizes contribute zero to the derived
budget; their per-pool behavior remains unchanged, while independently valid configured modules
remain usable.

## Errors

All five are exported for `instanceof` handling: `WorkerPoolUnavailableError`, `WorkerTaskError`,
`WorkerTaskTimeoutError`, `WorkerQueueFullError`, `WorkerExitError`.

`WorkerExitError` is distinct from `WorkerTaskError` on purpose: the latter carries an error the
worker managed to report, while a thread that simply stops raises nothing at all.

## Health

Registers a `worker-pool` health indicator reporting `{ available, exitDetection, pools, budget }`,
where `pools` is one `{ taskModule, workers, busy, queued, completed, failed }` snapshot per pool.

`budget` is `{ maxWorkers, workers }`: the resolved bound (`null` for `Infinity`) and the sum of all
pools' worker slots. It counts slots, not threads: on Deno a timed-out CPU-bound worker can keep
running after its slot is released (see Sizing).

The status derives from `available`:

| `available` | Status     | Meaning                                                                              |
| ----------- | ---------- | ------------------------------------------------------------------------------------ |
| `true`      | `up`       | A worker host is present, so tasks can run.                                          |
| `false`     | `degraded` | No worker host: every `run()` rejects with `WorkerPoolUnavailableError`. The payload |
|             |            | adds a `reason` saying so.                                                           |

`degraded` rather than `down` because registering this plugin on Cloudflare Workers is deliberate —
the runtime has no threads, the capability resolves and refuses, and `degraded` keeps `/ready` at
200 while still surfacing in the payload. Reporting `down` would 503 every such deployment.

The pool counters are DATA, never a threshold. `failed` is cumulative, so any status derived from it
would need a failure rate this plugin cannot choose on an application's behalf; watch it through the
metrics instead.

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
