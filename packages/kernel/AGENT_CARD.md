# @setu-ts/kernel — application composition root

Every scaffold depends on this; `setu add` has no entry for it and there is no plugin to register.
Construct the application, register plugins, then `app.start()`.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export async function boot(): Promise<void> {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/health', { handler: (ctx) => ctx.response.status(200).json({ ok: true }) });
  await app.start({ port: 3000 });
  const response = await app.inject({ method: 'GET', url: '/health' });
  console.log(response.statusCode, response.json<{ ok: boolean }>());
  await app.stop();
}
```

- `ApplicationOptions.plugins` pre-registers plugins before startup; `app.register(plugin)` chains
  and plugins run in dependency order at `app.start()`.
- `app.start()` throws when a dependency is unsatisfied or cyclic, or when no plugin provides
  `CAPABILITIES.RUNTIME`; register `RuntimePlugin()` from `@setu-ts/runtime` first. Pass a
  `{ port, hostname }` object, e.g. `app.start({ port: 3000 })`.
- `app.fetch(request)` delegates a web-standard `Request` without a listening socket (the Cloudflare
  Workers path). `app.inject({ method, url })` synthesizes one after startup and returns
  `statusCode`, `headers`, `body` plus `response.json<T>()`.
- `inject` accepts a string, byte array, blob, form parameters or plain object body; a GET or HEAD
  body is dropped. Any other shape is refused rather than serialised.
- Diagnostics are opt-in: omit `diagnostics` and `app.diagnostics` is absent, creating no collector.
  `diagnostics: {}` enables the reader but projects opaque identifiers only; the `labels` allowlists
  (`plugins`, `capabilities`, `routes`, `middleware`) are exact-match and capped at 256 entries of
  160 bytes. Read with `app.diagnostics.snapshot()` or `app.diagnostics.read(after,limit)`; there is
  no writer and no registry token.
- `app.stop()` runs shutdown hooks; `app.unregister(name)` removes a still-pending plugin before
  startup and returns whether one was removed.
