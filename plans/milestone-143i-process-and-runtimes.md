# Milestone 143i — What the Process Says, and What Differs Between Runtimes (`@setu-ts/kernel`, `@setu-ts/runtime`, `@setu-ts/common`, `@setu-ts/logger-plugin`)

> **Status:** Planning. Branch: `feat/m143i-process-and-runtimes`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

The Core lane's only letter of the `v0.13.0` smoke closeout (ROADMAP "Milestone 143i"). A process
that crashes, is stopped or is cut off leaves a structured log line; the shutdown drain is one
setting and waits for what is really in flight; a stop during start cancels the start; a draining
member tells HTTP/2 clients to go elsewhere; `HEAD` works on every `GET` route; the four places
where Node, Bun, Deno and workerd behave differently (a refused upgrade, a WebSocket size limit, an
idle stream, a failed response stream) behave the same, or the difference is said at startup; and on
workerd a client that leaves mid-response still runs its `ctx.defer` cleanup.

- **In scope:** the kernel, runtime (all but `src/adapters/workers`), common and logger-plugin
  halves of V13-11, V13-12, V13-13, V13-23, V13-26, V13-41, V13-42, V13-43, V13-53, V13-113,
  V13-200, V13-223, V13-256, plus the logger-plugin half of V13-110 (owned by M143j).
  `health-plugin` belongs to the lane but no row needs it.
