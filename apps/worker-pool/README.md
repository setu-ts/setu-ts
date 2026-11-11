# Worker pool example

Run `pnpm --dir apps/worker-pool run start`, then request `GET /health` on port 3000 (pass another
port as the first argument). Run `pnpm --dir apps/worker-pool run smoke` to exercise the unstarted
factory in `setu.config.ts`. A downloaded copy runs the same scripts with `npm run start` and
`npm run smoke` in its own directory.

The app registers RuntimePlugin, HealthPlugin with `details: true` (so `/health` shows the pool's
budget, which is hidden by default) and WorkerPoolPlugin with `maxWorkers: 1`. Its two task modules
in `src/tasks/` share that slot: `spin.task.ts` does CPU-bound work off the event loop;
`fill.task.ts` writes a byte pattern into a caller-provided buffer.

The smoke checks main-thread timer progress during a 300 ms spin, completion of a second module
before the spin queue drains, shared-buffer writes visible to the caller, an unchanged ArrayBuffer
control, and the budget reported through `/health`.

Wait for the task promise to settle before reading shared memory. A timeout kills the worker and may
leave a partial write; concurrent access requires an Atomics protocol.

The CLI has no worker-task schematic. `setu g job` creates queue/scheduler jobs, which are not the
URL-loaded `defineWorkerTask` modules this example demonstrates. The existing `src/tasks/` files
therefore stay as they are; no unused job or health-indicator barrel is added.

Read the [example deep dive](../../docs/examples.md#worker-pool) for the concept and source
walkthrough.

For a Node production build, `setu build` bundles the literal
`new URL('./spin.task.ts', import.meta.url)` and `fill.task.ts` targets into `dist/src/tasks/` and
relocates their URLs for each output. Keep source specifiers unchanged for development. Dynamic task
paths are refused; Deno and Bun run source.
