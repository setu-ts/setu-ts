# Milestone 21 — OpenAPI Plugin (`@hono-enterprise/openapi-plugin`)

> **Status:** Planning. Branch: `feat/21-openapi-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

This milestone adds the `@hono-enterprise/openapi-plugin` package, which auto-generates an OpenAPI
3.1 document from the application's registered routes and serves it (plus an optional Swagger UI
shell) over HTTP. Route schemas (`RouteSchema.body` / `query` / `params` / `response` on
`RouteDefinition`) are Zod schemas by convention; the plugin converts them to OpenAPI schema
objects, deduplicates shared schemas into `components/schemas`, and emits a single `paths` document.
The plugin registers an `IOpenApiService` under `CAPABILITIES.OPENAPI` and drains
`CAPABILITIES.OPENAPI_SCHEMA` contributions (named schemas contributed by other plugins via
`ctx.openapi.addSchema`).

- **In scope:**
  - `packages/openapi-plugin` — `OpenApiPlugin` factory, `OpenApiGenerator`, `ZodToOpenApi`
    transformer, Swagger UI HTML serving, `IOpenApiService`, barrel exports.
  - A minimal **route-introspection seam** added to `@hono-enterprise/common`
    (`IRouterApi.listRoutes()`) and implemented by the kernel `Router`, because the OpenAPI
    generator must read every registered `RouteDefinition` and the public `IRouterApi` currently
    exposes only write methods. This is a deliberate, named `common` + `kernel` change shipped in
    the same PR (precedent: M11 added `IResponse.snapshot()` to `common` for the cache plugin; M16
    made `ctx.request.user` writable).
  - `PUBLIC_API.md` update for the new `IRouterApi.listRoutes()` seam, the
    `@hono-enterprise/openapi-plugin` public surface, and the `IOpenApiService` interface.
  - `ARCHITECTURE.md` update for the openapi-plugin section (already has a stub) and the
    route-introspection seam.
  - `ROADMAP.md` progress-tracking row flip to `✅` and CLAUDE.md "Current status" update.
- **NOT this milestone:**
  - OpenAPI code generation (client SDK from a spec) — owned by the SDK milestone (M30+).
  - OpenAPI contract validation / schemathesis-style testing — not on the roadmap.
  - Per-route `security` requirement enforcement — the plugin records `security` metadata declared
    in `RouteSchema` into the spec but does not enforce it (enforcement is the auth plugin's guards,
    M16).
  - ReDoc or alternate UIs — only Swagger UI ships; the UI is an HTML shell loading the official
    Swagger UI bundle from a CDN, so no UI assets are bundled.

## 1. Contracts verified from SOURCE (not names)

| Reference                     | Source (file:line)                                    | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IPlugin`                     | `packages/common/src/plugin.ts:437`                   | `name`, `version`, `dependencies?`, `optionalDependencies?`, `provides?`, `consumes?`, `priority?`, `register(ctx): void \| Promise<void>` — the contract the plugin factory returns.                                                                                                                                                                                                                                                                                                                                                 |
| `IPluginContext`              | `packages/common/src/plugin.ts:376`                   | `services`, `middleware`, `router`, `environment`, `health`, `metrics`, `openapi`, `decorators`, `cli`, `lifecycle`, `runtime` (non-optional), `config?`, `logger?`, `metadata?`, `container?`, `options`, `app`. The plugin reads `ctx.router`, `ctx.openapi`, `ctx.services`, `ctx.lifecycle`, `ctx.runtime`, and optionally `ctx.metadata`.                                                                                                                                                                                        |
| `IRouterApi`                  | `packages/common/src/plugin.ts:59`                    | `get/post/put/patch/delete/head/options(path, route)` and `group(prefix, configure)`. **No read/introspection method exists** — `listRoutes()` must be added (§3.1).                                                                                                                                                                                                                                                                                                                                                                  |
| `RouteDefinition`             | `packages/common/src/http.ts:267`                     | `{ handler, middleware?, schema? }` — `schema` is `RouteSchema`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RouteSchema`                 | `packages/common/src/http.ts:244`                     | `{ body?, query?, params?, headers?, response?: Readonly<Record<number, unknown>>, tags?, summary? }`. All schema values are `unknown` (common is dep-free; the OpenAPI plugin narrows them to Zod). NOTE: `description` and `security` appear in PUBLIC_API.md examples but are NOT on the committed `RouteSchema` — see §2 C2.                                                                                                                                                                                                      |
| `IOpenApiApi`                 | `packages/common/src/plugin.ts:187`                   | `addSchema(name: string, schema: unknown): void` — the contribution funnel. The kernel wires it to `CAPABILITIES.OPENAPI_SCHEMA` multi-provider (`packages/kernel/src/application/application.ts:183`).                                                                                                                                                                                                                                                                                                                               |
| `IServiceRegistry`            | `packages/common/src/registry.ts:55`                  | `register<T>(token, service, options?)`, `registerFactory`, `get<T>`, `getAll<T>`, `has`, `unregister`. The plugin registers `IOpenApiService` under `CAPABILITIES.OPENAPI` and drains `getAll(CAPABILITIES.OPENAPI_SCHEMA)` at `onInit`.                                                                                                                                                                                                                                                                                             |
| `CAPABILITIES.OPENAPI`        | `packages/common/src/tokens.ts:69`                    | `'openapi'` — lowercase kebab, already in the constant. No new token needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CAPABILITIES.OPENAPI_SCHEMA` | `packages/common/src/tokens.ts:105`                   | `'openapi-schema'` — multi-provider contribution token, already wired in the kernel.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IMetadataStore`              | `packages/common/src/plugin.ts:314`                   | `controllers`, `services`, `routes` maps (loosely typed). The decorator plugin's concrete `RouteMetadata` carries `openapi?` and `schema?` (`packages/decorator-plugin/src/metadata/metadata-store.ts:137`), and the decorator plugin folds both into `RouteDefinition.schema` at registration (`packages/decorator-plugin/src/plugin/decorator-plugin.ts:208` `buildRouteSchema`). So decorator-based routes reach the OpenAPI plugin through the SAME `RouteDefinition.schema` seam — no separate decorator-reading path is needed. |
| `IRuntimeServices`            | `packages/common/src/runtime.ts`                      | `now()`, `uuid()`, `env`, etc. Used for the generated `operationId` fallback and any timestamp. The plugin does NOT call `Date.now()` (CLAUDE.md clock rule).                                                                                                                                                                                                                                                                                                                                                                         |
| `IResponse`                   | `packages/common/src/http.ts:83`                      | `status(code)`, `header(name, value)`, `json<T>(body)`, `text(body)`, `send(body?)`. The spec and UI handlers build responses via `ctx.response`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `RouteHandler`                | `packages/common/src/http.ts:235`                     | `(ctx: IRequestContext) => HandlerResult \| Promise<HandlerResult>` — the shape of the spec/UI route handlers.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Router.getAll()`             | `packages/kernel/src/router/router.ts:129`            | Kernel-internal `getAll(): readonly RouteEntry[]` where `RouteEntry = { pattern, method, definition, index, segments, statics }` (`packages/kernel/src/router/router.ts:17`). This is the data the generator needs; it is NOT on `IRouterApi` and `RouteEntry` is NOT exported from kernel's index — hence §3.1 adds a public `listRoutes()` seam.                                                                                                                                                                                    |
| Zod specifier                 | `deno.lock:24`                                        | `"npm:zod@^3.24.0": "3.25.76"` — the resolved Zod version in this repo. The transformer imports `npm:zod@^3.24.0` (matches the config-plugin precedent, `packages/config-plugin/src/plugin/config-plugin.ts:64`).                                                                                                                                                                                                                                                                                                                     |
| Decorator OpenAPI metadata    | `packages/decorator-plugin/src/decorators/openapi.ts` | `@ApiTags`, `@ApiOperation({operationId,summary,description})`, `@ApiResponse({status,description,schema})` exist and write into `RouteMetadata.openapi` (`packages/decorator-plugin/src/metadata/metadata-store.ts:63`). The decorator plugin merges these into `RouteSchema` (`buildRouteSchema` / `buildResponseSchemas`). **Decorator-based API is in scope** because the decorator plugin already exists (M9 complete) and flows metadata into `RouteDefinition.schema`.                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                                                                                          |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `IRouterApi` (common source) has no route-introspection method, but ROADMAP M21 says "Generate OpenAPI docs from route definitions" and PUBLIC_API.md shows the spec derived from `app.router.post(..., { schema })`. The generator cannot read routes without a seam.   | Add `listRoutes(): readonly RouteInfo[]` to `IRouterApi` in `packages/common/src/plugin.ts` and implement it in the kernel `Router` (`packages/kernel/src/router/router.ts`) returning `{ method, path, definition }` triples. `RouteInfo` is a new exported type in `common`. This is a minimal, additive public-API change (no existing method altered).                                                                                      | `PUBLIC_API.md` (add `listRoutes` to the `IRouterApi` row and the plugin-context APIs table), `ARCHITECTURE.md` (note the introspection seam).                                                                     |
| C2 | `PUBLIC_API.md` OpenAPI route-schema example (`PUBLIC_API.md:2614`) uses `description` and `security` fields on `RouteSchema`, but the committed `RouteSchema` interface (`packages/common/src/http.ts:244`) has only `body/query/params/headers/response/tags/summary`. | Pick the committed source: `RouteSchema` does NOT carry `description` or `security`. The OpenAPI plugin will NOT read those fields from `RouteSchema` (they are not there). `description` and `security` per-operation are out of scope for M21 (a future milestone may widen `RouteSchema` in `common`). The plugin emits `summary` and `tags` (which ARE on `RouteSchema`).                                                                   | `PUBLIC_API.md` (correct the OpenAPI route-schema example to remove `description` and `security`, or mark them as planned-future), `ROADMAP.md` (no change — ROADMAP example already matches the committed shape). |
| C3 | ROADMAP M21 lists `swagger: true` as a plugin option; PUBLIC_API.md shows `endpoint: '/docs'` and `specEndpoint: '/openapi.json'` but no `swagger` boolean.                                                                                                              | Pick a superset: the plugin accepts `swagger?: boolean` (default `true`), `endpoint?: string` (default `'/docs'`, the UI), and `specEndpoint?: string` (default `'/openapi.json'`, the JSON spec). When `swagger: false`, the UI route is not registered but the spec endpoint still is.                                                                                                                                                        | `PUBLIC_API.md` (document all three options and their defaults).                                                                                                                                                   |
| C4 | ARCHITECTURE.md openapi-plugin stub (`ARCHITECTURE.md:1284`) lists "Public API: `OpenApiPlugin()`; `IOpenApiService`" but `IOpenApiService` is not in `common` (no `services/openapi.ts`).                                                                               | `IOpenApiService` is owned by the openapi-plugin package (not `common`), exported from `packages/openapi-plugin/src/index.ts`. `common` stays dep-free. This matches the pattern where plugin-specific service interfaces live in their plugin (e.g. the scheduler plugin owns its concrete service shape while `IScheduler` is in common — but here there is no `common` OpenAPI service contract, so the plugin owns the interface outright). | `PUBLIC_API.md` (document `IOpenApiService` under the OpenAPI section), `ARCHITECTURE.md` (clarify the interface ownership).                                                                                       |

