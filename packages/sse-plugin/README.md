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

**`channel(name)` is get-or-create; `peek(name)` is the read that is not.** The first call to
`channel(name)` creates the channel and every later call with the same name returns it — so reading
`channel(name).size` for an arbitrary caller-supplied name registers one channel per distinct name
polled. **Nothing reclaims a channel before shutdown**: the registry has no removal path outside the
one that runs when the application stops, so unlike a WebSocket room (which is swept on the next
disconnection) a leaked channel lives for the life of the process.

`channelCount` is the operator-visible side of this, reported by the `sse` health indicator as
`channels`: because nothing reclaims a channel, the number only rises for the life of a running
application, so a steadily climbing value means names are being derived from unbounded input. Only
shutdown lowers it — `onClose` discards every channel.

Use `peek` wherever the name comes from a request. It returns the channel if one exists and
`undefined` otherwise, and registers nothing:

```typescript
app.router.get('/subscribers/:build', (ctx) => {
  const build = ctx.params.build ?? '';
  return ctx.response.json({ subscribers: sse.peek(`build:${build}`)?.size ?? 0 });
});
```

**`SseMessage.data` is typed `JsonValue`** — a recursive JSON-safe type, so the compiler admits
exactly what the frame encoder can write. A `bigint` (which `JSON.stringify` throws on) and a
function or symbol value (which it silently drops) are compile errors rather than runtime surprises.
A property written `T | undefined` is fine: `JSON.stringify` drops the key. Two limits remain — a
circular structure still throws at runtime, and a named `interface` does not assign, because
TypeScript grants implicit index signatures only to object-literal types. Declare the payload with a
`type` alias, or extend `Record<string, JsonValue | undefined>`.

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
