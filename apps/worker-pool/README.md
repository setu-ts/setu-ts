# Worker pool example

Run `pnpm --dir apps/worker-pool run start` here, then request `GET /health` on port 3000 (`PORT`
overrides it). Run `pnpm --dir apps/worker-pool run smoke` to exercise the unstarted factory in
`src/app.ts`.

The app registers RuntimePlugin, HealthPlugin with `details: true` (so `/health` shows the pool's
budget, which is hidden by default) and WorkerPoolPlugin with `maxWorkers: 1`. Its two task modules
share that slot: `spin.ts` does CPU-bound work off the event loop; `fill.ts` writes a byte pattern
into a caller-provided buffer.

The smoke checks main-thread timer progress during a 300 ms spin, completion of a second module
before the spin queue drains, shared-buffer writes visible to the caller, an unchanged ArrayBuffer
control, and the budget reported through `/health`.

Wait for the task promise to settle before reading shared memory. A timeout kills the worker and may
leave a partial write; concurrent access requires an Atomics protocol.