## 3. Design decisions

### 3.1 Route introspection seam

- **Decision:** Add `listRoutes(): readonly RouteInfo[]` to `IRouterApi` in
  `packages/common/src/plugin.ts`, where
  `RouteInfo = { readonly method: HttpMethod; readonly path: string; readonly definition: RouteDefinition }`.
  Implement it in the kernel `Router` (`packages/kernel/src/router/router.ts`) by mapping its
  internal `RouteEntry[]` to the public `RouteInfo` shape (dropping `index`/`segments`/`statics`).
  Export `RouteInfo` from `@hono-enterprise/common`.
- **Why:** The OpenAPI generator must read every registered route's `method`, `path`, and `schema`.
  `IRouterApi` currently exposes only write methods; the kernel's `Router.getAll()` is internal and
  `RouteEntry` is not exported. Adding a read seam to the public interface is the minimal, type-safe
  way to let the plugin (and future introspection tooling) read routes without importing kernel
  internals. This is additive (no existing method changes) and mirrors the M11 precedent of adding
  `IResponse.snapshot()` to `common` for a downstream plugin.
- **Test home:** `test/unit/openapi-generator.test.ts` asserts the generator consumes `RouteInfo[]`
  and produces the expected `paths` object; `packages/kernel/test/unit/router.test.ts` (extended in
  this PR) asserts `listRoutes()` returns every registered route in registration order with the
  correct `method`/`path`/`definition`.