- **NOT this milestone:** every template line in `packages/cli` (M143j — §9 lists the exact change
  per row); the `grpc-plugin` retry of a draining peer's 503 (M143c); the
  `realtime-backplane-plugin` close-hook order and abort handling (M143m); `websocket-plugin`
  reporting its limit and the Workers adapter's ceiling and `waitUntil` handover (M143o); any change
  to `react-router-plugin` (M143l — §3.10 makes its V13-113 half unnecessary, to be confirmed by
  that letter); prose in `docs/` outside the shared files (M143n).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeSignal`                            | `packages/common/src/runtime.ts:40`                                                                | `'SIGTERM' \| 'SIGINT'`; the JSDoc above it gives the reason for the narrow set.                                                                                                                                                                                                                   |
| `IRuntimeServices.onSignal?`               | `packages/common/src/runtime.ts:452`                                                               | Optional; absent on Workers and on Deno for Windows (`deno-runtime.ts:214-227`). Node `proc.on` (`node-runtime.ts:153`), Bun `proc.on` (`bun-runtime.ts:286`), Deno `addSignalListener` (`deno-runtime.ts:225`). No handler-removal member and no uncaught-error member exist.                     |
| `IHttpAdapter`                             | `packages/common/src/runtime.ts:468-521`                                                           | `setHandler`, `fetch`, `listen`, `close`, optional `setUpgradeRouter`. No drain or limit member.                                                                                                                                                                                                   |
| `StartOptions`                             | `packages/common/src/plugin.ts:422-427`                                                            | `port?`, `hostname?` only.                                                                                                                                                                                                                                                                         |
| `IPluginContext`                           | `packages/common/src/plugin.ts:521`                                                                | No abort signal. `packages/testing` only RECEIVES contexts (`mock-plugin.ts:70`, `override-provider.ts:141`), never builds one, so an optional member breaks no implementor.                                                                                                                       |
| `IRequestContext.signal`                   | `packages/common/src/http.ts:427`; `packages/kernel/src/context/request-context.ts:153`            | `request.signal ?? new AbortController().signal` — the raw request's signal when the adapter supplies one.                                                                                                                                                                                         |
| `upgradeIntentOf` / `setUpgradeIntent`     | `packages/common/src/http.ts:702-716`                                                              | Exported from common; the kernel brands the `IRequest` in `#tryUpgrade` (`application.ts:2060`) before the pipeline's `next()` returns to outer middleware.                                                                                                                                        |
| `ILogger.fatal`                            | `packages/common/src/services/logger.ts:38`                                                        | Exists.                                                                                                                                                                                                                                                                                            |
| `WebSocketEventSink.maxMessageBytes`       | `packages/common/src/services/websocket.ts:88`                                                     | Per-sink; `0` unlimited; Node passes it to `ws` as `maxPayload` (`node-ws-upgrader.ts:419-425`). `IWebSocketService` exposes no limit (`websocket.ts:424-494`).                                                                                                                                    |
| Kernel shutdown                            | `packages/kernel/src/application/application.ts:837-931`                                           | `stop()` no-ops only when `!#started`; `#started` is set true at the top of `start()` (`:544`), so a `stop()` during start runs the whole shutdown concurrently with startup. Drain: `#drainRequests` `:2612-2629`, `hrtime() + 10_000`, `MAX_POLLS = 200`. No stop or drain log line.             |
| Drain accounting of streams                | `application.ts:1886-1922`                                                                         | With no `ctx.defer` cleanup a streamed body releases `#inFlight` at settle time, before the body is read (`:1894-1898`); only bodies with cleanups go through `wrapDeferredStream`. So the drain does not wait for a server stream.                                                                |
| `wrapDeferredStream`                       | `packages/kernel/src/context/deferred.ts:90-134`                                                   | Runs cleanups on end, error, or consumer `cancel()` — never on the request signal.                                                                                                                                                                                                                 |
| Drain 503                                  | `application.ts:1084-1102`                                                                         | Pre-pipeline problem 503 while `#stopping`.                                                                                                                                                                                                                                                        |
| Listening log                              | `application.ts:2549-2564`                                                                         | `logger.info('Server listening', …)`; silent without a logger.                                                                                                                                                                                                                                     |
| HTTP/2 session close                       | `packages/runtime/src/adapters/node/node-http2-listener.ts:98-120`; `node-http-adapter.ts:263-272` | `trackHttp2Sessions` returns a closer that calls `session.close()` (GOAWAY, in-flight streams finish); the adapter calls it only inside `server.close()`, i.e. after the drain.                                                                                                                    |
| Router                                     | `packages/kernel/src/router/router.ts:444-467`, `:507-600`                                         | `get` registers `GET` only; `match(method, path)` asks Hono for that method alone, then ranks candidates.                                                                                                                                                                                          |
| Node refused upgrade                       | `packages/runtime/src/adapters/node/node-http-adapter.ts:536-542`; `node-ws-upgrader.ts:451-462`   | Writes `HTTP/1.1 <status> <reason>` with `Bad Request` for every status but 500/501/503, `Connection: close`, no body, no headers.                                                                                                                                                                 |
| node-server response error                 | `node_modules/.pnpm/@hono+node-server@2.1.8_hono@4.13.18/…/dist/index.mjs:885-897`, `:786-788`     | `handleResponseError` calls `console.error(e)` unconditionally (no option reaches it); a body stream error reaches it via `writable.destroy(error)`. `writable.on('close', cancel)` cancels the reader cleanly (`:779`).                                                                           |
| Bun serve                                  | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:204-232`, `:328-339`                        | `fetch(request, server)` callback; `websocket` handlers with no `maxPayloadLength`; no `idleTimeout` and no per-request `server.timeout`.                                                                                                                                                          |
| Request logger                             | `packages/logger-plugin/src/middleware/request-logger.ts:83-114`, `:169-171`                       | Reads `ctx.response.snapshot().status` after `next()`; ignores `ctx.signal` and the upgrade brand.                                                                                                                                                                                                 |
| Generated entry signals                    | `packages/cli/src/templates/project-files.ts:795-833`; `full-stack-build-files.ts:480`             | Loops over `['SIGTERM', 'SIGINT']`; no uncaught handler. (Read for §9 only; not edited.)                                                                                                                                                                                                           |
| Measured on `develop` (`d2ec1aef1`, built) | `.claude/repro/repro1.mjs`, `repro2.mjs` (scratch, uncommitted)                                    | `HEAD /x` → 404 on Node and Deno; a failing response stream prints a raw trace on Node, Bun and Deno with the response already 200; Node's refused upgrade is `401 Bad Request` with no body while Bun and Deno send the 401 JSON body; the request log says `200` for a 101 upgrade on all three. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                    | Resolution (picked side)                                                                                   | Doc deliverable (same PR)                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C1  | `IRequestContext.defer` JSDoc (`common/src/http.ts:382-399`) promises cleanup on stream end, error or cancellation; on workerd a client leaving triggers none of the three. | The code is brought up to the contract (§3.12); the JSDoc gains "or the request's signal aborting".        | `common/src/http.ts` JSDoc; `PUBLIC_API.md` defer paragraph.                                         |
| C2  | grpc-plugin README "a server shutting down refuses a call already on the wire" vs the kernel answering 503 for the drain and closing sessions after it.                     | The kernel sends GOAWAY at drain start (§3.6); the README stays, the remaining 503 window is M143c's half. | None in this lane (grpc-plugin README belongs to M143c; §9 names the sentence).                      |
| C3  | `RuntimeSignal` JSDoc says the two signals are "the only two every non-edge runtime can register for"; SIGHUP is registrable on Node, Bun and Deno-on-POSIX.                | Widen to SIGHUP with the reason written down (§3.2).                                                       | `common/src/runtime.ts` JSDoc; `PUBLIC_API.md`; `docs/deployment.md` shutdown block is M143n's (§9). |

## 3. Design decisions

### 3.1 Uncaught exceptions and unhandled rejections (V13-11)

- **Decision:** `IRuntimeServices` gains an optional
  `onFatalError?(handler: (error: unknown, origin: FatalErrorOrigin) => void): () => void`, with
  `type FatalErrorOrigin = 'uncaughtException' | 'unhandledRejection'` in common. It OBSERVES only:
  the process still dies exactly as before (same exit code, the runtime's own trace still on
  stderr). It returns an unsubscribe function. Implementations: Node
  `process.on('uncaughtExceptionMonitor', …)` (under Node's default `--unhandled-rejections=throw`
  an unhandled rejection arrives there with origin `'unhandledRejection'`); Deno
  `globalThis.addEventListener('error' | 'unhandledrejection')` without `preventDefault()`; Bun
  `uncaughtExceptionMonitor` for thrown errors (measured on Bun 1.4.5: it fires, the process still
  exits 1 with its trace) — but Bun never routes a rejection there, and a Bun `unhandledRejection`
  listener SUPPRESSES the crash (measured: the process lived and exited 0). So for rejections the
  Bun adapter adds an `unhandledRejection` listener that calls the handlers and then, when it is the
  only `unhandledRejection` listener, rethrows the reason so Bun crashes as it would have; when the
  application has its own listener the rethrow is skipped (the application chose not to crash). The
  Bun e2e arm proves exit code 1 and a trace on stderr; the JSDoc states the Bun mechanism. Workers
  omits it (an isolate's exceptions are per request). Each adapter installs ONE process-level
  listener per mechanism lazily, on the first subscription, keeps the handlers in a set, and removes
  the process listener when the set empties, so a test suite that starts many applications does not
  pile listeners onto `process`. The kernel subscribes at the start of `#runStartup` once the
  runtime resolves and unsubscribes at the end of `stop()` and after a failed start. Its handler
  resolves the logger at fire time and writes
  `logger.fatal('Process failed', { origin, error: describeError(error) })`; with no logger it does
  nothing (the runtime's trace is still printed). A throwing logger is swallowed.
- **Why:** an observer keeps the documented decision that the framework does not take over process
  behaviour (`docs/deployment.md` "Graceful shutdown"), while the JSON pipeline finally sees why the
  process ended. The kernel owns the logger, so the line goes through the same redaction as every
  other line.
- **Test home:** `runtime/test/unit/fatal-error-observer.test.ts` (per-runtime wiring through
  injected hosts); `kernel/test/unit/fatal-error-log.test.ts` (subscribe/unsubscribe, log shape);
  `runtime/test/e2e/fatal-error-process.test.ts` — a real child process on Node (and Bun/Deno where
  installed, guarded) that throws and that rejects: stdout carries the `fatal` JSON line, exit code
  and stderr trace match a control without the app.

### 3.2 SIGHUP (V13-12)

- **Decision:** `RuntimeSignal` becomes `'SIGTERM' | 'SIGINT' | 'SIGHUP'`. Node, Bun and Deno
  (POSIX) already pass the name through to their native call, so each adapter's `onSignal` accepts
  it unchanged; the JSDoc names SIGHUP as the signal a closed terminal or lost session sends. The
  kernel still installs no handler (the documented decision stays). The template half (adding
  `'SIGHUP'` to the generated loops) is M143j's.
- **Why:** the row's remaining half is the type; the kernel-handler half was withdrawn in the
  2026-11-20 audit and stays withdrawn.
- **Test home:** `runtime/test/unit/signals.test.ts` — each adapter forwards `'SIGHUP'` to its host;
  a guarded e2e on Node sends SIGHUP to a child that registered through `onSignal` and observes the
  handler run.

### 3.3 Stop and drain log lines (V13-13)

- **Decision:** with a logger registered the kernel logs, at `info`: `'Server stopping'` when
  `stop()` begins (before `onStopping` hooks, with `{ inFlight }`), `'Shutdown drain finished'` when
  the drain ends (`{ durationMs, remaining, timedOut }`, `remaining` being requests still in flight;
  `warn` instead of `info` when `timedOut`), and `'Server stopped'` after the close hooks (with
  `{ durationMs }`), including when a hook failed (then `warn` with `{ error }` before the rethrow).
  No logger: silent, as for `'Server listening'`. A throwing logger never changes the shutdown.
- **Why:** a log that ends after startup must tell a clean stop from a kill.
- **Test home:** `kernel/test/unit/shutdown-log.test.ts`.

### 3.4 The drain bound is one setting (V13-26)

- **Decision:** `StartOptions.drainTimeoutMs?: number` (common). Default stays `10_000`. Validated
  in `start()` before any plugin registers: a finite number from 0 to 2,147,483,647, else a
  `TypeError` naming the option. `#drainRequests` reads it; the poll cap becomes
  `Math.ceil(drainTimeoutMs / 50) + 1` so a manual clock still cannot spin forever. `0` means "do
  not wait". An application started without `listen` (Workers) accepts it and the bound still
  applies to `stop()`.
- **Why:** `StartOptions` is reachable from every entry, including starters and the generated
  entries, without touching `createApplication`'s options, which the starters build themselves.
- **Test home:** `kernel/test/unit/shutdown-drain.test.ts` — a request held 15 s survives a stop
  with `drainTimeoutMs: 20_000` on a manual clock and is cut at 10 s by default; an invalid value is
  refused before registration.

### 3.5 The drain waits for streamed bodies (V13-23, server-stream half)

- **Decision:** every streamed body holds its request in `#inFlight` until it ends, errors or is
  cancelled — not only bodies with `ctx.defer` cleanups. `#settleRequest` routes a streamed body
  with no cleanups through `wrapDeferredStream(body, [], …, complete)` like the rest. An open SSE
  stream therefore holds the drain until the stream ends or the bound passes; the drain-finished
  line (§3.3) reports it as `remaining`.
- **Why:** a gRPC server stream in flight at shutdown was cut with CANCEL because the drain had
  already released it. "Drain" means in-flight responses finish.
- **Test home:** `kernel/test/unit/shutdown-drain.test.ts` — a streamed body with no `defer` keeps
  `stop()` waiting until the stream closes.

### 3.6 GOAWAY at drain start (V13-23, kernel half)

- **Decision:** `IHttpAdapter` gains an optional `beginDrain?(handle: ServerHandle): void`. The
  kernel calls it (when a server handle exists and the adapter has it) in the same synchronous turn
  that sets `#stopping`, after the `onStopping` hooks. Node: closes every tracked HTTP/2 session
  gracefully (`session.close()`: GOAWAY, streams in flight continue) on both the TLS and cleartext
  listeners, and calls `closeIdleConnections()` on the HTTP/1.1 server where the server has it; the
  later `close()` is unchanged. Bun: the same for whichever HTTP/2 listener M139b gave it, measured;
  Deno: `Deno.serve` exposes no session control, so Deno omits the member and its JSDoc says so. A
  throw from `beginDrain` is caught and logged at `warn`; it never stops the shutdown.
- **Why:** after GOAWAY a conforming client opens new streams on another connection, and a stream it
  opened past the last-stream-id is refused without being processed — the retryable case
  `grpcClient` already handles. The 503 the kernel still answers for a stream that raced the GOAWAY
  is M143c's half (retry an HTTP 503 from a draining peer that carries no `grpc-status`).
- **Test home:** `runtime/test/integration/node-drain-goaway.test.ts` — a real `node:http2` client
  on a session opened before stop receives GOAWAY at drain start, its in-flight stream completes,
  and a stream opened after GOAWAY is refused (`NGHTTP2_REFUSED_STREAM` or the GOAWAY session
  error); `kernel/test/unit/shutdown-drain.test.ts` — the kernel calls `beginDrain` once, after
  stopping hooks, and survives a throwing one.

### 3.7 A stop during start cancels the start (V13-43, kernel half)

- **Decision:** `start()` owns an `AbortController`; `IPluginContext` gains an optional
  `readonly signal?: AbortSignal` that the kernel always sets and aborts when `stop()` is called
  before `start()` finishes. While starting, `stop()` does NOT run the shutdown sequence: it aborts
  the signal and returns a promise that settles when `start()` has unwound. Every awaited startup
  step (`register()` promises, `runInit`, `runBootstrap`, `adapter.listen`) is raced against the
  signal, so a hook that never settles cannot hold the stop. On abort `start()` rejects with
  `StartCancelledError` (new, exported from `@setu-ts/kernel`,
  `message: 'start() was cancelled by stop()'`), its existing catch runs the close hooks, a server
  bound by a `listen` that resolved after the abort is closed, and nothing listens later even if a
  hook resolves afterwards. The kernel logs `'Startup cancelled'` at `warn` when a logger is
  registered. `stop()` resolves (it does not reject with the cancellation). A second `stop()`
  returns the same promise.
- **Why:** the sockets leaked because the shutdown ran before the backplane registered its close
  hook and startup then carried on to `listen`. The plugin half (register the close hook before
  connecting, honour `ctx.signal`) is M143m's.
- **Test home:** `kernel/test/unit/start-cancel.test.ts` — a plugin whose `onInit` never resolves:
  `stop()` resolves, `start()` rejects with `StartCancelledError`, the plugin's `onClose` ran,
  `ctx.signal.aborted` is true, and when the hook later resolves no `listen` happens (fake adapter
  records calls); 20 cycles leave no listener on a fake adapter.

### 3.8 Node answers a refused upgrade with the framework response (V13-53)

- **Decision:** `rejectRawUpgrade` is replaced, for the "no intent" path, by a writer of the
  framework response's snapshot onto the raw socket:
  `HTTP/1.1 <status> <node:http STATUS_CODES reason>`, every snapshot header, `content-length` of
  the buffered body, `connection: close`, then the body; a streamed body is cancelled and sent as
  `content-length: 0`. The fixed-status paths (no handler, handshake failure) keep an empty body but
  take their reason phrase from the same `STATUS_CODES` table.
- **Why:** Bun and Deno already send the framework's response; Node's raw socket path dropped it.
- **Test home:** `runtime/test/unit/node-ws-upgrader.test.ts` (writer bytes);
  `runtime/test/integration/refused-upgrade-parity.test.ts` — a middleware 401 with a JSON body on a
  raw upgrade request: same status line reason, content type and body on Node as on Bun and Deno
  (Bun/Deno arms guarded on the binary).

### 3.9 The request log records 101 for an upgrade and the client leaving (V13-223, V13-110 half)

- **Decision:** after `next()`, the request logger's status is: `101` when
  `upgradeIntentOf(ctx.request)` is set; else, when `ctx.signal.aborted`, `499` with `aborted: true`
  added to the line; else the error-predicted or snapshot status as today. The message stays
  `'request completed'`.
- **Why:** the wire said 101; a client that left received nothing and must not page a 5xx alert. 499
  is the established "client closed request" code in access logs.
- **Test home:** `logger-plugin/test/unit/request-logger.test.ts`.

### 3.10 Implicit `HEAD` on every `GET` route (V13-113)

- **Decision:** `Router.match('HEAD', path)` collects the `HEAD` candidates and the `GET` candidates
  and ranks them together with the existing ranking; at equal rank an explicit `HEAD` route wins. A
  `GET` definition served for `HEAD` runs its full middleware and handler. For every `HEAD` request
  the kernel drops the response body in `#settleRequest` (a buffered body becomes `null` with its
  headers kept; a streamed body is cancelled so its producer and its cleanups run), so an explicit
  `HEAD` handler that writes a body is also served without one. Applies to `inject()` and
  `dispatch()` too. The explicit `router.head()` keeps working.
- **Why:** RFC 9110 §9.1. Ranking together means a specific `GET /assets/*` beats a catch-all
  `HEAD /*`, so react-router's asset and public-file routes answer `HEAD` with no change in that
  plugin.
- **Test home:** `kernel/test/unit/router-head.test.ts`;
  `kernel/test/integration/head-requests.test.ts` (inject: status, headers and empty body; a
  streamed GET under HEAD runs its `defer`).

### 3.11 WebSocket size limits across runtimes (V13-41)

- **Decision:** `IHttpAdapter` gains an optional `readonly webSocketMaxMessageBytes?: number` — the
  runtime's own per-message ceiling: Bun `16 * 1024 * 1024`, passed explicitly as Bun's
  `maxPayloadLength` so the number is the adapter's and not a hidden default; Deno
  `64 * 1024 * 1024`; Node absent (no ceiling). `IWebSocketService` gains an optional
  `readonly maxMessageBytes?: number`. At startup, after bootstrap and before listen, when both are
  present and the service's limit is `0` or larger than the ceiling, the kernel logs one `warn`:
  `'WebSocket message limit exceeds the runtime ceiling'` with `{ configured, ceiling, platform }`.
  The ceiling is not raised: a global raise on Bun would let any socket send frames up to it while
  the plugin checks its own limit only after receipt.
- **Why:** the plugin cannot know the runtime's ceiling and the adapter cannot know the plugin's
  limit until the first handshake; the kernel holds both at startup. Populating the service's
  `maxMessageBytes` and the Workers ceiling are M143o's halves.
- **Test home:** `kernel/test/unit/websocket-ceiling.test.ts` (fake adapter and service: warns for
  `0` and for above-ceiling, silent at or below, silent when one of the two is absent);
  `runtime/test/unit/bun-http-adapter.test.ts` (serve receives `maxPayloadLength`, ceiling exposed).

### 3.12 workerd: cleanup when the client leaves (V13-200, kernel half)

- **Decision:** `wrapDeferredStream` takes the request's `AbortSignal` and runs its `once()` (the
  cleanups and the drain release) when the signal aborts before the stream finished, then cancels
  the source reader. The kernel passes `ctx.signal`. Same on every runtime; on Node it is a no-op in
  practice because `cancel()` already arrives. On workerd this needs `ctx.signal` to fire, which
  requires the `enable_request_signal` compatibility flag before the 2026-11-17 compatibility date —
  the template half is M143j's. Asynchronous cleanups on workerd also need the isolate kept alive
  (`waitUntil`), which the kernel cannot reach — M143o's half if the workerd proof shows an async
  cleanup cut short.
