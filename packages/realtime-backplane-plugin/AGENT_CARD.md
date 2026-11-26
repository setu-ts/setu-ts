# @setu-ts/realtime-backplane-plugin — share room and channel broadcasts

**Add it:** `setu add realtime-backplane` wires `RealtimeBackplanePlugin()` in functional config.
Provides `CAPABILITIES.REALTIME_BACKPLANE` (`IRealtimeBackplane`); replicas need Redis or messaging.

## Connect replicas through Redis

```ts
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

export const backplane = RealtimeBackplanePlugin({
  transport: 'redis', url: 'redis://localhost:6379', topic: 'setu-ts.realtime',
});
```

## Broadcast through the existing SSE service

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

## Behaviour the types do not show

- Default `'memory'`: process-local, bus `default`; it does not connect replicas.
- Redis needs two connections: injected `client` and `subscriber` must be supplied together
  (node-redis: `client: nodeRedisClient(url)` and `subscriber`). Otherwise the transport loads
  `ioredis` and builds both.
- Injected clients are borrowed: close and cancelled/failed/timed-out starts never disconnect or
  QUIT them. Close stops waiting, removes own listeners/watches and unsubscribes when subscribed.
  Owned clients force-disconnect on cancelled SUBSCRIBE, even with a finite bound.
- Replicas share `topic` (default `setu-ts.realtime`); generated `origin` prevents self-replay.
- WebSocket/SSE broadcasts fan out automatically. Membership counts stay local.
- Outages keep health up and local delivery working; inspect `data.reachable`.
- Built Redis commands default to 15000 ms. A timed-out publish can still arrive later.
- `commandTimeoutMs` bounds injected connect + first subscribe (15000 ms, 0 unbounded); expiry is
  `BackendUnavailableError`. Cancelled starts end waits before registering services or health.

## Other options

- `'messaging'` needs a broker confirming `fanOut`, else startup fails.
- `maxFrameAgeMs` (default 0) drops late frames.
- `'custom'` uses `instance: IRealtimeBackplane`; `'memory'` accepts a named `bus`.
- `diagnostics` observes transport activity; `localNotice: false` suppresses the memory notice.
