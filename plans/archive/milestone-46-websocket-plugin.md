# Milestone 46 — WebSocket Plugin (`@hono-enterprise/websocket-plugin`)

> **Status:** Planning. Branch: `feat/46-websocket-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide full-duplex, bidirectional real-time messaging as an optional plugin, completing the
real-time story the SSE plugin (M43) started one-way. The plugin registers an `IWebSocketService`
under a new `CAPABILITIES.WEBSOCKET = 'websocket'` token: applications declare WebSocket routes with
lifecycle handlers, address connections individually and through named rooms, and get idle-peer
detection — without ever touching a runtime-specific socket API. The handshake itself is performed
by the HTTP adapters in `packages/runtime`, reached through one new optional member on the committed
`IHttpAdapter`; the plugin never creates a server and never imports a runtime API (AI_GUIDELINES
§4.3).

- **In scope:** the `common` WebSocket contract + `WEBSOCKET` token + the `IHttpAdapter`
  `setUpgradeRouter?` widening; upgraders for all four runtimes (Deno, Node, Bun, Cloudflare
  Workers); the plugin with route table, connection registry, rooms, heartbeat/idle sweeper,
  `maxConnections` admission control, health indicator, and shutdown drain.
- **NOT this milestone:** client-side WebSocket helpers and a browser SDK (M35 `sdk`); a
  cross-process / Redis-backed room fan-out (a follow-up M46b, mirroring the M14→M14b split);
  subprotocol negotiation beyond echoing a single chosen protocol; per-message compression
  (`permessage-deflate`); `:param` path patterns on WebSocket routes (§3.4 decides exact-path
  matching); WebSocket route documentation in the OpenAPI spec (OpenAPI 3.1 has no WebSocket
  operation model — AsyncAPI would be its own milestone).

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                            | Verified surface / fact                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IHttpAdapter`                       | `packages/common/src/runtime.ts:283-314`                                                      | Exactly four members: `setHandler(handler)`, `fetch(Request): Promise<Response>`, `listen(port, hostname?): Promise<ServerHandle>`, `close(handle): Promise<void>`. No upgrade seam exists — must be added.        |
| `IRequest`                           | `packages/common/src/http.ts:32-79`                                                           | Carries `method`/`url`/`path`/`headers`/`ip?`/`user?`/`signal?`/`json`/`text`/`bytes`. Carries **no** native `Request`, so a route handler provably cannot perform an upgrade.                                     |
| `mapWebRequestToFrameworkRequest`    | `packages/runtime/src/adapters/shared/fetch-mapping.ts:37`                                    | Calls `await request.arrayBuffer()` on every request — this **disturbs** the body. Combined with the Deno fact below, the upgrade MUST be intercepted before this call.                                            |
| `Deno.upgradeWebSocket`              | `deno types` output, `Deno.upgradeWebSocket` decl (line ~5206)                                | `(request: Request, options?: UpgradeWebSocketOptions) => { socket: WebSocket; response: Response }`. Doc text: _"If the request body is disturbed (read from) before the upgrade is completed, upgrading fails."_ |
| `Deno.UpgradeWebSocketOptions`       | `deno types` output (line ~5130)                                                              | `{ protocol?, idleTimeout?, socket?, head? }` — `protocol` is the subprotocol echo used by §3.7.                                                                                                                   |
| `@hono/node-server` `serve()`        | `~/.cache/deno/npm/registry.npmjs.org/@hono/node-server/2.0.10/dist/index.d.mts:78,46`        | `serve(options, cb?) => ServerType` where `ServerType = node:http.Server \| Http2Server \| Http2SecureServer`. The returned server therefore exposes `.on('upgrade', …)` — the Node interception point.            |
| `@hono/node-server` built-in WS      | `.../@hono/node-server/2.0.10/dist/index.mjs:1019-1063`                                       | Its `websocket: { server }` option drives the handshake through Hono's `c.env` plus private `CONNECTION_SYMBOL_KEY`/`WAIT_FOR_WEBSOCKET_SYMBOL`. Unusable from a bare fetch function — see §2 C2.                  |
| `@hono/node-ws`                      | `~/.cache/deno/npm/registry.npmjs.org/@hono/node-ws/1.3.1/dist/index.d.ts:16,24`              | `createNodeWebSocket({ app: Hono<any,any,any> })` — **requires a concrete Hono app**. `deno info` also reports it peer-deps `@hono/node-server@^1.19.11` while this repo resolves `2.0.10`. Rejected in §3.3.      |
| `ws` (`WebSocketServer`)             | `~/.cache/deno/npm/registry.npmjs.org/ws/8.21.1` (resolved via `deno info npm:@hono/node-ws`) | Version 8.21.1 resolves. Structural surface used: `new WebSocketServer({ noServer: true })`, `.handleUpgrade(req, socket, head, cb)`, `.close()`. Typed structurally per §3.9, never imported for types.           |
| `NodeServeHost` / `NodeServer`       | `packages/runtime/src/adapters/node/node-http-adapter.ts:27-50`                               | `serve()` returns `Promise<NodeServer>`; `NodeServer` currently declares only `close(): void`. Widening it with `on?(…)` is required to reach the `upgrade` event (§3.3).                                          |
| `BunServeHost`                       | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:27-39`                                 | `serve({ port, hostname?, fetch })`; the `fetch` callback is declared **one-arg**. Bun's `server.upgrade` needs the second `server` argument, so the seam must be widened (§3.5).                                  |
| `CloudflareWorkersHttpAdapter`       | `packages/runtime/src/adapters/workers/cf-http-adapter.ts:68`                                 | `listen` throws by design; `fetch` is the only entry point. The Workers upgrade therefore lives purely on the `fetch` path (§3.6).                                                                                 |
| `createCapabilityToken` grammar      | `packages/common/src/tokens.ts:146-147`                                                       | `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.…)*$` — colons illegal. `'websocket'` is a single valid lowercase segment.                                                                                                     |
| `CAPABILITIES`                       | `packages/common/src/tokens.ts:39-118`                                                        | No `WEBSOCKET` key exists today; `SSE: 'sse'` and `HTTP_ADAPTER: 'http-adapter'` do. Adding `WEBSOCKET: 'websocket'` collides with nothing.                                                                        |
| `PluginResolver` duplicate detection | `packages/kernel/src/registry/plugin-resolver.ts`                                             | Duplicate plugin names and duplicate capability providers throw at startup. `WebSocketPlugin` is therefore **single-instance**, claiming the bare `websocket` token exactly once (§3.10).                          |
| `ISseService` (shape precedent)      | `packages/common/src/services/sse.ts:126-148`                                                 | `open(ctx)`, `channel(name)`, `connectionCount`. M46 mirrors this shape for familiarity: `route()`, `room()`, `connectionCount`.                                                                                   |
| `SsePlugin` (plugin precedent)       | `packages/sse-plugin/src/plugin/sse-plugin.ts:38-70`                                          | Reads `ctx.runtime` directly (non-optional), registers the service, registers a health indicator, registers `ctx.lifecycle.onClose`. M46 follows this exact structure.                                             |
| `IRequestContext.state`              | `packages/common/src/http.ts:207`                                                             | `readonly state: Map<string, unknown>` — the committed precedent for app-facing per-request scratch state, justifying `IWebSocketConnection.data` in §4.                                                           |
| `IRuntimeServices` timers            | `packages/common/src/runtime.ts:247-253`                                                      | `setInterval(fn, ms): TimerHandle` / `clearInterval(handle)` — the heartbeat sweeper's only timer source. No bare `setInterval` anywhere (AI_GUIDELINES §4.2).                                                     |
| `IRuntimeServices.uuid` / `hrtime`   | `packages/common/src/runtime.ts:202,225`                                                      | `uuid(): string` for connection ids; `hrtime(): number` monotonic for idle tracking. `now()` is wall-clock and is NOT used for durations (CLAUDE.md clock rule).                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                  | Resolution (picked side)                                                                                   | Doc deliverable (same PR)                                                                                                                                          |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `README.md:105` lists WebSocket as `🚧 Planned`, and `ARCHITECTURE.md:2456` lists a "WebSocket Plugin" as a _future_ extension point. This milestone ships it.                            | Ship it: WebSocket becomes a delivered plugin.                                                             | Flip the `README.md` row to shipped; move the WebSocket row out of the ARCHITECTURE.md future-extension table into the shipped plugin set.                         |
| C2 | `@hono/node-server@2` documents a first-class `websocket: { server }` option, which reads like the sanctioned Node path, but its implementation is Hono-context-coupled (verified in §1). | Do not use it. Attach an own `upgrade` listener to the `ServerType` that `serve()` returns.                | Record the rejection and its reason in the ROADMAP M46 section and in the `node-ws-upgrader.ts` module JSDoc, so the next reader does not re-litigate it.          |
| C3 | `PUBLIC_API.md:4514` lists the Runtime type group without any WebSocket type, and `PUBLIC_API.md:4651-4654` lists the four HTTP adapters with no upgrade surface.                         | The widening is deliberate and public.                                                                     | Add `setUpgradeRouter?` to the `IHttpAdapter` listing, add the WebSocket contract type group to `common`, and add the four upgraders to the runtime export tables. |
| C4 | `ARCHITECTURE.md:2386-2395` shows the WebSocket Plugin hanging directly off `Kernel`, but the verified design has the upgrade seam in `runtime`, not `kernel`.                            | The plugin depends on `common` + the `http-adapter` capability; the kernel is untouched by this milestone. | Correct the ARCHITECTURE.md diagram edge and add a sentence stating the upgrade is an HTTP-adapter concern.                                                        |

## 3. Design decisions

### 3.1 Where the upgrade is intercepted

- **Decision:** Inside each HTTP adapter, **before** `mapWebRequestToFrameworkRequest` runs. One new
  optional member on `IHttpAdapter`: `setUpgradeRouter?(router: WebSocketUpgradeRouter): void`.
- **Why:** Verified in §1 — `IRequest` carries no native request, and the shared mapping disturbs
  the body, which makes `Deno.upgradeWebSocket` fail outright. The adapter is the only component
  holding the native request and owning the serve loop. A single optional member keeps the widening
  minimal and matches the `fs?` (M44) / `workers?` (M45) precedents.
- **Test home:** `test/unit/deno-ws-upgrader.test.ts` asserts the fake
  `DenoServeHost.upgradeWebSocket` is called and that `mapWebRequestToFrameworkRequest` never runs
  for an accepted upgrade (proved by a fake framework handler that records invocations and must stay
  at zero).

### 3.2 The router contract — a decision, not a `Response`

- **Decision:**
  `WebSocketUpgradeRouter = (request: Request) => Promise<WebSocketUpgradeDecision | null>`, where
  `WebSocketUpgradeDecision` is a union discriminated on `accept`:
  `{ accept: true; sink: WebSocketEventSink; protocol?: string }` and
  `{ accept: false; status: number }`. `null` means "not a WebSocket route" and the adapter falls
  through to the ordinary HTTP pipeline unchanged.
- **Why:** A `Response` return would be meaningless on Node, where the handshake happens on a raw
  socket with no `Response` object in play. Returning a decision keeps one uniform plugin-side
  contract while each adapter owns its native handshake.
- **Test home:** `test/unit/ws-route-table.test.ts` (decision shapes) and each adapter's upgrader
  test (accept / reject / fall-through, three cases each).

### 3.3 Node handshake

- **Decision:** Attach an own `server.on('upgrade', …)` listener to the `ServerType` returned by
  `@hono/node-server` `serve()`, and complete the handshake with
  `new WebSocketServer({ noServer: true }).handleUpgrade(req, socket, head, cb)` from `npm:ws@^8`,
  loaded inject-or-lazy through an `adaptWsModule(module)` / `loadWsModule()` seam. `NodeServer`
  gains `on?(event: 'upgrade', listener): void` and `NodeServeHost` is unchanged otherwise.
- **Why:** `@hono/node-ws` demands a concrete `Hono` app and drives the handshake through private
  symbols, and peer-deps a node-server major this repo does not use (both verified in §1); the
  built-in `websocket: { server }` option is Hono-context-coupled for the same reason (C2). The raw
  `upgrade` event uses only public Node APIs. `ws` stays optional per AI_GUIDELINES §12.2.
- **Test home:** `test/unit/node-ws-upgrader.test.ts` (fake `ws` module —
  accept/reject/fall-through, plus the missing-`ws` error path) and
  `test/unit/node-ws-real-import.test.ts` (guarded REAL `import('npm:ws@^8')`, skipped when absent).

### 3.4 WebSocket route matching

- **Decision:** Exact-path matching only. The route table is a `Map<string, WebSocketHandlers>`
  keyed on the URL pathname, built once at `register()` time. Variable data travels in the query
  string and is exposed to `onOpen` through `WebSocketConnectionContext.query`.
- **Why:** The kernel's `parsePattern` lives in `packages/kernel/src/router/route-matcher.ts` and is
  **not** exported from `packages/kernel/src/index.ts`; importing it would violate AI_GUIDELINES
  §2.1 (no reaching into another package's internals), and hand-rolling a second matcher is
  precisely the duplicated-logic defect CLAUDE.md calls out. A `Map` lookup is also O(1) per upgrade
  and hoists all parsing to registration time (AI_GUIDELINES §14).
- **Test home:** `test/unit/ws-route-table.test.ts` — a registered path matches, an unregistered
  path returns `null`, and a path differing only by query string still matches.

### 3.5 Bun handshake

- **Decision:** Widen `BunServeHost.serve`'s `fetch` callback to
  `(request, server) => Response | undefined | Promise<…>` and add a serve-time `websocket` handler
  object. On accept, call `server.upgrade(request, { data: { sink } })` and return `undefined`; the
  serve-time handlers route `open`/`message`/`close` back through `ws.data.sink`.
- **Why:** Bun's upgrade is intrinsically out-of-band — `server.upgrade` needs the `Server` instance
  (only reachable as the fetch callback's second argument) and the handlers must be supplied at
  `Bun.serve()` time. `IHttpAdapter.fetch` keeps its `Promise<Response>` signature; only the
  internal callback handed to `Bun.serve` widens, so no committed contract changes.
- **Test home:** `test/unit/bun-ws-upgrader.test.ts` drives a fake `BunServeHost` and asserts
  `server.upgrade` was called with the sink and that the callback resolved `undefined`.

### 3.6 Cloudflare Workers handshake

- **Decision:** On accept, call an injectable `CloudflareWebSocketHost.createPair()` (defaulting to
  a single boundary cast over the `WebSocketPair` global, matching `cf-runtime.ts`'s established
  pattern), call `server.accept()`, bind the sink, and return
  `new Response(null, { status: 101, webSocket: client })` via an injectable response factory.
- **Why:** Workers has no socket model (`listen` throws by design, verified in §1), so `fetch` is
  the sole path. The injectable pair factory keeps the branch unit-testable off-Workers, which is
  the only way this file clears the 90% bar.
- **Test home:** `test/unit/cf-ws-upgrader.test.ts` — accept returns a 101 carrying the client
  socket, reject returns the decision's status, `null` falls through.

### 3.7 Subprotocol negotiation

- **Decision:** Single-value echo only. When a decision carries `protocol`, the adapter passes it to
  the runtime's native protocol slot (`Deno.upgradeWebSocket(request, { protocol })`, `ws`'s
  handshake callback, Bun's upgrade options, the Workers response header). The plugin selects it by
  taking the first entry of the request's `Sec-WebSocket-Protocol` list that appears in the route's
  configured `protocols` array; no match with a non-empty configured list rejects with 400.
- **Why:** Echoing an unrequested protocol breaks conformant clients, and full negotiation is not
  needed by any planned consumer. Selecting from a configured allow-list is the secure default
  (AI_GUIDELINES §13.4).
- **Test home:** `test/unit/ws-route-table.test.ts` — configured-and-requested selects,
  requested-but-not-configured rejects 400, no configured list echoes nothing.

### 3.8 Heartbeat and idle detection

- **Decision:** Application-level, not protocol ping frames. Two options, both consumed by
  `HeartbeatSweeper`: `heartbeatMs` sends the configured `heartbeatPayload` (default `'ping'`) to
  every open connection on an interval, and `idleTimeoutMs` closes any connection whose last
  **inbound** message is older than the timeout with code `1001`. Both use `runtime.setInterval` and
  monotonic `runtime.hrtime()`.
- **Why:** The web `WebSocket` API exposed by Deno and Workers has no `ping()` method — only `ws`
  and Bun do — so a protocol-ping heartbeat is not portable and would silently no-op on two of four
  runtimes. An application-level heartbeat behaves identically everywhere. `hrtime()` (monotonic) is
  mandatory here; `now()` would mix clocks (CLAUDE.md).
- **Test home:** `test/unit/heartbeat.test.ts` with a fake runtime whose `setInterval` captures the
  callback and whose `hrtime()` is advanced manually — asserts payload delivery, idle close at the
  threshold, and that a connection receiving traffic is not closed.

### 3.9 External-type policy for `ws`

- **Decision:** Declare a minimal structural `WsModuleLike` / `WsServerLike` / `WsSocketLike` in the
  runtime package and adapt the imported module through `adaptWsModule(module: unknown)`. Never
  import `ws` types.
- **Why:** `@types/ws` is not a dependency of this repo and adding one for a §12.2 optional driver
  is unjustified; the structural-facade pattern is already established by
  `SmtpProvider`/`ISesClient` (M29) and `cf-runtime.ts`.
- **Test home:** `test/unit/node-ws-upgrader.test.ts` passes a hand-built fake module through
  `adaptWsModule`; the guarded real-import test proves the real module satisfies the same shape.

### 3.10 Plugin instance count and token ownership

- **Decision:** `WebSocketPlugin` is single-instance, `name: 'websocket-plugin'`,
  `provides: [CAPABILITIES.WEBSOCKET]`, `optionalDependencies: ['logger']`, priority `NORMAL`.
- **Why:** `PluginResolver` throws on duplicate plugin names and duplicate capability providers
  (verified in §1), and there is no coherent meaning for two competing socket hubs on one server.
- **Test home:** `test/integration/websocket-integration.test.ts` — the service resolves from
  `CAPABILITIES.WEBSOCKET`, and registering the plugin twice throws at startup.

### 3.11 Behavior when the adapter cannot upgrade

- **Decision:** The plugin probes `typeof adapter.setUpgradeRouter === 'function'`. When absent, it
  still registers the service and the health indicator (reporting `available: false`), and
  `service.route(...)` throws `WebSocketUnavailableError`.
- **Why:** Mirrors the M45 `WorkerPoolUnavailableError` precedent so one codebase deploys
  everywhere; a custom third-party adapter that predates this widening must not crash an application
  at startup. Throwing at `route()` (registration) rather than at connect time surfaces the problem
  immediately.
- **Test home:** `test/unit/websocket-plugin.test.ts` — a fake adapter without `setUpgradeRouter`
  registers cleanly, health reports `available: false`, and `route()` throws.

### 3.12 Admission control

- **Decision:** `maxConnections` (default `0`, meaning unlimited) is checked in the router before
  accepting; over the limit returns `{ accept: false, status: 503 }`.
- **Why:** An unbounded socket registry is a memory-exhaustion vector, and the reject path must
  exist before rooms can be trusted at scale (AI_GUIDELINES §13.4, §14.5).
- **Test home:** `test/unit/websocket-service.test.ts` — the connection at the limit is accepted,
  the next is rejected 503, and after one closes a new connection is accepted again.

## 4. Exported surface — every symbol names its consumer

### 4.1 `@hono-enterprise/common` (contract additions)

| Exported symbol                  | Kind              | Consumer / real code path that READS it                                                                          |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.WEBSOCKET`         | token             | `WebSocketPlugin.provides` + `ctx.services.register`; resolved by application code and the integration test.     |
| `IWebSocketService`              | interface         | Implemented by `WebSocketService`; the type argument of `ctx.services.get` in the integration and e2e tests.     |
| `IWebSocketConnection`           | interface         | Implemented by `WebSocketConnection`; passed to every `WebSocketHandlers` callback and stored by `RoomRegistry`. |
| `WebSocketRoom`                  | interface         | Implemented by `Room`; returned by `IWebSocketService.room()` and used by the e2e broadcast test.                |
| `WebSocketHandlers`              | interface         | The second argument of `IWebSocketService.route()`; invoked by `WebSocketService` on every socket event.         |
| `WebSocketConnectionContext`     | interface         | Built by `WebSocketService` from the upgrade request; the second argument of `onOpen`.                           |
| `WebSocketCloseEvent`            | interface         | Constructed by every upgrader's sink `onClose`; the second argument of `WebSocketHandlers.onClose`.              |
| `WebSocketReadyState`            | type              | The `readyState` of `IWebSocketConnection`/`IWebSocketTransport`; branched on by `WebSocketConnection.isOpen`.   |
| `IWebSocketTransport`            | interface         | Implemented per runtime by each upgrader; held by `WebSocketConnection` and called by `send`/`close`.            |
| `WebSocketEventSink`             | interface         | Built by `WebSocketService`, passed inside the accept decision, and invoked by all four upgraders.               |
| `WebSocketUpgradeDecision`       | type              | Returned by `WebSocketUpgradeRouter`; branched on by all four upgraders (`accept` true/false).                   |
| `WebSocketUpgradeRouter`         | type              | The parameter type of `IHttpAdapter.setUpgradeRouter`; stored and called by all four adapters.                   |
| `IHttpAdapter.setUpgradeRouter?` | method (widening) | Called by `WebSocketPlugin.register`; implemented by all four adapters.                                          |

