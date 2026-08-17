# Milestone 45b — Worker Pool Metrics (`@setu-ts/worker-pool-plugin`)

> **Status:** Planning. Branch: `feat/m45b-worker-pool-metrics`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M45 built `TaskPoolStats` — `workers`, `busy`, `queued`, `completed`, `failed` per task module — and
wired it to exactly one consumer, the `worker-pool` health indicator. Pool saturation ("is work
queueing faster than it drains?") is the operational question a worker pool raises, and today it is
answerable only by polling `/health` and diffing counts by hand. This milestone exposes that state
as Prometheus instruments an operator can scrape, alert on, and graph, by resolving
`CAPABILITIES.METRICS` **optionally** and pushing from the pool's own state transitions. It also
fixes X8-2, the prerequisite the ROADMAP names, because it lives in the file this milestone
modifies.

- **In scope:** optional `CAPABILITIES.METRICS` resolution in `WorkerPoolPlugin`; an internal
  `WorkerPoolCollector` owning six instruments; instrument updates from `TaskPool`'s existing
  mutation sites; the X8-2 `postMessage` guard; PUBLIC_API/README/ROADMAP/CLAUDE.md/CHANGELOG
  deliverables.
- **NOT this milestone:**
  - **X8-7** (`taskTimeoutMs: 0` leaks a pool slot) — **M70k**. Its named fix needs an optional
    `IWorkerHandle` exit signal in `common` plus per-runtime implementations, which is M70k's kind
    of work; scoped out at the maintainer's direction (§2 C2). This milestone documents the
    limitation rather than fixing it.
  - **A scrape-time collector callback on `IMetricsService`** — a `common` widening serving one
    consumer, which this repo defers until a second consumer exists (§3.1).
  - **In-worker trace propagation** — recorded as out of scope in the ROADMAP's own M45b section and
    unchanged here.
  - **Making `stats().failed` count admission rejections** — a behaviour change to a published
    health payload (§3.4).

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                               | Verified surface / fact                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMetricsService`                       | `packages/common/src/services/metrics.ts:154`                    | `counter`/`gauge`/`histogram`/`summary`/`get` only. **No scrape-time callback** — no `onScrape`, no `beforeCollect`. Confirms the ROADMAP's framing of §3.1. |
| `ICounter`                              | `packages/common/src/services/metrics.ts:76`                     | `inc(value?, labels?)` — an INCREMENT, so a cumulative snapshot fed into it double-counts.                                                                   |
| `IGauge`                                | `packages/common/src/services/metrics.ts:91`                     | `set(value, labels?)` / `inc` / `dec`. `set` is absolute, so a gauge CAN be fed a snapshot.                                                                  |
| `MetricOptions`                         | `packages/common/src/services/metrics.ts:54`                     | `help?`, `labels?`, `buckets?`, `quantiles?`, `maxSamples?`. Label names are declared at creation.                                                           |
| `TaskPoolStats`                         | `packages/common/src/services/worker-pool.ts:33`                 | `taskModule`, `workers`, `busy`, `queued`, `completed`, `failed` — all `readonly number`/`string`.                                                           |
| `TaskPool.stats()`                      | `packages/worker-pool-plugin/src/pool/task-pool.ts:128`          | Computes `busy`/`queued` from live `slots`/`pending`; `completed`/`failed` from two counters. Pure read, no mutation.                                        |
| `TaskPool.rejectTask`                   | `packages/worker-pool-plugin/src/pool/task-pool.ts:296`          | The ONLY site incrementing `failedCount`; called from 5 places (reply-not-ok, worker error ×2, timeout, shutdown ×2).                                        |
| `TaskPool.run` queue-full path          | `packages/worker-pool-plugin/src/pool/task-pool.ts:105`          | Rejects BEFORE a `Task` exists, so it never reaches `rejectTask` and **`stats().failed` never counts it**. Drives §3.4.                                      |
| `TaskPool.dispatch`                     | `packages/worker-pool-plugin/src/pool/task-pool.ts:199`          | `slot.handle.postMessage(request)` is unguarded — the X8-2 defect site.                                                                                      |
| `IWorkerHandle`                         | `packages/common/src/runtime.ts:149`                             | `postMessage`/`onMessage`/`onError`/`terminate` — **no exit or close signal**. This is why X8-7 cannot be fixed without a `common` widening.                 |
| `HttpCollector`                         | `packages/metrics-plugin/src/collectors/http-collector.ts:90`    | Instruments created in `register()`, then pushed from the hot path via `inc`/`dec`/`observe`. Confirms the ROADMAP's "push" precedent claim.                 |
| `HttpCollector` label policy            | `packages/metrics-plugin/src/collectors/http-collector.ts:71`    | Labels are `method`+`status` ONLY, "never by path (unbounded cardinality)" — the cardinality rule §3.3 is measured against.                                  |
| Optional-capability precedent           | `packages/websocket-plugin/src/plugin/websocket-plugin.ts:63,74` | `optionalDependencies: [CAPABILITIES.X]` + `ctx.services.has(X) ? ctx.services.get<T>(X) : undefined`. The exact shape §3.2 copies.                          |
| Resolver honours `optionalDependencies` | `packages/kernel/src/registry/plugin-resolver.ts:49`             | An optional token whose provider EXISTS becomes a real ordering edge, so MetricsPlugin's `register()` provably runs first. Not merely a priority accident.   |
| `MetricsPlugin` priority                | `packages/metrics-plugin/src/plugin/metrics-plugin.ts:58`        | `provides: [CAPABILITIES.METRICS]`, `priority: 100` (HIGH) vs worker-pool's `NORMAL` (500) — consistent with the edge above.                                 |
| `PLUGIN_PRIORITY`                       | `packages/common/src/types.ts:80`                                | `HIGHEST:0, HIGH:100, NORMAL:500, OPENAPI:700, LOW:900, LOWEST:1000`.                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                       | Doc deliverable (same PR)                                                                                    |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| C1 | The ROADMAP M45b section specifies "counters for `completed`/`failed`" — five instruments. This plan ships six, adding `worker_pool_tasks_rejected_total` for admission failures.       | Ship six. A queue-full rejection is the clearest saturation signal the pool produces and is invisible in `stats().failed` (§1, `run` queue-full path), so omitting it would omit the headline. | ROADMAP M45b Implementation Files + the metric table; PUBLIC_API Worker pool section lists all six.          |
| C2 | The ROADMAP M45b section says "**Fix those first**" of X8-2 and X8-7, and the M70k row says M70k "**Blocks M45b**". This branch fixes only X8-2.                                        | X8-2 here (same file, no contract change); X8-7 stays with M70k. Maintainer's direction, recorded rather than inherited.                                                                       | ROADMAP: M45b prerequisite paragraph amended to name what shipped where; M70k row keeps X8-7 and drops X8-2. |
| C3 | `worker-pool-plugin/README.md` promises "a worker-level crash rejects its in-flight task" unconditionally, which X8-7 shows is untrue when `taskTimeoutMs: 0` (finding X8-7, `smoke/`). | Do not restate the promise. Document the limitation in the README and PUBLIC_API beside `taskTimeoutMs`, naming M70k as the owner.                                                             | README `taskTimeoutMs` note; PUBLIC_API Worker pool Options note; CHANGELOG "Known limitation".              |

## 3. Design decisions

### 3.1 Sampling model — push from the pool, never a timer

- **Decision:** `TaskPool` pushes to the instruments from its own mutation sites. Gauges are written
  with `set()` fed from `this.stats()`; counters are written with `inc(1)` at each settle site. No
  `setInterval` anywhere, and no `common` widening.
- **Why:** `IMetricsService` has no scrape-time hook (§1), so the sampling model must be chosen.
  Interval sampling is the one with a real wrong answer — a timer outliving `onClose` leaks a handle
  per application, and the M53 `RedisStreamsBroker` defect (a `TimerHandle` coerced to `NaN`, so
  `clearInterval` silently no-ops) is the precedent for exactly how that ships green. Push mirrors
  `HttpCollector`, the package-family's established shape (§1). A collector seam on
  `IMetricsService` is the general fix and is out of scope: a `common` widening serving one
  consumer.
- **Test home:** `test/unit/worker-pool-metrics.test.ts` — "no timer is armed for metrics" asserts
  the injected runtime's `setInterval` is never called across a full run/settle/shutdown cycle.

### 3.2 Instrument ownership — an internal `WorkerPoolCollector`, constructed only when metrics exist

- **Decision:** A new internal `WorkerPoolCollector` (in `src/metrics/`, **not** barrel-exported)
  owns the six instruments and exposes `syncGauges(stats)`, `taskCompleted(module)`,
  `taskFailed(module, reason)` and `taskRejected(module, reason)`. `WorkerPoolPlugin.register()`
  declares `optionalDependencies: ['logger', CAPABILITIES.METRICS]` and builds the collector only
  when `ctx.services.has(CAPABILITIES.METRICS)`; it is threaded `WorkerPoolService` → `TaskPool` as
  an optional constructor argument. Absent `metrics-plugin`, every argument is `undefined` and
  behaviour is byte-identical to M45.
- **Why:** §1 confirms `optionalDependencies` creates a real ordering edge, so the instruments exist
  before the pool can push to them. Keeping the collector internal means no new public surface for a
  milestone that adds a signal, not an API.
- **Correction, established by running the negative control rather than assumed.** An earlier
  revision of this decision claimed the edge is what guarantees ordering and that "priority alone
  would be a coincidence". Measured: dropping `CAPABILITIES.METRICS` from `optionalDependencies`
  fails only the metadata assertion and NO functional test, because the shipped `MetricsPlugin` sits
  at priority 100 against this plugin's 500 and is therefore ordered first regardless. The edge is
  load-bearing only for a REPLACEMENT metrics provider at a higher priority number — which
  AI_GUIDELINES §3.4 explicitly permits — so the claim is now pinned by a test that constructs
  exactly that case (`PLUGIN_PRIORITY.LOW` provider), and the control fails it.
- **Test home:** `test/integration/metrics-absent.test.ts` (byte-identical behaviour with no metrics
  plugin) and `test/integration/worker-pool-metrics-app.test.ts` (real kernel app, both plugins,
  ordering observed).

### 3.3 Metric names, types and labels

- **Decision:** Six instruments, all labelled `task_module` (the pool's specifier, i.e.
  `TaskPoolStats.taskModule`), with `reason` as a second label on the two failure counters:

  | Name                                | Type    | Labels                 | Meaning                                   |
  | ----------------------------------- | ------- | ---------------------- | ----------------------------------------- |
  | `worker_pool_workers`               | gauge   | `task_module`          | Workers alive (`stats().workers`)         |
  | `worker_pool_busy_workers`          | gauge   | `task_module`          | Workers executing a task (`stats().busy`) |
  | `worker_pool_queued_tasks`          | gauge   | `task_module`          | Tasks waiting (`stats().queued`)          |
  | `worker_pool_tasks_completed_total` | counter | `task_module`          | Tasks settled successfully                |
  | `worker_pool_tasks_failed_total`    | counter | `task_module`,`reason` | Admitted tasks that then failed           |
  | `worker_pool_tasks_rejected_total`  | counter | `task_module`,`reason` | Tasks never admitted                      |

  `reason` on `failed` is one of `handler` | `timeout` | `crash` | `clone` | `shutdown`; on
  `rejected` it is `queue_full` | `pool_closed` | `unavailable`.
- **Why:** `task_module` is bounded by the number of task modules written in the application's
  source — a small fixed set, unlike the HTTP path label `HttpCollector` explicitly refuses (§1), so
  it does not create unbounded cardinality. `reason` is what separates "tasks are failing" from
  "tasks are timing out" and costs one argument at sites that already exist. Saturation is readable
  as `queued_tasks` rising while `busy_workers` is pinned at `workers`, with
  `rejected_total{reason="queue_full"}` as the moment it overflows.
- **Test home:** `test/unit/worker-pool-metrics.test.ts` asserts each name/type/label set, and the
  kernel-app test asserts the rendered `# HELP`/`# TYPE` lines.

### 3.4 `failed_total` matches `stats().failed`; `rejected_total` is deliberately separate

- **Decision:** `worker_pool_tasks_failed_total` is incremented at exactly the sites that increment
  `failedCount` — so its sum over `reason` equals `stats().failed` for that module, always.
  Admission failures (queue full, pool closed, no worker host) go to the SEPARATE
  `worker_pool_tasks_rejected_total` and are NOT added to `failedCount`.
- **Why:** `stats().failed` does not count a queue-full rejection (§1), because that path rejects
  before a `Task` exists. Two honest options existed: replicate the gap in the metric, or fix
  `failedCount`. Fixing it changes a published health payload's meaning and belongs to no milestone
  here. So the metric neither lies nor silently diverges: one counter mirrors the health number
  exactly, the other reports what the health number cannot see, and the split is documented.
- **Test home:** `test/unit/worker-pool-metrics.test.ts` — "failed_total sums to stats().failed"
  drives a handler error, a timeout and a shutdown, then compares the summed counter to the
  snapshot; a separate case drives a queue-full rejection and asserts `failed_total` did NOT move
  while `rejected_total{reason="queue_full"}` did.

### 3.5 Gauge sync points — the five origins of state change

- **Decision:** Gauges are synced by one private `#syncMetrics()` called at the end of `TaskPool`'s
  five state-change origins: `run()`, `onMessage()`, `onWorkerError()`, `onTimeout()` and
  `shutdown()`. Every other mutation (`pump`, `dispatch`, `spawnSlot`, `dropSlot`, the settle
  helpers) is reached only from one of those five, so no transition escapes.
- **Why:** Feeding `set()` from the same `stats()` the health indicator reads means gauge and health
  can never disagree — one source of truth, rather than per-site `inc`/`dec` bookkeeping that drifts
  the first time a path is added. The five origins are an exhaustive list read off the call graph,
  not a guess.
- **Test home:** `test/unit/worker-pool-metrics.test.ts` — "gauges equal stats() after every
  transition kind" asserts equality after enqueue, dispatch, success, handler error, timeout, worker
  crash and shutdown.

### 3.6 X8-2 — a `postMessage` that throws rejects its own task and leaves the pool healthy

- **Decision:** `dispatch()` wraps `slot.handle.postMessage(request)` in try/catch. On a throw the
  slot is freed (`slot.task = null`), the task is rejected with the thrown error via `rejectTask`
  (counted as `reason: 'clone'`), and the pump continues. The worker is NOT terminated — it never
  received anything and is healthy.
- **Why:** `dispatch()` reached from `run()` is inside the caller's promise, so a throw rejects
  normally; reached from `pump()` inside `onMessage`, the identical throw is an uncaught exception
  that **kills the host process** (X8-2, observed exit 1). Catching inside `dispatch` rather than at
  each call site makes both paths agree, which is the finding's own prescription. The catch must be
  inside `dispatch` and not around the `pump` loop, or one bad task would abandon the whole drain.
- **Test home:** `test/unit/task-pool-clone-failure.test.ts` — a host whose `postMessage` throws,
  driven on BOTH paths (idle pool → dispatched from `run`; busy pool → dispatched from the drain),
  asserting both reject with the same error and that a following good task on the same pool still
  succeeds.

## 4. Exported surface — every symbol names its consumer

**No change to `src/index.ts`.** This milestone adds a signal, not an API: the collector is internal
and the instruments are reached through `GET /metrics`, not through a Setu-TS export.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                                        |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None (checked)  | —    | `src/index.ts` is unchanged; verified by a barrel-exports test asserting the surface is identical to M45's (the M56 precedent, where a dropped re-export left 18 tests green). |

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation)                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (checked) | —        | `WorkerPoolPluginOptions` is unchanged. Metrics are enabled by the PRESENCE of `CAPABILITIES.METRICS`, not by an option — the M47 `REALTIME_BACKPLANE` precedent — so there is no option that can be set to a value nothing reads. An `enabled` flag was considered and cut: absent `metrics-plugin` there is nothing to disable, and present it, a user who does not want the series does not register the plugin. |

