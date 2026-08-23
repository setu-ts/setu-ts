# Milestone 70k — Storage, queue and worker operability (`@setu-ts/storage-plugin`, `@setu-ts/queue-plugin`, `@setu-ts/worker-pool-plugin`)

> **Status:** Planning. Branch: `feat/m70k-storage-queue-worker-operability`. `main` is protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the eight open `X8-*` rows the alpha.8 smoke programme left on the three background/IO
capabilities: an upload whose declared limit does not bound what the process buffers or parses, a
job that dies after its last retry with no programmatic surface reporting it, an object written
without a content type so the presigned URL that is the feature's whole point downloads instead of
renders, a worker that ends itself and permanently wedges its pool, and a storage options type that
cannot name its own bad key. The unifying complaint is **operability**: in each case the capability
does the work and then cannot tell an operator what it did.

- **In scope:** X8-3, X8-4, X8-6, X8-7, X8-8, X8-9, X8-10, X8-11.
- **Package list corrected from the ROADMAP row.** The row names
  `storage-plugin, queue-plugin, worker-pool-plugin`; the rows it assigns need FOUR more: `common`
  (X8-4 `ProcessOptions.onFailed`, X8-6 `PutObjectOptions`, X8-7 `IWorkerHandle.onExit?`), `runtime`
  (X8-7's per-runtime exit signal — the ROADMAP row itself says "an optional `common` widening plus
  per-runtime implementations"), `cli` (X8-9's assigned package), and — found during implementation
  — `cloudflare-plugin`, because `R2Storage` is the other in-repo `IStorage` implementor and R2
  carries both attributes natively (`httpMetadata.contentType` / `customMetadata`). This mirrors the
  M70b, M70g and M70h corrections, which added packages the row's body assigned but its list
  omitted.
- **NOT this milestone:** X8-1, X8-2, X8-5 and X8-12 are already closed (M70f, M45b, M70c, M70f
  respectively). A streaming request body — the only thing that would stop a large upload being
  buffered at all — is a `common`/`kernel`/`runtime` widening of `IRequest`, named in §9 and owned
  by no milestone yet. Extending the doc-fence gate to **all** package READMEs is M70n's docs sweep;
  this milestone gates only the three READMEs it rewrites.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                 | Verified surface / fact                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IStorage.put`                       | `packages/common/src/services/storage.ts:36`                       | `put(path: string, data: Uint8Array): Promise<void>` — no third parameter, so no provider can receive a content type. Confirms X8-6's mechanism.                                                              |
| `StorageProvider.put`                | `packages/storage-plugin/src/interfaces/index.ts:196`              | Internal port, same two-parameter shape. Widening it is NOT a public-contract change on its own.                                                                                                              |
| `StorageProviderOptions`             | `packages/storage-plugin/src/interfaces/index.ts:41`               | Undiscriminated union; first member `MemoryProviderOptions = Record<string, never>` (`:49`). Confirms X8-11's mechanism exactly as the register states it.                                                    |
| `StoragePluginOptions`               | `packages/storage-plugin/src/interfaces/index.ts:29`               | `provider?` and `options?` are SEPARATE fields, so the discriminant is not on the union being reported. The fix must restructure the TOP-level type, not `StorageProviderOptions` alone.                      |
| `createProvider`                     | `packages/storage-plugin/src/plugin/storage-plugin.ts:50`          | Returns `unknown`; every arm casts `options as XProviderOptions`. Those casts exist BECAUSE the union is undiscriminated — X8-11 deletes them rather than adding surface.                                     |
| `IAwsS3Client`                       | `packages/storage-plugin/src/interfaces/index.ts:105`              | Declares `put/get/delete/head/getSignedUrl/getStream` — the provider's own surface, NOT `@aws-sdk/client-s3`'s `send(command)`. Confirms X8-10. `IGcsClient.bucket()` (`:117`) genuinely mirrors its SDK.     |
| `adaptAwsS3Module`                   | `packages/storage-plugin/src/providers/s3-provider.ts:125`         | Builds the facade from real SDK commands (`PutObjectCommand({ Bucket, Key, Body })`) — so the facade is the ADAPTED shape, which is what makes the "inject a fake SDK" doc claim wrong.                       |
| `maxBodyBytes`                       | `packages/storage-plugin/src/middleware/upload-middleware.ts:40`   | `Math.max(maxSize * 2, 50 * 1024 * 1024)` with the comment "cap at 50 MB". `Math.max` makes 50 MB a FLOOR. Confirms X8-3's second half verbatim.                                                              |
| `mapWebRequestToFrameworkRequest`    | `packages/runtime/src/adapters/shared/fetch-mapping.ts:37`         | `await request.arrayBuffer()` — the ENTIRE body is buffered by the HTTP adapter before any middleware runs. **Falsifies the middleware-level half of X8-3's suggested fix** (see §3.1).                       |
| `IRequest`                           | `packages/common/src/http.ts:33-95`                                | `json`/`text`/`bytes` only — no body `ReadableStream` member. A streaming multipart scan is therefore not expressible in this package at all.                                                                 |
| `ProcessOptions`                     | `packages/common/src/services/queue.ts:51`                         | Exactly one member, `readonly concurrency?: number`. Adding an optional callback is source-compatible for every existing caller.                                                                              |
| `IQueue`                             | `packages/common/src/services/queue.ts:79`                         | `add`/`process`/`addRecurring` only — no `getJob`, no dead-letter accessor. Confirms X8-4's "no surface".                                                                                                     |
| `runJob`                             | `packages/queue-plugin/src/processors/job-processor.ts:50`         | Already takes a `report` sink (M70f) and calls it before `deadLetter`. X8-4's "invisible through EVERY surface" is now partly false — a log line exists. The remaining gap is a PROGRAMMATIC surface.         |
| `RedisQueue.deadLetter`              | `packages/queue-plugin/src/adapters/redis-queue.ts:273`            | `zrem(processing)` + `zadd(dead)`, and the comment "keep payload in jobs hash for debugging" — no `hdel`, no `expire`. Confirms X8-4's unbounded-growth half.                                                 |
| `IRedisQueueClient`                  | `packages/queue-plugin/src/interfaces/index.ts:16`                 | No `expire`, no `zcard`. Both must be added as OPTIONAL members so an existing injected fake still type-checks.                                                                                               |
| `QueueService.createHealthIndicator` | `packages/queue-plugin/src/services/queue-service.ts:198`          | Reports `{ adapter, reachable }` (M70c). The depth fields X8-4 asks for extend this payload; they do not replace it.                                                                                          |
| `IWorkerHandle`                      | `packages/common/src/runtime.ts:149-173`                           | `postMessage`/`onMessage`/`onError`/`terminate` — **no exit or close signal**. Confirms the ROADMAP's statement that X8-7 needs a `common` widening.                                                          |
| `IWorkerHost`                        | `packages/common/src/runtime.ts:181`                               | `spawn`/`availableParallelism` only — no capability query, so the plugin cannot today know whether exit is observable.                                                                                        |
| `createWebWorkerHost`                | `packages/runtime/src/adapters/shared/web-worker-host.ts:85`       | ONE implementation serves BOTH Deno and Bun, via injected `WebWorkerGlobals`. It therefore cannot distinguish them without a new parameter (§3.5).                                                            |
| `createNodeWorkerHost`               | `packages/runtime/src/adapters/node/node-worker-host.ts:56`        | `NodeWorkerLike.on` is typed `'message' \| 'error'` only — the widening must extend that union before `'exit'` can be registered.                                                                             |
| `TaskPool.onTimeout` / `shutdown`    | `packages/worker-pool-plugin/src/pool/task-pool.ts:300`, `:154`    | Both call `handle.terminate()` on purpose. Bun fires `'close'` after a deliberate terminate (§1 probe P4), so the pool needs an intentional-termination guard or shutdown would self-report as a crash.       |
| `TaskPool.onWorkerError`             | `packages/worker-pool-plugin/src/pool/task-pool.ts:271`            | On a not-ready slot it SHIFTS and rejects the oldest pending task. An exit handler reusing this path unmodified could reject an unrelated task after a deliberate terminate.                                  |
| `setu add` / `ADDABLE`               | `packages/cli/src/commands/add.ts:50`                              | Writes `imports` in `deno.json`/`package.json` ONLY — it does not touch `tasks`. X8-9's "amending `denoPermissions` is exactly the kind of thing it should do" is therefore unimplemented, not merely unused. |
| `denoPermissions`                    | `packages/cli/src/templates/project-files.ts:904`                  | `--allow-net --allow-env` unconditionally, plus `manifest.denoPermissions`. No template declares `--allow-write`. Confirms X8-9's one-flag cause.                                                             |
| `LocalStorageProvider.isHealthy`     | `packages/storage-plugin/src/providers/local-provider.ts:66`       | `fs.stat(root)` — a READ. With `--allow-read` granted (every generated task has it) this reports `up` while every write fails. M70c did NOT close X8-9's health half.                                         |
| `createCachedProbe`                  | `packages/common/src/health/probe.ts:97`                           | Exists and is exported; M70c's probes ride it. Queue depth reads can share the same cache rather than adding a second per-probe round trip.                                                                   |
| `respondWithError`                   | `packages/common/src/index.ts` (M70f)                              | The request-scoped error responder every short-circuit site routes through. The upload middleware already uses it, so changing a status code changes only the number, not the body format.                    |
| `WorkerPoolCollector`                | `packages/worker-pool-plugin/src/metrics/worker-pool-collector.ts` | M45b's optional-metrics precedent: `ctx.services.has(CAPABILITIES.METRICS)`, guarded writes, logger read at CALL time. The queue collector copies this shape rather than inventing one.                       |

### 1.1 Platform facts established by probe, not by memory

Every one of these was measured on this machine during planning; each changed a design decision.

| #  | Probe                                                        | Result                                                                                                                                                                                                                                                                                                 |
| -- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 | Deno web `Worker`, worker calls `self.close()`               | **No host-side event at all** — not `close`, `exit`, `error` or `messageerror`; `postMessage` afterwards does not throw; the `Worker` object exposes no liveness member. Deno self-termination is undetectable.                                                                                        |
| P2 | Node `worker_threads.Worker`, worker calls `process.exit(0)` | `'exit'` fires with the code. Also fires under Deno's `node:` compatibility layer.                                                                                                                                                                                                                     |
| P3 | Bun web `Worker`, worker calls `process.exit(0)`             | `'close'` fires with `code: 0`. **`self.close` is `undefined` on Bun** — an earlier probe "showing" a Bun self-close was actually an uncaught `TypeError`, and the `error` event it produced was that exception, not a close signal.                                                                   |
| P4 | Bun web `Worker`, live worker, then host calls `terminate()` | No `close` while alive; `close` with `code: 0` AFTER the deliberate terminate. Hence the intentional-termination guard in §3.6.                                                                                                                                                                        |
| P5 | Deno spawning a worker through `node:worker_threads`         | Works, including a `.ts` module; inside it BOTH `globalThis.postMessage` and `parentPort` exist, and the web-global route reaches the host's `'message'` listener — so `resolveTaskPort`'s web-first preference would still be correct. Recorded as the evidenced future option in §9, not taken here. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                          | Doc deliverable (same PR)                                                                                                                                        |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `upload-middleware.ts:40`'s comment says "cap at 50 MB"; the code makes 50 MB a floor.                                                                                                      | The comment states the intent; the code is wrong. Implement a real cap (§3.1).                                                                                    | Comment deleted with the expression it described; the new bound is documented in the storage README Options table and `PUBLIC_API.md`.                           |
| C2 | The storage README Uploads example uses `maxFileSize`, `file.contentType`, and `getUploadedFile(ctx, 'avatar')` against a middleware defaulting `fieldname` to `'file'` — none of it works. | The code is right; three doc claims are wrong. Rewrite the example so it compiles AND runs (X8-8).                                                                | `packages/storage-plugin/README.md` Uploads section rewritten; the `PUBLIC_API.md` Storage upload snippet rewritten with it; both then gated by §6's fence test. |
| C3 | `IAwsS3Client`'s module JSDoc says consumers "inject a fake SDK"; the type is the provider's own backend surface, so a real `S3Client` is rejected.                                         | The type is correct for what it does; the NAME and both doc claims are wrong. Rename to `IS3Backend` and say what it is (X8-10).                                  | `interfaces/index.ts` module doc + option JSDoc corrected; `PUBLIC_API.md` and the storage README export tables updated; `CHANGELOG.md` migration entry.         |
| C4 | The worker-pool README promises "a worker-level crash rejects its in-flight task, drops the worker, and re-dispatches its queued work"; with `taskTimeoutMs: 0` nothing detects it.         | The README states the intent. Make it true where the platform allows (Node, Bun) and state the Deno limitation precisely rather than deleting the promise (X8-7). | `packages/worker-pool-plugin/README.md` gains a per-runtime exit-detection table; `PUBLIC_API.md` gains the `onExit?`/`reportsExit?` rows and the Deno caveat.   |
| C5 | `PUBLIC_API.md`'s upload snippet is not valid TypeScript (`allowedMimeTypes?: [...]` in a value position) and uses `app.post`/`ctx.json`/`ctx.req.param`, none of which the kernel exports. | The kernel is right. Rewrite to `app.router.post` + `ctx.response.json` (the form the guides' fence gate already enforces).                                       | Same `PUBLIC_API.md` rewrite as C2; the surrounding buffered-download snippet is corrected with it.                                                              |

## 3. Design decisions

### 3.1 What an upload's `maxSize` actually bounds (X8-3)

- **Decision:** `maxBodyBytes` becomes `min(maxSize * BODY_ALLOWANCE + FRAMING_ALLOWANCE, hardCap)`
  where the hard cap is a new explicit option `maxBodyBytes?` defaulting to 50 MB — a **cap**, never
  a floor — and both oversize refusals answer **413** rather than 400. The `content-length`
  pre-check and the post-read bound are kept and both use the same computed number. **The design
  does NOT claim the body is no longer read**: `fetch-mapping.ts:37` buffers the whole body before
  any middleware exists, so what this bound actually prevents is the multipart PARSE and the
  retained per-part copies — the expensive, attacker-controlled multiplier. That limit is stated in
  the README and in the option's JSDoc rather than implied away.
- **Why:** the register's preferred fix ("stream-scan for the boundary instead of buffering") is not
  expressible here — `IRequest` has no body stream (§1), so no code in `storage-plugin` can decline
  to read. Claiming otherwise would be exactly the docs-must-match-behavior defect this repo keeps
  finding. The half that IS in this package's hands is the bound, which was inverted, and the status
  code, which told a client "you sent something malformed" for a request that was merely too large.
- **Test home:** `test/unit/upload-middleware.test.ts` — a table-driven case per row of the
  register's own probe matrix, asserting the refusal's STATUS and its `title`, because the title is
  the only externally visible signal of which guard fired (the register's own point about why no
  gate caught this).

### 3.2 Dead-letter visibility (X8-4)

- **Decision:** three additive surfaces, no adapter contract break.
  1. `ProcessOptions.onFailed?(job, error)` in `common`, invoked **once, after the final attempt**,
     immediately before `deadLetter`. Not on every failed attempt: the register specifies "after the
     final attempt", and a callback that also fired on retries would need a `willRetry` flag whose
     only honest consumer is a caller that wants the final one anyway.
  2. Queue metrics behind an OPTIONAL `CAPABILITIES.METRICS`, following M45b exactly:
     `queue_jobs_total{name,outcome}` with `outcome` in `completed|retried|dead_lettered`, and
     `queue_jobs_in_flight{name}`. Every write is guarded and reported through the logger read at
     call time.
  3. `QueuePluginOptions.deadLetterTtlMs` (default `undefined` = retain forever, today's behaviour)
     bounding the retained payload, applied by `RedisQueue.deadLetter` through a new OPTIONAL
     `IRedisQueueClient.expire`.
- **Depth reporting is included but bounded:** a new OPTIONAL `QueueAdapter.stats?(name)` returning
  `{ ready, delayed, dead }`, implemented on **memory** (in-process, free) and **redis** (`zcard`,
  one round trip, ridden on the same `createCachedProbe` cache the M70c liveness probe uses), and
  omitted on rabbitmq and sqs. Omitted rather than faked because both would need a management-API or
  `GetQueueAttributes` call whose cost and permissions are not this milestone's to take on; the
  health payload reports the field as absent, never as `0`, so "not reported" and "none" stay
  distinguishable.
- **Why counters AND depths:** counters are per-process and reset on restart, so a restarted replica
  would report zero dead letters while Redis still held them; depths are the durable view. Neither
  alone answers the register's question.
- **Test home:** `test/unit/queue-service-failure-surface.test.ts` (callback fires exactly once, at
  the final attempt, and a throwing callback cannot break the runner),
  `test/unit/queue-metrics.test.ts`, `test/unit/redis-queue.test.ts` (TTL applied / not applied),
  `test/integration/queue-integration.test.ts` (depths through a real kernel `/health`).

### 3.3 Object metadata (X8-6)

- **Decision:** `IStorage.put(path, data, options?: PutObjectOptions)` where
  `PutObjectOptions = { readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>> }`,
  both in `common`. Optional third parameter, so every existing call is source-compatible (the
  `IRequest.signal?` / `IFileSystem.realPath?` precedent). The internal `StorageProvider.put` is
  widened identically. S3 sets `ContentType`/`Metadata` on `PutObjectCommand`; GCS passes
  `{ contentType, metadata }` to `file.save`; Azure passes
  `{ blobHTTPHeaders: { blobContentType }, metadata }` to `uploadData`.
- **Memory and local accept the options and do not persist them**, documented per provider in a
  README table beside the existing `getSignedUrl` semantics table. This is deliberate, not an
  omission: content type is a backend-side object attribute, and neither backend has a reader for it
  — `IStorage.get` returns bytes, `LocalStorageProvider.getSignedUrl` throws, and `MemoryProvider`'s
  synthetic URL is not fetchable — so retaining it would be a field no code path reads.
- **Test home:** `test/unit/s3-provider.test.ts`, `gcs-provider.test.ts`, `azure-provider.test.ts`
  each assert the translated call carries the content type; `test/unit/storage-service.test.ts`
  asserts pass-through and the omitted-options arm; `test/unit/memory-provider.test.ts` and
  `local-provider.test.ts` assert the documented accept-and-ignore.

### 3.4 The exit signal's shape (X8-7, mechanism)

- **Decision:** TWO optional members in `common`, each with a distinct reader:
  `IWorkerHandle.onExit?(listener: (code: number | null) => void): void` is the mechanism, and
  `IWorkerHost.reportsExit?(): boolean` is the capability query. `code` is `number | null` because
  Node reports a numeric exit code while a web `close` event may carry none.
- **Why two:** the mechanism lives on the handle, which only exists after a spawn, so nothing could
  answer "will this application detect a dead worker?" at `register()` time — and that question has
  two real readers: the `worker-pool` health indicator's payload and the register-time warning in
  §3.7. A single member would leave the plugin unable to say anything until the first task ran.
- **Test home:** `packages/common/test/unit/runtime-contracts.test.ts` (type-level), and the runtime
  and pool tests below.

### 3.5 Which runtimes report exit (X8-7, per-runtime)

- **Decision:** `createNodeWorkerHost` registers `worker.on('exit', …)` and reports
  `reportsExit() === true`. `createWebWorkerHost` gains a second parameter
  `options?: { readonly exitEventName?: string }`; **`bun-runtime.ts` passes `'close'`** and
  **`deno-runtime.ts` passes nothing**, so on Deno both `onExit` and `reportsExit` are OMITTED
  rather than present-and-silent.
- **Why omitted rather than a no-op:** P1 established that Deno's web `Worker` emits nothing on
  self-termination. A present `onExit` that never fires would let the pool conclude it has crash
  detection while the slot still leaks — precisely the failure M70h's `onSignal` widening refused
  when it declined to ship a no-op. Presence therefore means "this host can report an exit", and its
  absence is a fact the plugin surfaces rather than hides.
- **Why not switch Deno to the Node worker host:** P5 shows it would work, including with a `.ts`
  task module and the existing worker-side channel preference. It is nonetheless a wholesale change
  to the primary runtime's worker implementation — different permission inheritance, different
  startup cost, `self` undefined inside the worker — and belongs to a milestone that can verify all
  of that. Named in §9 with its evidence so it is a decision someone can take, not a rediscovery.
- **Test home:** `packages/runtime/test/unit/node-worker-host.test.ts` and `web-worker-host.test.ts`
  (injected fakes: listener registered, code forwarded, `reportsExit` true/false per parameter),
  plus `packages/runtime/test/integration/worker-exit-real.test.ts` — a REAL `node:worker_threads`
  worker under Deno whose module exits itself, proving the default host path rather than only the
  injected one.

### 3.6 What the pool does with an exit (X8-7, behaviour)

- **Decision:** `TaskPool.spawnSlot` registers `handle.onExit?.(…)`. An exit the pool did not ask
  for drops the slot, fails its in-flight task with a new exported `WorkerExitError` naming the
  specifier and the code, and re-pumps — the same disposition `onWorkerError` gives a crash, which
  is what makes C4's README promise true. A slot the pool terminated ON PURPOSE carries a
  `terminating` flag set before every `terminate()` call (`onTimeout` and `shutdown`), and its exit
  is ignored.
- **Correction, established by running the plan's own negative control.** This plan claimed the flag
  was load-bearing against a live defect. Removing it changes NO observable behaviour today:
  `shutdown()` drains `pending` before it terminates anything and `onTimeout` nulls the slot's task
  first, so the exit that follows finds nothing to settle. What the flag actually buys is that the
  invariant becomes LOCAL rather than spread across two other methods — probed, with the flag gone
  AND `shutdown()`'s drain moved after its `terminate()` calls, two queued tasks reject with
  `WorkerExitError` instead of the shutdown error, because each not-yet-ready slot's exit takes the
  startup-failure branch. It is kept on that basis and the code comment says so; the ordering it
  backs up is pinned by its own test.
- **Test home:** `test/unit/task-pool-exit.test.ts` — unexpected exit fails the in-flight task and
  frees the slot; a second task then runs on a fresh worker (this is X8-7's case D, the wedge);
  `taskTimeoutMs: 0` plus an exit still settles; a deliberate `terminate()` produces no extra settle
  and rejects no pending task.

### 3.7 Telling an application that exit detection is absent (X8-7, Deno)

- **Decision:** the `worker-pool` health indicator's payload gains `exitDetection: boolean`, read
  from `host.reportsExit?.() ?? false`; and when `taskTimeoutMs` resolves to `0` on a host that does
  not report exit, `register()` emits ONE `ctx.logger?.warn` naming the runtime, the option, and the
  consequence. It does **not** throw.
- **Why warn and not throw:** `taskTimeoutMs: 0` is documented, released behaviour and a legitimate
  choice for long CPU-bound work; refusing it would remove a capability on the primary runtime to
  fix an observability gap. A warning plus a health-payload field converts a silent permanent wedge
  into two signals an operator already watches, which is what the register asks for ("failing that,
  document that `0` also disables crash detection"). The warning is emitted once at `register()`,
  not per task, so it cannot become log noise.
- **Test home:** `test/unit/worker-pool-plugin.test.ts` — indicator field true/false; warning
  emitted for `0` on a non-reporting host and NOT emitted for `0` on a reporting host, nor for a
  non-zero timeout.

### 3.8 Local storage fails at startup, not at the first upload (X8-9)

- **Decision:** `LocalStorageProvider.connect()` probes writability — `mkdir(root, {recursive})`
  then write-then-delete of a probe key under the root — and on failure throws an error naming the
  root, the underlying cause, and, when `runtime.platform()` is `'deno'`, the `--allow-write` flag.
  `isHealthy()` reports the cached outcome alongside the existing `stat`, so a root that becomes
  unwritable later reads `down` instead of `up`.
- **Why a startup probe rather than a per-check write:** this package's own stated principle
  (`facades.ts:402`, cited by M52c and M52d) is to fail at `register()` with a name rather than at
  the first request with a bare error; and a write on every health-probe interval is recurring I/O
  for a fact that changes almost never (the M52 "a KV read per probe bills" reasoning).
- **The CLI's half:** `setu add storage` prints the `--allow-write` note, since M70h landed the
  command X8-9 said would be the right home for it. It does **not** silently add the flag to the
  generated task: `--allow-write` is only needed by the `local` provider, and `denoPermissions`' own
  contract is that the default stays least-privilege, so granting filesystem write to every project
  that installs an S3-backed capability would be a security regression to fix an ergonomics one.
- **Test home:** `test/unit/local-provider.test.ts` (throw names the flag on Deno, does not on other
  platforms, `isHealthy` false after an unwritable root), `packages/cli/test/unit/add.test.ts` (the
  note is printed for `storage` and not for an unrelated package).

### 3.9 Discriminating the storage options (X8-11)

- **Decision:** `StoragePluginOptions` becomes a union discriminated on `provider`, following
  `DatabasePluginOptions` (`packages/database-plugin/src/interfaces/index.ts:312`) exactly: the
  DEFAULT arm keeps `provider?: 'memory'` optional so an omitted provider still means memory, and
  every other arm requires its own literal. `S3ProviderOptions.bucket`, `GcsProviderOptions.bucket`
  and `AzureBlobProviderOptions.containerName` become compile-required under their arms.
  `StorageProviderOptions` is retained as the union of the per-provider option shapes, because it is
  a barrel export with real readers.
- **Why:** it is the register's stated fix, it matches three existing precedents (M30
  `ChannelConfig`, M50, M52c), and it deletes the five `options as XProviderOptions` casts in
  `createProvider` rather than adding surface. It is a **breaking change** to a released options
  type; §9's CHANGELOG entry carries the migration.
- **Test home:** `test/unit/storage-plugin.test.ts` plus a type-level fixture asserting that a
  literal carrying an unknown key is rejected **naming that key**, with `@ts-expect-error` on the
  bad arm and no error on the good one.

### 3.10 Recurrence gate for the broken README snippets (X8-8)

- **Decision:** a new `test/package-readme-fence-compiler.test.ts` running the EXISTING fence engine
  (`test/fixtures/snippets/fence-engine.ts`) over exactly the three package READMEs this milestone
  rewrites, with the same expected-inventory table the guide gate uses so a fence added later cannot
  slip through unclassified.
- **Why only three:** the engine over all 40+ package READMEs would surface a large pre-existing
  backlog that is M70n's docs sweep, and mixing it in here would bury this milestone's own changes.
  Three is the set this milestone is responsible for not breaking again.
- **Test home:** itself, plus a negative control in the same file's docstring: reintroducing
  `maxFileSize` must fail it.

### 3.11 Status codes on upload refusal

- **Decision:** the two size refusals become `413`; `maxFiles`, MIME-type and malformed-body
  refusals stay `400`.
- **Why:** 413 is what "too large" means on the wire, and the register names it. The other three are
  genuinely bad requests rather than oversized ones. This is a **behaviour change** to a released
  middleware and gets a CHANGELOG entry.
- **Test home:** `test/unit/upload-middleware.test.ts` asserts each status explicitly, and
  `test/integration/upload-error-passthrough.test.ts` asserts the body still carries the configured
  Problem Details format at the new status (M70f's responder is status-agnostic, and this proves
  it).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                               | Kind  | Consumer / real code path that READS it                                                                                                         |
| --------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PutObjectOptions` (`common`)                 | type  | `IStorage.put`'s third parameter; read by `StorageService.put` and all five providers; named in the storage README and `PUBLIC_API.md`.         |
| `ProcessOptions.onFailed?` (`common`, field)  | field | `QueueService.process` stores it; `runJob` invokes it on the dead-letter path. Asserted by §6's failure-surface test.                           |
| `IWorkerHandle.onExit?` (`common`, field)     | field | Registered by `TaskPool.spawnSlot`; implemented by `createNodeWorkerHost` and by `createWebWorkerHost` when given `exitEventName`.              |
| `IWorkerHost.reportsExit?` (`common`, field)  | field | Read by `WorkerPoolPlugin.register` (health payload + warning) and by `WorkerPoolService` when resolving the warning condition.                 |
| `WorkerExitError`                             | class | Thrown into the caller's promise by `TaskPool` on an unexpected exit; `instanceof`-checkable by an application, like the four sibling errors.   |
| `IS3Backend` (renamed from `IAwsS3Client`)    | type  | `S3ProviderOptions.client`, `adaptAwsS3Module`'s return type, `S3Provider`'s field. Same readers as before — this is a rename, not new surface. |
| `StoragePluginOptions` (reshaped)             | type  | `StoragePlugin` factory parameter; `createProvider` now narrows on it instead of casting.                                                       |
| `MemoryStorageOptions` / per-arm option types | types | Members of the reshaped union; each is the `options` type of exactly one arm and is read by that arm of `createProvider`.                       |

No symbol is removed from a barrel except `IAwsS3Client`, which is renamed (§9 prerelease rule:
deleted rather than aliased, with a CHANGELOG migration line).

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                            | Behavior (per implementation)                                                                                                               |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `UploadMiddlewareOptions.maxBodyBytes?` | `createUploadMiddleware`            | Hard ceiling on the buffered body considered for parsing; default 50 MB. The effective bound is `min(maxSize * 2 + framing, maxBodyBytes)`. |
| `PutObjectOptions.contentType?`         | S3 / GCS / Azure providers          | Set on the stored object. Memory and local accept and do not persist (documented).                                                          |
| `PutObjectOptions.metadata?`            | S3 / GCS / Azure providers          | Set as user metadata. Memory and local accept and do not persist (documented).                                                              |
| `ProcessOptions.onFailed?`              | `QueueService.process` → `runJob`   | Invoked once after the final attempt, before `deadLetter`. A throwing callback is caught and reported, never allowed to abort the settle.   |
| `QueuePluginOptions.deadLetterTtlMs?`   | `RedisQueue.deadLetter`             | Redis: `expire` on the jobs hash entry. Memory: the dead entry is dropped after the TTL. RabbitMQ/SQS: not applicable (documented).         |
| `createWebWorkerHost` `exitEventName?`  | `bun-runtime.ts` (passes `'close'`) | When given, `onExit` is implemented and `reportsExit()` is `true`. When omitted (Deno), both are absent.                                    |
| `StoragePluginOptions.provider` (arms)  | `createProvider`                    | Selects the arm AND its `options` type; a wrong key is now reported by name.                                                                |

## 5. Implementation files

| File                                                                             | Purpose                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/common/src/services/storage.ts`                                        | `PutObjectOptions`; `IStorage.put` third parameter.                                            |
| `packages/common/src/services/queue.ts`                                          | `ProcessOptions.onFailed?`.                                                                    |
| `packages/common/src/runtime.ts`                                                 | `IWorkerHandle.onExit?`, `IWorkerHost.reportsExit?`.                                           |
| `packages/common/src/index.ts`                                                   | Barrel: `PutObjectOptions`.                                                                    |
| `packages/runtime/src/adapters/node/node-worker-host.ts`                         | `'exit'` listener; `NodeWorkerLike.on` union widened; `reportsExit`.                           |
| `packages/runtime/src/adapters/shared/web-worker-host.ts`                        | `exitEventName` parameter; conditional `onExit`/`reportsExit`.                                 |
| `packages/runtime/src/adapters/bun/bun-runtime.ts`                               | Passes `'close'`.                                                                              |
| `packages/runtime/src/adapters/deno/deno-runtime.ts`                             | Comment recording WHY it passes nothing (P1), so it is not "fixed" later by accident.          |
| `packages/storage-plugin/src/middleware/upload-middleware.ts`                    | Real cap, 413, `maxBodyBytes` option.                                                          |
| `packages/storage-plugin/src/interfaces/index.ts`                                | Discriminated `StoragePluginOptions`; `IS3Backend` rename; `put` options on `StorageProvider`. |
| `packages/storage-plugin/src/services/storage-service.ts`                        | `put` pass-through.                                                                            |
| `packages/storage-plugin/src/providers/{memory,local,s3,gcs,azure}-provider.ts`  | `put` options; local writability probe.                                                        |
| `packages/storage-plugin/src/plugin/storage-plugin.ts`                           | `createProvider` narrows instead of casting.                                                   |
| `packages/storage-plugin/src/index.ts`                                           | Barrel: `IS3Backend` replaces `IAwsS3Client`; new arm option types.                            |
| `packages/queue-plugin/src/services/queue-service.ts`                            | `onFailed` storage; metrics; depth in the health indicator.                                    |
| `packages/queue-plugin/src/processors/job-processor.ts`                          | `onFailed` invocation, guarded.                                                                |
| `packages/queue-plugin/src/metrics/{metric-names,queue-collector}.ts`            | New, internal — the M45b collector shape.                                                      |
| `packages/queue-plugin/src/plugin/queue-plugin.ts`                               | Optional `CAPABILITIES.METRICS`; `deadLetterTtlMs`.                                            |
| `packages/queue-plugin/src/adapters/{queue-adapter,memory-queue,redis-queue}.ts` | `stats?`; TTL on the retained payload.                                                         |
| `packages/queue-plugin/src/interfaces/index.ts`                                  | `IRedisQueueClient.expire?`/`zcard?`; `QueuePluginOptions.deadLetterTtlMs`.                    |
| `packages/worker-pool-plugin/src/pool/task-pool.ts`                              | `onExit` registration, `terminating` guard, exit disposition.                                  |
| `packages/worker-pool-plugin/src/errors.ts`                                      | `WorkerExitError`.                                                                             |
| `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts`                   | `exitDetection` in the health payload; the `taskTimeoutMs: 0` warning.                         |
| `packages/worker-pool-plugin/src/index.ts`                                       | Barrel: `WorkerExitError`.                                                                     |
| `packages/cli/src/commands/add.ts`                                               | The `--allow-write` note for `storage`.                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                            | src covered                                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage-plugin/test/unit/upload-middleware.test.ts`                 | `middleware/upload-middleware.ts`                          | The register's three-row matrix, asserting STATUS and `title` per row; `maxBodyBytes` honoured as a cap for `maxSize > 25 MB`; 413 vs 400 per refusal kind. Calls `createUploadMiddleware({ maxSize, maxBodyBytes })`.                        |
| `storage-plugin/test/integration/upload-error-passthrough.test.ts`   | same, through a kernel app                                 | A 413 still carries the configured `rfc9457` body (M70f responder is status-agnostic).                                                                                                                                                        |
| `storage-plugin/test/unit/storage-service.test.ts`                   | `services/storage-service.ts`                              | `put(path, data)` and `put(path, data, { contentType })` both reach the provider with the third argument forwarded verbatim / omitted.                                                                                                        |
| `storage-plugin/test/unit/{s3,gcs,azure}-provider.test.ts`           | those providers                                            | The translated SDK call carries `ContentType`/`contentType`/`blobHTTPHeaders.blobContentType` and the metadata map; omitted options produce a call with neither.                                                                              |
| `storage-plugin/test/unit/{memory,local}-provider.test.ts`           | those providers                                            | Options accepted and not persisted (documented behaviour, asserted so it cannot drift); local `connect()` throws naming `--allow-write` on Deno; `isHealthy()` false when the root is unwritable.                                             |
| `storage-plugin/test/unit/storage-plugin.test.ts`                    | `plugin/storage-plugin.ts`                                 | Every arm constructs its provider with no cast; the default arm still resolves memory.                                                                                                                                                        |
| `storage-plugin/test/unit/options-typing.test.ts` (new)              | `interfaces/index.ts` (type-level)                         | `@ts-expect-error` on an arm carrying an unknown key; the same literal without it compiles; a missing `bucket` under `provider: 's3'` is an error.                                                                                            |
| `storage-plugin/test/unit/barrel-exports.test.ts`                    | `src/index.ts`                                             | `IS3Backend` exported, `IAwsS3Client` gone, new arm types present.                                                                                                                                                                            |
| `queue-plugin/test/unit/queue-service-failure-surface.test.ts` (new) | `services/queue-service.ts`, `processors/job-processor.ts` | `onFailed` fires exactly once at the final attempt and not on retries; a throwing `onFailed` is reported and the dead-letter still happens. Calls `queue.process(name, fn, { onFailed })`.                                                    |
| `queue-plugin/test/unit/queue-metrics.test.ts` (new)                 | `metrics/*`                                                | One increment per outcome; a throwing instrument cannot break the settle (the M45b isolation case).                                                                                                                                           |
| `queue-plugin/test/unit/redis-queue.test.ts`                         | `adapters/redis-queue.ts`                                  | `expire` called with the configured TTL and NOT called when unset; `stats()` reads `zcard` for all three sets.                                                                                                                                |
| `queue-plugin/test/unit/memory-queue.test.ts`                        | `adapters/memory-queue.ts`                                 | `stats()` counts; TTL drops the dead entry.                                                                                                                                                                                                   |
| `queue-plugin/test/integration/queue-integration.test.ts`            | plugin + service                                           | `/health` carries the depths for memory; the payload OMITS them for an adapter without `stats`.                                                                                                                                               |
| `queue-plugin/test/integration/outage-real.test.ts`                  | redis path                                                 | Existing guarded real-Redis suite extended with a real dead-letter TTL round trip.                                                                                                                                                            |
| `common/test/unit/*`                                                 | `runtime.ts`, `services/{storage,queue}.ts`                | Type-level: a handle without `onExit` and one with both satisfy `IWorkerHandle`; `put` arity 2 and 3 both type-check.                                                                                                                         |
| `runtime/test/unit/node-worker-host.test.ts`                         | `adapters/node/node-worker-host.ts`                        | `'exit'` registered on the injected fake and the code forwarded; `reportsExit()` true. Widened `NodeWorkerLike.on` union.                                                                                                                     |
| `runtime/test/unit/web-worker-host.test.ts`                          | `adapters/shared/web-worker-host.ts`                       | With `exitEventName: 'close'` the listener is attached and `reportsExit()` is true; without it BOTH members are absent (`'onExit' in handle === false`).                                                                                      |
| `runtime/test/integration/worker-exit-real.test.ts` (new)            | the DEFAULT node host path                                 | A real `node:worker_threads` worker under Deno exits itself and the host observes it — the guarded REAL path, not an injected fake (P2).                                                                                                      |
| `worker-pool-plugin/test/unit/task-pool-exit.test.ts` (new)          | `pool/task-pool.ts`                                        | Unexpected exit fails the in-flight task with `WorkerExitError` and frees the slot; a following task runs (X8-7 case D); `taskTimeoutMs: 0` still settles; a deliberate `terminate()` settles nothing extra and rejects no pending task (P4). |
| `worker-pool-plugin/test/unit/worker-pool-plugin.test.ts`            | `plugin/worker-pool-plugin.ts`                             | `exitDetection` true/false; the warning fires only for `0` on a non-reporting host.                                                                                                                                                           |
| `worker-pool-plugin/test/e2e/real-worker.test.ts`                    | the whole path                                             | Extended: a real self-terminating worker under the NODE host settles its task without a timeout.                                                                                                                                              |
| `cli/test/unit/add.test.ts`                                          | `commands/add.ts`                                          | The `--allow-write` note printed for `storage`, absent for another package.                                                                                                                                                                   |
| `test/package-readme-fence-compiler.test.ts` (new, root)             | the three rewritten READMEs                                | Every `@setu-ts/` fence compiles; inventory table pins the fence counts.                                                                                                                                                                      |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70k-storage-queue-worker-operability, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree — three packages change their exported surface
deno task release:verify 0.1.0-alpha.8
```

## 8. Risks & mitigations

- **The `IStorage.put` widening is breaking for IMPLEMENTORS**, not callers — an existing custom
  `IStorage` still satisfies the interface because the parameter is optional, but a class that
  DECLARES `put(path, data)` remains assignable while silently ignoring the third argument.
  Mitigation: the CHANGELOG entry states this explicitly, and the in-repo implementors
  (`StorageService`, `cloudflare-plugin`'s `R2Storage`) are both updated in this PR — verified by
  `deno task check`, not assumed.
- **`StoragePluginOptions` becoming a union will break real call sites**, including any that pass a
  bare `options` object without `provider`. Mitigation: the default arm keeps `provider` optional
  (the `DatabasePluginOptions` precedent), so only genuinely-mismatched configurations break; the
  starters and CLI templates are re-checked by the existing scaffold e2e.
- **Deno cannot detect a self-terminated worker at all** (P1), so X8-7 is closed on Node and Bun and
  DOCUMENTED on Deno. Mitigation: the health-payload field and the register-time warning make the
  gap visible rather than silent; §9 records P5's evidence for the milestone that may close it.
- **Bun's `close` fires after a deliberate `terminate()`** (P4), so a naive exit handler would make
  every timeout and every shutdown report a crash. Mitigation: the `terminating` flag, with a test
  that fails without it.
- **Queue metrics could double-count** if written from both the runner and the service. Mitigation:
  every counter is incremented at exactly one site (the M45b rule), and a test asserts the counter
  summed over `outcome` equals the number of settled jobs.
- **CI runs on Deno only**, so the Bun `close` path has no in-repo runtime test. Mitigation: the
  branching is unit-tested through the injected-globals seam (the repo's standard technique for an
  unreachable platform branch), the real behaviour is recorded as P3/P4 with the probe that produced
  it, and the compat suite exercises Bun.

## 9. Out of scope

- **A streaming request body.** `IRequest` has no stream member and the HTTP adapter buffers before
  any middleware runs (§1), so an upload cannot avoid being read. Closing that is a
  `common`/`kernel`/`runtime` widening owned by no milestone yet; this plan records the boundary
  rather than implying the bound is something it is not.
- **Switching Deno's worker host to `node:worker_threads`.** P5 proves it would work and would give
  Deno real exit detection; it is a wholesale change to the primary runtime's worker implementation
  and needs its own verification of permissions, startup cost and the `self`-undefined difference.
- **Depth reporting for the RabbitMQ and SQS adapters.** Both need a management API or
  `GetQueueAttributes` call with its own cost and permission story; the health payload omits the
  field rather than reporting a fake `0` (§3.2).
- **A `sdkClient` option taking a real `@aws-sdk/client-s3` `S3Client`.** X8-10's second suggested
  fix; this milestone takes the first (rename + correct the docs), because the second adds a second
  configuration path to the same provider and wants its own design.
- **Extending the doc-fence gate to all package READMEs.** M70n's docs sweep; §3.10 gates the three
  READMEs this milestone rewrites.
- **`IQueue.getJob` / a dead-letter accessor on the committed contract.** X8-4's surfaces here are
  the callback, the metrics and the health payload; a read API over dead letters is a contract
  addition with no named consumer yet.
