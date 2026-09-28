# @setu-ts/realtime-backplane-plugin

Cross-replica fan-out for WebSocket rooms and SSE channels.

## Why

`@setu-ts/websocket-plugin` rooms and `@setu-ts/sse-plugin` channels hold their membership in
ordinary in-process sets. That is correct and fast on a single instance, and invisible to every
other instance — behind a load balancer, `ws.room('lobby').broadcast(...)` reaches only the clients
that happen to be connected to the replica that ran it.

This plugin registers an `IRealtimeBackplane` under `CAPABILITIES.REALTIME_BACKPLANE`. Both of those
plugins resolve that token **optionally**, so registering this plugin is the whole change: rooms and
channels become cluster-wide, and removing it returns them to in-process behavior with no
application code touched.

## Installation

```bash
deno add jsr:@setu-ts/realtime-backplane-plugin
```

## Usage

Register it **before** the WebSocket or SSE plugin — its `HIGH` priority already ensures the
transport is connected before either subscribes.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { SsePlugin } from '@setu-ts/sse-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://localhost:6379' }),
    WebSocketPlugin(),
    SsePlugin(),
  ],
});

await app.start({ port: 3000 });
```

Nothing else changes. `ws.room('lobby').broadcast(data)` and `sse.channel('news').publish(msg)` now
reach clients on every replica.

## Transports

| `transport`   | Crosses processes | Dependencies                   | Notes                                                                         |
| ------------- | ----------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `'memory'`    | No                | None                           | The default. A real single-process bus, not a no-op — useful in tests and dev |
| `'messaging'` | Yes               | A plugin providing `messaging` | Reuses every broker the messaging plugin ships; adds no dependency            |
| `'redis'`     | Yes               | `npm:ioredis@5.x` (lazy)       | Redis pub/sub. Opens **two** connections (see below)                          |
| `'custom'`    | Depends           | None                           | Any `IRealtimeBackplane` you supply                                           |

### `'messaging'`

```typescript
RealtimeBackplanePlugin({ transport: 'messaging' });
```

Publishes over whatever broker is registered under `CAPABILITIES.MESSAGING` — in-memory, Redis
Streams, RabbitMQ, NATS, or Kafka. Configuring it with no messaging capability registered throws
during `register()` rather than failing silently per request.

### `'redis'`

```typescript
RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://localhost:6379' });

// Or inject clients — both are required together:
RealtimeBackplanePlugin({ transport: 'redis', client, subscriber });
```

Two connections, deliberately: a Redis connection in subscriber mode refuses every command other
than (un)subscribe, so one connection cannot both publish and subscribe. Injecting a `client`
without a `subscriber` throws at construction rather than failing at the first publish.

## Options

| Option                  | Applies to         | Default                  | Description                                                                                                                                                       |
| ----------------------- | ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topic`                 | all but memory     | `'setu-ts.realtime'`     | Broker topic / Redis channel. Every replica must agree on it                                                                                                      |
| `origin`                | all                | a fresh `runtime.uuid()` | This replica's identity. Override only to make a test deterministic                                                                                               |
| `bus`                   | `'memory'`         | `'default'`              | Named in-process bus; separate names stay isolated                                                                                                                |
| `url`                   | `'redis'`          | —                        | Connection URL, used only on the lazy-load path                                                                                                                   |
| `client` / `subscriber` | `'redis'`          | —                        | Injected client pair; required together                                                                                                                           |
| `module`                | `'redis'`          | —                        | An `ioredis`-shaped module, for testing without the real driver                                                                                                   |
| `commandTimeoutMs`      | `'redis'`          | `15000`                  | Per-command timeout on the two connections the lazy path builds; `0` disables. Must be `0`–`2147483647` (above that the timer overflows to 1 ms). See Limitations |
| `instance`              | `'custom'`         | —                        | The transport to register, used as-is                                                                                                                             |
| `localNotice`           | `'memory'`         | `true`                   | Logs one `info` line at registration when the transport is the process-local `'memory'`, naming `'redis'`/`'messaging'`. `false` suppresses it                    |
| `diagnostics`           | all but `'custom'` | omitted                  | Opt-in realtime observations (M98l); see below                                                                                                                    |

## Diagnostics (M98l)

`RealtimeBackplanePlugin({ transport: 'redis', url, diagnostics: { enabled: true, alias: 'fanout' } })`
counts, for the local diagnostics connector's `GET /v1/realtime` (`@setu-ts/diagnostics-plugin`),
how many publications resolved or rejected (with the duration of the last one) and how many arriving
frames reached the local handlers. A publication's success means the transport's `publish()`
resolved — never that a peer received it — and a receive is counted only after the transport's own
frame-shape and own-origin filters admitted the frame; a receive where any local handler threw is
`failed`. A backplane reports no gauges. No frame, room or channel name, payload, `exceptId` or
origin is ever captured. A `'custom'` transport is never observed and its options accept no
`diagnostics` field.

Without the option the plugin registers an inert `disabled` source and nothing is attached to the
transport. Observation never changes a result: a rejected publish still rejects with the same
reason, and a failing clock latches the source `collection-failed` instead. Enable only on an
approved development dataset: counts aggregate every tenant using the instance.

## Limitations

