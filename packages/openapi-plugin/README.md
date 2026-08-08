# @setu-ts/openapi-plugin

OpenAPI 3.1 generation from registered routes, plus Swagger UI. Registers an `IOpenApiService` under
`CAPABILITIES.OPENAPI` (`'openapi'`).

Zod schemas are transformed to OpenAPI schema objects, and identical schemas are deduplicated into
`components`.

## Installation

```typescript
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';

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

| Option         | Type                             | Default           | Description                                              |
| -------------- | -------------------------------- | ----------------- | -------------------------------------------------------- |
| `swagger`      | `boolean`                        | `true`            | Serve the Swagger UI HTML page.                          |
| `endpoint`     | `string`                         | `'/docs'`         | Path for the Swagger UI page.                            |
| `specEndpoint` | `string`                         | `'/openapi.json'` | Path for the JSON spec.                                  |
| `security`     | `readonly SecurityRequirement[]` | —                 | Document-level requirement inherited by every operation. |
| `exclude`      | `readonly string[]`              | —                 | Router paths to omit; matches the resolved pattern.      |

The remaining options come from `OpenApiGeneratorOptions` (title, version, servers,
`securitySchemes`, and the rest of the document metadata).

`exclude` matches the **fully-resolved** router pattern — router-style (`/todos/:id`, not
`/todos/{id}`) and including any `router.group()` prefix, so a route registered as `get('/metrics')`
inside `group('/internal', …)` is matched only by `'/internal/metrics'`. An entry matching no route
is silently ignored.

A `security` requirement naming a scheme absent from `securitySchemes` is refused at `register()`,
because emitting it produces a document that is invalid per the specification and nothing downstream
can detect that.

The plugin's own `specEndpoint` and `endpoint` are never documented as operations — a spec listing
`/openapi.json` and `/docs` describes its own delivery mechanism, and those entries flow into every
generated client. They are still served; only the document entries are omitted.

## Documenting authentication

Declaring `securitySchemes` is what gives Swagger UI its **Authorize** button; without it a
protected route cannot be exercised from the page. Pair it with `security` for the default, and let
a route opt out with an empty array:

```typescript
OpenApiPlugin({
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  security: [{ bearerAuth: [] }],
});

// Public, overriding the document-level requirement.
app.router.post('/login', { schema: { security: [] }, handler });

// Inherits the document requirement.
app.router.get('/todos/:id', { middleware: [requireAuth()], handler });
```

On a decorated controller, `@Public` produces the same empty `security` array, so the opt-out is
available without writing a schema:

```typescript
@Controller('/auth')
class AuthController {
  @Public()
  @Post('/login')
  login() {/* ... */}
}
```

`RouteSchema.security` enforces nothing — authentication is enforced by middleware and guards. It
describes the route for readers and for generated clients.

## Contributions

At registration the plugin drains `CAPABILITIES.OPENAPI_SCHEMA` contributions, so other plugins —
and the `@ApiTags`/`@ApiOperation`/`@ApiResponse` decorators from
[`@setu-ts/decorator-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/decorator-plugin)
— can enrich the document.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md).
