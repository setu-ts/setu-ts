# @setu-ts/common — routing, context and capabilities

Every scaffold installs this; no plugin to register. Import service interfaces and their matching
`CAPABILITIES` tokens here. A token does not install its provider.

```ts
import type { MiddlewareFunction } from '@setu-ts/common';

export const audit: MiddlewareFunction = async (ctx, next) => {
  ctx.state.set('audit', ctx.request.headers.get('x-audit'));
  await next();
  ctx.response.header('x-audit', 'yes');
};
```

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig, IRouterApi, MiddlewareFunction } from '@setu-ts/common';

export function registerRoutes(router: IRouterApi, audit: MiddlewareFunction): void {
  router.get('/greeting/:id', {
    middleware: [audit],
    handler: (ctx) => {
      const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
      return ctx.response.status(200).json({
        id: ctx.params.id,
        q: ctx.query.q,
        greeting: config.get('GREETING', { default: 'Hello' }),
      });
    },
  });
}
```

- `router.get(path,handler)` also has post, put, patch, delete, head and options forms. Pass a
  `RouteDefinition` with `handler`, `middleware?`, `schema?`; group with `router.group(prefix,fn)`.
- `ctx.params.id` and `ctx.query.q` read path/query strings; `ctx.request.headers.get('x')` reads a
  header. `await ctx.request.json<T>()`, `ctx.request.text()`, `ctx.request.bytes()` read the body;
  validate untrusted input before using it. `ctx.state` is a per-request `Map<string,unknown>`.
- `ctx.response.status(code)` and `ctx.response.header(name,value)` chain. Return a writer:
  `ctx.response.json(value)`, `ctx.response.text(s)`, `ctx.response.html(s)`,
  `ctx.response.redirect(url,status?)`, `ctx.response.send(bytes?)`.
- To refuse in middleware, write a response and return without calling next. Continue with
  `await next()`.
- `ctx.services.get<IConfig>(CAPABILITIES.CONFIG)` needs a registered config provider.
  `ctx.startTime` is monotonic milliseconds: use `runtime.hrtime()-ctx.startTime`, with
  `IRuntimeServices` from `CAPABILITIES.RUNTIME`, for a duration.
- Functional `setu g module orders` writes `src/modules/orders/orders.routes.ts`,
  `orders.service.ts` and `index.ts` there; `orders.schemas.ts` appears with validation installed.
  The managed `src/modules/index.ts` feeds `registerModules(app.router,app.services)` in
  `setu.config.ts`. Edit feature files; generate to update managed indexes.

<!-- card-allow: registerModules -->
