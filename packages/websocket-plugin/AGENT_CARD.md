# @setu-ts/websocket-plugin — bidirectional socket messaging

**Add it:** `setu add websocket` wires `WebSocketPlugin()` in recognized functional config; Node
gets the `ws` peer. Provides `CAPABILITIES.WEBSOCKET` (`IWebSocketService`).

## Put clients in a chat room

```ts
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IWebSocketService } from '@setu-ts/common';

export const websocket = WebSocketPlugin({
  heartbeatMs: 30_000, idleTimeoutMs: 90_000,
  routes: [(services) => {
    const ws = services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
    return {
      path: '/ws/chat',
      handlers: {
        onOpen: (conn, { query }) => {
          const room = query.room ?? 'lobby';
          conn.data.set('room', room);
          ws.room(room).add(conn);
        },
        onMessage: (conn, data) => {
          const room = conn.data.get('room');
          if (typeof room === 'string') ws.room(room).broadcast(data, { except: conn });
        },
      },
    };
  }],
});
```

## Broadcast an application update

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IWebSocketService } from '@setu-ts/common';

const ws = ctx.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
ws.peek('lobby')?.broadcastJson({ event: 'deployment', version: '1.2' });
```

## Behaviour

- Paths match exactly; send variable data through the query. Route factories resolve at `onInit`.
- Without an adapter upgrade seam, `available` is false and registering a route throws
  `WebSocketUnavailableError`. `app.fetch` and `app.inject` do not establish Node sockets.
- Rooms are created by `room`; `peek` returns `undefined` without creating one. Closing a connection
  automatically removes it from rooms.
- `heartbeatMs` and `idleTimeoutMs` default to `0` (off); an idle timeout requires a heartbeat.
  `maxConnections` defaults to `0` (unlimited) and refuses excess upgrades with 503.
- Rooms are local without a backplane. With one, sizes stay local and `except` applies only on the
  originating replica.

## Other options

- `maxMessageBytes` defaults to 1 MiB; `0` disables it. Oversized messages close 1009. Node bounds
  the read; Bun's transport cap is 16 MB. Bun/Deno check after buffering.
- Route `options.guards` checks upgrades before acceptance; `protocols` selects a subprotocol.
- `behaviors` wraps incoming messages; `diagnostics` opts into observations and `scalingNotice`
  controls the local-only startup notice.
