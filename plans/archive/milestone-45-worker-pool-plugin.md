# Milestone 45 — Worker Pool Plugin (`@hono-enterprise/worker-pool-plugin`)

> **Status:** Planning. Branch: `feat/m45-worker-pool-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Give applications a way to run CPU-bound work (image processing, report generation, large data
transforms) off the event loop, on real threads, behind the framework's capability model. The
milestone ships a `WorkerPoolPlugin` registering an `IWorkerPool` under a new
`CAPABILITIES.WORKER_POOL` token; a runtime-abstracted thread primitive (`IWorkerHost` — a new
**optional** member of `IRuntimeServices`, implemented by the Deno/Node/Bun runtime adapters, absent
on Cloudflare Workers, following the M44 `IFileSystem.realPath` precedent); and a worker-side helper
`defineWorkerTask` shipped as a `@hono-enterprise/runtime/worker` subpath export so task modules
never touch runtime-specific messaging APIs. Task handlers are referenced by **module specifier**,
never by closure — closures cannot cross a thread boundary.

- **In scope:** `IWorkerPool`/`IWorkerHost`/`IWorkerHandle` + message-protocol contracts and the
  `WORKER_POOL` token in `common`; web + node worker hosts wired into the Deno/Bun/Node runtime
  adapters; `defineWorkerTask` (runtime `./worker` subpath); the `worker-pool-plugin` package
  (plugin, service, per-task-module `TaskPool`, errors, health indicator, `onClose` shutdown); docs
  (PUBLIC_API.md, ROADMAP §M45 + tracking row, CLAUDE.md status, package README).
- **NOT this milestone:** a worker-backed execution backend for the queue plugin (future queue
  milestone, if ever); worker autoscaling / idle reaping; transferables & SharedArrayBuffer API
  surface (structured clone only); Cloudflare Workers support (platform has no threads — `run()`
  throws `WorkerPoolUnavailableError` there).

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                                           | Verified surface / fact                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IPlugin`                               | `packages/common/src/plugin.ts:470-499`                                      | `name/version/dependencies?/optionalDependencies?/provides?/consumes?/priority?`, `register(ctx): void \| Promise<void>`                                                                |
| `IPluginContext`                        | `packages/common/src/plugin.ts:409-448`                                      | `runtime` is NON-optional; `services.register`, `health.register(name, fn)`, `lifecycle.onClose(fn)` all present                                                                        |
| `IServiceRegistry.register`             | `packages/common/src/registry.ts:66`                                         | `register<T extends object>(token, service, options?)`                                                                                                                                  |
| `createCapabilityToken` grammar         | `packages/common/src/tokens.ts:143-153`                                      | lowercase kebab segments, dot namespacing, NO colons — `'worker-pool'` passes; no existing worker token in `CAPABILITIES` (tokens.ts:39-116)                                            |
| `IRuntimeServices`                      | `packages/common/src/runtime.ts:118-208`                                     | has optional `fs?: IFileSystem` precedent (line 207); timers `setTimeout/clearTimeout` (174-194); NO worker member today                                                                |
| `mergeRuntimeServices`                  | `packages/runtime/src/services/cross-runtime.ts:73-91`                       | takes `Pick<IRuntimeServices, 'platform' \| 'version' \| 'hostname' \| 'env' \| 'exit' \| 'fs'>` — must gain `'workers'` so adapters can supply/omit it                                 |
| Deno adapter host pattern               | `packages/runtime/src/adapters/deno/deno-runtime.ts:63-96`                   | injectable `DenoHost` seam + single boundary cast; returns `mergeRuntimeServices({...})`                                                                                                |
| Node adapter static `node:` imports     | `packages/runtime/src/adapters/node/node-runtime.ts:14-17,113-141`           | static `node:os`/`node:fs/promises`/`node:process` imports + injectable `NodeModules` seam — same pattern extends to `node:worker_threads`                                              |
| CF adapter omits absent services        | `packages/runtime/src/adapters/workers/cf-runtime.ts:46-56`                  | omits `fs` from the divergent object (never passes `undefined`) — `workers` omitted the same way                                                                                        |
| `HealthCheckResult`/`HealthIndicatorFn` | `packages/common/src/services/health.ts:13-26`                               | `{ status: HealthStatus; data?: Readonly<Record<string, unknown>> }`; indicator is `() => Promise<HealthCheckResult>`                                                                   |
| Duplicate provider throw                | `packages/kernel/src/registry/plugin-resolver.ts:111,121-127`                | duplicate plugin names AND duplicate capability providers throw at startup; plugin implicitly provides its own name                                                                     |
| `PLUGIN_PRIORITY.NORMAL`                | `packages/common/src/types.ts:78-84`                                         | `NORMAL: 500` — used by sibling plugins (sse-plugin.ts:44)                                                                                                                              |
| Sibling plugin shape                    | `packages/sse-plugin/src/plugin/sse-plugin.ts:38-70`                         | factory returning `IPlugin`; registers service, health indicator, `onClose`; version `'0.1.0'`                                                                                          |
| Workspace membership                    | `deno.json:2-41`                                                             | packages listed explicitly — `./packages/worker-pool-plugin` must be added                                                                                                              |
| Runtime pkg exports                     | `packages/runtime/deno.json`                                                 | currently a single `"exports": "./src/index.ts"` string — must become a map to add `"./worker"` (AI_GUIDELINES §14.3 documents the subpath-exports pattern)                             |
| Test-app pattern                        | `packages/sse-plugin/test/integration/sse-integration.test.ts:16-21`         | tests may import `createApplication` (kernel) + `RuntimePlugin` (runtime) + plugin src via workspace resolution — no per-package imports map needed                                     |
| Platform worker facts                   | verified by the planned REAL-spawn e2e tests (run on Deno, the gate runtime) | web `Worker` global (`{ type: 'module' }`) exists on Deno & Bun; Node has `node:worker_threads` `Worker`; `node:` static imports load on all three runtimes (node-runtime.ts precedent) |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                           | Resolution (picked side)                                                                      | Doc deliverable (same PR)                                                        |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| C1 | PUBLIC_API.md "Available Runtime Services" prints the full `IRuntimeServices` interface (PUBLIC_API.md:204+) without the new `workers?` member this milestone adds | Source wins; the widening is deliberate and flagged (optional member, additive, non-breaking) | Update the `IRuntimeServices` listing + add Worker Pool section in PUBLIC_API.md |
| C2 | ROADMAP.md has no Milestone 45 section and its Progress Tracking table has no row 45                                                                               | ROADMAP gains both (M45 is an out-of-sequence, user-requested milestone like M41–M44)         | ROADMAP §M45 section + `45` tracking row, flipped ✅ in this PR                  |

