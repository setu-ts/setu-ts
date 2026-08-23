# Milestone 70m — SDK and OpenAPI (`@setu-ts/sdk`, `@setu-ts/openapi-plugin`)

> **Status:** Complete (PR #181). Archived on completion. Branch: `feat/m70m-sdk-openapi`.

## 0. Objective & scope

Seven `smoke/DEFECTS.md` rows (X11-3 through X11-9) with one shape: **the document a Setu-TS
application publishes about itself, and the client generated from it, both describe less than the
application actually is** — and where they do describe it, the output cannot be published, formatted
or linted by the same toolchain the framework scaffolds. A route carrying `validateBody(schema)`
contributes nothing to the document, so the generated client for the API's only write takes no
argument and 400s against the live server (X11-5); the generated client cannot be published to JSR
because `createApi` has an inferred return type (X11-4); declared error responses type nothing
(X11-7); a reused schema appears both inline and as a `$ref` to a meaningless `Schema1` (X11-6);
`operationId` carries path braces and every generated client ships the app's operational surface
(X11-8); the emitted source fails `deno fmt --check` (X11-9); and the CORS example the
`http-security-plugin` README ships blocks every JSON request (X11-3).

- **In scope:** X11-3, X11-4, X11-5, X11-6, X11-7, X11-8, X11-9 — the `openapi-plugin` document
  generator, the `sdk` code generator, the `validation-plugin` middleware brand, the `common`
  contract that carries it, and the `http-security-plugin` CORS default.
- **NOT this milestone:** X11-1 (SDK `fetch` binding — closed in M70e), X11-2 (kernel fallback 500
  logging — closed in M70f). `@ValidateBody(schema)` not validating (E1) and `@Body()` discarding
  transforms (E2) are **M70n**, which owns `decorator-plugin`. Deriving a document from a decorated
  controller's `@ValidateBody` metadata is M70n's, not this milestone's — this milestone brands the
  programmatic middleware. Trailer-carrying gRPC serve paths, GraphQL and the `testing` package's
  `errorHandler` story are unowned or owned elsewhere.

**Package list corrected from the ROADMAP's three.** The row names `sdk`, `openapi-plugin` and
`validation-plugin`. Two more are required by rows the row itself assigns, mirroring the M70b, M70g,
M70h and M70k corrections: **`common`**, because X11-5's brand is a symbol plus two helpers that
`validation-plugin` writes and `openapi-plugin` reads, and §2.2 forbids a plugin importing a plugin
— exactly the channel M57 opened for `SECURITY_METADATA`; and **`http-security-plugin`**, which is
the package `smoke/DEFECTS.md` assigns X11-3 to (the ROADMAP body lists the row without listing its
package).

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                       | Verified surface / fact                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECURITY_METADATA` brand mechanism    | `packages/common/src/http.ts:404`                                        | `Symbol.for('setu.security.metadata')`; `withSecurityMetadata` (`:565`) uses `Object.defineProperty` with `enumerable:false, configurable:true, writable:false` and RETURNS the same reference      |
| `securityMetadataOf`                   | `packages/common/src/http.ts:593`                                        | Reads the symbol, narrows through `isRouteSecurityMetadata` (`:607`); a foreign value under the same global symbol is treated as ABSENT, not trusted                                                |
| `RouteSchema`                          | `packages/common/src/http.ts:321-371`                                    | Fields are `body`, `query`, `params`, `headers`, `response`, `tags`, `summary`, `security`. **There is no `cookies` field** — so a cookie brand has no declared counterpart                         |
| `ValidationTarget`                     | `packages/common/src/services/validation.ts:18`                          | `'body' \| 'query' \| 'params' \| 'headers' \| 'cookies'` — five members, `cookies` included                                                                                                        |
| `IValidationService.middleware`        | `packages/common/src/services/validation.ts:65`                          | `middleware(schema: unknown, target: ValidationTarget): MiddlewareFunction` — a SECOND entry point to the same middleware, beside the five helpers                                                  |
| `RouteInfo.owner`                      | `packages/common/src/plugin.ts:57-70`                                    | Optional `owner?: string`, the name of the plugin whose `register()` created the route; absent for application-registered routes (M68)                                                              |
| `owner` is populated                   | `packages/kernel/src/router/router.ts:74-103`                            | Set from a registration cursor at `register()` time, spread only when defined                                                                                                                       |
| Health/metrics owners — **MEASURED**   | probe, this branch                                                       | `GET /health`, `/live`, `/ready` → `owner=health-plugin`; `GET /metrics` → `owner=metrics-plugin`. Recorded because the paths are CONFIGURABLE, so a static path list would miss a renamed endpoint |
| `ZodToOpenApi.transform`               | `packages/openapi-plugin/src/transformers/zod-to-openapi.ts:77-129`      | Returns `{}` for a value with no `_def` and `{}` for an unknown `typeName` — **it never throws**. This is what makes deriving from a brand safe to default ON                                       |
| `ZodToOpenApi` recursion               | same file `:204,:235,:265,:274`                                          | Recurses through `this.transform(...)` for array items, object properties, optional/nullable inner types — so a sub-schema IS visited, it is simply not offered to the generator's dedup map        |
| `#resolveSchema` dedup                 | `packages/openapi-plugin/src/generators/openapi-generator.ts:632-652`    | Inlines FIRST use (adds to `#seenSchemas`), hoists on SECOND use to `Schema<n>`; the first occurrence is never rewritten. Called only at top level, never for a nested schema                       |
| `#generateOperationId`                 | `packages/openapi-plugin/src/generators/openapi-generator.ts:430-434`    | `${method}-${path.split('/').filter(Boolean).join('-')}` over the ALREADY-converted OpenAPI path, so `{id}` survives verbatim                                                                       |
| openapi-plugin default excludes        | `packages/openapi-plugin/src/plugin/openapi-plugin.ts:94-98`             | Only `specEndpoint` and (when swagger) `endpoint`. `/health`, `/live`, `/ready`, `/metrics` are NOT excluded                                                                                        |
| CORS `allowedHeaders`                  | `packages/http-security-plugin/src/middleware/cors-middleware.ts:73,126` | Defaults to `[]`; the header is emitted only `if (allowedHeaders.length > 0)`, while `methods` (`:72`) defaults to all seven standard methods                                                       |
| SDK codegen factory emission           | `packages/sdk/src/codegen/openapi-codegen.ts:669`                        | `L(`export function ${opts.factoryName}(client: IHttpClient) {`)` — **no return type**                                                                                                              |
| SDK codegen indentation                | `packages/sdk/src/codegen/openapi-codegen.ts:649-666,676-712`            | 4-space literals throughout; `ros()` (`:255`) emits property lines at a FIXED 4 spaces with no depth parameter, so a nested inline object type is not indented                                      |
| SDK codegen lint pragma                | `packages/sdk/src/codegen/openapi-codegen.ts:623`                        | Blanket `// deno-lint-ignore-file`, no rule list                                                                                                                                                    |
| SDK codegen error typing               | `packages/sdk/src/codegen/openapi-codegen.ts:550-561`                    | `getSuccessTypes` reads only `2xx`; nothing reads a non-2xx response schema                                                                                                                         |
| `HttpClientError.body`                 | `packages/sdk/src/errors.ts:19`                                          | `public readonly body: unknown` — not generic                                                                                                                                                       |
| SDK codegen refuses cookie params      | `packages/sdk/src/codegen/openapi-codegen.ts:376-379`                    | `p.in === 'cookie'` throws `OpenApiCodegenError`. **This is why cookie brands are not derived** (§3.3)                                                                                              |
| SDK codegen empty-object emission      | `packages/sdk/src/codegen/openapi-codegen.ts:280-283,286`                | Emits the literal `'{}'` for `additionalProperties: false`, and `` `{\n${body}\n}` `` with an empty body when `properties` is `{}`                                                                  |
| `deno lint` `ban-types` — **MEASURED** | probe, this branch                                                       | `export type Empty = {};` is an ERROR (`ban-types`). So the blanket pragma is not dead — it hides exactly this                                                                                      |
| `ban-unused-ignore` — **MEASURED**     | probe, this branch                                                       | `// deno-lint-ignore-file ban-types` on a file with no violation is itself an ERROR. So a NARROWED pragma cannot be emitted unconditionally — it would fail lint on every clean document            |
| Fixtures lint clean — **MEASURED**     | probe, this branch                                                       | Both committed fixtures lint clean with the pragma stripped, so no OTHER rule is currently suppressed                                                                                               |
| Root `fmt.exclude` — the X11-9 proof   | `deno.json:112-113`                                                      | `packages/sdk/test/fixtures/generated-client.ts` and `params-client.ts` are excluded from `deno fmt`. Nothing else in `packages/` is. The workaround IS the defect, committed                       |
| Root `lint` has no such exclude        | `deno.json:90-101`                                                       | `lint` declares only `rules`; the fixtures are already linted by `deno task lint`                                                                                                                   |
| Fixture ↔ generator drift test         | `packages/sdk/test/unit/openapi-codegen.test.ts:814,838`                 | Both fixtures are already byte-compared against live generator output, so regenerating them keeps generator and fixture tied                                                                        |
| `deno fmt --check -` (stdin)           | probe, this branch                                                       | Exits **0** even for unformatted input (it only prints `Not formatted stdin`). A stdin `--check` gate would be VACUOUS — recorded so it is not reached for (§3.8)                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                         | Doc deliverable (same PR)                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `packages/openapi-plugin/README.md:6` says "Zod schemas are transformed to OpenAPI schema objects", which reads as though a route's `validateBody(schema)` already reaches the document. It does not (X11-5)                               | Make the claim TRUE by deriving from the brand (§3.1), and state the precedence and the cookie limit explicitly rather than leaving the sentence to imply more than it delivers  | `packages/openapi-plugin/README.md` — derivation section, precedence table, cookie limit                                       |
| C2 | `packages/http-security-plugin/README.md:39-45` registration example sets `methods` and no `allowedHeaders`; the reference table lists `allowedHeaders` defaulting to `[]`. Copying the example verbatim blocks every JSON request (X11-3) | Fix the DEFAULT (echo `Access-Control-Request-Headers` for an allowed origin) **and** the example, because the register's own diagnosis is that the asymmetry is the part to fix | `packages/http-security-plugin/README.md` — example gains `allowedHeaders`, CORS section states the new default and its `Vary` |
| C3 | `PUBLIC_API.md:8481-8487` "Generated naming contract" table documents operation-method, component-type and Args-interface derivation, but the generated factory's own type is absent because it has none (X11-4)                           | Emit a named `Api` interface and add its row, so every emitted symbol appears in the contract table                                                                              | `PUBLIC_API.md` — naming-contract row, `apiTypeName` option row, error-union rows                                              |
| C4 | `PUBLIC_API.md:8503-8506` lists the codegen's `OpenApiCodegenError` cases and does not mention that `Args` interface names are NOT checked against component type names, which can collide today                                           | Fold `Args`, the error unions and the `Api` interface into ONE name registry so a collision throws, and document it as one rule rather than a component-schema-only rule         | `PUBLIC_API.md` — the throw list names the unified registry                                                                    |

## 3. Design decisions

### 3.1 X11-5 — the document is DERIVED from validation middleware, through a `common` brand

- **Decision:** `common` gains
  `VALIDATION_METADATA: unique symbol = Symbol.for('setu.validation.metadata')`,
  `RouteValidationMetadata { readonly target: ValidationTarget; readonly schema: unknown }`,
  `withValidationMetadata(middleware, metadata)` and `validationMetadataOf(middleware)` — the
  `SECURITY_METADATA` mechanism at `common/src/http.ts:404-612`, member for member, including
  `Symbol.for` and the narrow-or-treat-as-absent guard. `validation-plugin` brands the middleware it
  produces; `openapi-plugin` reads the brand off `RouteInfo.definition.middleware`.
- **Why:** §2.2 forbids `openapi-plugin` importing `validation-plugin`, and M57 already established
  that a symbol in `common` is the entire channel. `Symbol.for` rather than `Symbol()` because a
  locally-created symbol misses on every read when two copies of `common` share a process — the
  failure M37c hit with hand-written React Router context keys and M57 recorded verbatim.
- **Test home:** `common/test/unit/validation-metadata.test.ts`;
  `openapi-plugin/test/integration/derive-request-schemas.test.ts` drives the REAL
  `validation-plugin` helpers through a kernel app, which is the only thing that proves the two
  packages agree on the symbol.

### 3.2 X11-5 — BOTH validation entry points brand, and one test drives both

- **Decision:** the brand is applied in `createValidationMiddleware` (which is what
  `ValidationService.middleware(schema, target)` returns) AND in `bindHelper` (which is what the
  five `validateXxx` helpers return). Both carry the same `{ target, schema }`.
- **Why:** `bindHelper` resolves the service at REQUEST time inside the returned closure, so
  branding the inner middleware does not brand the outer one a route actually carries. Branding only
  one leaves a capability reachable two ways with two behaviours — the split CLAUDE.md's self-review
  checklist names, which shipped green once already for `errorFormat`.
- **Test home:** `validation-plugin/test/unit/validation-metadata-brand.test.ts` asserts both entry
  points carry identical metadata for the same `(schema, target)`.

### 3.3 X11-5 — four targets are derived; `cookies` is deliberately NOT

- **Decision:** `body` → `requestBody`; `query` → `in: 'query'` parameters; `params` →
  path-parameter schemas; `headers` → `in: 'header'` parameters. A `cookies` brand is read and
  **ignored**.
- **Why:** two independent reasons, both from source rather than caution. `RouteSchema`
  (`common/src/http.ts:321-371`) has no `cookies` field, so there is no declared counterpart a
  derived cookie parameter could be consistent with or lose to. And
  `packages/sdk/src/codegen/openapi-codegen.ts:376` **throws `OpenApiCodegenError` on any
  `in: 'cookie'` parameter** — so emitting one would convert a working `generateOpenApiClient` call
  into a hard failure for every consumer of that document. Turning a documented route into a codegen
  crash is a worse outcome than documenting one parameter less.
- **Test home:** `openapi-plugin/test/unit/derive-request-schemas.test.ts` — a route carrying
  `validateCookies(...)` contributes no parameter and the operation is otherwise unchanged.

### 3.4 X11-5 — derivation is ON by default, opt out with `deriveRequestSchemas: false`

- **Decision:** `OpenApiGeneratorOptions.deriveRequestSchemas?: boolean`, default `true`, threaded
  through `OpenApiPluginOptions`. Declared `schema.<field>` always wins over a derived one, per
  field.
- **Why:** this is the one place this milestone deviates from `deriveSecurity`'s opt-in shape, and
  the deviation has a reason rather than being an inconsistency. `deriveSecurity` must be opt-in
  because it needs a `scheme` NAME that cannot be inferred from a guard; here the schema on the
  route IS the schema the document wants, and nothing needs configuring. An opt-in option would
  leave the register's actual complaint — "a developer who has already written the validating one
  gets nothing for it" — intact for everyone who does not discover the option. Default-on is safe to
  assert rather than hope, because `ZodToOpenApi.transform` returns `{}` for anything it does not
  recognise and never throws (§1), so a non-Zod schema degrades to the document the app has today.
  The opt-out has a real consumer, not a hypothetical one: a route validating internal headers whose
  names the author does not want published.
- **Test home:** `openapi-plugin/test/unit/derive-request-schemas.test.ts` (declared-wins, per
  field, and `false` reproducing today's document byte-for-byte).

### 3.5 X11-5/X11-7 — a derived route also gets a `400` response when it declares none

- **Decision:** when derivation contributes at least one request schema and the route's
  `schema.response` declares no `400`, the operation gains `"400": { description: 'Bad request' }`
  with no content schema.
- **Why:** the middleware genuinely answers `400`, and X11-7 records Redocly flagging every
  operation for having no `4XX` — "and it is right". No schema is emitted because the body shape
  depends on the plugin's configured `errorFormat`, which the generator cannot see; describing the
  status without inventing its body is the honest half. A route that declares its own `400` is left
  alone, because a declared response is the author's statement.
- **Test home:** `openapi-plugin/test/unit/derive-request-schemas.test.ts`.

### 3.6 X11-6 — dedup counts in a PRE-PASS and hoists on FIRST use, through one traversal hook

- **Decision:** `ZodToOpenApi` gains an optional constructor hook
  `onSchema?: (schema: unknown) => OpenApiSchemaObject | undefined`, consulted for every schema it
  is about to transform — top level and every nested sub-schema — with `undefined` meaning
  "transform normally". `OpenApiGenerator.generate` runs two passes over the same routes: pass 1
  with a COUNTING hook that records each schema identity and returns `undefined`, pass 2 with a
  HOISTING hook that returns a `$ref` for any identity counted twice or more, hoisting it to
  `components.schemas` the first time it is seen.
- **Why:** one traversal serves both, so a nested schema is counted and hoisted by exactly the code
  that handles a top-level one — which is what closes the row's second half ("nested schemas are not
  counted at all", "two identical-arity cases behave differently") without a second mechanism
  (§11.1). Hoisting on first use is what removes the asymmetry: today the first occurrence is
  inlined and never rewritten, so one shape appears twice in two forms. The hook is optional and
  additive, so `new ZodToOpenApi()` — public API — is unchanged for every existing caller.
- **Test home:** `openapi-plugin/test/unit/schema-dedup.test.ts`.

### 3.7 X11-6 — a hoisted component is named from its first use site, not `Schema<n>`

- **Decision:** the name is `<PascalOperationId><Role>`, where role is `Body`, `Response<status>`,
  `Query`, `Params` or `Headers` — e.g. `PostOrdersResponse409`. A collision appends `2`, `3`, … A
  schema pre-registered through `addSchema`/`OPENAPI_SCHEMA` keeps its contributor-chosen name,
  exactly as today.
- **Why:** `Schema1` is "derived from nothing" and lands in the generated client as an equally
  meaningless exported type. The first use site is information the generator already has at the
  moment it hoists. Zod's `.describe()` was considered and rejected: a description is prose ("The
  order that was placed"), so it makes a poor type name and would be silently truncated or mangled.
- **Test home:** `openapi-plugin/test/unit/schema-dedup.test.ts`.

### 3.8 X11-9 — the recurrence gate is DELETING two `fmt.exclude` entries, not new machinery

- **Decision:** emit 2-space indentation, indent nested inline object types by threading a depth
  through `ros()`/`rtp()`/`renderSchema`, emit no lint pragma at all, replace both empty-object
  emissions with `Record<PropertyKey, never>`, regenerate the two committed fixtures, and **remove
  `packages/sdk/test/fixtures/generated-client.ts` and `params-client.ts` from `deno.json`'s
  `fmt.exclude`**.
- **Why:** those two entries exist for exactly one reason — the generator's output cannot be
  formatted — so the workaround is the defect, committed. Deleting them puts X11-9 under
  `deno task fmt:check`, one of the four mandated gates, permanently and with zero new code;
  `deno task lint` already covers the fixtures (no lint exclude exists), and the fixtures are
  already byte-compared against live generator output (§1), so generator, fixture and both gates are
  tied together. A stdin `deno fmt --check -` gate was considered and rejected with cause: it exits
  **0** on unformatted input (measured, §1), so it would have been vacuous. The pragma is removed
  rather than narrowed because a named ignore that matches nothing is itself a lint error (measured,
  §1), so `ban-types` could not be emitted unconditionally; removing the two `{}` emissions is what
  makes no pragma correct — and `Record<PropertyKey, never>` is also the semantically right type,
  since `{}` in TypeScript means "anything but `null`/`undefined`", the opposite of the empty object
  the schema describes.
- **Test home:** the four gates themselves, plus `packages/sdk/test/unit/openapi-codegen.test.ts`
  fixture drift assertions.

### 3.9 X11-4 — the generator emits a named `Api` interface and returns it

- **Decision:** emit `export interface Api { … }` listing every operation's signature, and
  `export function createApi(client: IHttpClient): Api`. The name defaults to `'Api'` and is
  configurable through a new `OpenApiCodegenOptions.apiTypeName`.
- **Why:** JSR rejects an inferred public-API return type as a slow type, which is this repository's
  own recorded M51 lesson pointed back at itself. A named interface is better output regardless: a
  consumer currently has no way to name the client's type at all. `apiTypeName` has a real consumer
  — a document with a component schema named `Api` would otherwise be unresolvable except by
  renaming the component.
- **Test home:** `packages/sdk/test/unit/openapi-codegen.test.ts`, plus the fixtures, plus a
  `deno publish --dry-run`-shaped assertion in §6.

### 3.10 X11-4 — ONE name registry covers component types, `Args`, error unions and `Api`

- **Decision:** the existing component-schema `usedTypes` map becomes a single registry every
  emitted TYPE name is claimed from, throwing `OpenApiCodegenError` naming both originals on a
  collision.
- **Why:** the map exists today for component schemas only, so a component named `ListUsersArgs`
  beside an operation `listUsers` already emits two declarations of one name — a syntax error in the
  generated file, from a generator whose stated contract is that it throws rather than emit source
  that does not compile. Adding two more name families without unifying would widen that hole.
- **Test home:** `packages/sdk/test/unit/openapi-codegen.test.ts`.

### 3.11 X11-7 — `HttpClientError` becomes generic in `body`, and each operation gets an error union

- **Decision:** `HttpClientError<TBody = unknown>` (source-compatible: the bare name stays valid and
  means `HttpClientError<unknown>`). For each operation declaring a non-2xx response, emit
  `export type <Op>Error = { readonly status: 409; readonly body: Conflict } | …` and
  `export function is<Op>Error(e: unknown): e is HttpClientError & <Op>Error`. `common`-free, no new
  runtime dependency; the guard is `e instanceof HttpClientError && (e.status === … || …)`.
- **Why:** the union must be discriminated on `status` to be usable, and
  `HttpClientError<A> | HttpClientError<B>` is not — `status` is `number` on both arms. Intersecting
  the runtime class with the literal-status union gives both `instanceof` narrowing and a `body` the
  compiler can discriminate. The generated guard is the emitted type's consumer, so neither is dead
  surface (§4).
- **Test home:** `packages/sdk/test/unit/openapi-codegen.test.ts` and the compile-checked fixture.

### 3.12 X11-8 — `operationId` unwraps path placeholders

- **Decision:** `#generateOperationId` maps a `{name}` segment to `by-<name>`, so `/orders/{id}` GET
  becomes `get-orders-by-id`. A segment mixing literal text and a placeholder unwraps the
  placeholder in place and strips the braces.
- **Why:** Redocly's recommended ruleset flags the brace form as URL-unsafe and is entitled to;
  tools that put `operationId` in an anchor, a filename or a URL are the ones that break. This is a
  **breaking change to generated client method names** (`getOrdersId` → `getOrdersById`) and gets
  CHANGELOG migration text rather than a silent bump.
- **Test home:** `openapi-plugin/test/unit/openapi-generator.test.ts`.

### 3.13 X11-8 — operational routes are excluded by OWNER, not by path

- **Decision:** `OpenApiGeneratorOptions.excludeOwners?: readonly string[]`, defaulting to
  `['health-plugin', 'metrics-plugin']`, threaded through `OpenApiPluginOptions`. A route whose
  `RouteInfo.owner` is in the set is dropped. `[]` restores today's document.
- **Why:** the paths are configurable — `HealthPlugin({ endpoints: … })` and
  `MetricsPlugin({ endpoint: … })` both accept them — so a static path list would silently stop
  working for a renamed endpoint, which is the failure a path-based fix would ship green. `owner` is
  the mechanism M68 added for precisely this kind of provenance question, and the two owner names
  were MEASURED on this branch rather than read off the plugin factories (§1).
- **Test home:** `openapi-plugin/test/integration/exclude-owners.test.ts`, driving the REAL
  `HealthPlugin` and `MetricsPlugin` with a RENAMED endpoint, which is what proves the owner
  mechanism beats the path list.

### 3.14 X11-3 — CORS echoes `Access-Control-Request-Headers` when none is configured

- **Decision:** with no `allowedHeaders` configured, an allowed origin's preflight echoes the
  request's `Access-Control-Request-Headers` verbatim and appends
  `Vary: Access-Control-Request-Headers`. An explicitly configured list still wins and still denies
  everything outside it.
- **Why:** the defect is the ASYMMETRY — the plugin advertises `POST`/`PUT`/`PATCH`/`DELETE` and
  then refuses the one header those methods need — so fixing only the README leaves a
  deny-by-default that contradicts a permissive `methods` default. §13.4 (secure defaults) is
  satisfied: the origin allowlist is the security boundary and it is unchanged; a header a caller
  could not otherwise send is not granted by echoing one it already sent on a request the origin
  check has already admitted. The `Vary` is a correctness requirement rather than a nicety — without
  it a shared cache can serve one caller's preflight answer to a caller asking for different
  headers.
- **Test home:** `http-security-plugin/test/unit/cors-middleware.test.ts` — echo,
  explicit-list-wins, the `Vary`, and no echo for a DENIED origin.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                | Kind      | Consumer / real code path that READS it                                                                                        |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_METADATA` (`common`)               | symbol    | `withValidationMetadata`/`validationMetadataOf`; exported so a validating middleware outside `validation-plugin` can brand too |
| `RouteValidationMetadata` (`common`)           | interface | The return type of `validationMetadataOf`, read by `OpenApiGenerator.#deriveRequestSchemas`                                    |
| `withValidationMetadata` (`common`)            | function  | `validation-plugin`'s `createValidationMiddleware` and `bindHelper`                                                            |
| `validationMetadataOf` (`common`)              | function  | `openapi-plugin`'s `OpenApiGenerator.#deriveRequestSchemas`                                                                    |
| `OpenApiGeneratorOptions.deriveRequestSchemas` | option    | `OpenApiGenerator.#createOperation`; set from `OpenApiPluginOptions`                                                           |
| `OpenApiGeneratorOptions.excludeOwners`        | option    | `OpenApiGenerator.generate`'s per-route drop; set from `OpenApiPluginOptions`                                                  |
| `OpenApiPluginOptions.deriveRequestSchemas`    | option    | Passed to `OpenApiService` → `OpenApiGenerator`                                                                                |
| `OpenApiPluginOptions.excludeOwners`           | option    | Passed to `OpenApiService` → `OpenApiGenerator`                                                                                |
| `ZodToOpenApi` constructor `onSchema` hook     | option    | `OpenApiGenerator`'s counting and hoisting passes                                                                              |
| `OpenApiCodegenOptions.apiTypeName`            | option    | `generateOpenApiClient`'s interface emitter and the unified name registry                                                      |
| `HttpClientError<TBody>` (`sdk`)               | class     | Generated per-operation guards; every existing bare `HttpClientError` use continues to mean `HttpClientError<unknown>`         |

### 4.1 Options — every option names its consumer

| Option                   | Consumer                               | Behavior (per implementation)                                                                                                  |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `deriveRequestSchemas`   | `OpenApiGenerator.#createOperation`    | `true` (default): brands fill `requestBody`/`parameters` per target, declared `schema.<field>` wins. `false`: today's document |
| `excludeOwners`          | `OpenApiGenerator.generate`            | Routes whose `owner` matches are dropped. Default drops `health-plugin` and `metrics-plugin`; `[]` documents everything        |
| `apiTypeName`            | `generateOpenApiClient`                | Name of the emitted interface and the factory's return type. Defaults to `'Api'`; claimed from the unified name registry       |
| `onSchema` (transformer) | `ZodToOpenApi.transform` and recursion | `undefined` → transform normally. A returned object replaces the transform for that node (used to emit a `$ref`)               |
| `allowedHeaders` (CORS)  | `corsMiddleware` preflight branch      | Configured: emitted verbatim, nothing else allowed. Omitted: echo `Access-Control-Request-Headers` + `Vary`                    |

## 5. Implementation files

| File                                                                 | Purpose                                                                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                                        | `VALIDATION_METADATA`, `RouteValidationMetadata`, `withValidationMetadata`, `validationMetadataOf`                                                               |
| `packages/common/src/index.ts`                                       | Barrel re-exports for the four new symbols                                                                                                                       |
| `packages/validation-plugin/src/middleware/validation-middleware.ts` | Brand in `createValidationMiddleware` and `bindHelper`                                                                                                           |
| `packages/openapi-plugin/src/transformers/zod-to-openapi.ts`         | Optional `onSchema` hook, consulted at every node                                                                                                                |
| `packages/openapi-plugin/src/generators/openapi-generator.ts`        | Derived request schemas, two-pass dedup, site-derived component names, `operationId` unwrap, `excludeOwners`                                                     |
| `packages/openapi-plugin/src/services/openapi-service.ts`            | Thread the two new options                                                                                                                                       |
| `packages/openapi-plugin/src/plugin/openapi-plugin.ts`               | Accept and forward the two new options                                                                                                                           |
| `packages/sdk/src/errors.ts`                                         | `HttpClientError<TBody = unknown>`                                                                                                                               |
| `packages/sdk/src/codegen/openapi-codegen.ts`                        | `Api` interface + explicit return type, unified name registry, error unions and guards, 2-space depth-aware indentation, no pragma, `Record<PropertyKey, never>` |
| `packages/http-security-plugin/src/middleware/cors-middleware.ts`    | Echo `Access-Control-Request-Headers` + `Vary` when unconfigured                                                                                                 |
| `packages/sdk/test/fixtures/generated-client.ts`, `params-client.ts` | Regenerated (committed generator output)                                                                                                                         |
| `deno.json`                                                          | Remove the two `fmt.exclude` entries                                                                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                                   | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/validation-metadata.test.ts`                    | `common/src/http.ts` (new block)              | `withValidationMetadata(fn, m)` returns the SAME reference; the property is non-enumerable (invisible to `Object.keys`/spread/`JSON.stringify`); `validationMetadataOf` round-trips; a foreign value under the same `Symbol.for` key reads as `undefined`; `Symbol.for` identity across a second module instance                                                                                                              |
| `packages/validation-plugin/test/unit/validation-metadata-brand.test.ts`   | `validation-middleware.ts`                    | All five helpers brand with the right `target`; `service.middleware(schema, target)` brands identically — **both entry points, same `(schema, target)`, identical metadata**; the brand does not change short-circuit behaviour (a failing body still 400s and `next()` is not called)                                                                                                                                        |
| `packages/openapi-plugin/test/unit/derive-request-schemas.test.ts`         | `openapi-generator.ts`                        | `body` → `requestBody` with constraints preserved; `query`/`headers` → parameters with `required` from the Zod shape; `params` → path-parameter schemas; `cookies` → nothing; declared `schema.body` wins over a derived one, per field; `deriveRequestSchemas: false` reproduces the pre-M70m document byte-for-byte; the derived `400` appears, and does NOT when the route declares its own                                |
| `packages/openapi-plugin/test/integration/derive-request-schemas.test.ts`  | generator + plugin + real `validation-plugin` | A kernel app registering `ValidationPlugin` and `OpenApiPlugin` with a route carrying the REAL `validateBody`/`validateQuery`; `GET /openapi.json` carries `requestBody` and the query parameters — the only test that proves both packages resolve the same `Symbol.for`                                                                                                                                                     |
| `packages/openapi-plugin/test/unit/schema-dedup.test.ts`                   | `openapi-generator.ts`, `zod-to-openapi.ts`   | One schema at two sites is a `$ref` at BOTH; a NESTED reused schema is hoisted too; a single-use schema stays inline; the component name is site-derived (`PostOrdersResponse409`), not `Schema1`; a name collision suffixes; `addSchema` names still win                                                                                                                                                                     |
| `packages/openapi-plugin/test/unit/openapi-generator.test.ts` (extend)     | `openapi-generator.ts`                        | `operationId` for `/orders/{id}` is `get-orders-by-id`; a mixed segment unwraps in place                                                                                                                                                                                                                                                                                                                                      |
| `packages/openapi-plugin/test/integration/exclude-owners.test.ts`          | plugin + generator + real health/metrics      | Default document omits `/health`, `/live`, `/ready`, `/metrics`; with **renamed** endpoints they are still omitted (the property a path list cannot have); `excludeOwners: []` documents them again                                                                                                                                                                                                                           |
| `packages/sdk/test/unit/openapi-codegen.test.ts` (extend)                  | `openapi-codegen.ts`                          | The emitted source contains `export interface Api {` and `): Api {`; `apiTypeName` renames both; a component named `Api` throws `OpenApiCodegenError`; a component colliding with an `Args` name throws; error unions and guards emitted for declared non-2xx; `Record<PropertyKey, never>` replaces `{}`; NO `deno-lint-ignore-file`; nested inline object types are indented; both fixtures match live output byte-for-byte |
| `packages/sdk/test/e2e/generated-client.test.ts` (extend)                  | fixtures + `http-client.ts` + `errors.ts`     | A generated guard narrows a real thrown `HttpClientError` to its declared `body` type at COMPILE time (a `@ts-expect-error` control on a field the union does not carry)                                                                                                                                                                                                                                                      |
| `packages/http-security-plugin/test/unit/cors-middleware.test.ts` (extend) | `cors-middleware.ts`                          | Unconfigured + allowed origin + `Access-Control-Request-Headers: content-type` → echoed, and `Vary` carries `Access-Control-Request-Headers`; explicit `allowedHeaders` still wins and refuses the rest; a DENIED origin echoes nothing; a preflight with no `Access-Control-Request-Headers` emits no `Allow-Headers`                                                                                                        |
| `deno task fmt:check` / `deno task lint`                                   | the regenerated fixtures                      | With the two `fmt.exclude` entries deleted, X11-9 is enforced by two of the four mandated gates                                                                                                                                                                                                                                                                                                                               |

**Negative controls to run and revert (each must be OBSERVED failing):**

1. Change `Symbol.for('setu.validation.metadata')` to `Symbol(...)` → the cross-copy `common` test
   fails while every same-copy test still passes.
2. Brand only `createValidationMiddleware`, not `bindHelper` → the integration test's derived
   `requestBody` disappears (the helpers are what a route actually carries).
3. Revert `#resolveSchema` to hoist-on-second-use → the "`$ref` at BOTH sites" and nested assertions
   fail while single-use stays green.
4. Restore the two `fmt.exclude` entries and un-format one fixture → `fmt:check` passes, proving the
   deletion is what carries the gate.
5. Replace `excludeOwners` with a hard-coded path list → the RENAMED-endpoint integration test fails
   while the default-path one still passes.
6. Drop the `Vary: Access-Control-Request-Headers` append → the cache-correctness assertion fails
   while the echo assertion passes.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70m-sdk-openapi, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree — X11-4 is a publish-gate defect by nature
deno task release:verify 0.1.0-alpha.8
```

Plus the functional bar: generate a client from a document produced by a REAL kernel app carrying
`validateBody`, and confirm the emitted source type-checks, formats and lints clean — the loop
X11-4, X11-5 and X11-9 each break at a different point.

## 8. Risks & mitigations

- **Default-on derivation changes an existing app's document.** → It is a behaviour change and gets
  a CHANGELOG entry naming `deriveRequestSchemas: false` as the opt-out; `transform` never throws
  (§1) so the worst case is an added `{}` schema, not a failure.
- **The two-pass dedup transforms every schema twice.** → Document generation happens once per
  application, not per request; the pre-pass discards its output. Measured against the existing
  generator tests rather than assumed.
- **`operationId` unwrapping renames generated client methods.** → Breaking, CHANGELOG migration
  text, and the fixtures make the new names visible in review.
- **Excluding by owner hides a health endpoint someone wanted documented.** → `excludeOwners: []`
  restores it, and the option is in `PUBLIC_API.md` and the README.
- **Echoing request headers reads as loosening a security default.** → The origin allowlist is
  untouched; a configured `allowedHeaders` still denies everything outside it; and the `Vary` closes
  the cache-poisoning path the echo would otherwise open.

## 9. Out of scope

- **`@ValidateBody(schema)` deriving into the document** — `decorator-plugin` is **M70n**'s package,
  and E1/E2 there change what that decorator does at all; branding a decorator before its behaviour
  is settled would need reworking in the next milestone.
- **Cookie parameters in the document** — refused with cause (§3.3); revisiting needs the SDK
  codegen to support `in: 'cookie'` first, which is a `sdk` HTTP-client change, not a codegen one.
- **A `$ref`-emitting transformer for `z.lazy` / recursive schemas** — `ZodLazy` is not in
  `ZodToOpenApi`'s switch today and degrades to `{}`; making recursion expressible is a transformer
  milestone, not a dedup fix.
- **`@setu-ts/testing` composing an `errorHandler`** — X11-2's watch-item, closed in M70f for the
  kernel half; the testing-package half is unowned.
