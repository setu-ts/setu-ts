# @setu-ts/realtime-backplane-plugin — cross-replica WebSocket and SSE fan-out

`setu add realtime-backplane` installs it and registers `RealtimeBackplanePlugin()` in a recognized
functional config; otherwise add that line in `setu.config.ts`. Register it **before** the WebSocket
or SSE plugin. `CAPABILITIES.REALTIME_BACKPLANE` resolves after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRealtimeBackplane } from '@setu-ts/common';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';

app.register(
  RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://localhost:6379' }),
);

await app.start({ port: 3000 });
const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
```

- `transport` is `'memory'` (default), `'messaging'`, `'redis'` or `'custom'`. Only the last three
  can cross processes — `'memory'` is a real bus but single-process, so a bare plugin changes
  nothing. `localNotice: false` silences the startup line that says so.
- `'messaging'` publishes over whatever broker is registered under `CAPABILITIES.MESSAGING`; with no
  such provider, registration throws. `'redis'` takes `url`, or a `client` **and** `subscriber`
  injected together (two connections are required).
- `'custom'` takes `instance: IRealtimeBackplane`. Every replica must share `topic` (default
  `'setu-ts.realtime'`); `origin` defaults to a generated id.
- `ws.room` and `sse.channel` membership become cluster-wide, but `.size` still reports local
  membership, and `.except` is honored only on the originating replica.
- Delivery is at-most-once and inherits the transport: a Redis publish that times out may still
  arrive later, so de-duplicate where a duplicate matters. `commandTimeoutMs` defaults to `15000` on
  the lazily built Redis connections.
- The health indicator stays `up` during a fan-out outage (local delivery still works); read
  `data.reachable` to detect the backend.
