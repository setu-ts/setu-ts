# @setu-ts/realtime-backplane-plugin

**Add it:** `setu add realtime-backplane` wires `RealtimeBackplanePlugin()`; provides
`CAPABILITIES.REALTIME_BACKPLANE` (`IRealtimeBackplane`).

## Redis

```ts
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

export const backplane = RealtimeBackplanePlugin({
  transport: 'redis', url: 'redis://localhost:6379', topic: 'setu-ts.realtime',
});
```

## SSE

With SSE registered:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, ISseService } from '@setu-ts/common';

export function registerDeployRoutes(router: IRouterApi): void {
  router.post('/deployments', {
    handler: (ctx) => {
      const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
      sse.channel('deploys').publish({ event: 'deployment', data: { status: 'live' } });
      return ctx.response.json({ accepted: true });
    },
  });
}
```

## Behaviour

- `'memory'` is process-local, bus `default`. Supply Redis `client`/`subscriber` together, or omit
  both to build an `ioredis` pair. node-redis:
  `client: nodeRedisClient(url), subscriber: nodeRedisClient(url)`.
- Once the backplane installs its connected pair, any close UNSUBSCRIBEs then QUITs both clients
  (disconnect on failed QUIT), even after a later plugin fails or `app.stop()` cancels application
  start. Retry with a new app and clients.
- Failed/cancelled/timed-out backplane opens never QUIT/disconnect injected clients; own
  listeners/watches come off, and late subscriptions are undone unless a newer open uses the
  subscriber. Owned clients force-close on cancelled SUBSCRIBE, even with a finite bound.
- Replicas share `topic` (default `setu-ts.realtime`); generated `origin` prevents self-replay.
- WebSocket/SSE broadcasts fan out; membership stays local. Outages keep health up and local
  delivery working; inspect `data.reachable`.
- `commandTimeoutMs` (default 15000 ms, 0 disables) bounds built commands and injected connect +
  first subscribe; injected open expiry is `BackendUnavailableError`. Injected commands after
  connect keep their own settings. Timed-out publishes may arrive. Cancelling application start
  during open ends waits without late service/health registration.

## Options

- `'messaging'` needs a broker confirming `fanOut`, else startup fails.
- `maxFrameAgeMs` (default 0) drops late frames.
- `'custom'` uses `instance: IRealtimeBackplane`; `'memory'` accepts a named `bus`.
- `diagnostics` observes activity; `localNotice: false` suppresses the memory notice.
