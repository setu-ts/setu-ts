# @setu-ts/websocket-plugin — bidirectional real-time messaging

`setu add websocket` installs it and registers `WebSocketPlugin()` in a recognized functional
config; on Node it also writes the `ws` peer. `CAPABILITIES.WEBSOCKET` resolves after `app.start`,
which must bind a real port — `app.fetch()` and `app.inject()` serve HTTP only.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IWebSocketService } from '@setu-ts/common';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';

app.register(WebSocketPlugin({ heartbeatMs: 30_000, idleTimeoutMs: 90_000 }));

await app.start({ port: 3000 });
const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

ws.route('/ws/chat', {
  onOpen: (conn, { query }) => {
    const room = query.room ?? 'lobby';
    conn.data.set('room', room);
    ws.room(room).add(conn);
  },
  onMessage: (conn, data) => {
    const room = conn.data.get('room');
    if (typeof room === 'string') ws.room(room).broadcast(data, { except: conn });
  },
});
```

- `ws.route(path,handlers,options)` registers an exact path; variables travel through `query`, which
  `onOpen` receives with `headers` and the authenticated `user`. Handlers are `onOpen`, `onMessage`,
  `onClose` and `onError`.
- `ws.room(name)` creates the room on first use; `.add`, `.remove`, `.broadcast`, `.broadcastJson`
  and `.size` address its members. Rooms evict a closing connection automatically. Use
  `ws.peek(name)` to read a client-supplied name without creating a room.
- In a `setu.config.ts` that never starts the server, declare routes through the plugin's `routes`
  option instead: `[{ path, handlers, options? }]`, or a factory resolved at `onInit`.
- `options.guards` (`[({ headers }) => headers.has('authorization') || { status: 401 }]`) refuses an
  upgrade before the handshake; return `true` to accept.
- `maxConnections` (default `0`, unlimited) answers 503 at the limit; `maxMessageBytes` closes with
  1009; `heartbeatMs` and `idleTimeoutMs` default `0` (off). `scalingNotice: false` silences the
  startup warning that no realtime backplane is registered.
- For server-to-client-only traffic prefer `@setu-ts/sse-plugin`; this one is for clients that also
  send.