- **Why:** workerd tears the request down without calling `cancel()`; the signal is the only notice.
- **Test home:** `kernel/test/unit/deferred.test.ts` (abort runs cleanups once; abort after end does
  nothing); `runtime/test/integration/stream-signal.test.ts` — on a real Node server (Bun and Deno
  arms guarded on the binary) a fully read stream runs its cleanups once, after the last chunk, so
  no runtime aborts the signal early, and a client that leaves runs them once; verification on local
  `wrangler dev` (§7), recorded in the PR.

### 3.13 Bun idle streams (V13-42)

- **Decision:** for a streamed response the Bun adapter calls `server.timeout(request, 0)` before
  returning it, which disables Bun's 10 s idle timeout for that request only. Buffered responses
  keep Bun's default.
- **Why:** Node and Deno never close a quiet response stream; the SSE heartbeat (30 s) cannot work
  under a 10 s idle cut.
- **Test home:** `runtime/test/unit/bun-http-adapter.test.ts` (fake server records the call for
  streamed bodies only); `runtime/test/e2e/bun-idle-stream.test.ts` — guarded on `bun`, a stream
  silent for 15 s stays open.

### 3.14 A failed response stream (V13-256)

- **Decision:** the kernel's stream guard (`guardEmptyChunks`, which wraps every streamed body)
  catches a source error, logs `'Response stream failed'` at `error` with
  `{ requestId, method, path, status, error: describeError(error) }` when a logger is registered,
  and re-raises it so the connection is still aborted. Each adapter then ends the connection on that
  error without the runtime printing it: Node takes `outgoing` from node-server's fetch `env` and
  destroys it, ending the body cleanly so node-server's `handleResponseError` never sees an error;
  Bun and Deno get the measured equivalent; where a runtime prints regardless, the adapter's JSDoc
  and a one-time startup line say so. The client always sees an aborted response, never a clean end.
