# @setu-ts/openapi-plugin

OpenAPI 3.1 generation from registered routes, plus Swagger UI. Registers an `IOpenApiService` under
`CAPABILITIES.OPENAPI` (`'openapi'`).

## Zod version support

The supported Zod range is **`>=4.6.6 <5`**. The plugin does not import Zod: each schema is
recognized by its public `toJSONSchema` method. `pnpm run check:compat` exercises Zod 4.

- **Zod v4** is converted wholesale through `schema.toJSONSchema()` (JSON Schema draft 2020-12,
  which OpenAPI 3.1 speaks natively) and adapted: the dialect `$schema` key is dropped, reused
  schemas land in `components/schemas` with their pointers rewritten, and a recursive schema's
  root-cycle pointer forces the schema into `components` so no bare `#` ref survives.
- **A type union is always `anyOf`, on every supported zod v4.** Draft 2020-12 permits two spellings
  and zod changed which one it emits across v4 releases — 4.5 collapses a union of bare types to
  `"type": ["string", "null"]` where 4.4 emitted `anyOf` — so the transformer normalizes the
  collapsed form back. One schema therefore yields one document whichever in-range zod the
  application installs, and the result still converts down to OpenAPI 3.0, where a `type` array is
  not legal.
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
  Nothing is logged when a node degrades: the document is built on the first `getSpec()` /
  `/openapi.json` request, not at startup, so inspect it (or test for `x-setu-unrepresentable`) in
  CI. For dates, `z.iso.datetime()` represents a date-time in JSON Schema.

- **Schemas without `toJSONSchema`, including Zod 3 schemas, are unrecognized.** They degrade to
  `{}` with the existing `not a recognized zod schema` diagnostic in `x-setu-unrepresentable`.
  Upgrade Zod to `>=4.6.6 <5` before regenerating documents.

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

Swagger defaults to self-hosting. Install `swagger-ui-dist` (supported range `^5`) in the
application and grant filesystem read access on Deno. On Deno, add
`"swagger-ui-dist": "npm:swagger-ui-dist@5.33.3"` to the `imports` of the app's `deno.json` (in a
workspace, the member's — as generated members do — or the root's), run `deno install` from the
workspace root, and keep `--allow-read` on the start task: the optional import resolves from the
installed `node_modules`, so an entry with no install still fails at startup. Registration awaits
the tiny `swagger-ui-dist/absolute-path.js` helper and reads only the three fixed distribution files
once. The routes `/docs/swagger-ui.css`, `/docs/swagger-ui-bundle.js`, and
`/docs/swagger-ui-standalone-preset.js` serve the package bytes with CSS/JavaScript content types
and `Cache-Control: public, max-age=3600`; changing `endpoint` moves all four UI routes. Delivery
routes are excluded from the generated spec; in the external modes no asset route exists, so only
the page endpoint is.

`SwaggerOptions` is `{ readonly assets?: 'self' | 'cdn' | { readonly baseUrl: string } }`. `true`
and `{}` select `'self'`; `false` disables the UI. Missing `swagger-ui-dist` fails startup with
`OptionalDependencyUnavailableError`: install it or set `swagger: { assets: 'cdn' }`. Runtimes
without `runtime.fs`, including Workers, must choose `'cdn'` or `{ baseUrl }`.

The `'cdn'` and `{ baseUrl }` modes add Subresource Integrity hashes computed for
`swagger-ui-dist@5.33.3`, so a `{ baseUrl }` that serves your own copy must serve **exactly that
release**; any other version's files fail the hash check and the page renders blank (V10-36). A
project generated by `setu` installs `5.33.3` exactly (M119c). `'self'` adds no hashes and works
with any 5.x release.

`swagger-ui-dist` depends on `@scarf/scarf`, whose npm `postinstall` sends install analytics
(platform, Node version, dependency data) unless the root `package.json` sets
`"scarfSettings": { "enabled": false }`. Scarf reads only the package.json npm was run from, so in a
workspace the setting belongs at the root; `setu new` sets it on a standalone project and on an npm
workspace root.

