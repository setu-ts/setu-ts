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
- Without an adapter upgrade seam `available` is false and `route` throws
  `WebSocketUnavailableError`. `app.fetch` and `app.inject` do not establish Node sockets.
- `room` creates a room; `peek` does not. Closing leaves every room.
- `heartbeatMs`/`idleTimeoutMs` default to `0` (off); an idle timeout needs a heartbeat.
  `maxConnections` defaults to `0` (unlimited) and refuses excess upgrades with 503.
- Rooms are local without a backplane. With one, sizes stay local and `except` applies only on the
  originating replica.
- Workers rooms need `CloudflarePlugin({ durableObject })`, else `room`/`peek` throw
  `WebSocketRoomsUnavailableError`.

## Other options

- `maxMessageBytes` defaults to 1 MiB; `0` disables it. Oversized messages close 1009. Node bounds
  the read; Bun's transport cap is 16 MB. Bun/Deno check after buffering.
- Route `options.guards` checks upgrades before acceptance; `protocols` selects a subprotocol.
- `behaviors` wrap incoming messages; `diagnostics` opts in to observations; `scalingNotice` toggles
  the startup notice.
