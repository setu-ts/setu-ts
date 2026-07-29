# @hono-enterprise/realtime-backplane-plugin

Cross-replica fan-out for WebSocket rooms and SSE channels.

## Why

`@hono-enterprise/websocket-plugin` rooms and `@hono-enterprise/sse-plugin` channels hold their
membership in ordinary in-process sets. That is correct and fast on a single instance, and invisible
to every other instance — behind a load balancer, `ws.room('lobby').broadcast(...)` reaches only the
clients that happen to be connected to the replica that ran it.

This plugin registers an `IRealtimeBackplane` under `CAPABILITIES.REALTIME_BACKPLANE`. Both of those
plugins resolve that token **optionally**, so registering this plugin is the whole change: rooms and
channels become cluster-wide, and removing it returns them to in-process behavior with no
application code touched.

## Installation

```bash
deno add jsr:@hono-enterprise/realtime-backplane-plugin
```

## Usage

Register it **before** the WebSocket or SSE plugin — its `HIGH` priority already ensures the
transport is connected before either subscribes.

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';
import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
import { SsePlugin } from '@hono-enterprise/sse-plugin';

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

| Option                  | Applies to     | Default                      | Description                                                         |
| ----------------------- | -------------- | ---------------------------- | ------------------------------------------------------------------- |
| `topic`                 | all but memory | `'hono-enterprise.realtime'` | Broker topic / Redis channel. Every replica must agree on it        |
| `origin`                | all            | a fresh `runtime.uuid()`     | This replica's identity. Override only to make a test deterministic |
| `bus`                   | `'memory'`     | `'default'`                  | Named in-process bus; separate names stay isolated                  |
| `url`                   | `'redis'`      | —                            | Connection URL, used only on the lazy-load path                     |
| `client` / `subscriber` | `'redis'`      | —                            | Injected client pair; required together                             |
| `module`                | `'redis'`      | —                            | An `ioredis`-shaped module, for testing without the real driver     |
| `instance`              | `'custom'`     | —                            | The transport to register, used as-is                               |

## Limitations

Two are structural rather than incidental, and are documented rather than silently approximated:

- **`Room.size` and `SseChannel.size` report LOCAL membership.** A cluster-wide count needs a
  presence protocol with expiry, which a later milestone owns.
- **`RoomBroadcastOptions.except` is honored only on the originating replica.** It names a live
  in-process connection object, which has no identity on another process.

Delivery is at-most-once and inherits the transport's guarantees: a replica that is partitioned from
Redis or the broker misses frames sent during the partition. Frames are not persisted or replayed.

## Documentation

- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [ARCHITECTURE.md](https://github.com/dkpaul91/hono-enterprise/blob/main/ARCHITECTURE.md)

## License

MIT
