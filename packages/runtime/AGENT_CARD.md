# @setu-ts/runtime — platform services and HTTP adapters

Every scaffold depends on this; `setu add` has no entry and there is no plugin to register by hand.
Register `RuntimePlugin()` first — no other plugin provides `CAPABILITIES.RUNTIME`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createRuntimeApp() {
  const app = createApplication({
    plugins: [RuntimePlugin({ maxBodyBytes: 10 * 1024 * 1024 })],
  });
  app.router.get('/info', (ctx) => {
    const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    return ctx.response.json({ platform: runtime.platform(), requestId: runtime.uuid() });
  });
  return app;
}
```

- `RuntimeOptions.platform` forces one of `node`, `deno`, `bun` or `cloudflare-workers`; omit it and
  detection runs once through `detectRuntime()`.
- `RuntimeOptions.env` carries the Workers bindings record; only string entries populate
  `runtime.env`, and the option is ignored on Deno, Node and Bun. Read environment values from
  `runtime.env`, never `process.env`, so the same code runs on every target.
- `RuntimeOptions.maxBodyBytes` bounds the body read itself, including chunked requests that declare
  no length. Omitted means unbounded; `0` refuses every request carrying a body; a negative,
  fractional or NaN value throws at `RuntimePlugin(...)`. Past the cap the read rejects with
  `RequestBodyTooLargeError`, branded with a 413 hint for `errorHandler`.
- `RuntimeOptions.adapters` and `RuntimeOptions.httpAdapters` are internal test seams; application
  code leaves them unset.
- `createRuntimeServices()` builds the same services outside an application, for example before
  loading config. `IRuntimeServices` exposes `runtime.platform()`, `runtime.version()`,
  `runtime.uuid()`, `runtime.randomBytes(16)`, `runtime.now()`, monotonic `runtime.hrtime()`,
  timers, `runtime.env` and `runtime.exit()`. `fs`, `workers`, `dns` and `onSignal` are optional and
  absent on edge platforms — guard them (`runtime.onSignal?.(...)`) before use.