CDN mode uses `https://unpkg.com/swagger-ui-dist@5.33.3` with SHA-384 integrity and
`crossorigin="anonymous"` on all three tags. A custom base must be printable ASCII with no
backslash, `?` or `#` (the file names are appended to it), and either an absolute HTTP(S) URL
already in its serialized form or a path starting with a single `/`. The base is written into the
page as given, so a URL carrying credentials (`https://user:password@host`) is refused. It must
serve the unmodified **5.33.3** files, since it uses the same hashes. Invalid modes and base URLs
throw `TypeError` at construction. `SwaggerUiOptions.assets` selects the same mode for
`swaggerUiHtml`; its `endpoint` supplies the local prefix (default `/docs`).

| Option                 | Type                             | Default                               | Description                                                  |
| ---------------------- | -------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `swagger`              | `boolean \| SwaggerOptions`      | `true`                                | Serve Swagger UI, self-hosted by default.                    |
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

The match is exact: there is no prefix or glob form. The exclusion set is read once when the plugin
is constructed; mutating the input array later has no effect. To omit an ordinary `router.group()`,
list each of its resolved paths in `exclude`. `excludeOwners` does not match a group prefix: it
matches `RouteInfo.owner`, so it only omits routes a plugin registered.

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
import { z } from 'zod';
import { validateBody, validateQuery } from '@setu-ts/validation-plugin';

const PlaceOrderSchema = z.object({ sku: z.string(), qty: z.number().int() });
const ListQuerySchema = z.object({ page: z.number().int().optional() });

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

When no id is declared, an id is derived from the method and the path with placeholders unwrapped:
`GET /orders/{id}` becomes `get-orders-by-id`. Braces are URL-unsafe — Redocly's recommended ruleset
flags them — and tools that put an `operationId` in an anchor, a filename or a URL are entitled to
break on them.

For example, `GET /api/v1/invoices` produces `get-api-v1-invoices`; the SDK generator names its
method `getApiV1Invoices` when no id is declared. Declare
`schema: { operationId: 'listInvoices', description: 'Lists invoices.' }` on a programmatic route,
or use `@ApiOperation({ operationId: 'listInvoices', description: 'Lists invoices.' })`. A declared
id is used verbatim and `description` is emitted on the operation alongside `summary` and `tags`.

Declared ids are reserved before derived ones, regardless of registration order. A derived
`get-users` becomes `get-users-2` if another included route declares `get-users`. A blank id (empty
or whitespace-only) or duplicate declared id throws exported `OperationIdError` with
`reason: 'blank' | 'duplicate'` at `app.start()`; direct `OpenApiGenerator.generate()` calls throw
the same error. Its message names the id and routes as `METHOD path`. Excluded paths and owners
neither claim nor collide. A route added after bootstrap is validated when the document is first
built; invalid declarations then produce a request-time `500`. The startup scan does not build or
cache the document.

Distinct ids can still sanitize to the same SDK method: declared `getUsers` beside undeclared
`GET /users` (derived `get-users`) is valid OpenAPI, but `@setu-ts/sdk` refuses it with
`Duplicate operation name`. Choose ids that also yield distinct TypeScript names when generating
clients. See
[the upgrade guide](https://github.com/setu-ts/setu-ts/blob/main/docs/upgrading.md#declared-apioperation-ids-and-descriptions-0100)
for generated-name changes.

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
import { publicRoute } from '@setu-ts/auth-plugin';

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
import { Controller, Post, Public } from '@setu-ts/decorator-plugin';

@Controller('/auth')
class AuthController {
  @Public()
  @Post('/login')
  login() {
    /* ... */
  }
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
| `OperationIdError`        | class     |
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
| `SwaggerOptions`          | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#openapi-setu-tsopenapi-plugin).
