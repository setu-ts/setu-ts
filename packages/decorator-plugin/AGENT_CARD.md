# @setu-ts/decorator-plugin — class controllers and injection

**Add it:** `setu add decorator`; register `DecoratorPlugin({ controllers })` in `setu.config.ts`.
Provides `CAPABILITIES.METADATA_STORE` (`IMetadataStore`).

## Inject configuration

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

Provide `CAPABILITIES.CONFIG`.

## Behaviour

- Decorators capture metadata; registered classes activate their routes.
- These are standard decorators: `@Params(...)` goes on the method with one source per argument.
  Constructor injection uses class-level `@Inject(...)`; a controller is a singleton, so it takes
  `'scoped'` services as `@Params(Service(token))`.
- Plain returns serialize as JSON; `Ctx()` supplies the response writer, which overrides shaping.
- `enforceSchemas` defaults to `true`; without a validation service, schemas are descriptive and the
  plugin warns.
- `enforceRoles` defaults to `true`; role/permission routes fail `501` without an authorization
  provider.
- `@McpTool(meta?)` enables @setu-ts/mcp-plugin discovery; register `McpPlugin({})`. Name falls back
  to operationId, then method; description to operation description, then summary. Tools need a
  security brand or `schema.security`; `@Public()` declares public intent.
- `Gateway(path, { guards })` supplies handshake options. Gateways refuse `Roles`, `Permissions` and
  method-level `Public` at startup; use handshake guards.

## Other options

- `Body`, `Query`, `Header`, `Cookie`, `CurrentUser` and `Ctx` are argument sources for `Params`.
- `services` lists injectable classes; `modules` expands `Module` definitions; `ingress` lists
  classes with non-HTTP handlers (HTTP plus non-HTTP classes need both lists).
- `HttpCode`, `ResponseHeader` and `Redirect` shape responses; `UseGuards`, `UseInterceptors` and
  `UseFilters` add route middleware.
- `autoDiscover` scans `controllersPath`; `policies` registers policy classes before controllers.
