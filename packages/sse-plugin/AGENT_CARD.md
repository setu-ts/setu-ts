# @setu-ts/sse-plugin — one-way server-to-client streaming

`setu add sse` installs it and registers `SsePlugin()` in a recognized functional config; otherwise
add that line in `setu.config.ts`. `CAPABILITIES.SSE` resolves after `app.start`. Use it when only
the server sends; use `@setu-ts/websocket-plugin` when the client also sends.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { ISseService } from '@setu-ts/common';
import { SsePlugin } from '@setu-ts/sse-plugin';

app.register(SsePlugin({ heartbeatMs: 15_000, retryMs: 3_000 }));

await app.start({ port: 3000 });
app.router.get('/events', (ctx) => {
  const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
  const conn = sse.open(ctx);
  conn.send({ id: '1', event: 'greeting', data: 'hello' });
  return conn.result;
});

const sse = app.services.get<ISseService>(CAPABILITIES.SSE);
sse.channel('deploys').publish({ data: { build: 412, status: 'live' } });
```

- `sse.open(ctx)` writes the stream headers and returns a connection; you must return `conn.result`
  from the handler. `conn.send`, `conn.comment` and `conn.close` use the open stream.
- `sse.channel(name)` gets or creates a channel; `.add`, `.remove`, `.publish` and `.size` address
  it. **Nothing reclaims a channel before shutdown**, so on a caller-supplied name use
  `sse.peek(name)` instead — it returns `undefined` without registering one.
- `data` is a JSON-safe value: a string is written literally, anything else is `JSON.stringify`-ed.
  Declare object payloads with a type alias, not an interface, so they assign. NaN/Infinity become
  null; a circular value throws.
- A channel is process-local until a cross-process backplane is registered. Register
  `@setu-ts/realtime-backplane-plugin` with `transport: 'redis'` (or `'messaging'`); its default
  `'memory'` transport is still one process. `scalingNotice: false` silences the startup warning
  without changing delivery.
- A browser's EventSource sends cookies only; guard the route with session-based auth, not a bearer
  header. Set `id` on messages so a reconnect can resume from Last-Event-ID.
- `heartbeatMs` and `retryMs` are off when omitted.
