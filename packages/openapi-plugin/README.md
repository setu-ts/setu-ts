# @hono-enterprise/openapi-plugin

OpenAPI 3.1 generation from registered routes, plus Swagger UI. Registers an `IOpenApiService` under
`CAPABILITIES.OPENAPI` (`'openapi'`).

Zod schemas are transformed to OpenAPI schema objects, and identical schemas are deduplicated into
`components`.

## Installation

```typescript
import { OpenApiPlugin } from '@hono-enterprise/openapi-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { OpenApiPlugin } from '@hono-enterprise/openapi-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    OpenApiPlugin({
      title: 'Orders API',
      version: '1.0.0',
      swagger: true,
      endpoint: '/docs',
      specEndpoint: '/openapi.json',
    }),
  ],
});
await app.start({ port: 3000 });
// GET /openapi.json → the spec
// GET /docs         → Swagger UI
```

## Options

| Option         | Type      | Default           | Description                     |
| -------------- | --------- | ----------------- | ------------------------------- |
| `swagger`      | `boolean` | `true`            | Serve the Swagger UI HTML page. |
| `endpoint`     | `string`  | `'/docs'`         | Path for the Swagger UI page.   |
| `specEndpoint` | `string`  | `'/openapi.json'` | Path for the JSON spec.         |

The remaining options come from `OpenApiGeneratorOptions` (title, version, servers, and the rest of
the document metadata).

## Contributions

At registration the plugin drains `CAPABILITIES.OPENAPI_SCHEMA` contributions, so other plugins —
and the `@ApiTags`/`@ApiOperation`/`@ApiResponse` decorators from
[`@hono-enterprise/decorator-plugin`](https://github.com/dkpaul91/hono-enterprise/tree/main/packages/decorator-plugin)
— can enrich the document.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