- **Why:** one log line, through the logger and its redaction, on every runtime.
- **Test home:** `kernel/test/unit/stream-guard.test.ts`;
  `runtime/test/integration/stream-failure.test.ts` — a real Node server: no `console.error` call,
  the logger records the line, the client sees a truncated response (Bun/Deno arms guarded).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — every member added to a published interface is optional, and
`RuntimeSignal` widens a union a caller passes in (an exhaustive `switch` over it in application
code would need a new arm; noted in `docs/upgrading.md`). Ships in minor `0.14.0`.

| Exported symbol                           | Kind             | Consumer / real code path that READS it                                             |
| ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `FatalErrorOrigin` (common)               | type             | `IRuntimeServices.onFatalError` signature; kernel's handler logs it.                |
| `IRuntimeServices.onFatalError?` (common) | interface member | Kernel `#runStartup` subscribes; `stop()`/failed start unsubscribes.                |
| `RuntimeSignal` adds `'SIGHUP'` (common)  | type change      | Generated entries (M143j) and any application `onSignal` call.                      |
| `StartOptions.drainTimeoutMs?` (common)   | option           | Kernel `#drainRequests`.                                                            |
| `IHttpAdapter.beginDrain?` (common)       | interface member | Kernel `#runShutdownSequence`.                                                      |
| `IHttpAdapter.webSocketMaxMessageBytes?`  | interface member | Kernel startup ceiling check (§3.11).                                               |
| `IWebSocketService.maxMessageBytes?`      | interface member | Kernel startup ceiling check; populated by websocket-plugin (M143o).                |
| `IPluginContext.signal?` (common)         | interface member | Plugins that await at startup (realtime-backplane-plugin, M143m); kernel aborts it. |
| `StartCancelledError` (kernel)            | class            | Thrown by `start()`; generated entries tell it from a failure (M143j).              |

