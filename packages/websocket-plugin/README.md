# @hono-enterprise/websocket-plugin

Full-duplex, **bidirectional** real-time messaging behind the Hono Enterprise capability model.
Registers an `IWebSocketService` under `CAPABILITIES.WEBSOCKET`.

Declare routes with lifecycle handlers, address peers individually or through named **rooms**, and
let the runtime's HTTP adapter perform the RFC 6455 handshake — the same application code runs on
Node, Deno, Bun, and Cloudflare Workers.

## When to use it

Reach for WebSockets when the **client also sends**: chat, collaborative editing, multiplayer state,
live cursors, interactive dashboards with client-driven subscriptions.

When traffic only flows server → client — notifications, progress feeds, log tailing, metric ticks —
prefer
[`@hono-enterprise/sse-plugin`](https://github.com/dkpaul91/hono-enterprise/tree/main/packages/sse-plugin).
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
import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
import { CAPABILITIES, type IWebSocketService } from '@hono-enterprise/common';

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
    logger.error('socket failed', { id: conn.id, error });
  },
});
```

## Options

| Option             | Type     | Default  | Description                                                                        |
| ------------------ | -------- | -------- | ---------------------------------------------------------------------------------- |
| `maxConnections`   | `number` | `0`      | Simultaneous open connections; `0` is unlimited. At the limit, upgrades get `503`. |
| `heartbeatMs`      | `number` | `0`      | Heartbeat interval; `0` disables it and creates no timer at all.                   |
| `heartbeatPayload` | `string` | `'ping'` | The text frame sent each tick. Read only when `heartbeatMs > 0`.                   |
| `idleTimeoutMs`    | `number` | `0`      | Inbound silence after which a peer is closed with `1001`; `0` disables.            |
| `maxMessageBytes`  | `number` | `0`      | Largest inbound frame; `0` is unlimited. A larger frame closes with `1009`.        |

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
`@hono-enterprise/kernel`, and hand-rolling a second one would duplicate logic that must not drift.
Registering the same path twice throws.

Subprotocols are opt-in per route and echoed from an allow-list — never blindly reflected back:

```typescript
ws.route('/ws', handlers, { protocols: ['chat', 'json'] });
// client asks for "json, chat" → "json" is echoed
// client asks for "binary"     → handshake refused with 400
```

## Semantics

- **Upgrades bypass the middleware pipeline, by design.** A handshake needs the _native_ `Request`,
  and the framework's request mapping pre-reads the body — which makes `Deno.upgradeWebSocket` fail
  outright. The adapter therefore consults the plugin's upgrade router first, and only for requests
  carrying WebSocket upgrade headers. Non-WebSocket traffic is untouched, and a request on an
  unregistered path falls straight through to your normal routes.
- **Authenticate inside `onOpen`.** Browsers cannot set headers on a `WebSocket` constructor, so
  carry the credential in a cookie, a query parameter, or a subprotocol, verify it in `onOpen`, and
  `conn.close(1008)` to refuse.
- **The heartbeat is an application-level frame, not an RFC 6455 ping.** Deno and Cloudflare Workers
  expose no `ping()` on their web `WebSocket`, so a protocol ping would silently no-op on half the
  supported runtimes. Your client should treat `heartbeatPayload` as a keep-alive and may reply to
  keep the idle timer fresh — the idle sweep looks only at _inbound_ traffic.
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
[`@hono-enterprise/realtime-backplane-plugin`](https://github.com/dkpaul91/hono-enterprise/blob/main/packages/realtime-backplane-plugin/README.md)
**with a cross-process transport** is the entire fix. This plugin resolves it _optionally_, so
nothing else changes:

```typescript
import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';

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
If you are running a single replica, that line is informational and safe to ignore.

## Errors

`WebSocketUnavailableError` is exported for `instanceof` handling. It is thrown by `route()` when
the registered `IHttpAdapter` implements no `setUpgradeRouter` seam — which happens only with a
custom third-party adapter predating the seam. In that state the service still registers and the
health indicator reports `available: false`, so one codebase deploys everywhere; the failure
surfaces at registration rather than at a peer's first connect.

## Health

Registers a `websocket` health indicator reporting `{ available, connections, rooms, routes }`.