### 3.2 Spec generation timing and caching

- **Decision:** The plugin builds the OpenAPI document lazily on the first request to the spec
  endpoint (or first `IOpenApiService.getSpec()` call) and caches it. It registers an `onInit` hook
  that drains `CAPABILITIES.OPENAPI_SCHEMA` contributions (named schemas from other plugins) into
  the generator's component store, but the full `paths` are computed from
  `ctx.app.router.listRoutes()` at first-spec-read time (after all plugins have registered and the
  router is fully populated). The cached spec is invalidated never (routes are not added after
  `start()` — `Application.register` throws after start,
  `packages/kernel/src/application/application.ts:125`).
- **Why:** Routes are only registered before `start()`; the router is immutable at request time.
  Building once and caching avoids per-request re-generation (AI_GUIDELINES §14, hoist work out of
  the request path; ARCHITECTURE.md §"OpenAPI spec is generated once and cached").
- **Test home:** `test/unit/openapi-service.test.ts` asserts the spec is built on first `getSpec()`
  and the same instance is returned on subsequent calls;
  `test/integration/openapi-integration.test.ts` asserts a request to `/openapi.json` returns 200
  and the body matches `getSpec()`.

### 3.3 Zod → OpenAPI conversion strategy

- **Decision:** `ZodToOpenApi` imports `z` from `npm:zod@^3.24.0` and converts a Zod schema to an
  OpenAPI 3.1 schema object by introspecting the schema's `_def` (Zod's internal AST). It handles
  `ZodObject` → `type: 'object'` + `properties` + `required`, `ZodString` → `type: 'string'` (+
  `format`/`minLength`/`maxLength` when present), `ZodNumber` → `type: 'number'` (+
  `minimum`/`maximum`), `ZodBoolean`, `ZodArray`, `ZodOptional`/`ZodNullable` (unwrap), `ZodEnum`,
  `ZodLiteral`, `ZodUnion` (`anyOf`), `ZodIntersection` (`allOf`), `ZodRecord`, `ZodDate`
  (`type: 'string'`, `format: 'date-time'`), and `ZodEffects`/`ZodPipeline` (unwrap to the inner
  schema). Schemas it does not recognize fall back to an empty schema (`{}`) — never throw, so an
  exotic schema never breaks spec generation.
