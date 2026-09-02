# @setu-ts/websocket-plugin

Full-duplex, **bidirectional** real-time messaging behind the Setu-TS capability model. Registers an
`IWebSocketService` under `CAPABILITIES.WEBSOCKET`.

Declare routes with lifecycle handlers, address peers individually or through named **rooms**, and
let the runtime's HTTP adapter perform the RFC 6455 handshake — the same application code runs on
Node, Deno, Bun, and Cloudflare Workers.

## When to use it

Reach for WebSockets when the **client also sends**: chat, collaborative editing, multiplayer state,
live cursors, interactive dashboards with client-driven subscriptions.

When traffic only flows server → client — notifications, progress feeds, log tailing, metric ticks —
prefer [`@setu-ts/sse-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/sse-plugin).
Server-Sent Events run over ordinary HTTP, survive proxies and corporate middleboxes far more
reliably, and reconnect automatically in the browser. A WebSocket buys you an upstream channel at
the cost of all of that.

## Runtime support

| Runtime            | Backing primitive                                 | Upgrade arrives on | Extra dependency |
| ------------------ | ------------------------------------------------- | ------------------ | ---------------- |
| Deno               | `Deno.upgradeWebSocket`                           | the `fetch` path   | none             |
| Cloudflare Workers | `new WebSocketPair()` + a 101 response            | the `fetch` path   | none             |
| Bun                | `server.upgrade` + serve-time `websocket`         | `listen()` only    | none             |
| Node               | the raw `upgrade` event on the `node:http` server | `listen()` only    | `npm:ws@^8`      |

On Node, install `ws` (`npm install ws` / `deno add npm:ws`). It is an **optional** dependency
loaded lazily on the first accepted upgrade, so a plain HTTP application never pulls it in; if it is
missing when an upgrade arrives you get a clear error naming the install command.

Because Bun's `server.upgrade` needs the `Server` instance and its handlers must be supplied at
`Bun.serve()` time, and Node's upgrades never touch `fetch` at all, WebSockets on those two runtimes
require a real listening server (`app.start({ port })`). `app.fetch()` and `app.inject()` serve
ordinary HTTP only.

## Installation

```typescript
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
```

## Usage

### In an application (the form a scaffolded project uses)

Declare your routes in a plugin — an `IPlugin` with `dependencies: [CAPABILITIES.WEBSOCKET]` whose
`register()` receives the live service. This is exactly what `setu generate plugin <name>` emits,
and it is the only form that works inside a CLI-scaffolded project: its generated `setu.config.ts`
forbids starting the server, so there is no post-`start()` moment to resolve the capability from.

```typescript
import type { IPlugin, IPluginContext, IWebSocketService } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';

export class ChatPlugin implements IPlugin {
  readonly name = 'chat';
  readonly version = '1.0.0';
  readonly dependencies = [CAPABILITIES.WEBSOCKET];

  register(ctx: IPluginContext): void {
    const ws = ctx.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    ws.route('/ws/chat', {
      onOpen: (conn, { query }) => {
        // Authenticate here; close(1008) to refuse a peer after the handshake.
        const room = query.room ?? 'lobby';
        conn.data.set('room', room);
        ws.room(room).add(conn);
      },
      onMessage: (conn, data) => {
        const room = conn.data.get('room') as string;
        ws.room(room).broadcast(data, { except: conn });
      },
      onClose: () => {
        // Rooms evict the connection automatically — nothing to clean up here.
      },
      onError: (conn, error) => {
        ctx.logger?.error('socket failed', { id: conn.id, error });
      },
    });
  }
}

// setu.config.ts
export default createApplication({
  plugins: [
    RuntimePlugin(),
    WebSocketPlugin({ heartbeatMs: 30_000, idleTimeoutMs: 90_000 }),
    new ChatPlugin(),
  ],
});
```

### Standalone script

In a plain script you own end to end, resolving the service after `app.start()` works too:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { CAPABILITIES, type IWebSocketService } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    WebSocketPlugin({ heartbeatMs: 30_000, idleTimeoutMs: 90_000 }),
  ],
});
await app.start({ port: 3000 });

const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

ws.route('/ws/chat', {
  onOpen: (conn, { query, headers }) => {
    // Authenticate here; close(1008) to refuse a peer after the handshake.
    const room = query.room ?? 'lobby';
    conn.data.set('room', room);
    ws.room(room).add(conn);
  },
  onMessage: (conn, data) => {
    const room = conn.data.get('room') as string;
    ws.room(room).broadcast(data, { except: conn });
  },
  onClose: (conn, { code, reason }) => {
    // Rooms evict the connection automatically — nothing to clean up here.
  },
  onError: (conn, error) => {
    // A standalone script has no IPluginContext — use your own logger here.
    console.error(`socket ${conn.id} failed`, error);
  },
});
```

## Options

| Option             | Type      | Default  | Description                                                                                    |
| ------------------ | --------- | -------- | ---------------------------------------------------------------------------------------------- |
| `maxConnections`   | `number`  | `0`      | Simultaneous open connections; `0` is unlimited. At the limit, upgrades get `503`.             |
| `heartbeatMs`      | `number`  | `0`      | Heartbeat interval; `0` disables it and creates no timer at all.                               |
| `heartbeatPayload` | `string`  | `'ping'` | The text frame sent each tick. Read only when `heartbeatMs > 0`.                               |
| `idleTimeoutMs`    | `number`  | `0`      | Inbound silence after which a peer is closed with `1001`; `0` disables.                        |
| `maxMessageBytes`  | `number`  | `0`      | Largest inbound frame; `0` is unlimited. A larger frame closes with `1009`.                    |
| `scalingNotice`    | `boolean` | `true`   | Logs one `info` line at startup when no realtime backplane is registered. `false` silences it. |

### Opting a route out of the sweep

A route that speaks its own liveness protocol passes `heartbeat: false`:

```typescript
ws.route('/graphql/ws', handlers, { protocols: ['graphql-transport-ws'], heartbeat: false });
```

That excludes the route's connections from **both** halves of the sweep — the payload send and the
idle eviction — and defaults to `true`, so no existing route is affected. It exists because the
sweeper is global across routes and `heartbeatPayload` is a raw text frame, not a protocol message:
a `graphql-transport-ws` peer that receives one must close the socket with `4400`, and a listen-only
subscriber is inbound-silent by design so `idleTimeoutMs` would evict it.

`idleTimeoutMs` requires `heartbeatMs > 0`, since the heartbeat tick performs the sweep. Configuring
one without the other **throws at construction** rather than silently doing nothing.

## Routing

Routes match on **exact path**. Variable data belongs in the query string and reaches `onOpen` via
`WebSocketConnectionContext.query`:

```typescript
ws.route('/ws/chat', handlers); // matches /ws/chat and /ws/chat?room=general
// does NOT match /ws/chat/general
```

Pattern parameters (`:id`) are deliberately unsupported: the kernel's matcher is internal to
`@setu-ts/kernel`, and hand-rolling a second one would duplicate logic that must not drift.
Registering the same path twice throws.

Subprotocols are opt-in per route and echoed from an allow-list — never blindly reflected back:

```typescript
ws.route('/ws', handlers, { protocols: ['chat', 'json'] });
// client asks for "json, chat" → "json" is echoed
// client asks for "binary"     → handshake refused with 400
```

## Semantics

- **The middleware pipeline runs before the handshake.** Since M70a an upgrade goes through the same
  chain as a `GET /users`. A handshake does need the _native_ `Request`, which the framework's
  request mapping pre-reads — so the kernel keeps an undisturbed copy on `IRequest.raw` and consults
  `IWebSocketService.routeUpgrade` from its terminal handler, after the pipeline has run without
  short-circuiting and **before** route matching, so an application catch-all such as the SSR one
  `ReactRouterPlugin` mounts cannot shadow the upgrade. A guard that answers `401` therefore refuses
  it, metrics apply, and a draining application answers `503`. `setUpgradeRouter` is still the
  adapter seam, but the adapter no longer consults the router: it only needs to know one was
  installed, which is what makes Node attach its raw `upgrade` listener. Non-WebSocket traffic is
  untouched, and a request on an unregistered path falls straight through to your normal routes.
- **An accepted upgrade carries no response headers a middleware wrote.** The adapter answers with
  the runtime's own `101`, so security headers and `Set-Cookie` set on `ctx.response` are not
  carried onto the handshake response. The pipeline still _runs_, which is what lets a guard refuse;
  it just has no response left to decorate once the socket is taken over. A refused upgrade is an
  ordinary HTTP response and carries everything.
- **Authenticate inside `onOpen` — a cookie session is verifiable there.** Browsers cannot set
  headers on a `WebSocket` constructor, so a bearer header never arrives — but a cookie does, and
  the framework now reads it. When `@setu-ts/auth-plugin` runs with a `session` arm (see
  [`packages/auth-plugin/README.md`](https://github.com/setu-ts/setu-ts/tree/main/packages/auth-plugin/README.md)),
  the pipeline authenticates the upgrade before the handshake decides it, so `onOpen`'s
  `context.user` carries the principal the session mapped — `context.user.id` is the peer, and the
  member is omitted entirely when the upgrade was anonymous. To read the session payload itself,
  open it from the upgrade's headers: `await sessions.fromHeaders(context.headers)` (where
  `sessions` is the `ISessionService` resolved from `CAPABILITIES.SESSION`) returns the read-only
  `SessionView` — `{ id, data }` — or `null`. `conn.close(1008)` refuses a peer whose credential
  fails, and a guard in the authentication band refuses the upgrade earlier, before the socket
  opens. The `SessionView` is a snapshot taken at handshake time and never refreshes: a session
  destroyed mid-connection leaves the socket open, so `1008` is the application-side revocation
  path. An application not running `SessionPlugin` can still verify a credential it can check
  directly: a signed token in the query string (keep it short-lived; it lands in URLs and access
  logs) or a subprotocol carrying a nonce your HTTP layer issued.
- **A cookie-authenticated socket is same-site by default — and `sameSite: 'none'` removes that.**
  The session cookie defaults to `sameSite: 'lax'`, and a WebSocket handshake is not a top-level
  navigation, so a `Lax` cookie is not sent on a cross-site upgrade: a cross-site page cannot open a
  cookie-authenticated socket. Setting `cookie.sameSite: 'none'` on `SessionPlugin` removes that
  protection, and the same-origin policy does not cover `WebSocket` — a cross-site page can then
  open the socket and read everything it is sent. If you must run `none`, check the `Origin` header
  in the authentication band (a guard that refuses foreign origins refuses the upgrade before the
  handshake) rather than trusting the cookie alone.
- **The heartbeat is an application-level frame, not an RFC 6455 ping.** Deno and Cloudflare Workers
  expose no `ping()` on their web `WebSocket`, so a protocol ping would silently no-op on half the
  supported runtimes. Your client should treat `heartbeatPayload` as a keep-alive and may reply to
  keep the idle timer fresh — the idle sweep looks only at _inbound_ traffic.
- **`room(name)` is get-or-create; `peek(name)` is the read that is not.** Calling
  `room('board:acme').size` for a name nobody has joined CREATES that room, so a presence or
  dashboard endpoint reporting size for caller-supplied names accumulates one empty room per
  distinct name polled — with nothing to reclaim it until some other socket disconnects (the sweep
  runs on disconnection, so an idle application never reclaims). Use `peek` wherever the name comes
  from a request: it returns the room if one exists and `undefined` otherwise, and registers
  nothing.

  ```typescript
  app.router.get('/presence/:board', (ctx) => {
    const board = ctx.params.board ?? '';
    return ctx.response.json({ present: ws.peek(`board:${board}`)?.size ?? 0 });
  });
  ```
- **Rooms are in-process by default.** `broadcast` skips closed members and drops them, and a room
  that empties is discarded, so a churning connection set does not grow memory. Behind more than one
  replica, register a backplane — see [Scaling beyond one replica](#scaling-beyond-one-replica).
- **Handler errors never escape.** A throw or a rejected promise from any callback is routed to
  `onError` rather than becoming an unhandled rejection.
- **Backpressure is not managed for you.** `send` hands the frame to the platform socket. A slow
  consumer with a fast producer will buffer in the runtime; throttle at the application level.
- **Shutdown.** `onClose` closes every live connection with `1001` (going away) and stops the
  heartbeat timer.

## Scaling beyond one replica

**A room is process-local until you register a backplane.** On a single instance that is invisible.
Behind two or more, `room('lobby').broadcast(...)` reaches only the clients connected to _that_
process — the other replicas' clients hear nothing, and no error is raised anywhere. It is partial
delivery, not a failure, which is what makes it easy to ship.

Registering
[`@setu-ts/realtime-backplane-plugin`](https://github.com/setu-ts/setu-ts/blob/main/packages/realtime-backplane-plugin/README.md)
**with a cross-process transport** is the entire fix. This plugin resolves it _optionally_, so
nothing else changes:

```typescript
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

createApplication({
  plugins: [
    RuntimePlugin(),
    RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://localhost:6379' }),
    WebSocketPlugin(),
  ],
});
```

**The transport matters, not just the plugin.** `RealtimeBackplanePlugin()` defaults to
`transport: 'memory'` — a real bus, but a _single-process_ one. Registering it bare silences the
startup notice described below without fanning anything out. Use `'redis'`, or `'messaging'` to
reuse whichever broker `MessagingPlugin` already registered.

Rooms now fan out across every replica sharing that transport, including
`RoomBroadcastOptions.except` — connection ids are UUIDs, so the exclusion is honored cluster-wide.
Remove the plugin and behavior returns to in-process, with no application change.

Two things stay local by design: `room.size` counts this replica's members only (a cluster-wide
count is inherently asynchronous and cannot satisfy the synchronous getter), and per-connection
`send` is naturally local since the socket lives on one process.

When no backplane is registered this plugin logs one `info` line at startup stating the limitation.
If you are running a single replica, that line is informational and safe to ignore — and if you have
decided single-replica fan-out is correct for this deployment, `scalingNotice: false` silences it:

```typescript
WebSocketPlugin({ scalingNotice: false });
```

That suppresses the message only. Room delivery is identical either way.

## Errors

`WebSocketUnavailableError` is exported for `instanceof` handling. It is thrown by `route()` when
the registered `IHttpAdapter` implements no `setUpgradeRouter` seam — which happens only with a
custom third-party adapter predating the seam. In that state the service still registers and the
health indicator reports `available: false`, so one codebase deploys everywhere; the failure
surfaces at registration rather than at a peer's first connect.

## Health

Registers a `websocket` health indicator reporting `{ available, connections, rooms, routes }`.

## Exports

| Export                       | Kind      |
| ---------------------------- | --------- |
| `buildContext`               | function  |
| `frameByteLength`            | function  |
| `parseRequestedProtocols`    | function  |
| `resolveOptions`             | function  |
| `selectProtocol`             | function  |
| `WebSocketPlugin`            | function  |
| `HeartbeatSweeper`           | class     |
| `Room`                       | class     |
| `RoomRegistry`               | class     |
| `WebSocketConnection`        | class     |
| `WebSocketService`           | class     |
| `WebSocketUnavailableError`  | class     |
| `WsRouteTable`               | class     |
| `CAPABILITIES`               | const     |
| `HeartbeatOptions`           | interface |
| `IWebSocketConnection`       | interface |
| `IWebSocketService`          | interface |
| `IWebSocketTransport`        | interface |
| `LocalBroadcastOptions`      | interface |
| `RoomBroadcastOptions`       | interface |
| `RoomMembershipListener`     | interface |
| `WebSocketCloseEvent`        | interface |
| `WebSocketConnectionContext` | interface |
| `WebSocketEventSink`         | interface |
| `WebSocketHandlers`          | interface |
| `WebSocketPluginOptions`     | interface |
| `WebSocketRoom`              | interface |
| `WebSocketRouteDefinition`   | interface |
| `WebSocketRouteOptions`      | interface |
| `WsRoute`                    | interface |
| `RoomPublisher`              | type      |
| `WebSocketReadyState`        | type      |
| `WebSocketRouteEntry`        | type      |
| `WebSocketUpgradeDecision`   | type      |
| `WebSocketUpgradeRouter`     | type      |
| `WsRouteMatch`               | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#websocketplugin-setu-tswebsocket-plugin).
