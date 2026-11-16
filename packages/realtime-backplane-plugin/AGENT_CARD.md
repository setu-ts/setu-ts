# @setu-ts/realtime-backplane-plugin — share room and channel broadcasts

**Add it:** `setu add realtime-backplane` wires `RealtimeBackplanePlugin()` in functional config.
Provides `CAPABILITIES.REALTIME_BACKPLANE` (`IRealtimeBackplane`); replicas need Redis or messaging.

## Connect replicas through Redis

In `setu.config.ts`:

```ts
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

export const backplane = RealtimeBackplanePlugin({
  transport: 'redis', url: 'redis://localhost:6379', topic: 'setu-ts.realtime',
});
```

## Broadcast through the existing SSE service

With SSE registered, use its channel API; it publishes through the backplane automatically:

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
- Built/injected pairs get error/ready watches, detached on close. Successful injected opens QUIT on
  close. An overtaken open only stops waiting: the caller's connect keeps running and remains
  caller-owned. Retired owned clients keep an error sink until end.
- Replicas share `topic` (default `setu-ts.realtime`); generated `origin` prevents self-replay.
- WebSocket/SSE broadcasts fan out automatically. Membership counts stay local.
- Outages keep health up and local delivery working; inspect `data.reachable`.
- Built Redis commands default to 15000 ms. A timed-out publish can still arrive later.

## Other options

- `'messaging'` requires `CAPABILITIES.MESSAGING`; its reach depends on that broker's transport.
- `'custom'` uses `instance: IRealtimeBackplane`; `'memory'` accepts a named `bus`.
- `commandTimeoutMs: 0` disables the Redis bound; `diagnostics` observes transport activity and
  `localNotice: false` suppresses the memory notice.