- **Why:** Zod 3.x exposes `_def` and `_parse`; there is no stable public "to JSON schema" API in
  the installed version. Introspecting `_def` is the established technique (used by
  `@asteasolutions/zod-to-openapi` and `zod-openapi`). The plugin owns the Zod dependency in its
  `deno.json` `imports` (matching `deno.lock`'s `npm:zod@^3.24.0`); `common` stays dep-free. The
  validation plugin duck-types `safeParse` and does NOT import zod
  (`packages/validation-plugin/src/services/validation-service.ts:32`), so the OpenAPI plugin is the
  first package to import zod directly — justified because schema introspection needs the real AST,
  not a structural interface.
- **Test home:** `test/unit/zod-to-openapi.test.ts` asserts each Zod type maps to the expected
  OpenAPI fragment (field-by-field, per the CLAUDE.md spec-named-output rule), including the
  fallback-to-`{}` branch for an unknown schema kind.

### 3.4 Schema deduplication and `components/schemas`

- **Decision:** The generator maintains a `Map<schemaObject, string>` keyed by the Zod schema
  instance (object identity). Named schemas come from `CAPABILITIES.OPENAPI_SCHEMA` contributions
  (`ctx.openapi.addSchema(name, schema)`) and are registered first. When the generator encounters a
  schema already in the map, it emits a `$ref:
  '#/components/schemas/<Name>'` instead of
  re-converting. Anonymous schemas used more than once get a generated name (`Schema<n>`) on first
  reuse and are hoisted to `components/schemas`; schemas used exactly once are inlined.
- **Why:** ROADMAP M21 lists "Schema deduplication" as a required test area. Object-identity keying
  is deterministic and matches how Zod schemas are shared (the same `UserSchema` constant is
  referenced by multiple routes). Generated names avoid collisions without requiring every schema to
  be named.
- **Test home:** `test/unit/openapi-generator.test.ts` asserts that a schema referenced by two
  routes appears once in `components/schemas` and both routes reference it via `$ref`; a schema used
  once is inlined (no `$ref`).

### 3.5 Swagger UI serving

- **Decision:** When `swagger` is not `false`, the plugin registers a GET route at `endpoint`
  (default `'/docs'`) that returns an HTML page. The HTML loads the official Swagger UI
  (`swagger-ui-dist`) from the unpkg CDN via `<script>`/`<link>` tags and points it at the
  `specEndpoint` URL. No UI assets are bundled or imported; the response is a single HTML string
  built once at registration time and cached. The spec endpoint (`/openapi.json` by default) is
  always registered and returns the JSON spec with `content-type:
  application/json`.
- **Why:** Bundling Swagger UI (a large JS/CSS asset) would violate the minimal-bundle /
  no-heavy-deps rules (AI_GUIDELINES §12.1, §14.4) and add a build step. Loading from CDN is the
  zero-dependency approach used by most Fastify/Hono OpenAPI plugins. The HTML is built once
  (hoisted, AI_GUIDELINES §14) and served as a constant string.
- **Test home:** `test/unit/swagger-ui.test.ts` asserts the HTML string contains the CDN script tag
  and the configured `specEndpoint` URL; `test/integration/openapi-integration.test.ts` asserts
  `GET /docs` returns 200 with `content-type: text/html` and `GET /openapi.json` returns 200 with
  `content-type: application/json`. When `swagger: false`, the `/docs` route is NOT registered
  (asserted in the integration test).

### 3.6 Decorator-based route support

- **Decision:** The decorator-based API (`@Controller`/`@Post`/`@ApiTags`/`@ApiOperation`/
  `@ApiResponse`/`@Body`) is IN SCOPE and requires NO OpenAPI-plugin-specific code beyond reading
  `RouteDefinition.schema`. The decorator plugin (M9, complete) already folds
  `@ApiTags`/`@ApiOperation`/`@ApiResponse` and `@ValidateBody` schemas into
  `RouteDefinition.schema` (`packages/decorator-plugin/src/plugin/decorator-plugin.ts:208`
  `buildRouteSchema`, `:189` `buildResponseSchemas`). The OpenAPI generator reads
  `RouteDefinition.schema` uniformly for both programmatic and decorator-registered routes.
- **Why:** The decorator plugin exists and already normalizes decorator metadata into the
  `RouteSchema` shape the generator consumes. A separate decorator-reading path would duplicate that
  normalization and couple the OpenAPI plugin to the decorator plugin's internal metadata shapes
  (violating plugin independence, AI_GUIDELINES §3.3).
- **Test home:** `test/integration/openapi-integration.test.ts` includes a decorator-based
  controller fixture and asserts its routes appear in the generated spec with the correct
  tags/summary/responses, identical to a programmatic route with the same schema.

### 3.7 `operationId` generation

- **Decision:** Each operation's `operationId` is derived as
  `<method-lowercased>-<path-with-slashes-dashed>` (e.g. `POST /users/:id` → `post-users-{id}`),
  unless `RouteSchema` carries an explicit `operationId` (it does not today — see §2 C2; the
  decorator `@ApiOperation({ operationId })` writes to `RouteMetadata.openapi.operationId`, but the
  decorator plugin does NOT currently copy `openapi.operationId` into `RouteSchema`). For M21, the
  generator always synthesizes the `operationId` from method + path. If a future milestone widens
  `RouteSchema` to carry `operationId`, the generator will prefer it.
- **Why:** OpenAPI requires `operationId` to be unique per spec. A deterministic method+path
  derivation is unique (the router rejects duplicate method+path at match time) and stable across
  restarts. Reading `openapi.operationId` from decorator metadata would require the OpenAPI plugin
  to import the decorator plugin's internal `RouteMetadata` shape — a cross-plugin internal import
  that AI_GUIDELINES §3.3 forbids.
- **Test home:** `test/unit/openapi-generator.test.ts` asserts the synthesized `operationId` for
  several method+path combinations and uniqueness across a multi-route fixture.

### 3.8 Path and query parameters → OpenAPI `parameters`

- **Decision:** The generator converts `RouteSchema.params` and `RouteSchema.query` into the
  operation's OpenAPI `parameters` array (they are NOT request bodies). Each is expected to be a Zod
  object schema; the generator enumerates its `ZodObject` shape (via the same `_def` introspection
  as `ZodToOpenApi`, reusing the transformer for each property's schema) and emits one `parameters`
  entry per property: `{ name, in, required, schema }` where `in` is `'path'` for `params` and
  `'query'` for `query`. `required` is `true` for path parameters always (a path template variable
  is always required in OpenAPI) and, for query parameters, `true` unless the property's Zod schema
  is `ZodOptional` (or has a default). A `params`/`query` schema that is not a `ZodObject` (or is
  absent) contributes no parameters. Parameters and `requestBody` coexist on the same operation when
  both `params`/`query` and `body` are present.
- **Why:** `RouteSchema` carries `query` and `params` (and the decorator plugin's `buildRouteSchema`
  at `packages/decorator-plugin/src/plugin/decorator-plugin.ts:208` folds
  `schema.query`/`schema.params` into the `RouteSchema` the generator consumes), so a spec that
  dropped them would silently omit the most common inputs an API consumer needs and would be
  incomplete against every documented route with a path or query parameter. OpenAPI models path and
  query inputs as `parameters`, not as a request body — mapping them there is required for a correct
  spec (and for the path-template variables from §3.9 to resolve, per the OpenAPI rule that every
  `{var}` in a path key has a matching `in: 'path'` parameter).
- **Test home:** `test/unit/openapi-generator.test.ts` asserts that a route whose `RouteSchema` has
  a `params` Zod object emits `parameters` entries with `in: 'path'` and `required: true`, and a
  `query` Zod object emits `in: 'query'` entries with `required` reflecting Zod optionality (an
  optional field → `required: false`); a route with both `body` and `params` emits both
  `requestBody` and `parameters`; a non-object/absent `params`/`query` emits no parameters.

### 3.9 OpenAPI path-template conversion (`:param` → `{param}`)

- **Decision:** The generator converts each route's router-style path to OpenAPI path-template
  syntax when building the `paths` key: every `:name` segment becomes `{name}` (e.g. `/users/:id` →
  `/users/{id}`, `/orgs/:orgId/users/:id` → `/orgs/{orgId}/users/{id}`). This single conversion
  helper is the one source of truth and is reused by §3.7's `operationId` synthesis (which already
  renders `{id}`), so both the `paths` key and the `operationId` derive from the same converted
  path. The set of `{name}` variables extracted during conversion is the authoritative list of path
  parameters; §3.8's `in: 'path'` parameters are reconciled against it (a path variable with no
  `params` schema entry still emits a minimal `{ name, in: 'path',
  required: true, schema: {} }`
  so the spec stays valid).