## 5. Implementation files

| File                                   | Purpose                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                         | Unchanged (no new export).                                                                                                               |
| `src/metrics/worker-pool-collector.ts` | **New.** `WorkerPoolCollector`: creates the six instruments, exposes `syncGauges`/`taskCompleted`/`taskFailed`/`taskRejected`. Internal. |
| `src/metrics/metric-names.ts`          | **New.** The six names, the `reason` union types, and the `MetricOptions` for each — one home so renderer output and tests cannot drift. |
| `src/plugin/worker-pool-plugin.ts`     | Optional `CAPABILITIES.METRICS` resolution; `optionalDependencies` gains the token; constructs the collector.                            |
| `src/services/worker-pool-service.ts`  | Accepts the optional collector and threads it into each `TaskPool`; reports `unavailable` rejections.                                    |
| `src/pool/task-pool.ts`                | Optional collector argument; `#syncMetrics()` at the five origins; counter pushes at settle sites; the §3.6 X8-2 guard.                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                    | src covered                                                   | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/worker-pool-metrics.test.ts`                      | `metrics/worker-pool-collector.ts`, `metrics/metric-names.ts` | Instrument names/types/labels per §3.3 against `IMetricsService.counter(name, MetricOptions)`/`gauge(...)`; gauges equal `stats()` after all seven transition kinds (§3.5); `failed_total` sums to `stats().failed` and queue-full moves only `rejected_total` (§3.4); no `setInterval` (§3.1). |
| `test/unit/task-pool-clone-failure.test.ts`                  | `pool/task-pool.ts` (X8-2 guard)                              | A `postMessage` that throws rejects its own task on BOTH the `run` path and the drain path, the pool keeps serving, and `failed_total{reason="clone"}` increments (§3.6). **Verified to fail without the fix.**                                                                                 |
| `test/unit/task-pool.test.ts` (existing, extended)           | `pool/task-pool.ts`                                           | Existing M45 assertions unchanged (regression guard that the collector threading is inert when absent), plus the counter push sites driven with a recording collector.                                                                                                                          |
| `test/unit/worker-pool-service.test.ts` (existing, extended) | `services/worker-pool-service.ts`                             | Collector threaded to each pool; the no-host path reports `rejected_total{reason="unavailable"}` and still rejects with `WorkerPoolUnavailableError`.                                                                                                                                           |
| `test/unit/worker-pool-plugin.test.ts` (existing, extended)  | `plugin/worker-pool-plugin.ts`                                | `optionalDependencies` names `CAPABILITIES.METRICS`; the collector is built when `has()` is true and NOT when false; the health indicator is unchanged.                                                                                                                                         |
| `test/integration/metrics-absent.test.ts`                    | plugin + service + pool                                       | A kernel app with `WorkerPoolPlugin` and NO `MetricsPlugin`: a task runs, `/health` reports as in M45, and no metrics call is made. Byte-identical behaviour.                                                                                                                                   |
| `test/integration/worker-pool-metrics-app.test.ts`           | plugin + service + pool + collector                           | A real `createApplication` with both plugins: all six series appear in `GET /metrics` with `# HELP`/`# TYPE` **before anything samples** (the ROADMAP's own bar), then a real task moves them.                                                                                                  |
| `test/e2e/real-worker.test.ts` (existing, extended)          | end-to-end on real threads                                    | A real spawned worker's completion is observed in the counter — the one place the instruments are driven by a genuine thread rather than a fake host.                                                                                                                                           |
| `test/unit/barrel-exports.test.ts`                           | `src/index.ts`                                                | The published surface is exactly M45's (§4). The M56 precedent.                                                                                                                                                                                                                                 |

