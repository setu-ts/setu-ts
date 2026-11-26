# @setu-ts/realtime-backplane-plugin — share room and channel broadcasts

**Add it:** `setu add realtime-backplane` wires `RealtimeBackplanePlugin()`; provides
`CAPABILITIES.REALTIME_BACKPLANE` (`IRealtimeBackplane`). Replicas need Redis or messaging.

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
- Supply Redis `client`/`subscriber` together (node-redis: `client: nodeRedisClient(url)` and
  `subscriber`); omit both to load `ioredis` and build them.
- After successful Redis start, close UNSUBSCRIBEs then QUITs both clients; disconnect on QUIT
  failure. Failed/cancelled/timed-out injected starts leave clients open, remove own
  listeners/watches and undo late subscriptions unless a newer open uses the subscriber. Owned
  clients force-close on cancelled SUBSCRIBE, even with a finite bound.
- Replicas share `topic` (default `setu-ts.realtime`); generated `origin` prevents self-replay.
- WebSocket/SSE broadcasts fan out automatically. Membership counts stay local.
- Outages keep health up and local delivery working; inspect `data.reachable`.
- `commandTimeoutMs` bounds built commands (default 15000 ms, 0 disables). Timed-out publishes may
  arrive.
- `commandTimeoutMs` bounds injected connect + first subscribe (default 15000 ms, 0 disables);
  expiry is `BackendUnavailableError`. Cancelled starts end waits before registering services or
  health.

## Other options

- `'messaging'` needs a broker confirming `fanOut`, else startup fails.
- `maxFrameAgeMs` (default 0) drops late frames.
- `'custom'` uses `instance: IRealtimeBackplane`; `'memory'` accepts a named `bus`.
- `diagnostics` observes transport activity; `localNotice: false` suppresses the memory notice.