- **Why:** OpenAPI 3.1 `paths` keys MUST use `{var}` templating; a key like `/users/:id` is invalid
  OpenAPI and Swagger UI will not render it as a templated path. The router stores and matches
  `:param` syntax (`packages/kernel/src/router/router.ts` `RouteEntry.pattern`), so the generator —
  not the router — owns the translation to spec syntax. Deriving both the path key and `operationId`
  from one converted path guarantees they agree (CLAUDE.md one-implementation rule), and reconciling
  emitted path variables against §3.8's parameters guarantees the required "every template variable
  has a path parameter" OpenAPI invariant holds.
- **Test home:** `test/unit/openapi-generator.test.ts` asserts that a route registered as
  `/users/:id` produces a `paths` key of `/users/{id}` (and a multi-param path converts every
  segment); that a path variable always yields a matching `in: 'path'`, `required: true` parameter
  even when `RouteSchema.params` is absent; and that the `paths` key and the `operationId` for the
  same route are derived from the identical converted path.

## 4. Exported surface — every symbol names its consumer

| Exported symbol             | Kind                                 | Consumer / real code path that READS it                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenApiPlugin`             | factory function                     | The application: `app.register(OpenApiPlugin({...}))`. Returns an `IPlugin` consumed by the kernel's plugin resolver (`packages/kernel/src/application/application.ts:277`).                                                                   |
| `OpenApiPluginOptions`      | type                                 | The application author typing the options object passed to `OpenApiPlugin`.                                                                                                                                                                    |
| `IOpenApiService`           | interface                            | Application code and other plugins: `ctx.services.get<IOpenApiService>(CAPABILITIES.OPENAPI)` (PUBLIC_API.md shows this). Read by the spec/UI route handlers inside the plugin and by any consumer calling `getSpec()`.                        |
| `OpenApiService`            | class (implements `IOpenApiService`) | Registered under `CAPABILITIES.OPENAPI` by the plugin; the spec/UI handlers call `service.getSpec()`.                                                                                                                                          |
| `OpenApiGenerator`          | class                                | Internal to the plugin but exported for advanced consumers who want to generate a spec without registering HTTP routes (e.g. a CLI docs command in a future milestone). Read by `OpenApiService` and by `test/unit/openapi-generator.test.ts`. |
| `ZodToOpenApi`              | class                                | `OpenApiGenerator` calls `transform(schema)` to convert each `RouteSchema` field. Also exported for consumers who want ad-hoc Zod→OpenAPI conversion.                                                                                          |
| `zodToOpenApi`              | function (convenience)               | Re-exported convenience wrapper around `new ZodToOpenApi().transform(schema)` for one-off use; read by tests and by `OpenApiGenerator`.                                                                                                        |
| `swaggerUiHtml`             | function                             | Returns the cached Swagger UI HTML string for a given spec URL. Read by the UI route handler and by `test/unit/swagger-ui.test.ts`.                                                                                                            |
| `RouteInfo` (from `common`) | type                                 | The OpenAPI generator's input; also available to any consumer of `IRouterApi.listRoutes()`.                                                                                                                                                    |

### 4.1 Options — every option names its consumer

| Option            | Consumer                                            | Behavior (per implementation)                                                                                                      |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | `OpenApiGenerator` → `info.title`                   | Required-ish; defaults to `'API'` when omitted. Written into the `info` block of the spec.                                         |
| `version`         | `OpenApiGenerator` → `info.version`                 | Defaults to `'1.0.0'`. Written into `info.version`.                                                                                |
| `description`     | `OpenApiGenerator` → `info.description`             | Optional; omitted from `info` when not provided (respects `exactOptionalPropertyTypes`).                                           |
| `servers`         | `OpenApiGenerator` → `servers`                      | Optional array of `{ url, description? }`; written into the top-level `servers` array.                                             |
| `securitySchemes` | `OpenApiGenerator` → `components.securitySchemes`   | Optional record; written into `components/securitySchemes`. (Per-operation `security` is NOT read from `RouteSchema` — see §2 C2.) |
| `endpoint`        | UI route registration in `OpenApiPlugin.register`   | Path for the Swagger UI HTML page; defaults to `'/docs'`. When `swagger` is `false`, this option is ignored.                       |
| `specEndpoint`    | Spec route registration in `OpenApiPlugin.register` | Path for the JSON spec; defaults to `'/openapi.json'`. Always registered.                                                          |
| `swagger`         | UI route registration in `OpenApiPlugin.register`   | Boolean, default `true`. When `false`, the UI route is not registered (spec endpoint still is).                                    |

## 5. Implementation files

| File                                                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/plugin.ts`                               | Add `listRoutes(): readonly RouteInfo[]` to `IRouterApi`; add `RouteInfo` type (importing `RouteDefinition` + `HttpMethod` already in scope).                                                                                                                                                                                                                                                                                                                                                     |
| `packages/common/src/index.ts`                                | Re-export `RouteInfo` from `./plugin.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/kernel/src/router/router.ts`                        | Implement `listRoutes()` on `Router` by mapping `RouteEntry[]` → `RouteInfo[]` (drop `index`/`segments`/`statics`).                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/openapi-plugin/deno.json`                           | Package manifest; `imports` adds `npm:zod@^3.24.0` and `@hono-enterprise/common` + `@hono-enterprise/kernel` jsr specifiers.                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/openapi-plugin/src/index.ts`                        | Barrel: `OpenApiPlugin`, `OpenApiPluginOptions`, `IOpenApiService`, `OpenApiService`, `OpenApiGenerator`, `ZodToOpenApi`, `zodToOpenApi`, `swaggerUiHtml`.                                                                                                                                                                                                                                                                                                                                        |
| `packages/openapi-plugin/src/plugin/openapi-plugin.ts`        | `OpenApiPlugin(options?)` factory returning an `IPlugin` (name `'openapi-plugin'`, `provides: [CAPABILITIES.OPENAPI]`, high priority number so it registers last). In `register`: build the generator, register `OpenApiService` under `CAPABILITIES.OPENAPI`, drain `OPENAPI_SCHEMA` contributions at `onInit`, register the spec + UI routes.                                                                                                                                                   |
| `packages/openapi-plugin/src/services/openapi-service.ts`     | `OpenApiService` implements `IOpenApiService` (`getSpec(): Readonly<Record<string, unknown>>`). Lazily builds and caches the spec via the generator on first call.                                                                                                                                                                                                                                                                                                                                |
| `packages/openapi-plugin/src/generators/openapi-generator.ts` | `OpenApiGenerator`: takes options (title/version/description/servers/securitySchemes), a `ZodToOpenApi` transformer, and a component-schema store. `generate(routes: readonly RouteInfo[]): OpenApiDocument` builds `paths` (keys converted `:param`→`{param}`, §3.9) + per-operation `parameters` from `params`/`query` (§3.8) + `requestBody`/responses + `components.schemas` with deduplication. Owns the single `:param`→`{param}` path-conversion helper reused by `operationId` synthesis. |
| `packages/openapi-plugin/src/transformers/zod-to-openapi.ts`  | `ZodToOpenApi`: `transform(schema: unknown): OpenApiSchemaObject`. Imports `z` from `npm:zod@^3.24.0`, introspects `_def`, handles the Zod types listed in §3.3, falls back to `{}` for unknown kinds.                                                                                                                                                                                                                                                                                            |
| `packages/openapi-plugin/src/ui/swagger-ui.ts`                | `swaggerUiHtml(specUrl: string): string` — returns the cached HTML string loading Swagger UI from unpkg CDN and pointing at `specUrl`.                                                                                                                                                                                                                                                                                                                                                            |
| `packages/openapi-plugin/src/interfaces/openapi-service.ts`   | `IOpenApiService` interface (`getSpec(): Readonly<Record<string, unknown>>`).                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Token grammar:** The plugin registers under `CAPABILITIES.OPENAPI` (`'openapi'`, already in
`packages/common/src/tokens.ts:69`) — single provider, no `multi`. It consumes
`CAPABILITIES.OPENAPI_SCHEMA` (`'openapi-schema'`, multi-provider, already wired in the kernel at
`packages/kernel/src/application/application.ts:183`) via `ctx.services.getAll(...)`. No new
capability tokens are created (the grammar in `packages/common/src/tokens.ts:139`
`createCapabilityToken` is not invoked). No `override` is used.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                                                                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/openapi-plugin/test/unit/zod-to-openapi.test.ts`             | `src/transformers/zod-to-openapi.ts`                                                       | Each Zod type → expected OpenAPI fragment, field-by-field: `ZodString`→`{type:'string'}` + format/minLength; `ZodNumber`→`{type:'number'}`+minimum/maximum; `ZodBoolean`→`{type:'boolean'}`; `ZodArray`→`{type:'array',items}`; `ZodObject`→`{type:'object',properties,required}`; `ZodOptional`/`ZodNullable` unwrap; `ZodEnum`→`{enum}`; `ZodLiteral`→`{const}`; `ZodUnion`→`{anyOf}`; `ZodIntersection`→`{allOf}`; `ZodRecord`→`{type:'object',additionalProperties}`; `ZodDate`→`{type:'string',format:'date-time'}`; `ZodEffects`/`ZodPipeline` unwrap; unknown kind → `{}`. Calls `transform(schema: unknown): OpenApiSchemaObject`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/openapi-plugin/test/unit/openapi-generator.test.ts`          | `src/generators/openapi-generator.ts`                                                      | `generate(routes: readonly RouteInfo[])` produces: `paths` keyed by the **OpenAPI-templated** path (`:id` → `{id}`, §3.9) with method sub-objects; `operationId` synthesized from method+path and derived from the SAME converted path as the key; `summary`/`tags` from `RouteSchema`; `requestBody` from `RouteSchema.body` with `content: application/json`; `parameters` from `RouteSchema.params` (`in: 'path'`, `required: true`) and `RouteSchema.query` (`in: 'query'`, `required` from Zod optionality) per §3.8; a path template variable with no `params` entry still yields a minimal `in: 'path'` parameter (§3.9); `body` + `params` coexist as `requestBody` + `parameters`; a non-object/absent `params`/`query` emits no parameters; response entries from `RouteSchema.response` keyed by status; deduplication — a schema referenced by two routes appears once in `components.schemas` and both routes use `$ref`; a schema used once is inlined (no `$ref`); `info`/`servers`/`securitySchemes` from options. |
| `packages/openapi-plugin/test/unit/openapi-service.test.ts`            | `src/services/openapi-service.ts`                                                          | `getSpec()` builds the spec on first call and returns the same cached object on the second call (identity check); the spec matches the generator output for a fixed route set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/openapi-plugin/test/unit/swagger-ui.test.ts`                 | `src/ui/swagger-ui.ts`                                                                     | `swaggerUiHtml(specUrl)` returns HTML containing the unpkg Swagger UI script tag and the given `specUrl` string; different `specUrl` values produce different strings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/openapi-plugin/test/unit/openapi-plugin.test.ts`             | `src/plugin/openapi-plugin.ts`                                                             | The factory returns an `IPlugin` with `name: 'openapi-plugin'`, `provides: ['openapi']`; `register(ctx)` registers `OpenApiService` under `CAPABILITIES.OPENAPI`, registers the spec route at `specEndpoint`, and (when `swagger !== false`) the UI route at `endpoint`; when `swagger: false`, the UI route is NOT registered (assert via a fake router that records `get` calls); `onInit` drains `OPENAPI_SCHEMA` contributions into the generator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/openapi-plugin/test/unit/barrel-exports.test.ts`             | `src/index.ts`                                                                             | Every documented export is present and is the expected kind (function/class/type).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/openapi-plugin/test/integration/openapi-integration.test.ts` | `src/plugin/openapi-plugin.ts` + `src/services` + `src/generators` + `src/ui` (end-to-end) | Build a real `createApplication` with `RuntimePlugin` + `OpenApiPlugin`; register programmatic routes with Zod schemas AND a decorator-based controller fixture; `app.inject({ method: 'GET', url: '/openapi.json' })` returns 200, `content-type: application/json`, and a body whose `paths` include both routes with correct schemas/tags/responses; `app.inject({ method: 'GET', url: '/docs' })` returns 200 `text/html` containing the spec URL; with `swagger: false`, `/docs` returns 404 and `/openapi.json` still 200.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/openapi-plugin/test/fixtures/fake-runtime.ts`                | (fixture)                                                                                  | Minimal `IRuntimeServices` fake for unit tests (matches the pattern in `packages/health-plugin/test/fixtures/fake-runtime.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/kernel/test/unit/router.test.ts` (extended)                  | `packages/kernel/src/router/router.ts` `listRoutes()`                                      | After registering several routes, `listRoutes()` returns them in registration order with correct `method`/`path`/`definition`; group-registered routes appear with their composed full path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Per-file 90% bar: every file under `packages/openapi-plugin/src/` and the touched
`packages/kernel/src/router/router.ts` / `packages/common/src/plugin.ts` must reach ≥90% on branch,
function, AND line (read ANSI-stripped per-file table from `deno task test:coverage`).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/21-openapi-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task audit
```