**Negative controls to run and revert** (each observed failing, per "Before reporting a task done"):

1. Remove the §3.6 try/catch → the busy-pool clone test must reproduce the uncaught throw.
2. Feed `completed` into `ICounter.inc` as a snapshot instead of `inc(1)` → the sums test must fail
   (the ROADMAP's named double-count trap).
3. Drop one of the five `#syncMetrics()` origins → the gauges-equal-stats test must fail for that
   transition.
4. Drop `CAPABILITIES.METRICS` from `optionalDependencies` → the late-registering replacement
   provider test must fail (§3.2). **Run: the first form of this control was non-discriminating** —
   with only the shipped `MetricsPlugin` in play, priority already orders it first, so nothing
   functional failed. The control is only meaningful against a provider at a higher priority number,
   which is now what the test builds.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m45b-worker-pool-metrics, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree
deno task release:verify 0.1.0-alpha.8
```

## 8. Risks & mitigations

- **A recording-collector fake hides a real `IMetricsService` mismatch** (the recurring
  contract-violating-double root cause: M37b ioredis, M53 `zrangebyscore`, M55 `readStream`) →
  mitigated by `test/integration/worker-pool-metrics-app.test.ts`, which drives the REAL
  `MetricsPlugin` through a kernel app and reads the rendered text, so the fake is never the only
  path exercised.
- **Gauge drift as `TaskPool` gains paths later** → mitigated by §3.5's single-source sync from
  `stats()` plus the equality test across every transition kind; a new path that forgets to sync
  fails that test rather than silently reporting stale values.
- **Cardinality from a long `task_module` label** (specifiers are absolute URLs) → bounded by the
  application's source, not by traffic (§3.3), and identical to what the health payload already
  publishes. Recorded so a reviewer does not re-raise it.
- **X8-7 remains open in a file this milestone touches** → M70k will edit `task-pool.ts` too.
  Mitigated by keeping this branch's `task-pool.ts` changes additive (one guard, one private sync
  method, four collector calls) rather than restructuring, so the merge stays mechanical.

## 9. Out of scope

- **X8-7** (`taskTimeoutMs: 0` leaks a pool slot; needs an `IWorkerHandle` exit signal) — **M70k**.
- **X8-3, X8-4, X8-6, X8-8 through X8-11** — **M70k** (storage/queue rows in the same register).
- **X8-5** (`storage`/`mail`/`queue` indicators report `up` with backends stopped) — **M70c**, which
  names this package's indicator as the counter-example to copy.
- **A scrape-time collector hook on `IMetricsService`** — the general fix for §3.1, deferred until a
  second consumer exists.
- **In-worker trace propagation** — out of scope in the ROADMAP's own M45b section; unchanged.
- **Resource (memory/CPU) metrics per worker** — needs a runtime resource seam M19 already deferred
  for the same reason.
