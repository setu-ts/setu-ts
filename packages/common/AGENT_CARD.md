# @setu-ts/common — routes, context and service contracts

**Add it:** Scaffolds install this package; `setu add common` adds it elsewhere. No plugin or
capability is provided: import service interfaces and matching `CAPABILITIES` tokens here.

## Register a module route

```ts
import { CAPABILITIES } from "@setu-ts/common";
import type { IConfig, IRouterApi } from "@setu-ts/common";

export function registerGreetingRoutes(router: IRouterApi): void {
  router.get("/greeting/:id", {
    handler: (ctx) => {
      const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
      return ctx.response.json({
        id: ctx.params.id,
        query: ctx.query.q,
        greeting: config.get("GREETING", { default: "Hello" }),
      });
    },
  });
}
```

Register a config provider before using that route.

## Add middleware around a route

```ts
import type { IRouterApi, MiddlewareFunction } from "@setu-ts/common";

const audit: MiddlewareFunction = async (ctx, next) => {
  ctx.state.set("audit", ctx.request.headers.get("x-audit"));
  await next();
  ctx.response.header("x-audit", "yes");
};

export function registerStatusRoutes(router: IRouterApi): void {
  router.get("/status", {
    middleware: [audit],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
}
```

## Behaviour the types do not show

- A capability token does not install its provider. Resolve services in handlers through
  `ctx.services`; application-level services exist after `app.start()` registers plugins.
- Path and query values are strings. `ctx.request.json<T>()` parses JSON but its type argument does
  not validate the result.
- `ctx.state` belongs to one request and carries values between middleware and handlers.
- Middleware continues with `await next()`; to refuse, return a response without calling it. Code
  after that await runs as the chain unwinds.
- `ctx.startTime` is monotonic milliseconds; subtract it from the runtime high-resolution clock,
  never from a wall-clock timestamp.

## Other options

- `IRouterApi` also has `post`, `put`, `patch`, `delete`, `head`, `options` and `group`.
- `ctx.response.status` and `ctx.response.header` chain; terminals include `json`, `text`, `html`,
  `redirect` and `send`.
- `RouteDefinition.schema` carries documentation metadata; enforcing validation requires middleware.