### 4.2 `@hono-enterprise/runtime` (upgrader additions)

| Exported symbol                                | Kind              | Consumer / real code path that READS it                                                                          |
| ---------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `isWebSocketUpgradeRequest`                    | function          | Called by all four adapters to decide whether to consult the router at all; shared to avoid four copies (§11.1). |
| `adaptWsModule`                                | function          | Called by `loadWsModule` and directly by the Node upgrader unit test with a fake module.                         |
| `WsModuleLike`                                 | interface         | The parameter type of `adaptWsModule`; implemented by the test fake and satisfied by real `ws`.                  |
| `CloudflareWebSocketHost`                      | interface         | The injectable seam of the Workers upgrader; a fake implements it in the unit test.                              |
| `DenoServeHost.upgradeWebSocket`               | method (widening) | Called by the Deno adapter's upgrade path; faked in its unit test.                                               |
| `BunServeHost` (widened `fetch` + `websocket`) | interface         | Consumed by `BunHttpAdapter.listen`; faked in its unit test.                                                     |
| `NodeServer.on?`                               | method (widening) | Called by `NodeHttpAdapter.listen` to attach the `upgrade` listener; faked in its unit test.                     |

### 4.3 `@hono-enterprise/websocket-plugin`

| Exported symbol             | Kind  | Consumer / real code path that READS it                                                                                  |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketPlugin`           | fn    | Registered by application code; driven by the integration and e2e tests.                                                 |
| `WebSocketService`          | class | Registered under `CAPABILITIES.WEBSOCKET` by the plugin; exported so applications can subclass-free compose it in tests. |
| `WebSocketUnavailableError` | class | Thrown by `WebSocketService.route()` when no upgrade seam exists; asserted with `instanceof` in the plugin unit test.    |
| `WebSocketPluginOptions`    | type  | The parameter type of `WebSocketPlugin`; every field consumed per §4.4.                                                  |

### 4.4 Options — every option names its consumer

| Option             | Consumer                                     | Behavior (per implementation)                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxConnections`   | `WebSocketService.#admit` (router path)      | `0` (default) is unlimited; at the limit the router returns `{ accept: false, status: 503 }` and no socket is created.                                                                                                                                                                                                   |
| `heartbeatMs`      | `HeartbeatSweeper` via `runtime.setInterval` | `0` (default) disables the interval entirely (no timer is created). Above `0`, sends `heartbeatPayload` to every open connection each tick.                                                                                                                                                                              |
| `heartbeatPayload` | `HeartbeatSweeper` tick                      | The exact text frame sent on each heartbeat tick. Defaults to `'ping'`. Read only when `heartbeatMs > 0`.                                                                                                                                                                                                                |
| `idleTimeoutMs`    | `HeartbeatSweeper` tick                      | `0` (default) disables idle closing. Above `0`, a connection whose monotonic last-inbound age exceeds it is closed with code `1001`. Requires `heartbeatMs > 0` to have a tick to run on; the plugin throws at `register()` when `idleTimeoutMs > 0` and `heartbeatMs === 0`, so the option can never be silently inert. |
| `maxMessageBytes`  | `WebSocketService` sink `onMessage`          | `0` (default) is unlimited. Above `0`, an inbound frame larger than the limit closes the connection with code `1009` and `onMessage` is not invoked.                                                                                                                                                                     |

