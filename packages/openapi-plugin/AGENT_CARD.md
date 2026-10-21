# @setu-ts/openapi-plugin — OpenAPI 3.1 document and Swagger UI

Every scaffold registers `OpenApiPlugin()`; elsewhere run `setu add openapi` and install —
zero-configuration, so the bare call is inserted. It serves the spec at `/openapi.json` and Swagger
UI at `/docs`, and provides `CAPABILITIES.OPENAPI`.

```ts
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createDocsApp() {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      OpenApiPlugin({
        title: 'Orders API',
        version: '1.0.0',
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        security: [{ bearerAuth: [] }],
        swagger: { assets: 'cdn' },
      }),
    ],
  });
}
```

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';
import type { IOpenApiService } from '@setu-ts/openapi-plugin';

export function readSpec(services: IServiceRegistry) {
  return services.get<IOpenApiService>(CAPABILITIES.OPENAPI).getSpec();
}
```

- `endpoint` defaults to `'/docs'` and `specEndpoint` to `'/openapi.json'`; both are always omitted
  from the document, as are the self-hosted asset routes.
- `swagger` defaults to `true` (self-hosted; needs `swagger-ui-dist` ^5 and `runtime.fs`, and Deno
  `--allow-read`). Use `{ assets: 'cdn' }` or `{ assets: { baseUrl } }` on Workers or without `fs`;
  `false` disables the UI. A missing package throws `OptionalDependencyUnavailableError` at
  registration.
- `title` defaults to `'API'`, `version` to `'1.0.0'`; `description` and `servers` fill the rest.
- `securitySchemes` adds Swagger UI's Authorize button. `security` is the document default and a
  route opts out with `schema: { security: [] }`. An undeclared scheme is refused at registration.
- `deriveSecurity: { scheme }` reads the brand on `@setu-ts/auth-plugin` guards.
  `deriveRequestSchemas` defaults to `true`: the `validateBody` and `validateQuery` middleware fill
  `requestBody`, parameters and a `400`. `deriveResponseStatus` defaults to `true` and reads the
  status a decorated handler declares.
- `exclude` matches the fully resolved router pattern (`/todos/:id`, group prefix included).
  `excludeOwners` defaults to `['health-plugin', 'metrics-plugin']`; pass `[]` to document
  `/health`, `/live`, `/ready` and `/metrics`.
- Route schemas come from the route's `schema` field or its validation middleware.