## 3. Design decisions

### 3.1 Where the thread primitive lives

- **Decision:** New optional `workers?: IWorkerHost` on `IRuntimeServices` (`common`), implemented
  by the Deno/Bun/Node runtime adapters and omitted by the Cloudflare adapter. `IWorkerHost` is
  `spawn(specifier: string): IWorkerHandle` + `availableParallelism(): number`. `IWorkerHandle` is
  `postMessage(unknown)`, `onMessage(listener)`, `onError(listener)`, `terminate(): Promise<void>`.
- **Why:** AI_GUIDELINES §4.1/§4.2 forbid runtime-specific APIs outside `packages/runtime`; the
  optional-member precedent is `IFileSystem.realPath` (M44) and `fs?` itself. Web `Worker` and
  `node:worker_threads` normalize cleanly to this 4-method handle.
- **Test home:** runtime `web-worker-host.test.ts` / `node-worker-host.test.ts` (normalization),
  adapter tests (presence/absence per platform), plugin e2e (real spawn).

### 3.2 Task module model — self-registering modules, not a generic pool entry

- **Decision:** A task is an ES module the APPLICATION owns; it calls
  `defineWorkerTask(async (input) => output)` (from `@hono-enterprise/runtime/worker`) at module top
  level. The pool spawns N workers OF that module and speaks the §3.3 protocol to them. There is no
  framework-owned generic worker-entry module.