## 5. Implementation files

### 5.1 `packages/common`

| File                        | Purpose                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/websocket.ts` | New. The whole WebSocket contract group listed in §4.1 (service, connection, room, handlers, sink, transport, decision, router). |
| `src/runtime.ts`            | Edit. Add the optional `setUpgradeRouter?` member to `IHttpAdapter`, importing the router type.                                  |
| `src/tokens.ts`             | Edit. Add `WEBSOCKET: 'websocket'` to `CAPABILITIES`.                                                                            |
| `src/index.ts`              | Edit. Re-export the new contract group.                                                                                          |

### 5.2 `packages/runtime`

| File                                          | Purpose                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/shared/upgrade-detection.ts`    | New. `isWebSocketUpgradeRequest(headers)` — the single shared `Upgrade: websocket` + `Connection` check.                                                   |
| `src/adapters/shared/upgrade-router-store.ts` | New. `UpgradeRouterStore` — the tiny store/consult helper the four adapters share, so router storage and the accept/reject/fall-through branch exist once. |
| `src/adapters/deno/deno-ws-upgrader.ts`       | New. Deno handshake over the widened `DenoServeHost.upgradeWebSocket`; builds an `IWebSocketTransport` from the native `WebSocket`.                        |
| `src/adapters/node/node-ws-upgrader.ts`       | New. `adaptWsModule`/`loadWsModule` + the `upgrade`-event handshake and transport.                                                                         |
| `src/adapters/bun/bun-ws-upgrader.ts`         | New. `server.upgrade` accept path and the serve-time `websocket` handler object.                                                                           |
| `src/adapters/workers/cf-ws-upgrader.ts`      | New. `CloudflareWebSocketHost` seam, `WebSocketPair` accept path, 101 response.                                                                            |
| `src/adapters/deno/deno-http-adapter.ts`      | Edit. Widen `DenoServeHost`, add `setUpgradeRouter`, consult the router before the shared mapping.                                                         |
| `src/adapters/node/node-http-adapter.ts`      | Edit. Widen `NodeServer`, add `setUpgradeRouter`, attach the `upgrade` listener in `listen`.                                                               |
| `src/adapters/bun/bun-http-adapter.ts`        | Edit. Widen `BunServeHost`, add `setUpgradeRouter`, pass the serve-time `websocket` handlers.                                                              |
| `src/adapters/workers/cf-http-adapter.ts`     | Edit. Add `setUpgradeRouter`, consult the router in `fetch`.                                                                                               |
| `src/index.ts`                                | Edit. Export the symbols listed in §4.2.                                                                                                                   |