## 8. Risks & mitigations

- **Zod `_def` introspection is version-coupled.** Zod 3.x `_def` shapes are internal and can change
  between minor versions. Mitigation: pin `npm:zod@^3.24.0` (matches `deno.lock`), and the
  transformer's unknown-kind fallback returns `{}` rather than throwing so a future Zod shape change
  degrades gracefully (missing fields) instead of crashing spec generation. A test asserts the
  fallback branch.
- **`listRoutes()` is a new public `IRouterApi` method.** Adding a method to a committed interface
  is a public-API change. Mitigation: it is purely additive (no existing method signature changes),
  documented in PUBLIC_API.md in the same PR, and the kernel's `GroupRouter` also implements it
  (delegating to the parent) so the interface contract holds for group facades too.
- **CDN dependency for Swagger UI.** The UI page loads Swagger UI from unpkg; an offline or
  air-gapped deployment cannot render the UI. Mitigation: documented in the README and
  PUBLIC_API.md; the JSON spec endpoint has no CDN dependency and works offline. A future milestone
  may bundle the UI assets behind a lazy `npm:` import if offline UI is needed.
- **Decorator `@ApiOperation({ operationId })` is not surfaced.** The decorator plugin writes
  `operationId` to `RouteMetadata.openapi` but does not copy it into `RouteSchema`
  (`buildRouteSchema` at `packages/decorator-plugin/src/plugin/decorator-plugin.ts:208` omits it).
  The OpenAPI plugin synthesizes `operationId` from method+path instead (§3.7). Mitigation:
  documented as a known limitation; a future milestone may widen `RouteSchema` in `common` to carry
  `operationId`/`description`/`security`, at which point the generator prefers the explicit value.

## 9. Out of scope

- **OpenAPI client code generation** — owned by the SDK milestone (M30+, ROADMAP "SDK — HTTP client
  with retry, circuit breaker, OpenAPI codegen").
- **Per-operation `security` enforcement and `description` on `RouteSchema`** — `RouteSchema` in
  `common` does not carry these fields (§2 C2); widening it is a `common` public-API change deferred
  to a future milestone. The plugin records `securitySchemes` (a top-level option) but not
  per-operation `security`.
- **ReDoc or alternate UIs** — only Swagger UI ships.
- **Bundling Swagger UI assets for offline use** — the UI loads from CDN; offline bundling is a
  future concern.
- **OpenAPI contract validation / mock-server generation** — not on the roadmap.
- **Hot-reload of the spec after `start()`** — routes are immutable after `start()` (the kernel
  throws on `register` after start), so the spec is built once and cached; no invalidation path is
  needed.
