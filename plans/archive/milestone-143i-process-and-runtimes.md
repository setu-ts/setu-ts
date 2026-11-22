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

| Reference                                  | Source (file:line)                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RuntimeSignal`                            | `packages/common/src/runtime.ts:40`                                                                | `'SIGTERM' \| 'SIGINT'`; the JSDoc above it gives the reason for the narrow set.                                                                                                                                                                                                                                   |
| `IRuntimeServices.onSignal?`               | `packages/common/src/runtime.ts:452`                                                               | Optional; absent on Workers and on Deno for Windows (`deno-runtime.ts:214-227`). Node `proc.on` (`node-runtime.ts:153`), Bun `proc.on` (`bun-runtime.ts:286`), Deno `addSignalListener` (`deno-runtime.ts:225`). No handler-removal member and no uncaught-error member exist.                                     |
| `IHttpAdapter`                             | `packages/common/src/runtime.ts:468-521`                                                           | `setHandler`, `fetch`, `listen`, `close`, optional `setUpgradeRouter`. No drain or limit member.                                                                                                                                                                                                                   |
| `StartOptions`                             | `packages/common/src/plugin.ts:422-427`                                                            | `port?`, `hostname?` only.                                                                                                                                                                                                                                                                                         |
| `IPluginContext`                           | `packages/common/src/plugin.ts:521`                                                                | No abort signal. `packages/testing` only RECEIVES contexts (`mock-plugin.ts:70`, `override-provider.ts:141`), never builds one, so an optional member breaks no implementor.                                                                                                                                       |
| `IRequestContext.signal`                   | `packages/common/src/http.ts:427`; `packages/kernel/src/context/request-context.ts:153`            | `request.signal ?? new AbortController().signal` — the raw request's signal when the adapter supplies one.                                                                                                                                                                                                         |
| `upgradeIntentOf` / `setUpgradeIntent`     | `packages/common/src/http.ts:702-716`                                                              | Exported from common; the kernel brands the `IRequest` in `#tryUpgrade` (`application.ts:2060`) before the pipeline's `next()` returns to outer middleware.                                                                                                                                                        |
| `ILogger.fatal`                            | `packages/common/src/services/logger.ts:38`                                                        | Exists.                                                                                                                                                                                                                                                                                                            |
| `WebSocketEventSink.maxMessageBytes`       | `packages/common/src/services/websocket.ts:88`                                                     | Per-sink; `0` unlimited; Node passes it to `ws` as `maxPayload` (`node-ws-upgrader.ts:419-425`). `IWebSocketService` exposes no limit (`websocket.ts:424-494`).                                                                                                                                                    |
| Kernel shutdown                            | `packages/kernel/src/application/application.ts:837-931`                                           | `stop()` no-ops only when `!#started`; `#started` is set true at the top of `start()` (`:544`), so a `stop()` during start runs the whole shutdown concurrently with startup. Drain: `#drainRequests` `:2612-2629`, `hrtime() + 10_000`, `MAX_POLLS = 200`. No stop or drain log line.                             |
| Drain accounting of streams                | `application.ts:1886-1922`                                                                         | With no `ctx.defer` cleanup a streamed body releases `#inFlight` at settle time, before the body is read (`:1894-1898`); only bodies with cleanups, and early-response streams whose handler has not settled (`:1866-1878`), go through `wrapDeferredStream`. So the drain does not wait for a gRPC server stream. |
| `wrapDeferredStream`                       | `packages/kernel/src/context/deferred.ts:90-134`                                                   | Runs cleanups on end, error, or consumer `cancel()` — never on the request signal.                                                                                                                                                                                                                                 |
| Drain 503                                  | `application.ts:1084-1102`                                                                         | Pre-pipeline problem 503 while `#stopping`.                                                                                                                                                                                                                                                                        |
| Listening log                              | `application.ts:2549-2564`                                                                         | `logger.info('Server listening', …)`; silent without a logger.                                                                                                                                                                                                                                                     |
| HTTP/2 session close                       | `packages/runtime/src/adapters/node/node-http2-listener.ts:98-120`; `node-http-adapter.ts:263-272` | `trackHttp2Sessions` returns a closer that calls `session.close()` (GOAWAY, in-flight streams finish); the adapter calls it only inside `server.close()`, i.e. after the drain.                                                                                                                                    |
| Router                                     | `packages/kernel/src/router/router.ts:444-467`, `:507-600`                                         | `get` registers `GET` only; `match(method, path)` asks Hono for that method alone, then ranks candidates.                                                                                                                                                                                                          |
| Node refused upgrade                       | `packages/runtime/src/adapters/node/node-http-adapter.ts:536-542`; `node-ws-upgrader.ts:451-462`   | Writes `HTTP/1.1 <status> <reason>` with `Bad Request` for every status but 500/501/503, `Connection: close`, no body, no headers.                                                                                                                                                                                 |
| node-server response error                 | `node_modules/.pnpm/@hono+node-server@2.1.8_hono@4.13.18/…/dist/index.mjs:885-897`, `:786-788`     | `handleResponseError` calls `console.error(e)` unconditionally (no option reaches it); a body stream error reaches it via `writable.destroy(error)`. `writable.on('close', cancel)` cancels the reader cleanly (`:779`).                                                                                           |
| Stream guard                               | `packages/kernel/src/context/stream-guard.ts:38-80`                                                | `guardEmptyChunks(body, runtime)` wraps every streamed body (`application.ts:1874`, `:1890`); it knows nothing of the request.                                                                                                                                                                                     |
| Request signal cost                        | `packages/kernel/src/context/request-context.ts:145-155`; `application.ts:2116-2124`               | `ctx.signal` allocates an `AbortController` when the request has none; the kernel already avoids extra signal work on the hot path ("about 8% of unary throughput").                                                                                                                                               |
| Bun HTTP/2                                 | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:327-339`; `runtime-plugin.ts:227-231`       | `BunHttpAdapter` serves `Bun.serve` only; with `http2` set, the runtime plugin runs Bun on the Node adapter. Deno serves h2 through `Deno.serve` (`deno-http-adapter.ts:305-308`) with no session control.                                                                                                         |
| `rejectRawUpgrade` export                  | `packages/runtime/src/index.ts:82`; runtime README:275                                             | Public; signature `(socket, status)`.                                                                                                                                                                                                                                                                              |
| Stale shutdown options in `PUBLIC_API.md`  | `PUBLIC_API.md:238-239`                                                                            | Documents `ApplicationOptions.gracefulShutdown?` and `shutdownTimeout?`, which do not exist (V13-129, M143n).                                                                                                                                                                                                      |
| Generated drain window                     | `packages/cli/src/workspace/k8s.ts:60`, `:213`                                                     | Grace 30 s, `preStopSleepSeconds` 5.                                                                                                                                                                                                                                                                               |
| Bun serve                                  | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:204-232`, `:328-339`                        | `fetch(request, server)` callback; `websocket` handlers with no `maxPayloadLength`; no `idleTimeout` and no per-request `server.timeout`.                                                                                                                                                                          |
| Request logger                             | `packages/logger-plugin/src/middleware/request-logger.ts:83-114`, `:169-171`                       | Reads `ctx.response.snapshot().status` after `next()`; ignores `ctx.signal` and the upgrade brand.                                                                                                                                                                                                                 |
| Generated entry signals                    | `packages/cli/src/templates/project-files.ts:795-833`; `full-stack-build-files.ts:480`             | Loops over `['SIGTERM', 'SIGINT']`; no uncaught handler. (Read for §9 only; not edited.)                                                                                                                                                                                                                           |
| Measured on `develop` (`d2ec1aef1`, built) | `.claude/repro/repro1.mjs`, `repro2.mjs` (scratch, uncommitted)                                    | `HEAD /x` → 404 on Node and Deno; a failing response stream prints a raw trace on Node, Bun and Deno with the response already 200; Node's refused upgrade is `401 Bad Request` with no body while Bun and Deno send the 401 JSON body; the request log says `200` for a 101 upgrade on all three.                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                    | Resolution (picked side)                                                                                                                          | Doc deliverable (same PR)                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C1  | `IRequestContext.defer` JSDoc (`common/src/http.ts:382-399`) promises cleanup on stream end, error or cancellation; on workerd a client leaving triggers none of the three. | The code is brought up to the contract (§3.12); the JSDoc gains "or the request's signal aborting".                                               | `common/src/http.ts` JSDoc; `PUBLIC_API.md` defer paragraph.                                         |
| C2  | grpc-plugin README "a server shutting down refuses a call already on the wire" vs the kernel answering 503 for the drain and closing sessions after it.                     | The kernel sends GOAWAY at drain start (§3.6); the README stays, the remaining 503 window is M143c's half.                                        | None in this lane (grpc-plugin README belongs to M143c; §9 names the sentence).                      |
| C4  | `PUBLIC_API.md:238-239` documents `gracefulShutdown`/`shutdownTimeout`, which do not exist; this PR adds the real bound, `StartOptions.drainTimeoutMs`.                     | Delete the two stale lines and point at `StartOptions.drainTimeoutMs` in this PR (the `PUBLIC_API.md` half of V13-129; M143n is told it is done). | `PUBLIC_API.md`.                                                                                     |
| C3  | `RuntimeSignal` JSDoc says the two signals are "the only two every non-edge runtime can register for"; SIGHUP is registrable on Node, Bun and Deno-on-POSIX.                | Widen to SIGHUP with the reason written down (§3.2).                                                                                              | `common/src/runtime.ts` JSDoc; `PUBLIC_API.md`; `docs/deployment.md` shutdown block is M143n's (§9). |

