# @setu-ts/openapi-plugin

OpenAPI 3.1 generation from registered routes, plus Swagger UI. Registers an `IOpenApiService` under
`CAPABILITIES.OPENAPI` (`'openapi'`).

## Zod version support

Both **zod v3 and zod v4** are supported: `>=3.24.0 <4` and `>=4.4.0 <5`. The plugin imports
neither: each schema is recognized by duck typing (`toJSONSchema` marks a zod v4 schema), so an
application may use either major — or both in one process. `deno task check:compat` exercises each
declared major independently.

- **Zod v3** is converted by the historical `_def.typeName` recursion.
- **Zod v4** is converted wholesale through `schema.toJSONSchema()` (JSON Schema draft 2020-12,
  which OpenAPI 3.1 speaks natively) and adapted: the dialect `$schema` key is dropped, reused
  schemas land in `components/schemas` with their pointers rewritten, and a recursive schema's
  root-cycle pointer forces the schema into `components` so no bare `#` ref survives.
- **Unrepresentable nodes degrade, never throw.** A type zod cannot represent in JSON Schema
  (`z.date()`, `z.bigint()`, …) becomes an empty schema, and the operation that owns it carries a
  machine-readable `x-setu-unrepresentable` extension naming the operation and the reason:

  ```json
  {
    "x-setu-unrepresentable": [
      { "at": "post-events", "reason": "zod v4 type 'date' has no JSON Schema representation" }
    ]
  }
  ```

  The extension is absent when every schema is representable, so valid documents are unchanged.

Zod schemas are transformed to OpenAPI schema objects, and a schema reused across request and
response bodies — including one nested inside another — is hoisted into `components` and referenced
by `$ref` from each of those sites.

Reuse means the **same schema object**, not an equal one: two separately constructed but
structurally identical schemas are two schemas and each stays where it is. Only object, array,
composition and enum shapes are hoisted — a reused primitive is smaller inline than as a `$ref`.
Parameter schemas are never hoisted, because a parameter list is built by destructuring the
transformed object's `properties`, and a `$ref` has none.

A route's schemas come from its declared `schema` field **or** are derived from the validation
middleware guarding it, so a route already carrying `validateBody(...)` does not repeat itself.

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

| Option                 | Type                             | Default                               | Description                                                  |
| ---------------------- | -------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `swagger`              | `boolean`                        | `true`                                | Serve the Swagger UI HTML page.                              |
| `endpoint`             | `string`                         | `'/docs'`                             | Path for the Swagger UI page.                                |
| `specEndpoint`         | `string`                         | `'/openapi.json'`                     | Path for the JSON spec.                                      |
| `security`             | `readonly SecurityRequirement[]` | —                                     | Document-level requirement inherited by every operation.     |
| `deriveSecurity`       | `{ scheme: string }`             | —                                     | Derive each operation's requirement from its route guards.   |
| `exclude`              | `readonly string[]`              | —                                     | Router paths to omit; matches the resolved pattern.          |
| `excludeOwners`        | `readonly string[]`              | `['health-plugin', 'metrics-plugin']` | Plugin names whose routes are omitted, by `RouteInfo.owner`. |
| `deriveRequestSchemas` | `boolean`                        | `true`                                | Fill `requestBody`/`parameters` from validation middleware.  |

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

`excludeOwners` drops operational routes by the plugin that registered them rather than by path,
because those paths are configuration: `HealthPlugin({ endpoints })` and
`MetricsPlugin({ endpoint })` both accept one, so a static path list silently stops excluding a
renamed endpoint. Without it, `/health`, `/live`, `/ready` and `/metrics` reach every generated
client as `getHealth`, `getLive`, `getReady` and `getMetrics`. Pass `[]` to document them.

## Deriving request schemas from validation middleware

```typescript
import { validateBody, validateQuery } from '@setu-ts/validation-plugin';

app.router.post('/orders', {
  middleware: [validateBody(PlaceOrderSchema), validateQuery(ListQuerySchema)],
  handler,
});
```

The operation is documented with a `requestBody` from `PlaceOrderSchema`, query parameters from
`ListQuerySchema`, and a `400` — which is what the middleware actually answers. No `schema.body` is
needed, and nothing is written twice.

Every helper `@setu-ts/validation-plugin` ships brands the middleware it returns with
`RouteValidationMetadata` from `@setu-ts/common`, and this plugin reads the brand off the route.
Neither package imports the other.

Rules and limits:

- A value **declared** on the route's own `schema` always wins, per field.
- The **last** brand for a target wins when a route carries two, because that is the value the
  handler receives: each middleware writes `validated:<target>` as it passes, so the final writer's
  is the one in `ctx.state`. The request must still satisfy every brand — any of them can answer
  `400` — so the documented shape is what the handler sees, not that conjunction.
- A `cookies` brand derives **nothing**: `RouteSchema` has no `cookies` field, and `@setu-ts/sdk`'s
  client generator refuses an `in: 'cookie'` parameter outright, so emitting one would turn a
  working document into a codegen failure for its consumers.
- The derived `400` carries a description and no schema — the body shape depends on the validation
  plugin's configured `errorFormat`, which this plugin cannot see.
- `deriveRequestSchemas: false` disables derivation only. It does NOT restore the rest of the
  pre-derivation document: owner exclusion, the `operationId` format and schema deduplication are
  unconditional. To document the operational routes again, pass `excludeOwners: []`.

## Operation ids

An id is derived from the method and the path with placeholders unwrapped: `GET /orders/{id}`
becomes `get-orders-by-id`. Braces are URL-unsafe — Redocly's recommended ruleset flags them — and
tools that put an `operationId` in an anchor, a filename or a URL are entitled to break on them.

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

### Deriving it from the guards instead

Declaring `security` per route makes the document a second source of truth that can drift from what
actually enforces. `deriveSecurity` closes that: every guard `@setu-ts/auth-plugin` ships is branded
with `RouteSecurityMetadata`, and the generator reads the brand off the route's middleware.

```typescript
OpenApiPlugin({
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  deriveSecurity: { scheme: 'bearerAuth' },
});

app.router.get('/todos/:id', { middleware: [requireAuth()], handler }); // → requires bearerAuth
app.router.post('/login', { middleware: [publicRoute()], handler }); // → public
```

A declared `schema.security` always wins, so this changes no document that already declares. Three
limits: only route-level middleware is inspected (`app.middleware.add()` is invisible to a route,
which is correct for `authMiddleware()` — it populates rather than enforces); roles and permissions
cannot be expressed, since a requirement names a scheme and none can be inferred from `'admin'`; and
the scheme name is configured rather than inferred, because a guard cannot know what your document
calls it.

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

## Exports

| Export                    | Kind      |
| ------------------------- | --------- |
| `OpenApiPlugin`           | function  |
| `swaggerUiHtml`           | function  |
| `zodToOpenApi`            | function  |
| `OpenApiGenerator`        | class     |
| `OpenApiService`          | class     |
| `ZodToOpenApi`            | class     |
| `IOpenApiService`         | interface |
| `OpenApiDocument`         | interface |
| `OpenApiGeneratorOptions` | interface |
| `OpenApiOperation`        | interface |
| `OpenApiParameter`        | interface |
| `OpenApiPluginOptions`    | interface |
| `OpenApiRequestBody`      | interface |
| `OpenApiResponse`         | interface |
| `OpenApiSchemaObject`     | interface |
| `OpenApiServiceOptions`   | interface |
| `SwaggerUiOptions`        | interface |
| `SchemaIo`                | type      |
| `SchemaNodeHook`          | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#openapi-setu-tsopenapi-plugin).