### 5.3 `packages/websocket-plugin`

| File                                     | Purpose                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                           | Barrel exports (§4.3).                                                                                                                  |
| `src/plugin/websocket-plugin.ts`         | `WebSocketPlugin` factory: resolves the adapter, builds the service, installs the router, registers the health indicator and `onClose`. |
| `src/services/websocket-service.ts`      | `WebSocketService` — route table owner, admission control, sink construction, connection registry.                                      |
| `src/routing/ws-route-table.ts`          | Exact-path route map + subprotocol selection (§3.4, §3.7).                                                                              |
| `src/connection/websocket-connection.ts` | `WebSocketConnection` over an `IWebSocketTransport`: id, `data`, `send`/`sendJson`/`close`, idle stamp.                                 |
| `src/rooms/room-registry.ts`             | `RoomRegistry` + `Room`: membership, broadcast with `except`, automatic removal on close.                                               |
| `src/heartbeat/heartbeat.ts`             | `HeartbeatSweeper` — the interval tick implementing `heartbeatMs`/`idleTimeoutMs` (§3.8).                                               |
| `src/errors/websocket-errors.ts`         | `WebSocketUnavailableError`.                                                                                                            |
| `src/interfaces/index.ts`                | `WebSocketPluginOptions` (§4.4).                                                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                         | src covered                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/websocket-contract.test.ts`                     | `common/src/services/websocket.ts`, `tokens.ts`    | `CAPABILITIES.WEBSOCKET === 'websocket'` and it survives `createCapabilityToken`; the decision union narrows on `accept`.                                                                                                                                                                |
| `runtime/test/unit/upgrade-detection.test.ts`                     | `shared/upgrade-detection.ts`                      | Header casing variants, `Connection: keep-alive, Upgrade`, absent headers. Calls `isWebSocketUpgradeRequest(headers: Headers): boolean`.                                                                                                                                                 |
| `runtime/test/unit/upgrade-router-store.test.ts`                  | `shared/upgrade-router-store.ts`                   | Store-then-consult returns the decision; no router stored returns `null`; a throwing router surfaces as a reject rather than a crash.                                                                                                                                                    |
| `runtime/test/unit/deno-ws-upgrader.test.ts`                      | `deno/deno-ws-upgrader.ts`, `deno-http-adapter.ts` | Accept calls the fake `upgradeWebSocket(request, { protocol })` and returns its `response`; the framework handler records **zero** calls (proves §3.1); reject returns the status; `null` falls through to the normal handler.                                                           |
| `runtime/test/unit/node-ws-upgrader.test.ts`                      | `node/node-ws-upgrader.ts`, `node-http-adapter.ts` | `adaptWsModule(fakeModule)` then accept calls `handleUpgrade(req, socket, head, cb)` and binds the sink; reject writes a status line to the fake socket; absent `ws` throws the documented error.                                                                                        |
| `runtime/test/unit/node-ws-real-import.test.ts`                   | the one lazy `import('npm:ws@^8')` line            | Guarded REAL import; asserts the real module satisfies `WsModuleLike` (constructs a `noServer` server and closes it). Skipped when `ws` is unavailable.                                                                                                                                  |
| `runtime/test/unit/bun-ws-upgrader.test.ts`                       | `bun/bun-ws-upgrader.ts`, `bun-http-adapter.ts`    | Accept calls `server.upgrade(request, { data })` and the fetch callback resolves `undefined`; the serve-time `websocket.message` handler routes to the sink.                                                                                                                             |
| `runtime/test/unit/cf-ws-upgrader.test.ts`                        | `workers/cf-ws-upgrader.ts`, `cf-http-adapter.ts`  | Accept returns status 101 carrying the client socket and calls `server.accept()`; reject returns the status; `null` falls through.                                                                                                                                                       |
| `websocket-plugin/test/unit/ws-route-table.test.ts`               | `src/routing/ws-route-table.ts`                    | Exact match hit/miss; query string ignored; the three subprotocol cases from §3.7.                                                                                                                                                                                                       |
| `websocket-plugin/test/unit/websocket-connection.test.ts`         | `src/connection/websocket-connection.ts`           | `send`/`sendJson` reach the fake transport; `close` is idempotent; `send` after close throws; `data` round-trips; the idle stamp advances on inbound.                                                                                                                                    |
| `websocket-plugin/test/unit/room-registry.test.ts`                | `src/rooms/room-registry.ts`                       | Broadcast reaches every open member; `except` omits one; a closed member is skipped and auto-removed; `size` tracks membership.                                                                                                                                                          |
| `websocket-plugin/test/unit/heartbeat.test.ts`                    | `src/heartbeat/heartbeat.ts`                       | `heartbeatMs: 0` creates no timer; a tick sends `heartbeatPayload`; an idle connection closes with `1001`; an active one does not. Fake runtime advances `hrtime()`.                                                                                                                     |
| `websocket-plugin/test/unit/websocket-service.test.ts`            | `src/services/websocket-service.ts`                | Route dispatch to all four handlers; `maxConnections` accept/503/re-accept; `maxMessageBytes` closes with `1009` and suppresses `onMessage`; `connectionCount` tracks.                                                                                                                   |
| `websocket-plugin/test/unit/websocket-plugin.test.ts`             | `src/plugin/websocket-plugin.ts`, `errors`         | Registers under the token; installs the router on a fake adapter; health `available` both ways; adapter without `setUpgradeRouter` makes `route()` throw `WebSocketUnavailableError`; `onClose` closes all with `1001`; `idleTimeoutMs > 0` with `heartbeatMs === 0` throws at register. |
| `websocket-plugin/test/unit/barrel-exports.test.ts`               | `src/index.ts`, `src/interfaces/index.ts`          | Every §4.3 symbol is exported and defined (mirrors the sse-plugin precedent).                                                                                                                                                                                                            |
| `websocket-plugin/test/integration/websocket-integration.test.ts` | plugin ↔ kernel wiring                             | Service resolves from `CAPABILITIES.WEBSOCKET` in a real kernel app; duplicate registration throws; a non-WebSocket request still routes normally through the pipeline.                                                                                                                  |
| `websocket-plugin/test/e2e/websocket-e2e.test.ts`                 | the REAL path, end to end                          | On Deno: `app.start({ port: 0 })`, connect a genuine `new WebSocket(...)` client, assert echo, room broadcast to two clients, `data` set in `onOpen` read during broadcast, and clean close on `app.stop()`. This is the "exercise the REAL path once" evidence.                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/46-websocket-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/websocket-plugin/src packages/runtime/src
```