## 3. Design decisions

### 3.1 Uncaught exceptions and unhandled rejections (V13-11)

- **Decision:** `IRuntimeServices` gains an optional
  `onFatalError?(handler: (error: unknown, origin: FatalErrorOrigin) => void): () => void`, with
  `type FatalErrorOrigin = 'uncaughtException' | 'unhandledRejection'` in common. It OBSERVES only:
  the process still dies with the same exit code and the runtime still prints its own report on
  stderr. It returns an unsubscribe function. Implementations, each measured on 2026-11-22:
  - Node 24: `process.on('uncaughtExceptionMonitor', …)`; under Node's default
    `--unhandled-rejections=throw` a rejection arrives there with origin `'unhandledRejection'`.
  - Deno 2.9.6: `globalThis.addEventListener('error' | 'unhandledrejection')`, no
    `preventDefault()`; the process still exits 1.
  - Bun 1.4.5: `uncaughtExceptionMonitor` fires for throws and the process still exits 1; it never
    fires for rejections, and a Bun `unhandledRejection` listener SUPPRESSES the crash (the process
    lived and exited 0). So for rejections the Bun adapter adds an `unhandledRejection` listener
    that calls the handlers and then, when it is the only `unhandledRejection` listener, rethrows
    the reason so Bun still crashes; when the application has its own listener the rethrow is
    skipped (the application chose not to crash). The rethrown reason is recorded (an object in a
    `WeakSet`, a primitive wrapped once in a marked `Error`) and the adapter's monitor skips it, so
    the crash is reported once, as `'unhandledRejection'`.
  - Workers omits it (an isolate's exceptions are per request). Each adapter installs ONE
    process-level listener per mechanism lazily, on the first subscription, keeps the handlers in a
    set, and removes the process listener when the set empties. A handler that throws is caught and
    never changes the crash. The kernel subscribes in `#runStartup` as soon as the runtime
    capability resolves (after the runtime plugin's `register()`; a crash before that point is not
    observed, and the README says so), and unsubscribes at the end of `stop()` and after a failed or
    cancelled start. Its handler resolves the logger at fire time and writes
    `logger.fatal('Process failed', { origin, error: describeError(error) })`; with no logger it
    does nothing. A throwing logger is swallowed. The line is as durable as the logger's write: the
    console logger and a synchronous pino destination write before the process exits; a pino
    worker-thread transport may lose it, which the logger-plugin README states.
- **Why:** an observer keeps the documented decision that the framework does not take over process
  behaviour (`docs/deployment.md` "Graceful shutdown"), while the JSON pipeline finally sees why the
  process ended. The kernel owns the logger, so the line goes through the same redaction as every
  other line.
- **Test home:** `runtime/test/unit/fatal-error-observer.test.ts` (per-runtime wiring through
  injected hosts, one listener per mechanism, the Bun rethrow rule and its de-duplication);
  `kernel/test/unit/fatal-error-log.test.ts` (subscribe/unsubscribe, log shape);
  `runtime/test/e2e/fatal-error-process.test.ts` — a real child process on Node, Bun and Deno (Bun
  and Deno arms guarded on the binary) that throws and that rejects: exactly one `fatal` JSON line
  on stdout with the right origin, exit code 1 as in a control child without the app, stderr
  non-empty and naming the error's message; on Bun, a child whose application has its own
  `unhandledRejection` listener keeps running.

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

### 3.5 The drain waits for RPC streamed replies (V13-23, server-stream half)

- **Decision:** a streamed reply sent by `#sendRpcResponse` (the gRPC, Connect and gRPC-Web path)
  holds its request in `#inFlight` until the body ends, errors or is cancelled: `#sendRpcResponse`
  marks the request, and `#settleRequest` routes a marked streamed body with no cleanups through
  `wrapDeferredStream(body, [], …, complete)`. Other streamed bodies (SSE, page renders, downloads)
  keep today's accounting, so an open SSE client does not hold every stop for the whole bound — SSE
  closes its connections only in `onClose`, after the drain (`sse-plugin.ts:139-147`).
- **Why:** a gRPC server stream in flight at shutdown was cut with CANCEL because the drain had
  already released it, while counting every stream would make each stop with a live SSE or GraphQL
  subscription wait the full bound.
- **Test home:** `kernel/test/unit/shutdown-drain.test.ts` — a fake gRPC service's streamed reply
  keeps `stop()` waiting until the stream closes; a plain streamed route body does not.

### 3.6 GOAWAY at drain start (V13-23, kernel half)

- **Decision:** `IHttpAdapter` gains an optional `beginDrain?(handle: ServerHandle): void`. The
  kernel calls it (when a server handle exists and the adapter has it) in the same synchronous turn
  that sets `#stopping`, after the `onStopping` hooks. Node: closes every tracked HTTP/2 session
  gracefully (`session.close()`: GOAWAY, streams in flight continue) on both the TLS and cleartext
  listeners, and calls `closeIdleConnections()` on the HTTP/1.1 server where the server has it; the
  later `close()` is unchanged. Bun needs no member of its own: `BunHttpAdapter` has no HTTP/2, and
  with `http2` set the runtime plugin already runs Bun on the Node adapter, which brings Node's
  `beginDrain`. Deno omits the member: `Deno.serve` gives no session control. Because the ROADMAP
  outcome ("a draining member refuses new gRPC streams") then does not hold on Deno, the Deno
  adapter states it once at `listen` whenever `http2` is configured (`Deno.serve` answers h2c on any
  listener and h2 under TLS), through `reportError`:
  `{ level: 'warn', msg: 'HTTP/2 clients are not sent GOAWAY when this Deno server drains; calls during the drain get 503' }`.
  A throw from `beginDrain` is caught and logged at `warn`; it never stops the shutdown.
- **Why:** after GOAWAY a conforming client opens new streams on another connection, and a stream it
  opened past the last-stream-id is refused without being processed — the retryable case
  `grpcClient` already handles. The 503 the kernel still answers for a stream that raced the GOAWAY
  is M143c's half (retry an HTTP 503 from a draining peer that carries no `grpc-status`).
- **Test home:** `runtime/test/integration/node-drain-goaway.test.ts` — a real `node:http2` client
  on a session opened before stop receives GOAWAY at drain start, its in-flight stream completes,
  and a stream opened after GOAWAY is refused (`NGHTTP2_REFUSED_STREAM` or the GOAWAY session
  error); `kernel/test/unit/shutdown-drain.test.ts` — the kernel calls `beginDrain` once, after
  stopping hooks, and survives a throwing one; `runtime/test/unit/deno-http-adapter.test.ts` — the
  Deno line once with `http2`, never without.

### 3.7 A stop during start cancels the start (V13-43, kernel half)

- **Decision:** `start()` owns an `AbortController`; `IPluginContext` gains an optional
  `readonly signal?: AbortSignal` that the kernel always sets and aborts when `stop()` is called
  before `start()` finishes. While starting, `stop()` does NOT run the shutdown sequence (no
  `onStopping` or `onShutdown` hooks — the start never finished; the upgrade note says so): it
  aborts the signal and returns a promise that settles when `start()` has unwound. Every awaited
  startup step (`register()` promises, `runInit`, `runBootstrap`, `adapter.listen`) is raced against
  the signal, so a hook that never settles cannot hold the stop. On abort `start()` rejects with
  `StartCancelledError` (new, exported from `@setu-ts/kernel`,
  `message: 'start() was cancelled by stop()'`), its existing catch runs the close hooks, a server
  bound by a `listen` that resolved after the abort is closed, and nothing listens later even if a
  hook resolves afterwards. Plugin work abandoned by the race may keep running: after the abort, a
  close hook registered through `ctx.lifecycle.onClose` runs at once (a failure logged at `warn`),
  so a resource connected late is still released; other lifecycle registrations after the abort are
  ignored. The kernel logs `'Startup cancelled'` at `warn` when a logger is registered. `stop()`
  resolves (it does not reject with the cancellation). A second `stop()` returns the same promise.
- **Why:** the sockets leaked because the shutdown ran before the backplane registered its close
  hook (`realtime-backplane-plugin.ts:129-176`) and startup then carried on to `listen`. Running a
  late close hook at once closes that leak from the kernel side; honouring `ctx.signal` and
  registering the hook before connecting is M143m's half.
- **Test home:** `kernel/test/unit/start-cancel.test.ts` — a plugin whose `onInit` never resolves:
  `stop()` resolves, `start()` rejects with `StartCancelledError`, the plugin's earlier `onClose`
  ran, `ctx.signal.aborted` is true, and when the hook later resolves and registers another
  `onClose`, that hook runs at once and no `listen` happens (fake adapter records calls); a `listen`
  resolving after the abort is closed; `onStopping`/`onShutdown` hooks did not run; 20 cycles leave
  no listener on a fake adapter.

### 3.8 Node answers a refused upgrade with the framework response (V13-53)

- **Decision:** a new internal writer, `writeRawUpgradeResponse(socket, snapshot)` in
  `node-ws-upgrader.ts`, serialises the framework response's snapshot onto the raw socket:
  `HTTP/1.1 <status> <node:http STATUS_CODES reason>`; every snapshot header, with each `Set-Cookie`
  value on its own line (`getSetCookie()`); `transfer-encoding` and `content-length` from the
  snapshot dropped; `content-length` of the buffered body; `connection: close`; then the body. A
  streamed body is cancelled and sent as `content-length: 0`. The node adapter's "no intent" path
  uses it. The exported `rejectRawUpgrade(socket, status)` keeps its signature for the fixed-status
  paths (no handler, handshake failure) and the empty body, and takes its reason phrase from the
  same `STATUS_CODES` table (a changed reason phrase is noted in the upgrade guide and README).
- **Why:** Bun and Deno already send the framework's response; Node's raw socket path dropped it.
- **Test home:** `runtime/test/unit/node-ws-upgrader.test.ts` (writer bytes: reason, two
  `Set-Cookie` lines, no `transfer-encoding`, length, body; `rejectRawUpgrade` reasons);
  `runtime/test/integration/refused-upgrade-parity.test.ts` — a middleware 401 with a JSON body on a
  raw upgrade request: same status line reason, content type and body on Node as on Bun and Deno
  (Bun/Deno arms guarded on the binary).

### 3.9 The request log records 101 for an upgrade and the client leaving (V13-223, V13-110 half)

- **Decision:** after `next()`, the request logger's status is: `101` when
  `upgradeIntentOf(ctx.request)` is set; else, when the status would be a 5xx and
  `ctx.request.signal?.aborted`, `499` with `aborted: true` added to the line; else the
  error-predicted or snapshot status as today. Narrowed to a 5xx in the code-review fix (M2): on
  Deno the first read of `request.signal` prints the runtime's legacy-abort notice, so the signal is
  read only where a client that left changes the line — a render that failed because it went away.
  The message stays `'request completed'`. The 101 records the accepted upgrade; a handshake that
  then fails is reported separately by the adapter (`'WebSocket handshake failed'`,
  `node-http-adapter.ts:547-557`), which the README states.
- **Why:** the wire said 101; a client that left received nothing and must not page a 5xx alert. 499
  is the established "client closed request" code in access logs.
- **Test home:** `logger-plugin/test/unit/request-logger.test.ts`.

### 3.10 Implicit `HEAD` on every `GET` route (V13-113)

- **Decision:** `Router.match('HEAD', path)` collects the `HEAD` candidates and the `GET` candidates
  and ranks them together with the existing ranking; at equal rank an explicit `HEAD` route wins. A
  `GET` definition served for `HEAD` runs its full middleware and handler, and the response keeps
  every header the `GET` would carry. Over a real server the kernel leaves the body to the adapter:
  Node's `http`, Bun and Deno already send no body for `HEAD` and keep the `GET`'s `content-length`.
  Only `inject()` and `dispatch()`, which have no server, drop the body themselves for a `HEAD`
  request (headers kept, `content-length` included; a streamed body is cancelled so its producer and
  cleanups run). The explicit `router.head()` keeps working.
- **Why:** RFC 9110 §9.1 and §9.3.2 (a `HEAD` response carries the `GET`'s headers). Ranking
  together means a specific `GET /assets/*` beats a catch-all `HEAD /*`, so react-router's asset and
  public-file routes answer `HEAD` with no change in that plugin.
- **Test home:** `kernel/test/unit/router-head.test.ts`;
  `kernel/test/integration/head-requests.test.ts` (inject: status, `content-length` equal to the
  `GET`'s, empty body; a streamed GET under HEAD runs its `defer`);
  `runtime/test/integration/head-real-server.test.ts` — on a real Node server (Bun and Deno arms
  guarded) `HEAD` answers 200 with the `GET`'s `content-length` and no body.

### 3.11 WebSocket size limits across runtimes (V13-41)

- **Decision:** the runtime states its ceiling where it learns the configured limit — at the
  handshake, from `sink.maxMessageBytes`. Bun's ceiling is `16 * 1024 * 1024`, now passed explicitly
  as Bun's `websocket.maxPayloadLength` so the number is the adapter's own; Deno's is
  `64 * 1024 * 1024` (fixed by Deno); Node has none (`ws` takes the sink's limit). On Bun and Deno,
  the first handshake whose `sink.maxMessageBytes` is `0` or above the ceiling reports once per
  server, through `reportError`:
  `{ level: 'warn', msg: 'WebSocket message limit exceeds the runtime ceiling', configured, ceiling, platform }`.
  The ceiling is not raised: a global raise on Bun would let any socket send frames up to it while
  the plugin checks its own limit only after receipt. No `common` member is added for this.
- **Why:** the earlier draft read a limit from `IWebSocketService` that nothing populates and that
  no scheduled letter would populate; the sink already carries the limit to the adapter. This states
  it at the first upgrade rather than at process start — the deviation from the ROADMAP's "at
  startup" wording is named in the PR, because no runtime-lane code knows the limit earlier.
- **Test home:** `runtime/test/unit/bun-http-adapter.test.ts` and `deno-http-adapter.test.ts` (serve
  receives `maxPayloadLength`; one report for `0` and for above-ceiling across two handshakes, none
  at or below).

### 3.12 Cleanup when the client leaves, on every runtime (V13-200, kernel half)

- **Decision:** a request's `ctx.defer` cleanups run once, on whichever comes first: the existing
  settle path (response sent, or stream ended, errored or cancelled), or the request's own signal
  aborting. The abort listener is attached lazily, on the first `ctx.defer` call, and only when the
  adapter's request carries a signal (`ctx.request` signal, never the allocating `ctx.signal`), so a
  request that defers nothing pays nothing. On abort before settle the kernel runs the cleanups (the
  same LIFO, the same per-cleanup bound) — the drain release stays with the settle path, since a
  request whose handler never settles is the drain's own concern — and logs
  `'Request aborted before completion'` at `info` with `{ requestId, method, path }` when a logger
  is registered. This covers a streamed body the isolate itself produces and a non-streaming handler
  that never settles (the service-binding deadline case). A request that deferred nothing gets no
  line from the kernel; with §3.9 the request logger records it as 499 wherever its `finally` runs.
  On workerd the signal needs the `enable_request_signal` compatibility flag before the 2026-11-17
  compatibility date — the template half is M143j's. Asynchronous cleanups on workerd may also need
  the isolate kept alive (`waitUntil`), which the kernel cannot reach: the workerd proof measures a
  sync and an async cleanup, and any shortfall goes to M143o.
- **Why:** workerd tears the request down without calling `cancel()`; the signal is the only notice.
  Measured on develop with local `wrangler dev`: no flag, no cleanup and no signal; with the flag,
  the signal fires and the cleanup still does not run.
- **Test home:** `kernel/test/unit/deferred-abort.test.ts` (abort runs cleanups once; abort after
  settle does nothing; a non-streaming handler that never settles still runs its cleanups on abort;
  no listener is attached without `defer`); `runtime/test/integration/stream-signal.test.ts` — on a
  real Node server (Bun and Deno arms guarded on the binary) a fully read stream runs its cleanups
  once, after the last chunk, so no runtime aborts the signal early, and a client that leaves runs
  them once; verification on local `wrangler dev` (§7), recorded in the PR.

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

- **Decision:** `guardEmptyChunks` gains a third parameter, `onError: (error: unknown) => void`,
  which the kernel supplies with the request in scope: it logs `'Response stream failed'` at `error`
  with `{ requestId, method, path, status, error: describeError(error) }` when a logger is
  registered. The guard calls it once on a source error and re-raises the error. Each adapter then
  ends the connection without the runtime printing it, by a mechanism measured on 2026-11-22:
  - Node: the fetch callback takes `outgoing` from node-server's `env`; on a body error the
    adapter's wrapper destroys `outgoing` and ends its own stream without erroring, so node-server's
    `handleResponseError` never runs — it would `console.error` the error and write
    `Error: <message>` into the response body (`index.mjs:885-897`).
  - Bun: Bun's `error` hook is not called for a body error and Bun prints the error; erroring the
    response stream with `undefined` instead resets the connection and prints nothing, so the Bun
    wrapper re-raises as `controller.error(undefined)`.
  - Deno: `Deno.serve`'s `onError` receives a body error; the adapter passes an `onError` that
    prints nothing (the kernel has logged) and returns a 500 that Deno discards once headers are
    sent. The client always sees an aborted response, never a clean end. The earlier
    `'request completed'` line keeps the status it saw (it is written before the body is read); the
    new line carries the same `requestId` to tie the two together.
- **Why:** one log line, through the logger and its redaction, on every runtime, and no error text
  in a response body.
- **Test home:** `kernel/test/unit/stream-guard.test.ts` (callback once, error re-raised);
  `runtime/test/integration/stream-failure.test.ts` — a real Node server: no `console.error` call,
  the logger records the line, the client sees a truncated response whose bytes contain no
  `Error: source failed`; Bun and Deno arms (guarded) run the same server in a child process and
  assert empty stderr and a truncated response.

### 3.15 A cancel signal for a worker-pool call (V13-131's `common` half, for M143r)

- **Decision:** `WorkerRunOptions` (`packages/common/src/services/worker-pool.ts`) gains
  `readonly signal?: AbortSignal` with `@since 0.14.0`. The JSDoc says what the pool does with it:
  an already-aborted signal rejects with `signal.reason`, a queued call is withdrawn, a running
  call's worker is terminated as on timeout. This letter adds only the field; the worker-pool plugin
  that honours it is M143r's follow-up (its plan §3.16). If that follow-up does not ship in
  `0.14.0`, the release removes the field rather than ship a member nothing reads.
- **Why:** an application reaches the pool as `IWorkerPool` (`capability-services.ts:140`), so
  `{ signal }` cannot reach `run` without this contract change, which only the Core lane may make.
- **Test home:** a type-level test in `common/test/unit/worker-pool-options.test.ts` that
  `run(…, { signal })` type-checks; the behaviour tests are M143r's.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — every member added to a published interface is optional, and
`RuntimeSignal` widens a union a caller passes in (an exhaustive `switch` over it in application
code would need a new arm). Behaviour changes, each in `docs/upgrading.md`: a stop during start no
longer runs `onStopping`/`onShutdown`; gRPC streamed replies hold the drain; `HEAD` reaches `GET`
routes; Node's refused upgrade carries the framework response and `rejectRawUpgrade` new reason
phrases; the request log's 101 and 499. Ships in minor `0.14.0`.

| Exported symbol                           | Kind             | Consumer / real code path that READS it                                                                                |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `FatalErrorOrigin` (common)               | type             | `IRuntimeServices.onFatalError` signature; kernel's handler logs it.                                                   |
| `IRuntimeServices.onFatalError?` (common) | interface member | Kernel `#runStartup` subscribes; `stop()`/failed start unsubscribes.                                                   |
| `RuntimeSignal` adds `'SIGHUP'` (common)  | type change      | Generated entries (M143j) and any application `onSignal` call.                                                         |
| `StartOptions.drainTimeoutMs?` (common)   | option           | Kernel `#drainRequests`.                                                                                               |
| `IHttpAdapter.beginDrain?` (common)       | interface member | Kernel `#runShutdownSequence`.                                                                                         |
| `IPluginContext.signal?` (common)         | interface member | Plugins that await at startup (realtime-backplane-plugin, M143m); kernel aborts it.                                    |
| `WorkerRunOptions.signal?` (common)       | option           | The worker-pool plugin's `run` (M143r follow-up, plan §3.16 there).                                                    |
| `StartCancelledError` (kernel)            | class            | Thrown by `start()`; an entry tells a cancelled start from a failure with `instanceof` (the generated entries, M143j). |
| `rejectRawUpgrade` (runtime, changed)     | function         | Node adapter fixed-status refusals; reason phrases now from `STATUS_CODES`.                                            |

### 4.1 Options — every option names its consumer

| Option                        | Consumer                    | Behavior (per implementation)                                                           |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `StartOptions.drainTimeoutMs` | `Application#drainRequests` | Same on every runtime: the longest `stop()` waits for in-flight requests; default 10 s. |

## 5. Implementation files

| File                                                               | Purpose                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `packages/common/src/runtime.ts`                                   | `RuntimeSignal`, `FatalErrorOrigin`, `onFatalError?`, `beginDrain?`    |
| `packages/common/src/plugin.ts`                                    | `StartOptions.drainTimeoutMs?`, `IPluginContext.signal?`               |
| `packages/common/src/http.ts`                                      | `defer` JSDoc (C1)                                                     |
| `packages/common/src/index.ts`                                     | export `FatalErrorOrigin`                                              |
| `packages/kernel/src/application/application.ts`                   | §3.1, §3.3–3.7, §3.10 inject/dispatch body drop, §3.12, §3.14 callback |
| `packages/kernel/src/context/request-context.ts`                   | lazy abort listener on first `defer` (§3.12)                           |
| `packages/kernel/src/application/start-cancelled-error.ts` (new)   | `StartCancelledError`                                                  |
| `packages/kernel/src/context/deferred.ts`                          | once-guard shared by settle and abort (§3.12)                          |
| `packages/kernel/src/context/stream-guard.ts`                      | stream failure log (§3.14)                                             |
| `packages/kernel/src/router/router.ts`                             | `HEAD` falls back to `GET` (§3.10)                                     |
| `packages/kernel/src/index.ts`                                     | export `StartCancelledError`                                           |
| `packages/runtime/src/adapters/node/node-runtime.ts`               | `onFatalError` (Node)                                                  |
| `packages/runtime/src/adapters/bun/bun-runtime.ts`                 | `onFatalError` (Bun, as measured)                                      |
| `packages/runtime/src/adapters/deno/deno-runtime.ts`               | `onFatalError` (Deno)                                                  |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`          | `beginDrain`, refused-upgrade writer call, stream-failure handling     |
| `packages/runtime/src/adapters/node/node-http2-listener.ts`        | drain closer usable before `close()`                                   |
| `packages/runtime/src/adapters/node/node-ws-upgrader.ts`           | `writeRawUpgradeResponse`; `rejectRawUpgrade` reasons                  |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`            | `maxPayloadLength`, ceiling report, `server.timeout`, stream failure   |
| `packages/runtime/src/adapters/bun/bun-ws-upgrader.ts`             | ceiling report at the handshake (where the sink is read)               |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`          | ceiling report, `onError`, the no-GOAWAY line                          |
| `packages/runtime/src/adapters/deno/deno-ws-upgrader.ts`           | ceiling report at the handshake                                        |
| `packages/runtime/src/services/cross-runtime.ts`                   | carry `onFatalError` through `mergeRuntimeServices` like `onSignal`    |
| `packages/logger-plugin/src/middleware/request-logger.ts`          | §3.9                                                                   |
| READMEs of kernel, runtime, common, logger-plugin; `PUBLIC_API.md` | the new members, lines and behaviours                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                 | src covered                                       | Key assertions                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel/test/unit/fatal-error-log.test.ts`                | `application.ts` §3.1                             | Subscribes once per start through `runtime.onFatalError`; logs `fatal` `'Process failed'` with origin; unsubscribes on stop and failed start; silent with no logger. |
| `kernel/test/unit/shutdown-log.test.ts`                   | `application.ts` §3.3                             | The three lines, levels and fields; `warn` on timeout and on hook failure; silent with no logger.                                                                    |
| `kernel/test/unit/shutdown-drain.test.ts`                 | `application.ts` §3.4–3.6                         | `drainTimeoutMs` honoured and validated; streamed body holds the drain; `beginDrain` called once after stopping hooks, a throw survived.                             |
| `kernel/test/unit/start-cancel.test.ts`                   | `application.ts` §3.7, `start-cancelled-error.ts` | As §3.7.                                                                                                                                                             |
| `kernel/test/unit/router-head.test.ts`                    | `router.ts`                                       | `match('HEAD')` finds GET; explicit HEAD wins at equal rank; specific GET beats catch-all HEAD.                                                                      |
| `kernel/test/integration/head-requests.test.ts`           | `application.ts` §3.10                            | Empty body, headers kept, streamed body cancelled and its `defer` run.                                                                                               |
| `kernel/test/unit/deferred-abort.test.ts`                 | `deferred.ts`, `request-context.ts`               | As §3.12.                                                                                                                                                            |
| `runtime/test/integration/stream-signal.test.ts`          | (real servers)                                    | As §3.12.                                                                                                                                                            |
| `runtime/test/integration/head-real-server.test.ts`       | (real servers)                                    | As §3.10.                                                                                                                                                            |
| `kernel/test/unit/stream-guard.test.ts`                   | `stream-guard.ts`                                 | Source error logged once with request fields and re-raised.                                                                                                          |
| `runtime/test/unit/fatal-error-observer.test.ts`          | node/bun/deno `*-runtime.ts`, `cross-runtime.ts`  | Each wires its host's mechanism and unsubscribes.                                                                                                                    |
| `runtime/test/e2e/fatal-error-process.test.ts`            | (real path)                                       | Child process: `fatal` JSON line on stdout, exit code and stderr trace as in the control.                                                                            |
| `runtime/test/unit/signals.test.ts`                       | `*-runtime.ts`                                    | `'SIGHUP'` forwarded.                                                                                                                                                |
| `runtime/test/integration/node-drain-goaway.test.ts`      | `node-http-adapter.ts`, `node-http2-listener.ts`  | As §3.6.                                                                                                                                                             |
| `runtime/test/unit/node-ws-upgrader.test.ts`              | `node-ws-upgrader.ts`                             | Writer bytes: reason phrase, headers, length, body; streamed body cancelled.                                                                                         |
| `runtime/test/integration/refused-upgrade-parity.test.ts` | `node-http-adapter.ts` (+ Bun/Deno guarded)       | Same refusal on every runtime installed.                                                                                                                             |
| `runtime/test/unit/bun-http-adapter.test.ts`              | `bun-http-adapter.ts`                             | `maxPayloadLength`, ceiling, `server.timeout(req, 0)` for streams only, stream failure.                                                                              |
| `runtime/test/e2e/bun-idle-stream.test.ts`                | (real Bun)                                        | Silent stream open after 15 s.                                                                                                                                       |
| `runtime/test/unit/deno-http-adapter.test.ts`             | `deno-http-adapter.ts`, `deno-ws-upgrader.ts`     | Ceiling report; `onError` prints nothing; the no-GOAWAY line.                                                                                                        |
| `runtime/test/unit/bun-ws-upgrader.test.ts`               | `bun-ws-upgrader.ts`                              | Ceiling report once.                                                                                                                                                 |
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

- Holding the drain for gRPC streams could slow a stop with a long server stream → the bound caps
  it, it is a setting now, and the drain-finished line names `remaining`.
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
  `drainTimeoutMs: 20_000` in the generated `app.start({ … })` (30 s grace minus 5 s
  `preStopSleepSeconds` leaves 25 s; 20 s of drain leaves 5 s for closing the server and the
  shutdown and close hooks); V13-43 — the generated entry's start catch treats `StartCancelledError`
  as a clean stop (no "Startup failed", exit 0); V13-200 — add `enable_request_signal` to the
  Workers `wrangler.toml` `compatibility_flags`; V13-110 — the full-stack template's `onError`
  should not set `didError` when `request.signal.aborted`.
- **M143c:** V13-23 — `grpcClient` retries an HTTP 503 answer that carries no `grpc-status` from a
  peer (the kernel's drain 503 for a stream that raced GOAWAY).
- **M143m:** V13-43 — `realtime-backplane-plugin` registers its close hook before connecting and
  passes `ctx.signal` to the connect wait.
- **M143o:** V13-41 — the Workers upgrader reports workerd's ceiling the way §3.11 does; V13-200 —
  hand the kernel's abort-time cleanup to `waitUntil` if the workerd proof shows an async cleanup
  cut short.
- **ROADMAP corrections (maintainer):** M143j's "Half of a row owned elsewhere" lists only V13-11,
  V13-12 and V13-200 from M143i; it also needs V13-26 and V13-43 (and V13-11 needs nothing). M143o's
  list needs V13-41 and V13-200. This letter may edit only its own progress row, so the corrections
  go in the report.
- **M143l:** V13-113 — nothing expected (the kernel ranks GET with HEAD); confirm on the full-stack
  app.
- **M143n:** V13-129's `PUBLIC_API.md` half is done here (C4); `docs/deployment.md` shutdown section
  (SIGHUP, `drainTimeoutMs`, the new log lines, streams holding the drain);
  `docs/programmatic-api.md:642` and `docs/ai.md:190` on `ctx.signal` needing
  `enable_request_signal` on Workers.

## 10. Compared with (sibling code and established frameworks)

Added 2026-11-22 after implementation, at the maintainer's request. Facts are from official docs or
source (URLs below); "not confirmed" means no primary source said it. A row marked **question** was
put to the maintainer because the frameworks split, or agree on something other than this plan; all
three were decided on 2026-11-22.

| Decision                                   | This plan                                                                                      | Repository siblings                                                                                                                      | Established frameworks                                                                                                                                                                                                                                                                                  | Verdict                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Uncaught exception / unhandled rejection   | Observe, log one `fatal` line through the logger, process still exits as before (§3.1)         | No package installs a handler (the row's finding)                                                                                        | Node exits 1 by default and calls resuming unsafe; Fastify says crash; close-with-grace hands the error to a callback and always exits; JVM ends the thread                                                                                                                                             | Matches: crash kept, observation only                    |
| SIGHUP as a shutdown signal                | In `RuntimeSignal`; the generated entry adds it (M143j)                                        | The CLI's own `main.ts` handles SIGINT only                                                                                              | NestJS `enableShutdownHooks()` and close-with-grace include SIGHUP; the JVM runs shutdown hooks on it; .NET `ConsoleLifetime` does not list it; Go exits on it with no handler                                                                                                                          | Matches the majority                                     |
| Drain bound and its default                | `StartOptions.drainTimeoutMs`, default 10 000 ms (§3.4)                                        | Generated Kubernetes: 30 s grace, 5 s pre-stop; Deno adapter `close` waits at most 1 s                                                   | Spring Boot 30 s; ASP.NET Core `ShutdownTimeout` 30 s; Kubernetes grace 30 s; close-with-grace 10 s; Fastify and Go have no built-in bound                                                                                                                                                              | **Decided** — keep 10 s (below)                          |
| Draining HTTP/2 / gRPC server, new streams | GOAWAY to every session at drain start, in-flight streams finish, later sessions closed (§3.6) | `grpcClient` retries only a refused stream                                                                                               | grpc-go `GracefulStop` and grpc-java `shutdown()` refuse new RPCs and let in-flight ones finish (grpc-go with a two-step GOAWAY + PING); Kestrel sends a preliminary GOAWAY; Envoy GOAWAY on drain; Node `session.close()` refuses new streams                                                          | Matches (single GOAWAY, as Node's `session.close()`)     |
| Implicit `HEAD` for `GET` routes           | Every `GET` route answers `HEAD` with its headers and no body (§3.10)                          | `static-plugin` answers `HEAD`; `react-router-plugin` routes `HEAD` on its catch-all                                                     | Express, Fastify (`exposeHeadRoutes` true), Hono, Spring MVC and Go 1.22 `ServeMux` all answer `HEAD` from `GET`                                                                                                                                                                                        | Matches                                                  |
| Explicit `HEAD` beside a `GET`             | Ranked together; explicit `HEAD` wins at equal rank, a more specific `GET` beats it (§3.10)    | —                                                                                                                                        | Express and Fastify: explicit `HEAD` wins only if registered before the `GET`; Hono never matches an explicit `HEAD`; Go: most specific pattern wins (HEAD vs GET not confirmed)                                                                                                                        | **Decided** — keep rank-based (below)                    |
| Refused WebSocket upgrade                  | Node writes the pipeline's whole response (§3.8)                                               | Bun and Deno adapters already return the pipeline's response                                                                             | `ws` `abortHandshake` writes status, headers and body; Bun and Deno return the application's `Response`; gorilla/websocket and coder/websocket write an HTTP error response                                                                                                                             | Matches                                                  |
| WebSocket size limit beyond the runtime    | Ceiling not raised; reported once per server at the first handshake asking for more (§3.11)    | `WebSocketPlugin` default 1 MiB, enforced after receipt                                                                                  | `ws` 100 MiB, close 1009; Bun 16 MB, close 1009; Deno fixed 64 MiB, not configurable; uWS 16 KiB; gorilla unlimited; coder 32 KiB                                                                                                                                                                       | Matches (no framework silently raises a runtime ceiling) |
| Quiet response stream on Bun               | `server.timeout(request, 0)` for streamed responses (§3.13)                                    | SSE heartbeat 30 s by default                                                                                                            | Bun's docs recommend `server.timeout(req, 0)` for SSE; Node's request timeouts cover the inbound request; Deno has no such timeout; Go's `WriteTimeout` caps a stream only when set                                                                                                                     | Matches                                                  |
| Request-log status for a client that left  | `499` with `aborted: true`; the line is written before the adapter sends anything (§3.9)       | Telemetry span (`telemetry-plugin`, CLI lane) records the snapshot status: `500` + span error for the same request, `200` for an upgrade | Before any response: nginx 499 (`NGX_HTTP_CLIENT_CLOSED_REQUEST`), Caddy `reverse_proxy` 499, ASP.NET Core 499 (`Status499ClientClosedRequest`); Envoy 0 + `DC`; HAProxy -1 or 400 with `C*` state; pino-http `null` + "request aborted"; morgan `-`. After headers went out, most keep the real status | **Decided** — keep 499 (below)                           |

Sources: https://nodejs.org/api/process.html ·
https://raw.githubusercontent.com/fastify/fastify/main/docs/Reference/Errors.md ·
https://raw.githubusercontent.com/mcollina/close-with-grace/main/README.md ·
https://raw.githubusercontent.com/nestjs/nest/master/packages/common/enums/shutdown-signal.enum.ts ·
https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html ·
https://learn.microsoft.com/en-us/dotnet/core/extensions/generic-host · https://pkg.go.dev/os/signal
· https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html ·
https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions ·
https://kubernetes.io/docs/concepts/workloads/pods/pod-termination/ · https://pkg.go.dev/net/http ·
https://raw.githubusercontent.com/grpc/grpc-go/master/server.go ·
https://grpc.github.io/grpc-java/javadoc/io/grpc/Server.html · https://nodejs.org/api/http2.html ·
https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/draining ·
https://expressjs.com/en/5x/api/router ·
https://raw.githubusercontent.com/fastify/fastify/main/docs/Reference/Server.md ·
https://raw.githubusercontent.com/honojs/hono/main/src/hono-base.ts ·
https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html
· https://raw.githubusercontent.com/websockets/ws/master/lib/websocket-server.js ·
https://bun.com/docs/runtime/http/websockets ·
https://docs.deno.com/api/deno/~/Deno.upgradeWebSocket ·
https://pkg.go.dev/github.com/gorilla/websocket · https://pkg.go.dev/github.com/coder/websocket ·
https://raw.githubusercontent.com/denoland/deno/main/ext/websocket/lib.rs ·
https://bun.com/docs/runtime/http/server · https://nodejs.org/api/http.html ·
https://raw.githubusercontent.com/nginx/nginx/master/src/http/ngx_http_request.h ·
https://raw.githubusercontent.com/caddyserver/caddy/master/modules/caddyhttp/reverseproxy/reverseproxy.go
·
https://raw.githubusercontent.com/dotnet/aspnetcore/main/src/Http/Http.Abstractions/src/StatusCodes.cs
·
https://raw.githubusercontent.com/envoyproxy/envoy/main/docs/root/configuration/advanced/substitution_formatter.rst
· https://raw.githubusercontent.com/haproxy/haproxy/master/doc/configuration.txt ·
https://raw.githubusercontent.com/pinojs/pino-http/master/logger.js

### Decided by the maintainer (2026-11-22: "Go with your recommendations on all of them")

1. **Drain default.** Spring Boot, ASP.NET Core and Kubernetes default to 30 s; close-with-grace to
   10 s; Fastify and Go have none. Decision: keep 10 s. The bound must fit inside the orchestrator's
   grace period minus the pre-stop sleep and the hooks, and a 30 s default would overrun the
   generated 30 s grace; the generated entry sets 20 000 (M143j).
2. **Explicit `HEAD` beside a `GET`.** Express and Fastify let an explicit `HEAD` win only when it
   is registered first; Hono never uses it. Decision: keep rank-based (explicit `HEAD` wins at equal
   rank, a more specific `GET` beats a catch-all `HEAD`): it is order-independent like the rest of
   the kernel's ranking, and it is what makes react-router's assets answer `HEAD` with no plugin
   change.
3. **499 for a client that left.** Before any response is sent, nginx, Caddy and ASP.NET Core log
   499; Envoy logs 0 with `DC`, HAProxy -1 or 400, the Node loggers no code. The request log line is
   written before the adapter sends anything, so an aborted request there is that case. Decision:
   keep `499` with `aborted: true`; the telemetry span is to agree (a CLI-lane half:
   `telemetry-plugin` should record 499 for an aborted request and 101 for an upgrade). As shipped
   the 499 replaces only a 5xx (§3.9), and the kernel's own error line still records the fault, so
   status-based alerting that counts 5xx misses it (security audit, Low; accepted under this
   decision).

The drain decision also asked that the library default and the generated value be stated together,
with the reason, in one place: `PUBLIC_API.md`, "The two drain numbers, in one place"; the
`StartOptions.drainTimeoutMs` JSDoc and the upgrade note point there. The telemetry half (499 and an
unset span status for an aborted request, 101 for an upgrade intent) belongs to M143k, as a new half
for the ROADMAP.

## 11. Design security review

**Status:** completed 2026-11-22, AFTER implementation. The committed-tree audit of `880b61ae6`
found the plan had none (blocking); this section is that review, written from the design decisions
above, and the audit is re-run against it. It does not restate the audit's results as obligations
met.

**Reviewed flows.**

1. A client opens a request and leaves before the response: the adapter's `request.signal` aborts →
   the kernel's abort watch (only when the request called `ctx.defer`) → `ctx.defer` cleanups and
   `Request aborted before completion`; the request logger's 499.
2. A client sends `HEAD` to any path: the router ranks `GET` routes with `HEAD` routes → the matched
   route's middleware and handler → the adapter, `inject()` or `dispatch()` drops the body.
3. A client sends a WebSocket upgrade on Node that the pipeline refuses: the raw `upgrade` socket →
   the pipeline → `writeRawUpgradeResponse` (status, headers, body) or `rejectRawUpgrade`.
4. `stop()` while requests, HTTP/2 sessions and RPC streams are open: `onStopping` hooks →
   `beginDrain` (GOAWAY, idle closes) → the drain bounded by `drainTimeoutMs` → close.
5. `stop()` while `start()` is still registering plugins: `ctx.signal` aborts, `start()` rejects
   with `StartCancelledError`, late registrations are ignored or closed at once.
6. A response stream whose source errors: `guardEmptyChunks` / `wrapDeferredStream` → one
   `Response stream failed` line → each adapter aborts the response.
7. An uncaught exception or unhandled rejection: `onFatalError` → one `Process failed` line → the
   process ends as the runtime would have ended it.

**Assets.** Process availability (it must not be crashed or kept alive against the runtime's rule);
file descriptors and sockets; admission and concurrency limits released through `ctx.defer`;
request-scoped resources (DI request scopes, connections) released through `ctx.defer`; server-side
error text (stream-source errors, fatal errors); the authorization a `GET` route's middleware
enforces; the response headers and body a refused upgrade carries; the operator's view of status
(request log, drain lines).

**Attackers.**

- An anonymous network client: connects and leaves, resets connections (RST) at any point,
  half-closes and never sends FIN, sends `HEAD` to probe guarded routes, sends upgrades to any path.
- A client holding HTTP/2 sessions open across a stop, or opening streams after GOAWAY.
- A stream source or dependency whose error text carries secrets.
- Application code with hostile values: a status no `Response` can carry, header values with CR, LF
  or NUL, hostile error objects reaching `onFatalError`, a `drainTimeoutMs` that is not a whole
  number in range.

**Approved budgets.** `drainTimeoutMs` (default 10 000 ms, at most 2 147 483 647) bounds the drain;
each asynchronous `ctx.defer` cleanup keeps its 5 000 ms bound. A refused upgrade writes one
response and then gives up the socket; it holds no descriptor after its bytes are flushed.

**Obligations on the committed-tree audit.**

1. Reset a refused upgrade's connection after the refusal and while the pipeline decides; prove the
   process survives and still serves (positive control: a later upgrade is answered).
2. Refuse upgrades to a client that never sends FIN; prove the server releases each descriptor
   (positive control: an idle keep-alive connection closed by the server in the same window).
3. Drive the raw refusal writer with statuses no `Response` can carry (NaN, 0, 1xx, 600+, a
   fraction) and with CR, LF and NUL header values; prove the wire never carries them.
4. Leave mid-request while a handler holds a DI request scope and an admission slot released through
   `ctx.defer`; prove what the design states about when those are released, and that
   connect-and-leave clients cannot run more handlers than the limit.
5. Send `HEAD` to a guarded `GET` route without credentials; prove the route's middleware refuses
   it, that an explicit `HEAD` route still wins, and that no other method falls back to `GET`.
6. Plant canaries in a failing stream source's error and in a fatal error; prove none reaches a
   response body, `console.*` or stderr from the framework on Node, Bun and Deno, and that each
   stream failure is logged once.
7. Drive `onFatalError` with hostile error objects and with application `uncaughtException` and
   `unhandledRejection` listeners on Node, Bun and Deno; prove the process ends, or survives,
   exactly as it would with no observer.
8. Stop during a hung startup hook; prove `stop()` is not held and nothing listens afterwards.
9. Hold HTTP/2 sessions across a stop; prove GOAWAY reaches sessions opened before and during the
   drain and that a stream opened after it never reaches a handler.
10. Feed `drainTimeoutMs` hostile values; prove each is refused before any plugin registers and the
    message does not echo the value.
11. Revert each new control in turn and show its probe detects the reversion (negative controls).

**Design-review findings.**

| Threat                                                        | Resolution                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A reset on the raw upgrade socket ends the process            | An `'error'` listener is added the moment the upgrade arrives (`node-http-adapter.ts`).               |
| A refused upgrade's half-open socket holds a descriptor       | The writer ends the socket and destroys it on `'finish'` (`writeRawUpgradeResponse`).                 |
| A hostile status reaches the raw status line                  | A status outside 200–599 is written as 500.                                                           |
| `HEAD` skips a `GET` route's authorization                    | `HEAD` matches the `GET` route itself, so its middleware runs (§3.10).                                |
| Stream-source error text reaches a body or stderr             | One logged line; Node destroys, Bun errors silently, Deno's `onError` stays quiet (§3.14).            |
| The fatal-error observer changes whether the process ends     | Observes only; on Bun it removes itself and raises the rejection again rather than rethrowing (§3.1). |
| Abort-time cleanup releases resources under a running handler | As §3.12 decides (see the maintainer's decision recorded there).                                      |
| A 499 hides a server fault from status-based alerting         | Accepted under decision 3 (§10); the kernel's error line still records the fault.                     |
| Bun streams lose the 10 s idle limit                          | Deliberate parity with Node and Deno (§3.13); a stream's own heartbeat or the drain bound applies.    |
