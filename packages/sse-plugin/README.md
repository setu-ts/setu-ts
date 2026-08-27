# @setu-ts/sse-plugin

Server-Sent Events — one-way, server → client streaming over `text/event-stream`. Registers an
`ISseService` under `CAPABILITIES.SSE` (`'sse'`).

Zero dependencies, built on `IResponse.stream()` and `IRequestContext.signal`.

## When to use it

SSE runs over ordinary HTTP: it survives proxies and corporate middleboxes far more reliably than a
socket upgrade, and browsers reconnect automatically. Reach for it whenever traffic only flows
server → client — notifications, progress feeds, log tailing, metric ticks.

When the client also needs to **send**, use
[`@setu-ts/websocket-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/websocket-plugin).

## Installation

```typescript
import { SsePlugin } from '@setu-ts/sse-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { CAPABILITIES, type ISseService } from '@setu-ts/common';

const app = createApplication({
  plugins: [RuntimePlugin(), SsePlugin({ heartbeatMs: 15_000, retryMs: 3_000 })],
});
await app.start({ port: 3000 });

app.router.get('/events', async (ctx) => {
  const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
  const conn = sse.open(ctx);
  conn.send({ id: '1', data: 'hello world' });
  return conn.result;
});
```

## Named channels

```typescript
const deploys = sse.channel('deploys');
deploys.publish({ data: JSON.stringify({ build: 412, status: 'live' }) });
```

**`channel(name)` is get-or-create.** First call creates the channel; every later call with the same
name returns it. There is no non-creating lookup, so code that reads `channel(name).size` for an
arbitrary caller-supplied name creates one channel per distinct name — and a never-published channel
is reclaimed only when another connection closes somewhere in this process. Keep polled names to a
fixed set.

## Scaling beyond one replica

**A channel is process-local until you register a backplane.** On a single instance that is
invisible. Behind two or more, `channel('deploys').publish(...)` reaches only the clients connected
to _that_ process — the other replicas' subscribers hear nothing, and no error is raised anywhere.
It is partial delivery, not a failure, which is what makes it easy to ship.

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
    SsePlugin(),
  ],
});
```

**The transport matters, not just the plugin.** `RealtimeBackplanePlugin()` defaults to
`transport: 'memory'` — a real bus, but a _single-process_ one. Registering it bare silences the
startup notice described below without fanning anything out. Use `'redis'`, or `'messaging'` to
reuse whichever broker `MessagingPlugin` already registered.

Channels now fan out across every replica sharing that transport. Remove the plugin and behavior
returns to in-process, with no application change. `channel.size` stays local by design: it counts
this replica's subscribers, because a cluster-wide count is inherently asynchronous and cannot
satisfy the synchronous getter.

When no backplane is registered this plugin logs one `info` line at startup stating the limitation.
If you are running a single replica, that line is informational and safe to ignore — and if you have
decided single-replica fan-out is correct for this deployment, `scalingNotice: false` silences it:

```typescript
SsePlugin({ scalingNotice: false });
```

That suppresses the message only. Channel delivery is identical either way.

## Options

| Option          | Type      | Default  | Description                                                                                    |
| --------------- | --------- | -------- | ---------------------------------------------------------------------------------------------- |
| `heartbeatMs`   | `number`  | disabled | Interval for a `: heartbeat` comment frame. Omitted means **no timer at all**.                 |
| `retryMs`       | `number`  | disabled | Emits a leading `retry: <ms>` advertising the reconnect delay.                                 |
| `scalingNotice` | `boolean` | `true`   | Logs one `info` line at startup when no realtime backplane is registered. `false` silences it. |

## Reconnection

A reconnecting browser sends `Last-Event-ID`. Set `id` on the messages you send so a client can
resume from where it dropped.

## Authentication

`EventSource` is the only browser API for this transport, and it can send exactly one credential: a
cookie — no `Authorization` header, no custom header at all. So an `EventSource` behind
`requireAuth()` is `401`ed unless a strategy reads the cookie. The plugin needs no source change for
this: `SsePlugin.register` registers no kernel route, the application owns the route, and
`SseService.open(ctx)` receives the live `IRequestContext` — so once a cookie-bearing request
produces a principal, `requireAuth()` on the route admits an `EventSource` exactly as it admits a
`fetch`.

Configure the session arm on `@setu-ts/auth-plugin` and guard the route:

- `SessionPlugin` (from `@setu-ts/session-plugin`) registers the session middleware at priority 260.
- `AuthPlugin({ jwt: { … }, session: { toPrincipal } })` — `toPrincipal(view)` maps the opened
  `SessionView` to the principal it carries, or returns `null` when the session holds no identity.
  Without `SessionPlugin` registered, `AuthPlugin` throws at `register()` naming both plugins.
- `app.middleware.add(authMiddleware(), { priority: 300 })` — the authentication band; a bare
  `add()` would take the kernel default of 500 and run after it.
- The route itself: `app.router.get('/events', { middleware: [requireAuth()], handler })`, where the
  handler opens the stream with `sse.open(ctx)`.

The client must opt in to sending the cookie cross-origin:
`new EventSource('/events', { withCredentials: true })` — and the server must answer with a named
origin plus `Access-Control-Allow-Credentials: true`, which
`corsMiddleware({ origin: 'https://example.com', credentials: true })` from
`@setu-ts/http-security-plugin` does. `origin: true` (reflect any origin) cannot be combined with
`credentials: true`; the middleware throws at registration, because that combination lets every site
the user visits read credentialed responses.

The session cookie defaults to `sameSite: 'lax'`, and an `EventSource` request is not a top-level
navigation, so a `Lax` cookie is not sent on a cross-origin `EventSource` — cookie-authenticated
streams are same-origin by default. Setting `cookie.sameSite: 'none'` on `SessionPlugin` removes
that protection and exposes the stream to cross-site reads; if you must run `none`, the
`credentials` CORS rule above is the minimum, and checking `Origin` in the authentication band is
the stronger form.

## Exports

| Export             | Kind      |
| ------------------ | --------- |
| `SsePlugin`        | function  |
| `SseConnection`    | class     |
| `SseService`       | class     |
| `CAPABILITIES`     | const     |
| `ISseConnection`   | interface |
| `ISseService`      | interface |
| `SseChannel`       | interface |
| `SseMessage`       | interface |
| `SsePluginOptions` | interface |
| `ChannelPublisher` | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#sseplugin-setu-tssse-plugin).
