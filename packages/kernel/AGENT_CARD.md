# @setu-ts/kernel — application lifecycle and routing

**Add it:** scaffolds already use `createApplication()` in `setu.config.ts`; there is no `setu add`
entry or capability provided by the kernel itself.

## Register a module's routes

```ts
import type { IRouterApi } from '@setu-ts/common';

export function registerGreetingRoutes(router: IRouterApi): void {
  router.get('/greeting/:name', {
    handler: (ctx) => ctx.response.json({ hello: ctx.params.name }),
  });
}
```

## Exercise the configured application without a socket

Use the scaffold's constructed application:

```ts
await app.start();
try {
  const response = await app.inject({ method: 'GET', url: '/greeting/Ada' });
  if (response.statusCode !== 200) throw new Error(response.body ?? 'Request failed');
  const greeting = response.json<{ hello: string }>();
} finally {
  await app.stop();
}
```

## Behaviour the types do not show

- Plugins register during `app.start()`, in dependency order; their capabilities are absent
  beforehand. Startup requires a provider for `CAPABILITIES.RUNTIME`.
- Starting without a port does not bind a socket; `app.start({ port: 3000 })` listens.
- Duplicate method/path registrations throw rather than replace the first route.
- Injection JSON-serializes plain object bodies; it drops bodies on GET and HEAD.
- `app.inject` refuses streaming responses; use `app.fetch` and read the response stream.
- Shutdown hooks run on `app.stop()`; repeated stops share the same shutdown operation.

## Other options

- `createApplication({ plugins })` pre-registers plugins; `app.register` adds one before startup.
- `app.unregister(name)` removes pending plugins; `app.hasPlugin(name)` checks exact names.
- `diagnostics: {}` opts into a read-only diagnostic reader; omitted, none is created.
