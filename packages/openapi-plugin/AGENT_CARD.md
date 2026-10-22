# @setu-ts/openapi-plugin — API documentation and Swagger UI

**Add it:** `setu add openapi` adds the dependency and inserts `OpenApiPlugin()` in recognized
scaffolds (already registered in REST projects). It provides `CAPABILITIES.OPENAPI`
(`IOpenApiService`).

## Serve a spec with bearer-auth documentation

Configure the existing registration in `setu.config.ts`:

```ts
import { OpenApiPlugin } from "@setu-ts/openapi-plugin";

app.register(OpenApiPlugin({
  title: "Orders API",
  version: "1.0.0",
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  security: [{ bearerAuth: [] }],
  swagger: { assets: "cdn" },
}));
```

## Document an explicitly public route

```ts
import type { IRouterApi } from "@setu-ts/common";

export function registerStatusRoutes(router: IRouterApi): void {
  router.get("/status", {
    schema: { summary: "Service status", tags: ["Status"], security: [] },
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
}
```

## Behaviour the types do not show

- `endpoint` defaults to `/docs`, `specEndpoint` to `/openapi.json`; served documentation and
  self-hosted asset routes are excluded from the generated document.
- `swagger` defaults to `true` with self-hosted assets: this needs `swagger-ui-dist` and a runtime
  filesystem. Missing assets fail registration. The CDN mode above avoids that filesystem need.
- `title` defaults to `"API"` and `version` to `"1.0.0"`.
- `security` describes requirements; it does not enforce authentication. Route `security: []`
  overrides the document default. A required scheme absent from `securitySchemes` refuses startup.
- `deriveRequestSchemas` and `deriveResponseStatus` default to `true`: validation metadata supplies
  request schemas and decorated handler metadata supplies response status.
- `excludeOwners` defaults to the health and metrics plugins; `exclude` matches fully resolved route
  patterns, including group prefixes.

## Other options

- `swagger: false` disables the UI; `swagger.assets` also accepts a custom `baseUrl` object.
- `description` and `servers` describe the API; `excludeOwners: []` includes infrastructure routes.
- `deriveSecurity: { scheme }` derives requirements from branded guards; the scheme must be
  declared.
- `IOpenApiService.getSpec` reads the document and `addSchema` contributes a named schema.
