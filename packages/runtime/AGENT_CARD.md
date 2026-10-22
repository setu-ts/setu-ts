# @setu-ts/runtime — platform services and HTTP adapters

**Add it:** scaffolds register `RuntimePlugin()` in `setu.config.ts`; there is no `setu add` entry.
It provides `CAPABILITIES.RUNTIME` (`IRuntimeServices`), `CAPABILITIES.HTTP_ADAPTER`
(`IHttpAdapter`) and `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER` (`ILocalDiagnosticsListenerFactory`).

## Read platform services in a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, IRuntimeServices } from '@setu-ts/common';

export function registerInfoRoutes(router: IRouterApi): void {
  router.get('/info', {
    handler: (ctx) => {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      return ctx.response.json({
        platform: runtime.platform(),
        requestId: runtime.uuid(),
        elapsedMs: runtime.hrtime() - ctx.startTime,
      });
    },
  });
}
```

## Bound request-body reads

Replace the runtime entry in the config's plugins array:

```ts
import { RuntimePlugin } from '@setu-ts/runtime';

export const runtimePlugin = RuntimePlugin({ maxBodyBytes: 10 * 1024 * 1024 });
```

## Behaviour the types do not show

- Platform detection runs when `RuntimePlugin` is constructed, unless `platform` is supplied.
- `maxBodyBytes` counts bytes actually read, including chunked bodies. Omitted means unbounded; zero
  refuses bodies. Negative, fractional or unsafe-integer limits throw at construction.
- A body over the limit rejects with `RequestBodyTooLargeError`; an error responder is needed to
  serve its 413 hint instead of the kernel's generic 500.
- `runtime.hrtime()` and `ctx.startTime` are monotonic milliseconds; `runtime.now()` is epoch time.
- On Workers, only string entries from `env` populate `runtime.env`; the option is ignored on Node,
  Deno and Bun. Workers omit `fs`, `workers`, `dns` and `onSignal`.

## Other options

- `platform` selects node, deno, bun or cloudflare-workers explicitly.
- `createRuntimeServices()` builds standalone services before an application exists.
- `adapters` and `httpAdapters` inject factories for tests.