## 8. Risks & mitigations

- **The `IHttpAdapter` widening is a committed public contract change.** → It is optional, so every
  existing implementation (including third-party ones) still type-checks; §3.11 defines the
  documented degraded behavior when it is absent, and that path is tested.
- **A third-party adapter cannot be upgraded and the failure is silent.** → The health indicator
  reports `available: false` and `route()` throws at registration rather than at first connect.
- **`ws` is absent in a Node deployment.** → `loadWsModule` throws a named error stating the exact
  install command; the branch around the import is unit-tested through `adaptWsModule`, and the
  import line itself has the guarded real-import test.
- **Bun and Workers cannot be executed by this repo's Deno test runner.** → Both are driven entirely
  through injected host seams with fakes, exactly as the existing `BunHttpAdapter` tests do; the
  real path is proven on Deno by the e2e test.
- **Socket leak on shutdown.** → `onClose` closes every registered connection with `1001` and clears
  the heartbeat interval; the plugin unit test asserts both (AI_GUIDELINES §14.5).
- **An unbounded room registry grows forever as connections churn.** → `Room.remove` is called from
  the connection's close path and empty rooms are dropped from the registry; asserted in
  `room-registry.test.ts`.

## 9. Out of scope

- **Cross-process room fan-out** (a Redis-backed room adapter so rooms span replicas) — deferred to
  a follow-up M46b, mirroring the M14→M14b broker split. In-process rooms only in M46.
- **A browser/client SDK** for connecting to these endpoints — owned by M35 (`sdk`).
- **`permessage-deflate` compression** and multi-value subprotocol negotiation — no planned
  consumer; §3.7 ships single-value echo.
- **`:param` path patterns on WebSocket routes** — §3.4 decides exact-path matching; adding patterns
  would require a matcher `packages/kernel` does not export.
- **AsyncAPI / OpenAPI documentation of WebSocket endpoints** — OpenAPI 3.1 has no WebSocket
  operation model; a documentation milestone (M38) would own any AsyncAPI work.
- **Authentication of the upgrade request** — applications inspect
  `WebSocketConnectionContext.headers` in `onOpen` and call `close(1008)` themselves; the
  auth-plugin (M16) owns credential verification and is resolved by application code, not by this
  plugin.
