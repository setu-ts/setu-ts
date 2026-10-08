# Milestone 45c — Worker Pool Sizing (`@setu-ts/worker-pool-plugin`)

> **Status:** Implemented and verified (PR pending). Branch: `feat/m45c-worker-pool-sizing`.
> `develop` and `main` are protected — all work (implementation + fixes) stays on this one branch
> until it merges via a single PR.

## 0. Objective & scope

Bound the total number of live worker threads an application holds across every task module, share
that budget between modules without starving any of them, and ship the worker pool's first runnable
example. Every worker is a full JavaScript isolate (measured with a trivial task module: about 12 MB
resident on Deno, about 13.5 MB on Node, about 1.5 MB on Bun). Today one pool exists per task-module
specifier, each pool's size defaults to `availableParallelism()`, nothing bounds the sum, and
workers are never terminated while their pool lives, so a burst across three task modules on a
32-core host leaves up to 96 isolates resident. The boundary: this milestone bounds the PEAK; it
does not shrink an idle pool on a timer.

- **In scope:** `WorkerPoolPluginOptions.maxWorkers` with validation at construction; an internal
  `WorkerBudget` shared by every `TaskPool` of one service, which evicts idle workers on demand and
  hands a freed slot to a waiting pool; a `budget` member in the `worker-pool` health payload; the
  `apps/worker-pool` example; README and PUBLIC_API documentation of container sizing, measured
  per-worker memory, `SharedArrayBuffer` usage and its caveats, and task granularity.
- **NOT this milestone:** timed idle reaping and prewarming (`idleTimeoutMs`, `minWorkers`) — no
  owning milestone; deferred until an application reports memory pressure between bursts.
  Multi-module workers and an `IWorkerHandle.postMessage` transfer list — no owning milestone; the
  second is a `common` widening. A native or bare-isolate backend — rejected: a native thread cannot
  be killed on timeout and its crash takes the process down, and a bare-isolate backend is Node-only
  with no imports inside a task. Validation of the pre-existing `defaultPoolSize`/`size`/`maxQueue`
  options — §9.
