# @setu-ts/sse-plugin — stream server events to browsers

**Add it:** `setu add sse` adds it and wires `SsePlugin()` in a recognized functional config. It
provides `CAPABILITIES.SSE` (`ISseService`).

## Subscribe a browser to a channel

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, ISseService } from '@setu-ts/common';

export function registerEventRoutes(router: IRouterApi): void {
  router.get('/events', {
    handler: (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      const conn = sse.open(ctx);
      sse.channel('deploys').add(conn);
      conn.send({ event: 'ready', data: 'connected' });
      return conn.result;
    },
  });
}
```

## Publish an update to connected clients

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { ISseService } from '@setu-ts/common';

const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
sse.peek('deploys')?.publish({ id: '412', event: 'deployment', data: { build: 412 } });
```

## Behaviour the types do not show

- `open` sets stream headers; return the connection's `result` from the handler. Disconnects remove
  channel membership automatically.
- `channel` creates a channel; `peek` returns `undefined` without creating one. Channel names remain
  registered until shutdown even when empty, so avoid creating unbounded names.
- String `data` is written literally; other values are JSON-encoded. Undefined data throws; circular
  values also throw. Messages to a closed connection are ignored.
- The incoming last-event-id header is exposed as `lastEventId` (or `null`). There is no automatic
  replay: application code must supply missed events.
- Channels are process-local without a cross-process backplane. A backplane failure logs and
  preserves local delivery; channel size still counts only local connections.
- `heartbeatMs` and `retryMs` are omitted by default. They use milliseconds; heartbeat writes a
  comment, while retry sends the browser's reconnect delay.

## Other options

- `SsePlugin({ heartbeatMs: 15000, retryMs: 3000 })` configures connection keepalive and retries.
- `send`, `comment` and `close` operate on one connection; channel `remove` detaches a member.
- `diagnostics` enables observations; `scalingNotice: false` suppresses the local-only notice.