- **Why:** a generic entry would have to `import()` the task module from INSIDE the worker and
  resolve the framework's own entry file across JSR's npm transform — fragile. A self-registering
  module needs only the user's import graph. This also keeps worker bundles free of framework side
  effects. Node cannot execute `.ts` task modules without a loader — that is the app's build
  concern, documented in the README (same stance as M44's app-owned frontend build).
- **Test home:** `define-worker-task.test.ts` (wiring over a fake port); both real-spawn e2e tests.

### 3.3 Host↔worker protocol — envelope messages in `common`

- **Decision:** Protocol types + type guards live in `common/src/services/worker-pool.ts`:
  `WorkerReadySignal { __hewp: 1; kind: 'ready' }`,
  `WorkerTaskRequest { __hewp: 1; kind: 'task'; id: number; input: unknown }`,
  `WorkerTaskReply { __hewp: 1; kind: 'reply'; id: number; ok: boolean; result?: unknown; error?: WorkerErrorShape }`
  (`WorkerErrorShape { name: string; message: string; stack?: string }`), with pure guards
  `isWorkerReadySignal` / `isWorkerTaskRequest` / `isWorkerTaskReply`. Worker posts `ready` after
  wiring; the pool dispatches only to ready workers; correlation `id` is a per-pool counter.
  Non-envelope messages are ignored by both sides.
- **Why:** both `packages/runtime` (worker side) and `packages/worker-pool-plugin` (host side) read
  the protocol, and plugins may not import other plugins — `common` is the only shared home
  (precedent: `TELEMETRY_CONTEXT_OPAQUE`, `ok()`/`some()` pure utilities). Guards in `common`
  prevent DRY violations (§11.1). The ready handshake makes module-eval failures deterministic
  instead of racing dispatch.
- **Test home:** common `worker-pool.test.ts` (guards, both branches); `define-worker-task.test.ts`
  and `task-pool.test.ts` (each side honors the protocol).

### 3.4 Worker-side channel detection in `defineWorkerTask`

- **Decision:** Split into an internal seam:
  `resolveTaskPort(g = globalThis as PortCandidate, nodePort = parentPort)` returns a
  `TaskPort { postMessage(msg): void; onMessage(listener): void }` — web branch when
  `typeof g.postMessage === 'function'` (Deno/Bun workers), else the statically-imported
  `node:worker_threads` `parentPort` (Node workers), else throws
  (`defineWorkerTask() must be called inside a worker`). `wireWorkerTask(fn, port)` does the
  protocol wiring; `defineWorkerTask(fn)` = `wireWorkerTask(fn, resolveTaskPort())`. Web-first
  ordering is load-bearing: Deno implements `worker_threads` over web workers, so inside a Deno web
  worker BOTH channels can appear — the host listens on the web channel, so web must win.
- **Why:** the detection branch is otherwise uncoverable from the (main-thread) test runner; the
  seam rule from the self-review checklist. Static `node:worker_threads` import is the sanctioned
  way to touch Node builtins and loads on all three runtimes.
- **Test home:** `define-worker-task.test.ts` — fake web-port candidate, fake node port, and the
  neither-channel throw; real path via both e2e tests.

### 3.5 Pool mechanics (`TaskPool`, internal — not exported from the plugin barrel)

- **Decision:** One `TaskPool` per task-module specifier, created lazily on first `run()`. Workers
  spawn on demand up to `size` (default `host.availableParallelism()`); an idle worker is reused
  before a new one spawns; pending tasks wait in a bounded FIFO queue (default bound 1024,
  `WorkerQueueFullError` beyond it). Completion/failure counters feed `stats()`. Timers go through
  the injected `IRuntimeServices` (`setTimeout`/`clearTimeout`) — never globals (§4.2).
- **Why:** FIFO fairness for tasks; spawn-on-demand avoids paying thread startup for unused
  capacity; the bound converts overload into a typed error instead of unbounded memory growth
  (bulkhead precedent, M27).
- **Test home:** `task-pool.test.ts` (dispatch order, reuse, spawn-up-to-size, queue bound).

### 3.6 Timeout semantics

- **Decision:** Per-task timeout = `run()` `timeoutMs` override → pool `taskTimeoutMs` → plugin
  `taskTimeoutMs` → default 30 000 ms; `0` disables (cacheTtl precedent). On timeout the task
  rejects with `WorkerTaskTimeoutError` and the worker is TERMINATED and dropped (JS cannot cancel
  in-flight work); queued tasks continue on remaining/new workers. A module that never calls
  `defineWorkerTask` never signals ready, so its tasks resolve through this same timeout path — no
  separate readiness timeout.
- **Why:** an un-terminated stuck worker would silently shrink the pool; terminate-and-replace is
  the only honest cancellation. One timeout mechanism instead of two keeps the state machine small.
- **Test home:** `task-pool.test.ts` with a controllable fake-runtime timer (assert terminate
  called, slot replaced, later tasks still run; assert `0` disables).

### 3.7 Worker error and crash semantics

- **Decision:** A task-level error (handler threw) travels back as an `ok: false` reply and rejects
  that one task with `WorkerTaskError` (carrying the remote `name`/`message`/`stack`); the worker
  STAYS in the pool. A worker-level error (`onError` — module eval failure, crash) rejects that
  worker's in-flight task with `WorkerTaskError` and DROPS the worker; its queued work is
  re-dispatched to surviving/new workers.
- **Why:** a thrown handler is a healthy worker reporting a result; a crashed worker is not.
  Conflating them would leak broken workers, or would pay a respawn per ordinary error.
- **Test home:** `task-pool.test.ts` (both branches, plus requeue-after-crash).

### 3.8 Behavior when the runtime has no worker support

- **Decision:** `WorkerPoolPlugin` ALWAYS registers; `run()` throws `WorkerPoolUnavailableError`
  when no host exists (no injected `host`, no `runtime.workers`). `stats()` returns `[]`,
  `shutdown()` resolves, health reports `up` with `available: false`. The same error (message
  "Worker pool has been shut down") rejects in-flight and queued tasks on `shutdown()` and any
  `run()` issued after it.
- **Why:** unlike M24b's config-only no-op, `run()` has a return value the caller depends on — a
  silent no-op would be a lie. Registering (rather than throwing at startup) keeps one codebase
  deployable to Cloudflare where the pool is simply unused.
- **Test home:** `worker-pool-service.test.ts` (throw + stats/shutdown/health branches).

### 3.9 Plugin registration surface

- **Decision:** Single-instance plugin `worker-pool-plugin`, `provides: [CAPABILITIES.WORKER_POOL]`
  (bare token, claimed once — resolver throws on duplicates, verified §1), priority
  `PLUGIN_PRIORITY.NORMAL`, `optionalDependencies: ['logger']`; registers the service, a
  `worker-pool` health indicator reporting `stats()`, and `onClose` → `service.shutdown()`
  (terminate every worker — §14.5 graceful shutdown).
- **Why:** mirrors the sibling-plugin shape (sse-plugin) exactly; no second instance story exists
  (pools are already per-task-module inside the one service).
- **Test home:** `worker-pool-plugin.test.ts` (integration: resolve token, health, onClose spy).

## 4. Exported surface — every symbol names its consumer

### `packages/common` (barrel additions)

| Exported symbol            | Kind      | Consumer / real code path that READS it                                           |
| -------------------------- | --------- | --------------------------------------------------------------------------------- |
| `CAPABILITIES.WORKER_POOL` | token     | plugin `provides` + registration; apps resolve the service by it                  |
| `IWorkerPool`              | interface | apps type the resolved service; `WorkerPoolService` implements it                 |
| `WorkerRunOptions`         | type      | `IWorkerPool.run` options parameter (read by `WorkerPoolService.run`)             |
| `TaskPoolStats`            | type      | `IWorkerPool.stats` return element; health indicator reads the fields             |
| `IWorkerHost`              | interface | `IRuntimeServices.workers` member type; `WorkerPoolService`/`TaskPool` consume it |
| `IWorkerHandle`            | interface | returned by `IWorkerHost.spawn`; consumed by `TaskPool` slots                     |
| `WorkerReadySignal`        | type      | posted by `wireWorkerTask`; narrowed by `TaskPool` via guard                      |
| `WorkerTaskRequest`        | type      | posted by `TaskPool`; narrowed by `wireWorkerTask` via guard                      |
| `WorkerTaskReply`          | type      | posted by `wireWorkerTask`; narrowed by `TaskPool` via guard                      |
| `WorkerErrorShape`         | type      | `WorkerTaskReply.error` field; `WorkerTaskError` constructor reads it             |
| `isWorkerReadySignal`      | fn        | `TaskPool` message handler                                                        |
| `isWorkerTaskRequest`      | fn        | `wireWorkerTask` message handler                                                  |
| `isWorkerTaskReply`        | fn        | `TaskPool` message handler                                                        |

### `packages/runtime` (barrel + new `./worker` subpath)

| Exported symbol                 | Kind | Consumer / real code path that READS it                                     |
| ------------------------------- | ---- | --------------------------------------------------------------------------- |
| `defineWorkerTask` (`./worker`) | fn   | application task modules (both e2e fixtures exercise it)                    |
| `createWebWorkerHost`           | fn   | `deno-runtime.ts` + `bun-runtime.ts` build `services.workers` with it       |
| `WebWorkerGlobals`              | type | injectable seam param of `createWebWorkerHost` (tests + bun adapter wiring) |
| `createNodeWorkerHost`          | fn   | `node-runtime.ts` builds `services.workers` with it                         |
| `NodeWorkerModules`             | type | injectable seam param of `createNodeWorkerHost` (tests)                     |

(`resolveTaskPort`, `wireWorkerTask`, `TaskPort` stay module-internal to `./worker` — imported by
runtime unit tests via relative path; absent from both barrels.)

### `packages/worker-pool-plugin`

| Exported symbol              | Kind  | Consumer / real code path that READS it                                  |
| ---------------------------- | ----- | ------------------------------------------------------------------------ |
| `WorkerPoolPlugin`           | fn    | applications register it                                                 |
| `WorkerPoolPluginOptions`    | type  | `WorkerPoolPlugin` factory parameter                                     |
| `TaskPoolOptions`            | type  | `WorkerPoolPluginOptions.pools` values; merged by `WorkerPoolService`    |
| `WorkerPoolService`          | class | the plugin instantiates it; apps may construct directly (replaceability) |
| `WorkerPoolUnavailableError` | class | thrown by `run()` (§3.8); apps `instanceof`-match                        |
| `WorkerTaskError`            | class | thrown by `run()` (§3.7); carries remote `name`/`message`/`stack`        |
| `WorkerTaskTimeoutError`     | class | thrown by `run()` (§3.6); carries `timeoutMs` + `taskModule`             |
| `WorkerQueueFullError`       | class | thrown by `run()` (§3.5); carries `taskModule` + `limit`                 |

### 4.1 Options — every option names its consumer

| Option                            | Consumer                                       | Behavior (per implementation)                                       |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `defaultPoolSize?`                | `WorkerPoolService` → `TaskPool.size`          | workers per pool; default `host.availableParallelism()`             |
| `maxQueue?`                       | `WorkerPoolService` → `TaskPool.maxQueue`      | pending-task bound; default 1024; exceeded → `WorkerQueueFullError` |
| `taskTimeoutMs?`                  | `WorkerPoolService` → `TaskPool.taskTimeoutMs` | default 30 000; `0` disables (§3.6)                                 |
| `pools?[specifier].size`          | `WorkerPoolService` merge                      | per-module override of `defaultPoolSize`                            |
| `pools?[specifier].maxQueue`      | `WorkerPoolService` merge                      | per-module override of `maxQueue`                                   |
| `pools?[specifier].taskTimeoutMs` | `WorkerPoolService` merge                      | per-module override of `taskTimeoutMs`                              |
| `host?`                           | `WorkerPoolService` (before `runtime.workers`) | injected `IWorkerHost` (tests / custom transports)                  |
| `run(..., { timeoutMs })`         | `TaskPool` per-task                            | per-call override of the resolved pool timeout                      |

## 5. Implementation files

| File                                                                | Purpose                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/worker-pool.ts`                       | `IWorkerPool`, `WorkerRunOptions`, `TaskPoolStats`, protocol types + guards                                     |
| `packages/common/src/runtime.ts` (edit)                             | `IWorkerHost`, `IWorkerHandle`, `workers?` on `IRuntimeServices`                                                |
| `packages/common/src/tokens.ts` (edit)                              | `WORKER_POOL: 'worker-pool'`                                                                                    |
| `packages/common/src/index.ts` (edit)                               | barrel additions                                                                                                |
| `packages/runtime/src/adapters/shared/web-worker-host.ts`           | `createWebWorkerHost` over injectable `WebWorkerGlobals` (Worker ctor + `hardwareConcurrency`)                  |
| `packages/runtime/src/adapters/node/node-worker-host.ts`            | `createNodeWorkerHost` over injectable `NodeWorkerModules` (`worker_threads.Worker`, `os.availableParallelism`) |
| `packages/runtime/src/adapters/{deno,bun,node}/…-runtime.ts` (edit) | wire `workers` into each adapter's divergent object                                                             |
| `packages/runtime/src/services/cross-runtime.ts` (edit)             | add `'workers'` to the `mergeRuntimeServices` Pick                                                              |
| `packages/runtime/src/worker/define-worker-task.ts`                 | `defineWorkerTask` (the `./worker` subpath's ONLY export)                                                       |
| `packages/runtime/src/worker/task-port.ts`                          | internal `resolveTaskPort`/`wireWorkerTask`/`TaskPort` (kept out of the subpath so it exports only the helper)  |
| `packages/runtime/src/index.ts` + `deno.json` (edit)                | export hosts; exports map gains `"./worker"`                                                                    |
| `packages/worker-pool-plugin/deno.json`                             | package manifest; test permissions `read: true` (worker module loading)                                         |
| `packages/worker-pool-plugin/src/interfaces/index.ts`               | `WorkerPoolPluginOptions`, `TaskPoolOptions`                                                                    |
| `packages/worker-pool-plugin/src/errors.ts`                         | the four error classes                                                                                          |
| `packages/worker-pool-plugin/src/pool/task-pool.ts`                 | `TaskPool` (internal)                                                                                           |
| `packages/worker-pool-plugin/src/services/worker-pool-service.ts`   | `WorkerPoolService implements IWorkerPool`                                                                      |
| `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts`      | `WorkerPoolPlugin` factory                                                                                      |
| `packages/worker-pool-plugin/src/index.ts`                          | barrel per §4                                                                                                   |
| `packages/worker-pool-plugin/README.md`                             | usage, task-module authoring, runtime support matrix                                                            |
| `deno.json` (edit)                                                  | workspace member `./packages/worker-pool-plugin`                                                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                        | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/worker-pool.test.ts`                           | `common/src/services/worker-pool.ts`                   | each guard: true on a conforming envelope, false on `null`/plain object/wrong `kind` (guards take `unknown`); `CAPABILITIES.WORKER_POOL === 'worker-pool'` passes `createCapabilityToken`                                                                                                                                                                                                                                                                                                      |
| `runtime/test/unit/web-worker-host.test.ts`                      | `adapters/shared/web-worker-host.ts`                   | `spawn(spec)` constructs injected `Worker(spec, { type: 'module' })`; `onMessage` unwraps `MessageEvent.data`; `onError` maps `ErrorEvent` and non-Error to `Error`; `terminate()` resolves; `availableParallelism()` from injected globals and its `?? 1` fallback                                                                                                                                                                                                                            |
| `runtime/test/unit/node-worker-host.test.ts`                     | `adapters/node/node-worker-host.ts`                    | `spawn` constructs injected `worker_threads.Worker`; `on('message')`/`on('error')` wiring; `terminate(): Promise<number>` normalized to `Promise<void>`; `availableParallelism` delegates to injected `os` fn                                                                                                                                                                                                                                                                                  |
| `runtime/test/unit/runtime-workers-wiring.test.ts`               | adapter `…-runtime.ts` edits                           | `createXxxRuntimeServices().workers` defined on deno/bun/node (spawn delegates to seam); `undefined` on cloudflare (key ABSENT, per `exactOptionalPropertyTypes`)                                                                                                                                                                                                                                                                                                                              |
| `runtime/test/unit/define-worker-task.test.ts`                   | `worker/task-port.ts` + `worker/define-worker-task.ts` | `resolveTaskPort`: web branch (fake candidate with `postMessage`), node branch (fake `parentPort`), neither → throws; `wireWorkerTask(fn, port)`: posts `ready`, `task` request → `ok` reply with result, throwing fn → `ok: false` reply with `name`/`message`, non-envelope ignored (fn takes `(input: unknown) => Promise<unknown>`)                                                                                                                                                        |
| `runtime/test/e2e/worker-host-real.test.ts`                      | real Deno spawn path                                   | REAL `createDenoRuntimeServices().workers.spawn(fixtureUrl)` round-trip against `test/fixtures/echo-task.ts` (which calls `defineWorkerTask`); ready arrives, reply correlates by `id`, terminate resolves                                                                                                                                                                                                                                                                                     |
| `worker-pool-plugin/test/unit/errors.test.ts`                    | `src/errors.ts`                                        | each class: `instanceof Error` + itself, `name`, message content, payload fields (`timeoutMs`, `taskModule`, `limit`, `WorkerErrorShape` passthrough)                                                                                                                                                                                                                                                                                                                                          |
| `worker-pool-plugin/test/unit/task-pool.test.ts`                 | `src/pool/task-pool.ts`                                | with `FakeWorkerHost`/`FakeHandle` + fake-runtime timers: FIFO dispatch after ready; idle reuse before spawn; spawns capped at `size`; queue bound → `WorkerQueueFullError`; timeout → `WorkerTaskTimeoutError` + terminate + replacement (and `0` disables); handler-error reply → `WorkerTaskError`, worker retained; crash via `onError` → in-flight rejects, worker dropped, queued task re-dispatched; `shutdown()` terminates all; `stats()` counts workers/busy/queued/completed/failed |
| `worker-pool-plugin/test/unit/worker-pool-service.test.ts`       | `src/services/worker-pool-service.ts`                  | lazy pool per specifier (same instance on 2nd `run`); NON-default global + per-pool option merge drives `TaskPool` ctor args; no host → `run` throws `WorkerPoolUnavailableError`, `stats() === []`, `shutdown()` resolves; injected `host` wins over `runtime.workers`; `stats()` aggregates across pools (calls type-check against `IWorkerPool.run<TIn, TOut>(module, input, opts?)`)                                                                                                       |
| `worker-pool-plugin/test/integration/worker-pool-plugin.test.ts` | `src/plugin/worker-pool-plugin.ts` + barrel            | `createApplication` + `RuntimePlugin` + `WorkerPoolPlugin({ host: fake })`: service resolves under `CAPABILITIES.WORKER_POOL` typed `IWorkerPool`; `run` round-trips through the resolved service; health indicator `worker-pool` registered and reports `available`/stats; `app.stop()` → every spawned handle terminated                                                                                                                                                                     |
| `worker-pool-plugin/test/e2e/real-worker.test.ts`                | whole stack, REAL threads                              | plugin with REAL `runtime.workers` (Deno): `run(echoFixture, input)` returns the transformed output (write→read-back through the public surface); `run(errorFixture, …)` rejects `WorkerTaskError` with the remote message; two concurrent `run`s on a `size: 2` pool both complete                                                                                                                                                                                                            |

Fixtures (`test/fixtures/*.ts`, excluded from coverage): `echo-task.ts`, `error-task.ts` import
`defineWorkerTask` from `@hono-enterprise/runtime/worker` (workspace resolution).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m45-worker-pool-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- **Deno test permissions for real workers** (module load needs read access) → per-package
  `deno.json` `test.permissions` gains `read: true` (worker-pool-plugin) / extend runtime's existing
  block; workers inherit permissions.
- **Bun/Node real-thread behavior unverified by the Deno-run gates** → hosts are normalization shims
  behind unit-tested seams; the CI Node/Bun compat suite (AI_GUIDELINES §6.4) is the cross-runtime
  backstop, as for every other adapter.
- **Structured-clone limits** (functions, class instances in `input`/`output`) → documented in
  README + JSDoc; a clone failure surfaces as a rejected `run()` (`WorkerTaskError` wrapping the
  local `DataCloneError`).
- **JSR npm transform of the new `./worker` subpath** → uses the exact exports-map pattern
  AI_GUIDELINES §14.3 prescribes; verified by the compat suite like every other subpath.
- **A task module that never calls `defineWorkerTask`** → converges on the §3.6 timeout path
  (tested), never a hang.

## 9. Out of scope

- Queue-plugin integration (worker-backed job execution) — a future queue milestone, if wanted.
- Worker autoscaling, idle reaping, warm-up API — YAGNI until a consumer exists.
- Transferables / SharedArrayBuffer surface — structured clone only in this milestone.
- Cloudflare Workers thread support — the platform has none; behavior is §3.8.