- **Pre-existing defect fixed here, because the budget makes it reachable from another pool:** when
  `host.spawn` throws synchronously (measured: Deno's `new Worker('not a url')` throws `URIError`),
  `run()` rejects but its task stays queued with its timeout armed (probed on the current code:
  `stats()` reports `queued: 1` after the rejection). §3.10.

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                                           | Verified surface / fact                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IWorkerHost`                            | `packages/common/src/runtime.ts:205`                                                                         | `spawn(specifier): IWorkerHandle`, `availableParallelism(): number`, optional `reportsExit?(): boolean`. No other member; no change needed.                                                                                                                   |
| `IWorkerHandle`                          | `packages/common/src/runtime.ts:149`                                                                         | `postMessage(message)` (ONE argument, no transfer list), `onMessage`, `onError`, optional `onExit?`, `terminate(): Promise<void>`. Eviction uses `terminate()` only.                                                                                          |
| `availableParallelism` on each host      | `packages/runtime/src/adapters/node/node-worker-host.ts:14,87`; `adapters/shared/web-worker-host.ts:149`     | Node reads `node:os` `availableParallelism`; web host reads `navigator.hardwareConcurrency`. Measured in Docker: `--cpus=2` and `--cpuset-cpus=0,1` both make Deno 2.9.6 and Node report `2`; no limit reports the host's 32.                                 |
| `TaskPoolStats`                          | `packages/common/src/services/worker-pool.ts:33`                                                             | `{ taskModule, workers, busy, queued, completed, failed }`. Unchanged; the budget is reported beside it, not inside it.                                                                                                                                       |
| `IWorkerPool`                            | `packages/common/src/services/worker-pool.ts:65`                                                             | `run`, `stats`, `shutdown`. Unchanged — no `common` change in this milestone.                                                                                                                                                                                 |
| `HealthCheckResult`                      | `packages/common/src/services/health.ts:13`                                                                  | `{ status, data?: Readonly<Record<string, unknown>> }` — a new `budget` key in `data` is additive.                                                                                                                                                            |
| `TaskPool` slot lifecycle                | `packages/worker-pool-plugin/src/pool/task-pool.ts:202,237,284,321,352,384,467`                              | `pump()` spawns via `spawnSlot()` up to `config.size`; every removal goes through `dropSlot()` (crash, exit, timeout); `shutdown()` splices all slots; `onMessage` re-pumps after a settle; `terminating` marks a pool-initiated stop so its exit is ignored. |
| Pool size resolution                     | `packages/worker-pool-plugin/src/services/worker-pool-service.ts:117`                                        | `size: overrides?.size ?? options?.defaultPoolSize ?? host.availableParallelism()`. One `TaskPool` per specifier in `#pools`.                                                                                                                                 |
| Options surface                          | `packages/worker-pool-plugin/src/interfaces/index.ts:15-52`                                                  | `defaultPoolSize`, `maxQueue`, `taskTimeoutMs`, `pools`, `host`. None is validated today.                                                                                                                                                                     |
| Health indicator                         | `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts` (the `ctx.health.register('worker-pool', …)`) | Payload `{ available, exitDetection, pools, reason? }`; status derives from `available` only.                                                                                                                                                                 |
| Example-app gate                         | `scripts/check-apps.ts:120,128`                                                                              | Every app must declare `start` and `smoke` tasks; `main.ts` and `smoke.ts` are type-checked; a declared `test` task is run.                                                                                                                                   |
| Examples-guide gate                      | `scripts/check-docs.ts:1149` (`checkExamplesCoverage`)                                                       | Every directory under `apps/` must be linked from `docs/examples.md`, derived from the filesystem.                                                                                                                                                            |
| `SharedArrayBuffer` through the protocol | measured, scratchpad `iso/sab.mjs` (Deno 2.9.6, Node 24.18, Bun 1.4.2)                                       | A `SharedArrayBuffer` nested in `{ input: { buf } }` is shared, not copied, on all three: a worker's write is visible to the host. 4 MB round trip ~10–89 µs shared vs ~620–905 µs copied.                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                         | Resolution (picked side)                                                                                                    | Doc deliverable (same PR)                                                                                             |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| C1 | The worker-pool README ("Workers spawn on demand up to the pool size") and the PUBLIC_API `defaultPoolSize` row ("Workers per pool") name the pool size as the only spawn bound. | Both stay true and become incomplete: the pool size bounds one module, `maxWorkers` bounds the sum. Code is the side taken. | README Semantics bullet and PUBLIC_API Options table gain `maxWorkers` and the budget rule.                           |
| C2 | The README and PUBLIC_API say inputs travel "by structured clone (plain data only)", which reads as "always copied".                                                             | A `SharedArrayBuffer` inside a structured-clone payload is shared, not copied (measured on all three runtimes).             | README and PUBLIC_API Notes gain a `SharedArrayBuffer` bullet with the timeout and `BodyInit`/`SubtleCrypto` caveats. |

## 3. Design decisions

### 3.1 `maxWorkers` default

- **Decision:** when `maxWorkers` is omitted, the budget is
  `max(host.availableParallelism(), defaultPoolSize ?? 0, Σ pools[*].size)`, computed once in the
  `WorkerPoolService` constructor from the resolved host. `Infinity` means no budget.
- **Why:** with no explicit sizes this equals today's per-pool default, so a one-module application
  is unchanged. Summing the explicitly listed pools means every pool the application sized itself
  can be at its configured size at the same time (two pools of `size: 64` on a 32-core host get a
  default of 128, not 64). Modules that fall back to `defaultPoolSize` or the core count share what
  remains, because the plugin cannot know in advance how many of them there will be — that is the
  behaviour change, and only applications with several such modules bursting at once see it.
- **Test home:** `test/unit/worker-pool-service.test.ts` — default equals parallelism; default
  raised by `defaultPoolSize`; default is the SUM of two listed `pools[*].size` values; explicit
  value wins.

### 3.2 `maxWorkers` validation

- **Decision:** one internal `validateSizingOptions(options)` in `src/services/sizing.ts` refuses a
  `maxWorkers` that is not `Infinity` and not a positive safe integer, throwing `RangeError` naming
  the option and the refused value (application configuration, not request input, so echoing it is
  safe and is what the developer needs to find it). It is called by `WorkerPoolPlugin(options)` (so
  a bad value fails when the plugin is constructed) and by the `WorkerPoolService` constructor (the
  exported class can be constructed directly).
- **Why:** M90a's lesson: `Number(env.X)` is `NaN` for an unset variable, and every comparison
  against `NaN` is false, so an unvalidated bound fails open. One function, two entry points.
- **Test home:** `test/unit/sizing.test.ts` (table of refused and accepted values);
  `test/unit/worker-pool-plugin.test.ts` (factory throws before `register`).

### 3.3 The budget is one object per service

- **Decision:** an internal `WorkerBudget` class (`src/pool/worker-budget.ts`, not exported from
  `src/index.ts`) owned by one `WorkerPoolService` and passed to every `TaskPool` it creates. It
  counts pool slots: a slot is acquired in `spawnSlot()` and released whenever `dropSlot()` returns
  `true` and in `shutdown()`. It holds a FIFO of waiting pools.
- **Freed budget is RESERVED for the waiter it is given to**, and the waiter is woken after the
  releasing call stack returns (a resolved-promise continuation, never a synchronous call into the
  other pool). Reservation is what makes §3.5 rule 2 work at all: without it the retiring pool's own
  `pump()`, running a line later with its tasks still queued, would re-acquire the slot it just
  freed and the starved pool would never get it. Deferring the wake-up keeps one pool from mutating
  another pool's slot list in the middle of its own `onMessage`. A woken waiter that no longer needs
  the slot (its tasks timed out or were served meanwhile) returns the reservation, which passes to
  the next waiter, so a reservation can never be stranded.
- **Shutdown closes the budget FIRST**, before any pool shuts down: otherwise slots released by the
  first pool's shutdown would be handed to a second pool, which would spawn new workers during
  shutdown. A closed budget refuses every acquire and wakes no one. The service also rejects every
  later `run()` with `WorkerPoolUnavailableError`, including a previously unseen module, before
  creating a pool. Otherwise a new module after shutdown could queue forever behind the closed
  budget when its timeout is disabled. This service lifecycle guard is internal and changes no
  exported surface; it records `pool_closed` rejection.
- **Why:** no module-global state (§11.4); two applications in one process keep separate budgets.
  Counting slots rather than OS threads matches what `stats().workers` reports; a terminated
  worker's thread may take a moment to exit, which the README states.
- **Test home:** `test/unit/worker-budget.test.ts` (reservation, deferred wake-up, returned
  reservation passes on, close refuses); `test/unit/worker-pool-service.test.ts` (shutdown of two
  pools with a waiter spawns nothing). The service test also checks that a new module after shutdown
  rejects immediately without a pool or timer, including while worker termination is still in
  progress.

### 3.4 Acquiring when the budget is full

- **Decision:** when `pump()` has a deficit and `budget.tryAcquire(pool)` fails, the budget asks the
  other pools, in creation order, to retire one idle worker (`ready && task === null`); a retired
  worker is marked `terminating`, dropped, terminated, and its slot transferred to the requester. If
  no other pool has an idle worker, the requester is queued as a waiter and spawns nothing.
- **Why:** without eviction the cap deadlocks: idle workers in pool A would hold the whole budget
  forever, because nothing reaps them, and pool B's tasks would wait until their timeout.
- **Test home:** `test/unit/task-pool-budget.test.ts` — B evicts A's idle worker; B waits when all
  of A's workers are busy.

### 3.5 Handing a freed worker to a waiting pool

- **Decision:** two rules.
  1. **At the end of every `pump()`**, if the budget has any waiter, every slot of this pool that is
     ready and idle is retired and its budget given to the waiters in order. Applying this in
     `pump()` rather than only in `onMessage` covers every way a slot becomes idle: a task settling,
     a new worker signalling ready after another worker took its task, and a clone failure freeing a
     slot (`task-pool.ts`, `dispatch`).
  2. **In `onMessage`, after a task settles and before re-pumping**, if this pool still has pending
     tasks but the budget has a STARVED waiter (a pool with queued tasks and zero slots, including
     starting ones), the slot is retired and its budget reserved for that waiter instead of reusing
     the worker.

  Waiters are served starved-first, then in arrival order, through the reservation and deferred
  wake-up of §3.3.
- **Why:** rule 1 shrinks a pool as soon as its work is done while others wait. Rule 2 guarantees
  every module with queued work eventually gets at least one worker; without it a module with a long
  queue reuses its own workers forever and a second module starves until the first drains. There is
  deliberately no proportional fair share: a module that already has one worker waits for ordinary
  releases. Retiring costs one worker spawn.
- **Test home:** `test/unit/task-pool-budget.test.ts` (both rules; the starved-first order; that a
  module with ≥1 worker is not preempted; that rule 2's retiring pool, with tasks still queued, does
  NOT get the slot back; that a slot freed by a clone failure is handed over);
  `apps/worker-pool/smoke.ts` (the no-starvation proof on real workers).

### 3.6 Budget release on every removal path

- **Decision:** `dropSlot()` releases the slot's budget when it returns `true`, which covers crash
  (`onWorkerError`), exit (`onWorkerExit`), timeout (`onTimeout`) and eviction. `shutdown()`
  releases all of its slots and the budget then clears its waiters. A clone failure removes no slot
  and releases nothing.
- **Eviction is a new origin of state change for the M45b gauges.** `syncMetrics()` is documented as
  called from exactly five origins (`run`, `onMessage`, `onWorkerError`, `onTimeout`, `shutdown`); a
  worker retired by ANOTHER pool's request changes this pool's `workers` gauge from outside all
  five. `retireIdle()` therefore calls `syncMetrics()` itself, and the comment on `syncMetrics()` is
  corrected to name it.
- **Why:** one release site per removal, so no path can leak a slot (the M70k double-dispose lesson:
  `dropSlot` returning `false` already marks a slot another handler accounted for).
- **Test home:** `test/unit/task-pool-budget.test.ts` — after a crash, an exit, and a timeout, a
  second pool can spawn into the freed slot; `test/unit/worker-pool-metrics.test.ts` — the evicted
  pool's `worker_pool_workers` gauge drops when another pool evicts its worker.

### 3.7 Health payload

- **Decision:** the `worker-pool` indicator's `data` gains `budget: { maxWorkers, workers }`, where
  `maxWorkers` is the resolved number (`Infinity` reported as `null`, because `JSON.stringify` turns
  `Infinity` into `null` anyway and the payload should say so on purpose) and `workers` is the sum
  of every pool's `workers`. Status rules are unchanged. The plugin reads the resolved limit through
  an internal `budgetLimitOf(service)` accessor exported from `worker-pool-service.ts` but NOT from
  `src/index.ts` (a module-private `WeakMap`, the M98a `collectorOf` precedent) — a public
  `WorkerPoolService` member would add published surface to an exported class for one internal
  reader.
- **Why:** an operator can see the bound and how close the application is to it without summing
  per-module gauges.
- **Test home:** `test/unit/worker-pool-plugin.test.ts`; `apps/worker-pool/smoke.ts` reads it
  through `GET /health`.

### 3.8 Task timeouts include waiting for budget

- **Decision:** unchanged mechanism: a task's timeout is armed at enqueue (`task-pool.ts`, `run`),
  so time spent waiting for budget counts toward it. Documented, not altered.
- **Why:** a task that cannot get a worker should fail with `WorkerTaskTimeoutError` rather than
  wait forever.
- **Test home:** `test/unit/task-pool-budget.test.ts` — a waiting task times out with
  `WorkerTaskTimeoutError` and leaves the waiter list.

### 3.9 Example application

- **Decision:** `apps/worker-pool` with `src/app.ts` (factory, unstarted), `main.ts` (starts on
  `PORT` or 3000), `smoke.ts`, `tasks/spin.ts` (CPU-bound busy loop for a given number of ms,
  returns its duration), `tasks/fill.ts` (writes a byte pattern into a `SharedArrayBuffer` passed in
  its input). Plugins: `RuntimePlugin`, `HealthPlugin`, `WorkerPoolPlugin({ maxWorkers: 1 })`. The
  smoke check asserts: (a) at least five 10 ms main-thread interval ticks fire while a 300 ms `spin`
  task runs; (b) with `maxWorkers: 1`, five queued `spin` tasks on one module and one `fill` task on
  the other both complete, and `fill` resolves before the last `spin` task; (c) `fill` writes into a
  `SharedArrayBuffer` the caller reads back, while a plain `ArrayBuffer` passed the same way is
  unchanged (the control); (d) `GET /health` reports `budget.maxWorkers === 1` and
  `budget.workers <= 1`.
- **Why:** each assertion has a failing counterpart: running `spin` on the main thread gives zero
  ticks; removing rule 2 makes `fill` finish last; a copied buffer stays zero.
- **Test home:** `apps/worker-pool/smoke.ts`, run by `deno task check:apps`.

### 3.10 A spawn that throws settles the task it was spawned for

- **Decision:** `spawnSlot()` acquires budget only after `host.spawn()` returns. If `spawn()`
  throws, `pump()` catches it, rejects the OLDEST pending task with that error (the startup-failure
  rule `onWorkerError` already applies), counts it as a `crash` failure, and returns without
  throwing. Today the throw escapes `pump()`: from `run()` it rejects the caller but leaves the task
  queued with its timer armed, so the pool reports `queued: 1` for a task nobody will run, and the
  same task is later counted a second time when its timeout fires.
- **Why:** with the budget, `pump()` is also reached from another pool's hand-over continuation
  (§3.3), where an escaping throw is an unhandled rejection — the X8-2 class of process kill.
  Settling inside `pump()` makes every caller safe and removes the ghost task.
- **Test home:** `test/unit/task-pool-budget.test.ts` — a throwing host rejects the task with the
  spawn error, leaves `queued: 0`, holds no budget, and a hand-over to such a pool raises no
  unhandled rejection.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No exported symbol is added, removed or retyped, and no
`common` contract changes. The behaviour change (a total bound where there was none, for
applications with several task modules) is recorded in CHANGELOG `Changed` and `docs/upgrading.md`
(under its `## Unreleased` heading); the §3.10 repair is recorded in CHANGELOG `Fixed`. Every entry
cites the PR number once it exists, because the CHANGELOG gate fails every later PR otherwise.

| Exported symbol           | Kind     | Consumer / real code path that READS it                                                   |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `WorkerPoolPlugin`        | function | Unchanged signature; applications and `apps/worker-pool/src/app.ts`.                      |
| `WorkerPoolPluginOptions` | type     | Gains `maxWorkers?`, read by `WorkerPoolService` constructor and `validateSizingOptions`. |
| `TaskPoolOptions`         | type     | Unchanged; its `size` now also feeds the §3.1 default.                                    |
| `WorkerPoolService`       | class    | Unchanged signature; constructs the internal `WorkerBudget`.                              |
| five error classes        | classes  | Unchanged.                                                                                |

`WorkerBudget`, `validateSizingOptions`, `resolveMaxWorkers` and `budgetLimitOf` are internal and
NOT exported from `src/index.ts`; `barrel-exports.test.ts` pins the barrel unchanged.

### 4.1 Options — every option names its consumer

| Option       | Consumer                                                    | Behavior (per implementation)                                                                                               |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `maxWorkers` | `WorkerPoolService` constructor → `new WorkerBudget(limit)` | Bounds live workers across all pools; default per §3.1; `Infinity` disables; invalid values refused at construction (§3.2). |

## 5. Implementation files

| File                                  | Purpose                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Barrel — unchanged.                                                                                                                                                                                 |
| `src/interfaces/index.ts`             | `maxWorkers?` on `WorkerPoolPluginOptions`, with JSDoc and `@since`.                                                                                                                                |
| `src/services/sizing.ts`              | New, internal: `validateSizingOptions`, `resolveMaxWorkers`.                                                                                                                                        |
| `src/pool/worker-budget.ts`           | New, internal: `WorkerBudget` (acquire, release, transfer, waiter queue, starved-first ordering, close).                                                                                            |
| `src/pool/task-pool.ts`               | Acquire after `spawn` returns, release in `dropSlot`/`shutdown`, `retireIdle()` (syncs its own metrics), §3.5 rule 1 at the end of `pump()`, rule 2 in `onMessage`, §3.10 spawn-failure settlement. |
| `src/services/worker-pool-service.ts` | Validate options, resolve the limit, own the budget, close it before shutting pools down, pass it to each pool, internal `budgetLimitOf`.                                                           |
| `src/plugin/worker-pool-plugin.ts`    | Validate at construction; `budget` in the health payload.                                                                                                                                           |
| `apps/worker-pool/*`                  | The example (`deno.json`, `README.md`, `src/app.ts`, `main.ts`, `smoke.ts`, `tasks/spin.ts`, `tasks/fill.ts`).                                                                                      |

The repository gates also require classifying the new app in `scripts/check-deploy.ts` (same server
image shape as minimal; its worker behavior is covered by smoke) and refreshing the registration
site and budget payload in `docs/health-indicators.md`. Existing `test/deploy-gate.test.ts` and
`test/health-indicator-audit.test.ts` verify those registries.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                          | src covered                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/sizing.test.ts`                         | `services/sizing.ts`                  | `validateSizingOptions(options?: WorkerPoolPluginOptions): void` refuses `NaN`, `0`, `-1`, `1.5`, `-Infinity`; accepts `1`, `64`, `Infinity`, omitted. `resolveMaxWorkers(options, parallelism): number` per §3.1.                                                                               |
| `test/unit/worker-budget.test.ts`                  | `pool/worker-budget.ts`               | acquire up to the limit; release frees; transfer moves a slot to a named waiter; starved waiters served before non-starved; FIFO among equals; `close()` clears waiters.                                                                                                                         |
| `test/unit/task-pool-budget.test.ts`               | `pool/task-pool.ts` (budget paths)    | spawn blocked at the limit; eviction of another pool's idle worker; waiting when none idle; rules 1 and 2 of §3.5; the retiring pool does not regain its slot; clone-failure hand-over; release on crash/exit/timeout; clone failure releases nothing; timeout while waiting; §3.10 spawn throw. |
| `test/unit/worker-pool-service.test.ts`            | `services/worker-pool-service.ts`     | default limit per §3.1 (parallelism, `defaultPoolSize`, SUM of listed sizes); explicit wins; constructor refuses an invalid `maxWorkers`; two services keep separate budgets; shutdown with a waiter spawns nothing.                                                                             |
| `test/unit/worker-pool-metrics.test.ts` (extended) | `pool/task-pool.ts` (`retireIdle`)    | an evicted pool's `worker_pool_workers` gauge drops when another pool evicts its worker.                                                                                                                                                                                                         |
| `test/unit/worker-pool-plugin.test.ts`             | `plugin/worker-pool-plugin.ts`        | `WorkerPoolPlugin({ maxWorkers: NaN })` throws before `register`; health `data.budget` present, `Infinity` reported as `null`.                                                                                                                                                                   |
| `test/unit/task-pool.test.ts` (existing)           | `pool/task-pool.ts` (unchanged paths) | Must stay green unmodified except for constructing the pool with a budget; any assertion that changes is a design regression.                                                                                                                                                                    |
| `test/e2e/real-worker.test.ts` (extended)          | real Deno workers                     | two task modules under `maxWorkers: 1` both complete; a real worker's write to a `SharedArrayBuffer` is visible to the host.                                                                                                                                                                     |
| `test/unit/barrel-exports.test.ts` (existing)      | `src/index.ts`                        | Barrel unchanged.                                                                                                                                                                                                                                                                                |
| `apps/worker-pool/smoke.ts`                        | the example                           | §3.9 (a)–(d).                                                                                                                                                                                                                                                                                    |

Negative controls to observe failing, then revert: (1) remove rule 2 of §3.5 → the starvation unit
test and smoke (b) fail; (2) remove the release in `dropSlot` → the crash-release test fails; (3)
remove the validation call from the factory → the `NaN` test fails; (4) default the limit to
`availableParallelism()` alone → the explicit-size default test fails; (5) run `spin` in-process in
the smoke → (a) fails with zero ticks; (6) pass a plain `ArrayBuffer` to `fill` → (c) fails; (7)
release without reserving → the "retiring pool does not get the slot back" test fails; (8) apply
rule 1 only in `onMessage` → the clone-failure hand-over test fails; (9) shut pools down before
closing the budget → the shutdown test sees a spawn; (10) restore the throwing `spawn` path → the
ghost-task test sees `queued: 1`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m45c-worker-pool-sizing, never develop or main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # the new example's smoke runs
deno task check:docs        # examples guide coverage and README export tables
deno task publish:check     # on the committed tree
deno task release:verify <version>
```

## 8. Risks & mitigations

- **Retiring a worker on hand-over costs a spawn, and with more modules than `maxWorkers` the budget
  rotates between them.** → Documented as the cost of a bound smaller than the number of active
  modules; the README advises sizing `maxWorkers` at or above the number of task modules that run
  concurrently.
- **The eviction and hand-over logic is the most likely place for a slot leak or a double release.**
  → One acquire site, one release site (`dropSlot` returning `true`, plus `shutdown`), and a test
  per removal path asserting a second pool can use the freed slot.
- **Timing-based smoke assertions can flake.** → (a) uses a 300 ms task against 10 ms ticks and
  requires only five; (b) compares completion order, not durations.
- **The behaviour change surprises an application with several task modules.** → CHANGELOG `Changed`
  entry and a `docs/upgrading.md` entry naming `maxWorkers: Infinity` as the way back.

## 9. Out of scope

- Timed idle reaping and prewarming (`idleTimeoutMs`, `minWorkers`) — no owning milestone yet.
- Validating the pre-existing `defaultPoolSize`, `pools[*].size` and `maxQueue` options (a `size` of
  `0` currently spawns nothing) — refusing values that were accepted is its own behaviour change; no
  owning milestone yet, recorded here so it is not lost.
- A metric for budget evictions or waiters — the existing `worker_pool_queued_tasks` gauge already
  shows work waiting; no owning milestone.
- Multi-module workers and an `IWorkerHandle.postMessage` transfer list — no owning milestone.

## 10. Design security review — completed 2026-10-08; implementation audit pending

This is a **post-implementation design review**, requested by the maintainer after implementation,
verification, code review and the spawn-backlog correction. It reviews the contract and intended
security properties against source revision `4f2e137ecacc6ea1ab184595ffa9256312ef2838`. It does not
claim that a pre-implementation security review occurred or that the implementation has passed a
security audit. Reviewer: the implementing Codex session, acting as design reviewer. The later
implementation auditor must be a fresh context that did not implement or fix M45c.

The maintainer subsequently instructed: **wait for an explicit go before running the audit**.
Writing this review and validating its Markdown are authorized; starting an auditor, executing audit
probes or negative controls is pending that go. This addition preserves §§0–9 as the original design
record and adds the requested security review rather than rewriting the earlier decisions.

### 10.1 Reviewed flows and trust boundaries

| Flow                                 | Reviewed path and boundary                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — configuration                   | Application-owned options, possibly parsed from environment variables, enter `WorkerPoolPlugin` and the directly constructible service. Both validate maxWorkers before a budget is created. The injected host is privileged application code, not a request-controlled transport.                                                                                   |
| F2 — admission and execution         | An application selects an owned task-module specifier and calls IWorkerPool.run with structured-clonable input. TaskPool checks its pending-queue bound, arms the enqueue-time timeout and asks the service budget for capacity before spawning. The module, its imports and its handler are application code; worker threads are not a sandbox for hostile code.    |
| F3 — budget hand-over                | A ready idle slot can be retired for another module. Removal releases capacity, which is reserved for an eligible waiter and consumed only through a deferred continuation. Concurrent module traffic competes for application-wide resources; one module must not permanently monopolize recoverable capacity.                                                      |
| F4 — worker messages and failure     | The runtime normalizes worker messages, errors and optional exits. The pool checks protocol/correlation data, settles tasks and re-pumps. A slow, failing or non-responsive dependency can delay startup, execution or termination. Resource recovery must be tested at each phase, not inferred from task rejection alone.                                          |
| F5 — observability                   | Pool snapshots feed gauges and the health indicator. The added budget consists only of a numeric/null limit and aggregate slot count. Existing snapshots include application module specifiers and counts; publishing health/metrics is an application deployment decision. Task payloads, results, shared bytes and credentials must not be added to observability. |
| F6 — shared memory                   | Structured clone copies ordinary ArrayBuffers but shares SharedArrayBuffers with the trusted worker. Shared memory is an intentional read/write authority grant; it is neither tenant isolation nor automatic synchronization. Worker cancellation can leave partial writes.                                                                                         |
| F7 — shutdown and example deployment | Service shutdown closes admission and the budget before pools release slots, then awaits worker termination. The new example starts a health endpoint and runs local worker smoke tasks. Its listener exposure and Deno permissions are separately reviewable deployment surfaces.                                                                                   |

Remote clients can influence task input only through routes the consuming application exposes; M45c
adds no task-execution HTTP route. Authentication, authorization, task-module allowlisting and
per-principal admission belong before an application's call to run. This is a boundary requirement,
not evidence that every consuming application satisfies it. The audit must also exercise misuse of
the public service with many specifiers and identify what the framework itself bounds.

### 10.2 Assets, attackers and dependencies

| Asset                                          | Threat actor / failure source                                                                                                        | Required protection                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event-loop availability and worker capacity    | A caller flooding admitted tasks; a task monopolizing CPU; a worker/dependency that crashes, never becomes ready, or never completes | Enforce configured admission and slot limits; preserve progress for legitimate queued modules; recover capacity on relevant failure paths.                                 |
| Queue memory, timers, waiters and reservations | Repeated refusals, expirations, clone failures, synchronous spawn throws and churn over distinct module keys                         | Refusals must not consume capacity; cancellation must remove stale demand; metadata growth must be measured and attributed separately from live slots.                     |
| Results and shared-buffer contents             | Malformed/non-cloneable input; wrong, duplicate or late worker replies; a task killed mid-write                                      | Correlate replies, settle once, avoid claiming full writes after cancellation, and require caller synchronization for concurrent access.                                   |
| Application secrets and topology               | Sensitive input/results/errors; health or metric readers; hostile module-name characters                                             | The new budget must contain only its specified scalars. Identify existing module/error disclosure separately; do not silently turn a task payload into log or health data. |
| Service lifecycle and separation               | A concurrent run during stop; an unavailable host; a slow termination; traffic in a second application                               | Fail closed after shutdown/when unavailable, prevent new spawns during shutdown, and keep separate services' budgets independent.                                          |
| Host files, environment and network            | Over-privileged example execution or an audit driver importing unsafe code                                                           | Audit with a cleared environment and narrowly justified grants; assess the example's blanket grants and listener binding rather than assuming they are production-safe.    |

Application code, worker modules and custom host implementations are trusted for execution
authority. Their **failure behavior is not assumed healthy**: synchronous throws, missing readiness,
late callbacks and hung termination are audit inputs. A malicious application owner already has
process authority, so this review does not invent protection against arbitrary code installed by
that owner. No new authentication, credential, cryptography or tenancy mechanism is introduced.

### 10.3 Budgets and explicit contract choices

- The configured bound is on **managed worker slots per service**, not a hard RSS, physical-thread,
  CPU-time, queue-byte or module-cardinality limit. A retiring OS thread can outlive its removed
  slot briefly; the audit must measure/describe this distinction instead of claiming a process
  memory guarantee.
- The default slot limit remains the maximum of host parallelism, defaultPoolSize and the sum of
  explicitly listed pool sizes. A finite explicit maxWorkers must be a positive safe integer.
  **Infinity is an intentional application-owner opt-out**, required by §3.1 and the maintainer's
  original milestone instruction; it is not an accidentally accepted invalid bound.
- Invalid maxWorkers must be refused at both construction entry points, before spawning. The
  original contract deliberately names the rejected configuration value in RangeError (§3.2). That
  trusted configuration diagnostic is an explicit exception to the audit checklist's generic
  no-value-echo recommendation; it does not authorize echoing task data or environment secrets.
- Existing default maxQueue is 1024 pending tasks **per module** and default taskTimeoutMs is 30,000
  ms measured from enqueue. Zero deliberately disables the task timer. Pre-existing size, queue and
  timeout validation remains outside M45c (§9); the audit must identify interactions with the new
  budget, rather than treating every invalid legacy value as a newly added validation bug.
- No startup-specific deadline, termination deadline or global module-metadata budget has been
  approved. These omissions are review leads below, not accepted findings or permission to invent a
  new public option. Finite task timeouts must be tested for actual capacity recovery, not just
  promise settlement.
- Audit-only workloads should use a small slot cap, finite timers and bounded local payloads. A
  driver watchdog bounds the probe itself; it is not evidence of a product timeout. Cache imports
  first, clear the environment and use read access scoped to the audited worktree, loopback-only
  network if needed, and the package test baseline `sys: hostname, cpus`. Do not run with `-A`. Any
  additional grant needs a source-backed reason and must be recorded by the auditor.

### 10.4 Design threats, resolutions and unresolved review leads

| ID | Threat / design observation                                                                                                                              | Resolution or required audit decision                                                                                                                                                                                                                                                    |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 | Invalid environment-derived maxWorkers can disable an intended cap; validation can diverge between entry points.                                         | One validator at factory and constructor; require O1 including invalid numeric strings. Infinity/value echo retain the explicit contract choices in §10.3.                                                                                                                               |
| D2 | A releasing pool can steal its own freed capacity or leave another module permanently starved.                                                           | Reserved deferred wakeups, starved-first/FIFO selection, idle eviction and both hand-over rules; require O2–O3 and fresh-process negative controls.                                                                                                                                      |
| D3 | Refusals or failures can leak slots, stale waiters or timers, or produce unhandled callback errors.                                                      | Owned-slot release, reservation cancellation and bounded spawn-failure queue progress; require O4–O5, including the fix at 4f2e137e.                                                                                                                                                     |
| D4 | A task timeout settles a queued task without necessarily proving a non-ready slot is reclaimed; termination returns a Promise with no declared deadline. | **Unresolved lifecycle review lead.** O5 must drive hung startup and hung/throwing termination and compare legitimate recovery. Any permanent application-wide capacity loss or unbounded shutdown must be reported, with scope/attacker evidence; it is not waived by this review.      |
| D5 | The service map and new budget registry can grow with module-specifier cardinality even while maxWorkers holds.                                          | **Unresolved resource-scope review lead.** O7 must drive 1,000 keys and distinguish live-slot bounds, retained metadata and pre-existing versus new growth. Application module allowlisting is required at any external execution boundary; no framework-wide metadata bound is claimed. |
| D6 | Health/metrics can leak task data or misreport the effective bound; module names can contain hostile wire/log characters.                                | New budget limited to maxWorkers/workers; require O6 with data/error/name canaries and raw captured outputs. Existing disclosure and new example exposure must be separately attributed.                                                                                                 |
| D7 | Shared buffers allow concurrent mutation, partial writes and inappropriate use as ordinary BodyInit/crypto input.                                        | Document explicit shared authority, Atomics/copy requirements and partial-write behavior; require O8 with caller readback and an ordinary-buffer control. No automatic synchronization or worker privilege isolation is claimed.                                                         |
| D8 | The new example uses `deno run -A` and starts via the runtime's default listener binding.                                                                | **Unresolved deployment review lead.** O9 must inspect effective permissions/binding and assess against audit class 15. The current example is not accepted as a hardened production deployment by this review.                                                                          |

This table records design decisions and investigation leads, **not dispositions accepting
implementation findings**. No Critical, High, Medium or Low audit finding has been accepted or
deferred by the maintainer. An actual finding must be recorded independently and routed to a fix or
an explicit disposition under the audit procedure.

### 10.5 Implementation audit obligations

Every obligation requires a negative half and a positive control through the same public path, plain
top-level-await drivers, exact assertions, pasted source/raw stdout and explicit runtime and
permission limits. Existing unit tests and verification logs are context, not substitute audit
evidence. The independent audit must sweep all fifteen recurring classes, marking each applicable or
N/A with a source-backed reason, and observe a fresh-process failure after reverting every new
control it relies on. Restore all mutations and finish on the exact clean commit.

| ID | Obligation and required comparison                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1 | Drive maxWorkers NaN, Infinity, -Infinity, zero, negative, fraction, unsafe integer, numeric string and omission at BOTH construction paths. Invalid values must fail before workers spawn; valid finite/default values must run real work and the intentional Infinity opt-out must remain observable. Include global-size and explicit-size-sum defaults and source-appropriate hostile configuration records.                                                                                                                        |
| O2 | Flood multiple modules under a small finite cap and assert the sum of managed slots never exceeds it, including starting slots. Legitimate work must complete; Infinity/default-size controls must show that the driver actually observes spawning. Assess asynchronous termination overlap without equating slots to RSS.                                                                                                                                                                                                              |
| O3 | Prove idle eviction, starvation avoidance, FIFO among equal waiters, reserved asynchronous hand-over and return of unused reservations. A waiting legitimate module must run before a sustained competing queue drains; clone failure and late readiness must not strand an idle slot.                                                                                                                                                                                                                                                  |
| O4 | Drive more than K refusals/failures at cap K, then run legitimate work. Cover queue-full, clone failure, timeout while budget-blocked, crash/exit and synchronous spawn throws from hand-over with multiple pending tasks. Assert task counts, timer cleanup, usable budget and no process-level uncaught exception/rejection.                                                                                                                                                                                                          |
| O5 | Exercise executing tasks that never settle, modules that never signal ready, synchronous dependency throws, delayed/never-resolving/throwing terminate, duplicate or late callbacks, and run racing shutdown. With finite timers, compare task rejection AND ability of another valid module to progress. After stop, unseen-module calls must reject without creating a pool/timer; shutdown must not spawn another worker. Keep a completing/terminating dependency as the positive control and report unsupported recovery honestly. |
| O6 | Plant separate canaries in task input, success output, handler error/cause, module name/path and captured logging/metrics. Check raw health, metrics and log outputs for unauthorized disclosure, including CR/LF/NUL module names. New budget must remain exactly its stated scalars and match the slot sum; valid task results must still reach their intended caller. Distinguish explicitly supplied module metadata and pre-existing error contracts from newly added disclosure.                                                  |
| O7 | Drive 1,000 distinct specifiers and inventory retained pools, registered pools, waiters, reservations and live slots. Establish which structures are bounded, where an external caller's module selection is constrained, and whether the new registry worsens persistent growth. Show a legitimate module still works afterward; do not treat a one-slot snapshot as proof of bounded total memory.                                                                                                                                    |
| O8 | A real worker writes a SharedArrayBuffer and the caller reads back the expected pattern; an ordinary ArrayBuffer remains unchanged. Exercise cancellation during writes and confirm that partial data is treated as failure, not successful completion. Check that task bytes do not enter new health data and that separate services have separate slot budgets; do not assert tenant isolation for intentionally shared memory.                                                                                                       |
| O9 | Inspect/run only local example surfaces with controlled environment and scoped audit grants. Determine actual listener address and permissions, verify ordinary health traffic does not provide task-module execution, and assess blanket grants/default binding against class 15. A valid local health request and sandboxed worker operation are the positive controls; any missing grant/unsupported isolation is evidence, not grounds to silently widen permissions.                                                               |

### 10.6 Audit hand-off and sign-off

Implementation: Codex `/root`, commits through `4f2e137e`. Design review: the same session, with no
audit independence claim. Code verification and follow-up review evidence:
`.tmp/m45c-fix/verification.md`; prior finding/report: `.tmp/m45c-review/` (superseded for the fixed
implementation). These are ignored scratch artifacts, not additional committed plan files.

**Design review completed; implementation audit not started.** The next phase needs the maintainer's
explicit go, then a fresh auditor under `.roo/skills/security-audit/SKILL.md`. Hand off only the
milestone, branch/worktree, exact resulting commit, this plan path/§10, evidence paths, and the fact
that no audit dispositions exist. Scratch drivers and the report must stay under the worktree's
`.tmp/`, following AGENTS.md's scratch-location rule. The report must include the PR audit record,
all O1–O9 evidence, all fifteen classes, negative-control failures and open findings. Do not push or
open a PR; do not fix findings within the audit pass.
