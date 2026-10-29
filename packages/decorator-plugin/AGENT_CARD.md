# @setu-ts/decorator-plugin — class controllers and injection

**Add it:** `setu add decorator` adds the dependency; register `DecoratorPlugin({ controllers })` in
`setu.config.ts`. It provides `CAPABILITIES.METADATA_STORE` (`IMetadataStore`); class-based
scaffolds already register it.

## Serve a controller with injected configuration

```ts
import { CAPABILITIES } from "@setu-ts/common";
import type { IConfig } from "@setu-ts/common";
import { Controller, DecoratorPlugin, Get, Inject, Param, Params } from "@setu-ts/decorator-plugin";

@Controller("/orders")
@Inject(CAPABILITIES.CONFIG)
export class OrdersController {
  constructor(private readonly config: IConfig) {}

  @Get("/:id")
  @Params(Param("id"))
  find(id: string): { id: string; currency: string } {
    return { id, currency: this.config.get("CURRENCY", { default: "INR" }) };
  }
}

app.register(DecoratorPlugin({ controllers: [OrdersController] }));
```

Register a config provider for that token; add the class to the existing controller registration.

## Behaviour the types do not show

- Decorators only capture metadata; routes become active when the plugin registers their classes.
- These are standard decorators: `@Params(...)` goes on the method with one source per argument.
  Constructor injection uses class-level `@Inject(...)`; a controller is a singleton, so it takes
  `'scoped'` services as `@Params(Service(token))`.
- A plain handler return is serialized as JSON. `Ctx()` supplies request context for returning a
  response writer directly; an explicit writer result takes precedence over response-shaping
  metadata.
- `enforceSchemas` defaults to `true`; validation decorators enforce only when a validation service
  is registered, otherwise they remain descriptive and the plugin warns.
- `enforceRoles` defaults to `true`; role/permission routes without an authorization provider fail
  closed with `501` instead of running unguarded.
- Imported modules are visited depth-first; each module contributes providers before controllers.

## Other options

- `Body`, `Query`, `Header`, `Cookie`, `CurrentUser` and `Ctx` are argument sources for `Params`.
- `services` lists injectable classes; `modules` expands `Module` definitions; `ingress` lists
  classes with non-HTTP handlers (HTTP plus non-HTTP classes need both lists).
- `HttpCode`, `ResponseHeader` and `Redirect` shape responses; `UseGuards`, `UseInterceptors` and
  `UseFilters` add route middleware.
- `autoDiscover` scans `controllersPath`; `policies` registers policy classes before controllers.