### 4.1 Options — every option names its consumer

| Option                        | Consumer                    | Behavior (per implementation)                                                           |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `StartOptions.drainTimeoutMs` | `Application#drainRequests` | Same on every runtime: the longest `stop()` waits for in-flight requests; default 10 s. |

## 5. Implementation files

| File                                                               | Purpose                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/common/src/runtime.ts`                                   | `RuntimeSignal`, `FatalErrorOrigin`, `onFatalError?`, `beginDrain?`, `webSocketMaxMessageBytes?` |
| `packages/common/src/plugin.ts`                                    | `StartOptions.drainTimeoutMs?`, `IPluginContext.signal?`                                         |
| `packages/common/src/services/websocket.ts`                        | `IWebSocketService.maxMessageBytes?`                                                             |
| `packages/common/src/http.ts`                                      | `defer` JSDoc (C1)                                                                               |
| `packages/common/src/index.ts`                                     | export `FatalErrorOrigin`                                                                        |
| `packages/kernel/src/application/application.ts`                   | §3.1, §3.3–3.7, §3.10 body drop, §3.11, §3.12 wiring                                             |
| `packages/kernel/src/application/start-cancelled-error.ts` (new)   | `StartCancelledError`                                                                            |
| `packages/kernel/src/context/deferred.ts`                          | signal-driven cleanup (§3.12)                                                                    |
| `packages/kernel/src/context/stream-guard.ts`                      | stream failure log (§3.14)                                                                       |
| `packages/kernel/src/router/router.ts`                             | `HEAD` falls back to `GET` (§3.10)                                                               |
| `packages/kernel/src/index.ts`                                     | export `StartCancelledError`                                                                     |
| `packages/runtime/src/adapters/node/node-runtime.ts`               | `onFatalError` (Node)                                                                            |
| `packages/runtime/src/adapters/bun/bun-runtime.ts`                 | `onFatalError` (Bun, as measured)                                                                |
| `packages/runtime/src/adapters/deno/deno-runtime.ts`               | `onFatalError` (Deno)                                                                            |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`          | `beginDrain`, refused-upgrade writer call, stream-failure handling                               |
| `packages/runtime/src/adapters/node/node-http2-listener.ts`        | drain closer usable before `close()`                                                             |
| `packages/runtime/src/adapters/node/node-ws-upgrader.ts`           | response writer for refused upgrades                                                             |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`            | `maxPayloadLength`, ceiling, `server.timeout`, `beginDrain` if Bun has HTTP/2, stream failure    |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`          | ceiling, stream failure                                                                          |
| `packages/runtime/src/services/cross-runtime.ts`                   | carry `onFatalError` through `mergeRuntimeServices` like `onSignal`                              |
| `packages/logger-plugin/src/middleware/request-logger.ts`          | §3.9                                                                                             |
| READMEs of kernel, runtime, common, logger-plugin; `PUBLIC_API.md` | the new members, lines and behaviours                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                 | src covered                                       | Key assertions                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel/test/unit/fatal-error-log.test.ts`                | `application.ts` §3.1                             | Subscribes once per start through `runtime.onFatalError`; logs `fatal` `'Process failed'` with origin; unsubscribes on stop and failed start; silent with no logger. |
| `kernel/test/unit/shutdown-log.test.ts`                   | `application.ts` §3.3                             | The three lines, levels and fields; `warn` on timeout and on hook failure; silent with no logger.                                                                    |
| `kernel/test/unit/shutdown-drain.test.ts`                 | `application.ts` §3.4–3.6                         | `drainTimeoutMs` honoured and validated; streamed body holds the drain; `beginDrain` called once after stopping hooks, a throw survived.                             |
| `kernel/test/unit/start-cancel.test.ts`                   | `application.ts` §3.7, `start-cancelled-error.ts` | As §3.7.                                                                                                                                                             |
| `kernel/test/unit/router-head.test.ts`                    | `router.ts`                                       | `match('HEAD')` finds GET; explicit HEAD wins at equal rank; specific GET beats catch-all HEAD.                                                                      |
| `kernel/test/integration/head-requests.test.ts`           | `application.ts` §3.10                            | Empty body, headers kept, streamed body cancelled and its `defer` run.                                                                                               |
| `kernel/test/unit/websocket-ceiling.test.ts`              | `application.ts` §3.11                            | As §3.11.                                                                                                                                                            |
| `kernel/test/unit/deferred.test.ts`                       | `deferred.ts`                                     | Abort runs cleanups once and cancels the source; abort after end is a no-op.                                                                                         |
| `kernel/test/unit/stream-guard.test.ts`                   | `stream-guard.ts`                                 | Source error logged once with request fields and re-raised.                                                                                                          |
| `runtime/test/unit/fatal-error-observer.test.ts`          | node/bun/deno `*-runtime.ts`, `cross-runtime.ts`  | Each wires its host's mechanism and unsubscribes.                                                                                                                    |
| `runtime/test/e2e/fatal-error-process.test.ts`            | (real path)                                       | Child process: `fatal` JSON line on stdout, exit code and stderr trace as in the control.                                                                            |
| `runtime/test/unit/signals.test.ts`                       | `*-runtime.ts`                                    | `'SIGHUP'` forwarded.                                                                                                                                                |
| `runtime/test/integration/node-drain-goaway.test.ts`      | `node-http-adapter.ts`, `node-http2-listener.ts`  | As §3.6.                                                                                                                                                             |
| `runtime/test/unit/node-ws-upgrader.test.ts`              | `node-ws-upgrader.ts`                             | Writer bytes: reason phrase, headers, length, body; streamed body cancelled.                                                                                         |
| `runtime/test/integration/refused-upgrade-parity.test.ts` | `node-http-adapter.ts` (+ Bun/Deno guarded)       | Same refusal on every runtime installed.                                                                                                                             |
| `runtime/test/unit/bun-http-adapter.test.ts`              | `bun-http-adapter.ts`                             | `maxPayloadLength`, ceiling, `server.timeout(req, 0)` for streams only, stream failure.                                                                              |
| `runtime/test/e2e/bun-idle-stream.test.ts`                | (real Bun)                                        | Silent stream open after 15 s.                                                                                                                                       |
| `runtime/test/unit/deno-http-adapter.test.ts`             | `deno-http-adapter.ts`                            | Ceiling; stream failure handling.                                                                                                                                    |
| `runtime/test/integration/stream-failure.test.ts`         | node adapter (+ Bun/Deno guarded)                 | No raw print, logger line present, client sees truncation.                                                                                                           |
| `logger-plugin/test/unit/request-logger.test.ts`          | `request-logger.ts`                               | 101 on upgrade intent; 499 + `aborted` on aborted signal; unchanged otherwise.                                                                                       |

Existing test files may hold these cases instead of the new names where a file for that source
already exists; every case listed must exist and fail without its fix.

## 7. Verification gates

```bash
git branch --show-current   # feat/m143i-process-and-runtimes
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common kernel runtime logger-plugin   # ANSI-stripped per-file table, ≥90% each
flock ~/.cache/setu-ts/locks/suite.lock pnpm run test:deno-lane
flock ~/.cache/setu-ts/locks/suite.lock pnpm run ci:local
pnpm run release:publish --dry-run
pnpm run release:verify 0.14.0
```

Real-runtime proofs, recorded in the PR: the repro drivers re-run on Node, Bun and Deno against the
built packages; V13-200 on local `wrangler dev` (no Cloudflare account — local workerd only) with
and without `enable_request_signal`, a sync and an async `defer`; V13-42 on Bun; V13-11
child-process crash on all three.

## 8. Risks & mitigations

- Counting streams in the drain makes `stop()` of an app with an open SSE client wait for the bound
  → the drain-finished line names `remaining`, the bound is now a setting, and the upgrade note says
  so.
- `uncaughtExceptionMonitor` and Deno's error events are process-global → the kernel unsubscribes on
  stop, so test suites that start many apps do not pile up listeners; a test asserts the count.
- Racing startup steps against the abort could leave a late `listen` bound → §3.7 closes a handle
  that arrives after the abort; the test drives that order.
- The HEAD body drop could leak a stream → the stream is cancelled, not dropped, so `defer` runs.
- Bun's `server.timeout` or Bun's crash hooks may differ on the installed Bun (1.4.5) → each is
  measured before it is relied on; a missing mechanism is stated in JSDoc, not faked.

## 9. Out of scope

Hand-over, per row, to the letters that own the other half:

- **M143j (templates):** V13-11 — none needed once the kernel logs (an entry may keep its own
  `console.error` fallback); V13-12 — add `'SIGHUP'` to the signal loops in `project-files.ts`
  (generated `main.ts`) and `full-stack-build-files.ts` (dev server entry); V13-26 — pass
  `drainTimeoutMs` in the generated `app.start({ … })` at 25 000 (5 s below the generated 30 s grace
  minus `preStopSleepSeconds` is 25 s); V13-43 — the generated entry's start catch treats
  `StartCancelledError` as a clean stop (no "Startup failed", exit 0); V13-200 — add
  `enable_request_signal` to the Workers `wrangler.toml` `compatibility_flags`; V13-110 — the
  full-stack template's `onError` should not set `didError` when `request.signal.aborted`.
- **M143c:** V13-23 — `grpcClient` retries an HTTP 503 answer that carries no `grpc-status` from a
  peer (the kernel's drain 503 for a stream that raced GOAWAY).
- **M143m:** V13-43 — `realtime-backplane-plugin` registers its close hook before connecting and
  passes `ctx.signal` to the connect wait.
- **M143o:** V13-41 — `WebSocketService` exposes `maxMessageBytes`; the Workers adapter sets
  `webSocketMaxMessageBytes` to workerd's ceiling; V13-200 — hand the kernel's abort-time cleanup to
  `waitUntil` if the workerd proof shows an async cleanup cut short.
- **M143l:** V13-113 — nothing expected (the kernel ranks GET with HEAD); confirm on the full-stack
  app.
- **M143n:** `docs/deployment.md` shutdown section (SIGHUP, `drainTimeoutMs`, the new log lines,
  streams holding the drain); `docs/programmatic-api.md:642` and `docs/ai.md:190` on `ctx.signal`
  needing `enable_request_signal` on Workers.