- **`Room.size` and `SseChannel.size` report LOCAL membership.** A cluster-wide count is inherently
  asynchronous (a scatter-gather across replicas), so it cannot satisfy the synchronous committed
  `size` getter; it wants a separate async method, which a later milestone owns.

`RoomBroadcastOptions.except` is **not** a limitation: it is honored on every replica. Connection
IDs come from `runtime.uuid()` and are globally unique, so the frame carries the excluded ID and
each replica skips the matching member.

Delivery is at-most-once and inherits the transport's guarantees — and the guarantee has a shape
worth knowing. On `'redis'`, ioredis's own defaults govern what a partition does:

- **A short partition (up to roughly 11 seconds): frames are buffered and delivered LATE, not
  dropped.** The publisher connection is created with ioredis's default `enableOfflineQueue: true`,
  so publishes issued while disconnected are held and flushed on reconnect. The receiving side sees
  stale ops seconds after the fact — measured at ~5.9 s in this framework's two-replica exercise —
  which an application told "frames during a partition are missed" will not defend against. A
  collaborative board should treat out-of-order late arrivals as possible.
- **A longer partition: the buffered commands reject** when ioredis's `maxRetriesPerRequest` budget
  (default 20 retries, ~11 s on the default backoff) exhausts, and both consumers log one `warn` per
  dropped frame.
- **A silent connection: the publish rejects after `commandTimeoutMs`** (default 15 s). A host that
  stops answering without closing the socket — paused, or partitioned with no reset — triggers no
  reconnect, so no retry budget applies; before this bound such a publish never settled, so neither
  consumer logged it and an observed publish was never recorded. The default sits above the ~11 s
  retry budget, so the two partition cases above behave as described; lowering it below that budget
  makes a dropped connection reject sooner too.
- **A publish before `connect()` or after `close()` rejects** rather than resolving, so a frame sent
  nowhere reads as a failure. It resolved without sending before 0.8.0.
- **`close()` during an outage still releases both connections.** Each step runs even when an
  earlier one fails, a connection whose QUIT fails is force-closed through `disconnect()` (without
  it, ioredis reconnects and re-subscribes once an unreachable server returns), and the first
  failure is rethrown afterwards, so a shutdown during an outage is reported rather than leaving
  connections reconnecting behind it. Against a silent server each step waits out the command
  timeout, so `close()` can take about three of them (≈45 s at the default); lower
  `commandTimeoutMs` if that exceeds your shutdown grace period.
- **A timed-out publish may still be sent.** A publish rejected by the command timeout can already
  be written to, or queued for, the connection, and reach Redis afterwards — measured at the default
  against a paused server, and with a lowered `commandTimeoutMs` against a stopped one. A caller
  that retries a rejected publish may therefore deliver that frame twice; consumers that cannot
  tolerate a duplicate need their own de-duplication. Against a server that refuses connections, the
  default's retry budget rejects the queued publish first and it is discarded.

Frames are never persisted or replayed beyond that buffer. `commandTimeoutMs` is the only ioredis
setting reachable through this plugin's options, and applies only on the lazy path — an application
that needs different behaviour, or injects its own `client`/`subscriber` pair, configures those
clients directly.

## Documentation

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#realtimebackplaneplugin-setu-tsrealtime-backplane-plugin)
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md)

## License

MIT

## Health indicator

Registered as `realtime-backplane`. Since M70c it probes the transport's reachability
(`isHealthy()`). A fan-out failure is `degraded` — local delivery still works, so `/ready` keeps
serving — never `down`. A transport that cannot probe reports `up` with `reachable: 'unknown'`.

| Status     | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `up`       | The transport is reachable, or cannot be probed (`reachable` is `'unknown'`).           |
| `degraded` | The transport is unreachable — a fan-out to a peer failed (local delivery still works). |

`data` reports `{ transport, origin, reachable }`, where `reachable` is `true`, `false`, or
`'unknown'`.

## Exports

| Export                             | Kind      |
| ---------------------------------- | --------- |
| `adaptRedisModule`                 | function  |
| `createBackplane`                  | function  |
| `decodeFrameData`                  | function  |
| `encodeFrameData`                  | function  |
| `isRealtimeFrame`                  | function  |
| `loadRedisModule`                  | function  |
| `RealtimeBackplanePlugin`          | function  |
| `MemoryBackplane`                  | class     |
| `MessagingBackplane`               | class     |
| `RedisBackplane`                   | class     |
| `RedisModuleError`                 | class     |
| `CAPABILITIES`                     | const     |
| `DEFAULT_REDIS_COMMAND_TIMEOUT_MS` | const     |
| `DEFAULT_TOPIC`                    | const     |
| `BackplaneCommonOptions`           | interface |
| `CustomBackplaneOptions`           | interface |
| `EncodedPayload`                   | interface |
| `IRealtimeBackplane`               | interface |
| `IRedisBackplaneClient`            | interface |
| `IRedisModule`                     | interface |
| `MemoryBackplaneOptions`           | interface |
| `MessagingBackplaneOptions`        | interface |
| `RealtimeDiagnosticsOptions`       | interface |
| `RealtimeFrame`                    | interface |
| `RedisBackplaneOptions`            | interface |
| `RealtimeBackplanePluginOptions`   | type      |
| `RealtimeFrameHandler`             | type      |
| `RealtimeFrameKind`                | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
