# @setu-ts/realtime-backplane-plugin — share room and channel broadcasts

**Add it:** `setu add realtime-backplane` adds it and wires `RealtimeBackplanePlugin()` in a
recognized functional config. It provides `CAPABILITIES.REALTIME_BACKPLANE` (`IRealtimeBackplane`);
use a cross-process transport for replicas.

## Connect replicas through Redis

Replace the default registration in `setu.config.ts`:

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

- The default `'memory'` transport shares frames only inside one process. Its default bus name is
  `default`; a bare registration does not connect replicas.
- Redis needs two connections: injected `client` and `subscriber` must be supplied together.
  Otherwise the transport lazily loads `ioredis` and builds both.
- Instances must share `topic`, default `setu-ts.realtime`; `origin` defaults to a generated id and
  prevents replaying an instance's own frames.
- The plugin orders before its WebSocket and SSE consumers. Their room/channel broadcasts fan out
  automatically; membership counts stay local and exclusions apply only on the sender.
- Health remains up during a backend outage; inspect `data.reachable`. Local delivery continues.
- Redis commands on built connections have a 15000 ms bound. A timed-out publication can still
  arrive later, so do not treat failure as proof of non-delivery.

## Other options

- `'messaging'` requires `CAPABILITIES.MESSAGING`; its reach depends on that broker's transport.
- `'custom'` uses `instance: IRealtimeBackplane`; `'memory'` accepts a named `bus`.
- `commandTimeoutMs: 0` disables the Redis bound; `diagnostics` observes transport activity and
  `localNotice: false` suppresses the memory notice.
