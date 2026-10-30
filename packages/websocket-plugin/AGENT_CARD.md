# @setu-ts/websocket-plugin — bidirectional socket messaging

**Add it:** `setu add websocket` adds it and wires `WebSocketPlugin()` in a recognized functional
config; Node also gets the `ws` peer. It provides `CAPABILITIES.WEBSOCKET` (`IWebSocketService`).

## Put clients in a chat room

Use this registration in `setu.config.ts`:

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

## Behaviour the types do not show

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

- `maxMessageBytes` closes oversized inbound frames with code 1009; its default `0` disables it.
- Route `options.guards` checks upgrades before acceptance; `protocols` selects a subprotocol.
- `behaviors` wraps incoming messages; `diagnostics` opts into observations and `scalingNotice`
  controls the local-only startup notice.
