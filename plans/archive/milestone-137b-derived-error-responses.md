# Milestone 137b — Derived Error Responses and Headers (`@setu-ts/openapi-plugin` + `common`, `auth-plugin`, `idempotency-plugin`, `decorator-plugin`, `rest-starter`, `cli`)

> **Status:** Planning. Branch: `feat/m137b-derived-error-responses`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

The generated OpenAPI document lists the error statuses and headers that Setu-TS's own middleware
answers on a route, derived from the brands that middleware carries, and lets a route declare its
own response headers. A route-level guard, limiter, body validator or idempotency middleware adds
its statuses (with their headers), and an `errorSchema: 'rfc9457'` option attaches one
`ProblemDetails` body to every generated error response. The boundary: derivation reads only what
the route's own `middleware` array carries (the generator cannot see app-wide middleware), and a
DECLARED status always wins over a derived one.

- **In scope:**
  - `RouteSecurityMetadata.forbids`;
  - a rate-limit brand in common;
  - `RouteIdempotencyMetadata.principalRequired`;
  - declared response headers through a typed response wrapper in common and
    `ApiResponseConfig.headers`;
  - the openapi-plugin options `deriveErrorResponses` and `errorSchema`;
  - the starters' and CLI templates' `errorSchema: 'rfc9457'`;
  - the `apps/mcp-tools` limiter wrapper re-branded;
  - docs, and the ROADMAP corrections in §2.
- **NOT this milestone:**
  - Form bodies and file uploads, plus reading `application/problem+json` error bodies in the
    generated client: M137c, which owns the SDK's content-type reading.
  - App-wide middleware visibility: no milestone; it needs a kernel API (§9).
  - Quota (`createQuota`) refusals: not derivable, because they are raised in handler code (§2 C1).

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RouteSecurityMetadata`                       | `packages/common/src/http.ts:773`                                                                                                 | `{ authenticated: boolean; scopes?: readonly string[] }`. `isRouteSecurityMetadata` (`:855`) refuses a non-boolean `authenticated` and non-string scopes; every other key is ignored.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `withSecurityMetadata` / `securityMetadataOf` | `packages/common/src/http.ts:814`, `:842`                                                                                         | Brands by `Object.defineProperty` under `Symbol.for('setu.security.metadata')`, non-enumerable, returns the same function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RouteIdempotencyMetadata`                    | `packages/common/src/http.ts:1225`                                                                                                | `{ idempotent: true; keyHeader?: string; required?: boolean }`; `idempotencyMetadataOf` (`:1261`) checks each field's type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RouteSchema.response`                        | `packages/common/src/http.ts:548`                                                                                                 | `Readonly<Record<number, unknown>>` — no wrapper type exists in common; the `{ schema?, description? }` wrapper is untyped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Auth refusal statuses                         | `packages/common/src/errors/authorization-responder.ts:14-48`                                                                     | `'authentication-required'` 401, `'not-configured'` 501, `'insufficient-privileges'` 403, `'second-factor-required'` 403, all through `respondWithError` (the configured error format).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `requireAuth`                                 | `packages/auth-plugin/src/guards/index.ts:199-265`                                                                                | 401 always possible; 403 (`insufficient-privileges`) only when `delegation` is `'forbid'` or `'require'`; with `signInPage` a navigation gets 302. Both arms brand `AUTHENTICATED` (`:27`).                                                                                                                                                                                                                                                                                                                                                                                                         |
| 403-capable auth-plugin guards                | `guards/index.ts:295,345,378,411,447,496`; `policies/policy-guard.ts:215`; `scoped/scoped-guards.ts:156`                          | `requireScopes`, `requireRole`, `requirePermission`, `requireAnyRole`, `requireAllPermissions`, `requireMfa` (403 `second-factor-required`), `requirePolicy` (brand `{ authenticated: !anonymous }`; an anonymous-allowed policy still answers 401 for a denied anonymous caller and 403 for a denied principal, `policy-guard.ts:204-209`), `requireScopedRole`/`requireScopedPermission` (both through the one `scoped-guards.ts:156` brand). The role/permission guards also answer 501 when no authorization capability is registered (`:56`). `publicRoute` brands `PUBLIC` and never refuses. |
| Decorator authorization middleware            | `packages/decorator-plugin/src/plugin/authorization-middleware.ts:41-67`; `policy-registration.ts:200-226`, `:340-362`            | `@Roles`/`@Permissions` middleware: 401 / 501 / 403, branded `AUTHENTICATED`. `@RequirePolicy`: as `requirePolicy`, brand `{ authenticated: !anonymous }`. `@ScopedRoles`/`@ScopedPermissions` (`decorators/scoped.ts`): 401/403, brand `{ authenticated: true }`. The ROADMAP's package list omitted these sites.                                                                                                                                                                                                                                                                                  |
| `WWW-Authenticate` writer                     | `packages/auth-plugin/src/resource-server/challenge.ts:113-160`; `plugin/auth-plugin.ts:578-595`                                  | The single writer is the app-wide `bearer-challenge` middleware. It is registered ONLY when `AuthPlugin` has `jwt`, a trusted issuer or a resource server. It sets the header on every 401, and on a 403 only when the refusal recorded required scopes (`requireScopes`). A session-only app sends 401 with NO `WWW-Authenticate`.                                                                                                                                                                                                                                                                 |
| `rateLimitMiddleware`                         | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:151-245`                                                            | On every governed request with `standardHeaders` (default `true`): `RateLimit-Policy` and `RateLimit` (`:221-226`), success responses included. On overflow it also sets `Retry-After` and answers 429 through `respondWithError(quotaProblemInit(...))` (`:229-240`). A path matching `exclude` (default operational paths, `:93`) skips everything. Returned unbranded; its only documented use is `app.middleware.add(...)` (`:143`).                                                                                                                                                            |
| Quota                                         | `packages/auth-plugin/src/quota/quota.ts:48-58`; `quota/refusal.ts:9-66`                                                          | `IQuota.reserve` throws `QuotaExceededError` from handler code; `respondQuotaExceeded` writes `Retry-After` + 429. No middleware exists to brand.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| App-wide middleware visibility                | `packages/common/src/plugin.ts:40-50` (`IMiddlewareApi`)                                                                          | Only `add()`; no listing. `OpenApiService.getSpec()` reads `app.router.listRoutes()` (`openapi-service.ts:136`), whose `definition.middleware` holds route-level middleware only.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Body validator 415                            | `packages/validation-plugin/src/middleware/validation-middleware.ts:76-104`, brand `:218`, `:383`                                 | A `target: 'body'` validator answers 415 (`respondWithError`) for a non-JSON media type (or non-JSON/non-form with `forms`). Every validator closure carries `{ target, schema }`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Idempotency middleware statuses               | `packages/idempotency-plugin/src/middleware/http-middleware.ts:125-245`; `core/record.ts:276`; `core/options.ts:618,670-679`      | GET/HEAD/OPTIONS pass through (`:126`). Missing key with `required: false` passes (`:132`). 401 when `principal === 'required'` (default, `options.ts:618`) and no user. 400 for a missing (required) or invalid key (an invalid key refuses even when `required: false`). 503 on store failure. 422 fingerprint mismatch, 409 in progress, 429 capacity (no `Retry-After`). A replay sets `Idempotent-Replayed: true`. `routeIdempotencyMetadata` does not record `principal`.                                                                                                                     |
| Existing derived key parameter                | `packages/openapi-plugin/src/generators/openapi-generator.ts:1204-1235`                                                           | Unconditional, from `keyHeader`, skipped on GET/HEAD/OPTIONS and when a header param of that name is declared.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `#createOperation` response assembly          | `openapi-generator.ts:864-934`                                                                                                    | Declared `response` map → `#buildResponses`; `derived` validation adds `400 { description: 'Bad request' }` unless declared; `#deriveResponseStatus` re-keys the default 200.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `#normalizeResponse`                          | `openapi-generator.ts:1300-1322`                                                                                                  | Treats a value as the `{ schema?, description? }` wrapper only when it OWNS `schema` or `description`; any other plain object is a schema. A wrapper with only `headers` would therefore be read as a schema — must change.                                                                                                                                                                                                                                                                                                                                                                         |
| `OpenApiResponse`                             | `openapi-generator.ts:297-306`                                                                                                    | `{ description; content?: { 'application/json'?: { schema } } }` — no `headers`, no problem media type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ApiResponseConfig` / `buildResponseSchemas`  | `packages/decorator-plugin/src/decorators/openapi.ts:38-45`; `plugin/decorator-plugin.ts:643-656`                                 | `{ status; description?; schema? }`; `ApiResponse` (`openapi.ts:109-122`) copies `description` and `schema` one by one into the stored value, so a new field needs its own copy there; `buildResponseSchemas` passes the stored value through unchanged.                                                                                                                                                                                                                                                                                                                                            |
| Option threading                              | `openapi-plugin.ts:85-101,154-178`; `openapi-service.ts:60-75`; generator constructor `:630-650`                                  | Each layer copies options by name; an option not threaded at each is dropped (M137a lesson).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `OpenApiDocumentOptionsError`                 | `packages/openapi-plugin/src/errors.ts:40-60`; `generators/document-metadata.ts:14`                                               | `reason: 'license-identifier-and-url' \| 'duplicate-tag'`, thrown by `validateDocumentMetadata` from both constructors. Unreleased (0.13.0), so widening its union is not breaking.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Component-name claim                          | `openapi-generator.ts:668`, `:1513`, `:1603`, `addSchema` `:704`                                                                  | `#claimComponentName(preferred, …)` resolves a collision with a registered or hoisted name by suffixing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Error format in starters and templates        | `packages/starters/rest-starter/src/app.ts:147,151,201`; `packages/cli/src/templates/rest.ts:53,57,79,100`; `microservice.ts:116` | `ValidationPlugin({ errorFormat: 'rfc9457' })` and `errorHandler({ format: 'rfc9457' })` hardcoded. `OpenApiPlugin(openApiOptionsFor(...))` in rest-starter; `full-stack-starter` reuses the rest tier. Template sites render `OpenApiPlugin` at `rest.ts:57`, `rest.ts:100`, `microservice.ts:116`. `utils/plugin-wirings.ts:35` (`setu add openapi`) renders it bare and stays bare (unknown error format).                                                                                                                                                                                       |
| SDK error arms                                | `packages/sdk/src/codegen/openapi-codegen.ts:766-800`                                                                             | One arm per declared non-2xx status, body read from `content['application/json']` only; otherwise `unknown`. New derived statuses add `unknown`-typed arms.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/mcp-tools` limiter                      | `apps/mcp-tools/src/modules/items/items.controller.ts:35-44`                                                                      | Wraps `rateLimitMiddleware` in a lazy closure, so a brand on the inner limiter never reaches the route array.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                          | Doc deliverable (same PR)                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP decision 3 says the quota refusal (`quotaProblemInit`) applies the rate-limit brand. Quotas are reserved in handler code; there is no middleware to brand.                                       | Source wins. Only `rateLimitMiddleware` is branded. A quota route documents its 429 by declaring it (with `headers: { 'Retry-After': … }`, §3.6).                                 | ROADMAP M137b decision 3 corrected; auth-plugin README quota section shows the declaration.                           |
| C2  | ROADMAP decision 1 implies a rate-limited route is documented. `rateLimitMiddleware` is documented as app-wide (`app.middleware.add`), and app-wide middleware is invisible to the generator.            | Source wins. Derivation covers route-level limiters only, and the README says so plainly: an app-wide limiter is documented by declaring 429 (§3.6), or it is attached per route. | ROADMAP M137b decision 1 note; openapi-plugin and auth-plugin README.                                                 |
| C3  | ROADMAP decision 1 lists `401` "with a `WWW-Authenticate` header" for every authenticated route. The header is written only by `bearer-challenge`, which exists only with `jwt`/issuers/resource server. | The header is documented only when the operation's derived security scheme is a bearer-type scheme (§3.2). A session-only app's 401 gets no header.                               | ROADMAP M137b decision 1 corrected.                                                                                   |
| C4  | ROADMAP decision 2's 403 list omits `requireAuth({ delegation })` (403-capable), anonymous `requirePolicy` (401-capable while `authenticated: false`) and the decorator-plugin middleware sites.         | Source wins: §3.1 lists every site.                                                                                                                                               | ROADMAP M137b decision 2 corrected; package list gains `idempotency-plugin`, `rest-starter`, `cli`, `apps/mcp-tools`. |
| C5  | ROADMAP decision 5 says "the CLI templates … set it too". The default composition lives in `rest-starter`'s `openApiOptionsFor`, not only in templates.                                                  | Both: the starter default and the three template sites (§3.8).                                                                                                                    | ROADMAP M137b decision 5 wording.                                                                                     |

## 3. Design decisions

### 3.1 The security brand gains `forbids`

- **Decision:**
  - **The field.** `RouteSecurityMetadata` gains `readonly forbids?: true` (`@since 0.13.0`).
  - **Validation.** `isRouteSecurityMetadata` accepts it only as `true` (absent otherwise; any other
    value makes the brand invalid, matching the strictness of `scopes`).
  - **Sites that set `forbids: true`:**
    - `requireScopes`;
    - `requireRole`, `requirePermission`, `requireAnyRole`, `requireAllPermissions`;
    - `requireMfa`;
    - `requirePolicy` (both anonymous modes);
    - the scoped guards (`scoped-guards.ts:156`);
    - `requireAuth` when `delegation !== 'allow'` (both `signInPage` arms);
    - decorator `authorizationMiddleware`, both `policy-registration.ts` brands.
  - **Sites that leave it unset:** `requireAuth` with `delegation: 'allow'` (the default) and
    `publicRoute`.
  - **Shared constants.** One frozen constant per shape replaces `AUTHENTICATED` at the 403-capable
    sites:
    - `auth-plugin/src/guards/index.ts`: `AUTHENTICATED_FORBIDS`;
    - decorator-plugin: its own `AUTHENTICATED_FORBIDS`.
    - Constants are not shared across packages, because no plugin imports another.
- **Why:** a 403 is documented only where one can occur (ROADMAP decision 2). The list comes from
  §1, not the ROADMAP's.
- **Test home:** `common/test/unit/security-metadata.test.ts` (brand validity);
  `auth-plugin/test/unit/guards-security-metadata.test.ts` (each guard's brand as a data table);
  `decorator-plugin/test/unit/authorization-metadata.test.ts`.

### 3.2 Derived 401 and 403

- **Decision:**
  - **Option.** New `deriveErrorResponses?: boolean` (default `true`). When `false`, nothing in
    §3.2–§3.5 is emitted.
  - **Collecting brands.** Over the route's `middleware`, a route is:
    - **401-capable** when any security brand has `authenticated: true` or `forbids: true`;
    - **403-capable** when any brand has `forbids: true`.
  - **Responses added:**
    - `401 { description: 'Unauthorized' }` for a 401-capable route;
    - `403 { description: 'Forbidden' }` for a 403-capable route.
  - **`WWW-Authenticate` on 401.** Present only when `deriveSecurity` is configured AND the scheme
    it names resolves, in the generator's `securitySchemes` option (`Record<string, unknown>`, so
    the value is narrowed to an object first), to `type: 'http'` with `scheme` `bearer`
    (case-insensitive), or to `type: 'oauth2'` or `'openIdConnect'`. The header is
    `{ schema: { type: 'string' }, description: 'The authentication challenge (RFC 6750).' }`.
  - **`WWW-Authenticate` on 403.** Added under the same scheme condition when a brand carries
    `scopes` (`requireScopes`), because `bearer-challenge` writes `insufficient_scope` only then.
  - **501 is never documented.** It is a deployment fault, not a caller outcome.
  - **302 is never documented.** The `signInPage` redirect is a browser-navigation path.
- **Why:** both statuses come from the brands, and the header follows the one writer's actual
  condition (§1, C3). `deriveSecurity` is the only place the generator learns the scheme. Requiring
  it keeps a session-cookie app from claiming a header it never sends.
- **Test home:** `openapi-plugin/test/unit/derived-error-responses.test.ts` (the table);
  `test/integration/derived-error-responses-live.test.ts` (live).

### 3.3 Derived 415

- **Decision:** a route carrying any validation brand with `target: 'body'` gets
  `415 { description: 'Unsupported Media Type' }`. This holds even when that brand has no schema and
  even when `deriveRequestSchemas` is `false`, because the media-type check runs regardless.
- **Why:** `extractTarget` answers 415 before any schema runs (§1).
- **Test home:** the unit table and the live test.

### 3.4 Rate-limit brand and derived 429

- **Decision:**
  - **The brand, in common** (`http.ts`, `@since 0.13.0`):
    `RATE_LIMIT_METADATA = Symbol.for('setu.rate-limit.metadata')`, interface
    `RouteRateLimitMetadata { readonly standardHeaders: boolean }`,
    `withRateLimitMetadata(middleware, metadata)` and `rateLimitMetadataOf(middleware)`. These
    follow the three existing brands' pattern exactly: in place, non-enumerable, and a foreign value
    is treated as absent.
  - **Applying it.** `rateLimitMiddleware` brands its returned function with `{ standardHeaders }`
    (the resolved option).
  - **What a route with a rate-limit brand gets:**
    - `429 { description: 'Too Many Requests' }` with header `Retry-After` (integer schema, "Seconds
      until the window resets.").
    - When the brand's `standardHeaders` is `true`, the 429 also gets `RateLimit` and
      `RateLimit-Policy` (string schemas; descriptions naming draft-ietf-httpapi-ratelimit-headers).
      The same two headers are added to every documented 2xx response of the operation (§3.6 merge
      rule), because the limiter writes them on governed successes too.
  - **Route-level only (C2).** No brand is read from app-wide middleware, because it cannot be seen.
  - **`apps/mcp-tools`.** `toolRateLimit()` re-brands its wrapper with
    `withRateLimitMetadata(wrapper, { standardHeaders: true })`, matching the inner limiter's
    default. Its routes are then documented.
- **Why:** ROADMAP decision 3, limited to what is brandable (C1, C2). Carrying `standardHeaders`
  keeps the document from listing headers the limiter does not send.
- **Test home:** `common/test/unit/rate-limit-metadata.test.ts`;
  `auth-plugin/test/unit/rate-limit-middleware.test.ts` (brand present, field follows option); the
  openapi unit table and the live test.

### 3.5 Idempotency statuses and the replay header

- **Decision:**
  - **The brand.** `RouteIdempotencyMetadata` gains `readonly principalRequired?: boolean`
    (`@since 0.13.0`). `routeIdempotencyMetadata` sets it from the resolved `principal`
    (`'required'` → `true`), and `idempotencyMetadataOf` type-checks it.
  - **Which routes get anything.** Non-GET/HEAD/OPTIONS routes carrying an idempotency brand.
  - **Statuses added:**
    - `400` when absent from the operation (missing or invalid key; it is the validation 400's
      status, so it is added once);
    - `409 { description: 'Conflict' }`;
    - `422 { description: 'Unprocessable Content' }`;
    - `429 { description: 'Too Many Requests' }` when not already present from §3.4. With no
      rate-limit brand this 429 carries no headers, because the capacity refusal sets none.
    - `401` when `principalRequired !== false`, absent meaning required, the middleware default.
      `WWW-Authenticate` follows §3.2's rule.
  - **Replay header.** `Idempotent-Replayed`
    (`{ schema: { type: 'string', enum: ['true'] }, description: 'Present when the response is a replay of a stored one.' }`)
    is added to every documented 2xx response (§3.6 merge rule).
  - **503 is not documented** (store fault; same reason as 501).
  - **The key request parameter** (`#deriveIdempotencyKeyHeaders`) stays unconditional, outside
    `deriveErrorResponses`: it is request shape, and PR #561 made it so for Swagger UI.
- **Why:** ROADMAP decision 1's idempotency half, with the statuses read from the middleware source
  (§1). Without `principalRequired`, an unguarded idempotent route would omit the 401 every
  anonymous call receives.
- **Test home:** `idempotency-plugin/test/unit/options.test.ts` (brand field);
  `common/test/unit/idempotency-metadata.test.ts`; the openapi unit table and the live test.

### 3.6 Declared response headers and the merge rule

- **Decision:**
  - **New types in common** (`@since 0.13.0`):
    - `RouteResponseHeader { readonly schema?: unknown; readonly description?: string; readonly required?: boolean }`;
    - `RouteResponseDocumentation { readonly schema?: unknown; readonly description?: string; readonly headers?: Readonly<Record<string, RouteResponseHeader>> }`.
  - **No widening.** `RouteSchema.response` stays `Record<number, unknown>`; the types document the
    wrapper for functional routes.
  - **Decorators.** `ApiResponseConfig` gains
    `headers?: Readonly<Record<string, RouteResponseHeader>>`.
  - **Recognising the wrapper.** `#normalizeResponse` treats a value as the wrapper when it owns any
    of `schema`, `description` and `headers` (and is not a schema with `toJSONSchema`). It returns
    `headers`.
  - **Emitting headers.** `#buildResponses` emits `headers` as an OpenAPI header object per name:
    - `schema` resolves through
      `#resolveSchema(schema, `${operationId}Response${status}${pascal(name)}Header`, 'output')`, or
      is `{ type: 'string' }` when absent;
    - `description` and `required` are copied only when defined.
    - Header names keep their declared casing.
  - **Merge rule** (one rule, used by §3.2–§3.5):
    - **Error status, declared:** a status in the DECLARED `response` map is never touched by
      derivation; no derived headers are added to it.
    - **Error status, not declared:** the status is added whole.
    - **2xx headers:** derived headers (`RateLimit`, `RateLimit-Policy`, `Idempotent-Replayed`) are
      added to each 2xx response, declared or default. A declared header with the same name
      (case-insensitive) wins.
  - **`OpenApiResponse`** gains `headers?` and a `'application/problem+json'` content key (§3.7).
- **Why:** ROADMAP decision 4, and "a declared field overrides a derived one per field". A 2xx is
  always present, so withholding its derived headers because the app declared a body would hide real
  headers.
- **Test home:** the openapi unit table; `openapi-plugin/test/unit/response-headers.test.ts`;
  `decorator-plugin/test/unit/openapi-decorator.test.ts`.

### 3.7 `errorSchema: 'rfc9457'`

- **Decision:**
  - **Option.** `errorSchema?: 'rfc9457'`.
  - **Validation.** In `validateDocumentMetadata`, any other value refuses with
    `OpenApiDocumentOptionsError` reason `'error-schema'`. This widens the unreleased reason union.
  - **What it attaches.** When set, every GENERATED error response (the derived 400 and §3.2–§3.5's
    statuses) gets
    `content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/<name>' } } }`.
    Declared responses are untouched.
  - **The component name** is claimed once per `generate()`, AFTER every operation is built and only
    when at least one generated error response used it, through
    `#claimComponentName('ProblemDetails')`. Each such response holds one shared `{ $ref }` object
    whose value is filled in after the claim, so an application schema named `ProblemDetails`
    (registered or hoisted) keeps its name and this one gets the suffix. The component is recorded
    as per-document (`#perDocComponents`), so the next `generate()` purges it.
  - **The schema:**
    `{ type: 'object', properties: { type: { type: 'string', format: 'uri-reference', default: 'about:blank' }, title: { type: 'string' }, status: { type: 'integer', minimum: 100, maximum: 599 }, detail: { type: 'string' }, instance: { type: 'string', format: 'uri-reference' } } }`,
    with no `required` list and no `additionalProperties: false` (RFC 9457 §3: members are optional;
    extensions such as `errors` and `violated-policies` are allowed).
  - **Omitted.** Error responses keep no content, as today.
- **Why:** ROADMAP decision 5. The generator cannot read the app's error format, so the app asserts
  it.
- **Test home:** `openapi-plugin/test/unit/problem-details.test.ts` (field-by-field, forbidden
  `message` absent, collision suffix); the live test asserts the body's `content-type` is
  `application/problem+json` under the starter composition.

### 3.8 Defaults in the starters and templates

- **Decision:**
  - **rest-starter.** `openApiOptionsFor` returns `{ errorSchema: 'rfc9457', ...openapi }` (both
    branches), so a caller option still wins. `full-stack-starter` inherits this through the rest
    tier.
  - **CLI templates.**
    - `rest.ts:57` gains `args: "{ errorSchema: 'rfc9457' }"`.
    - `rest.ts:100` and `microservice.ts:116` become
      `"{ swagger: { assets: 'cdn' }, errorSchema: 'rfc9457' }"`.
  - **`plugin-wirings.ts:35` stays bare.** `setu add openapi` cannot know the project's error
    format.
- **Why:** these compositions hardcode the RFC 9457 error format (§1), so the document's body claim
  is true for them.
- **Test home:**
  - `rest-starter/test/unit/workers-openapi.test.ts` (extend; it already tests `openApiOptionsFor`);
  - the CLI template unit tests that already snapshot these wirings;
  - `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (generated output changes, so the scaffold
    boot gate runs);
  - `cli/test/e2e/client-e2e.test.ts` (the generated client still compiles with the new arms).

### 3.9 Ordering in the emitted responses object

- **Decision:**
  - Responses are emitted in ascending numeric status order after derivation. This replaces today's
    insertion order (declared, then 400, then the re-keyed success status), and it changes key order
    for existing documents.
  - Within a response the keys are `description`, `headers`, `content`.
  - Header names inside `headers` are sorted case-insensitively.
- **Why:** the document reads the same whatever order the middleware is listed in, and Swagger UI
  lists statuses in order. The generated client is unaffected: `getErrorArms` already sorts its arms
  (`openapi-codegen.ts:766`).
- **Test home:** the openapi unit table (asserts key order); the existing
  `openapi-generator.test.ts` gains an `Object.keys(responses)` order assertion (its `toEqual`
  checks ignore key order), and the CHANGELOG names the reorder.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Every addition is an optional field, a new symbol or a new
option. Response key order changes in generated documents (§3.9) are documented in the CHANGELOG as
a document change, not an API break.

| Exported symbol                                       | Kind                  | Consumer / real code path that READS it                                                                                        |
| ----------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `RouteSecurityMetadata.forbids` (common)              | field                 | `openapi-generator.ts` 403/401 derivation; set by auth-plugin and decorator-plugin guards.                                     |
| `RATE_LIMIT_METADATA` (common)                        | unique symbol         | `withRateLimitMetadata`/`rateLimitMetadataOf`; exported (like `SECURITY_METADATA`) so a limiter outside auth-plugin can brand. |
| `RouteRateLimitMetadata` (common)                     | type                  | `rateLimitMiddleware` (writes), `openapi-generator.ts` (reads `standardHeaders`).                                              |
| `withRateLimitMetadata` (common)                      | function              | `rateLimitMiddleware`; `apps/mcp-tools` `toolRateLimit`.                                                                       |
| `rateLimitMetadataOf` (common)                        | function              | `openapi-generator.ts` 429 derivation.                                                                                         |
| `RouteIdempotencyMetadata.principalRequired`          | field                 | set by `routeIdempotencyMetadata`; read by `openapi-generator.ts` idempotency 401.                                             |
| `RouteResponseHeader` (common)                        | type                  | `ApiResponseConfig.headers`, `RouteResponseDocumentation.headers`; read by `#normalizeResponse`.                               |
| `RouteResponseDocumentation` (common)                 | type                  | functional routes typing `schema.response` values; `#normalizeResponse` reads its shape.                                       |
| `ApiResponseConfig.headers` (decorator)               | field                 | flows through `buildResponseSchemas` to `#normalizeResponse`.                                                                  |
| `OpenApiResponse.headers` / problem content           | type fields (openapi) | emitted document; asserted by tests and read by Swagger UI / client generators.                                                |
| `OpenApiHeader` (openapi, new)                        | type                  | names `OpenApiResponse.headers` values (exported beside `OpenApiResponse`, which is exported).                                 |
| `OpenApiDocumentOptionsError.reason` `'error-schema'` | union member          | thrown by `validateDocumentMetadata`; callers switch on `reason`.                                                              |

### 4.1 Options — every option names its consumer

| Option                                                        | Consumer                                                                                                      | Behavior (per implementation)                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `deriveErrorResponses?: boolean` (plugin, service, generator) | `#createOperation` → new `#deriveErrorResponses(route, responses, operationId)`; threaded at all three layers | default `true`; `false` emits none of §3.2–§3.5 (the key parameter and the validation 400 stay). |
| `errorSchema?: 'rfc9457'` (plugin, service, generator)        | `#createOperation` (attaches content) and `generate()` (claims the component)                                 | validated at both constructors; any other value → `OpenApiDocumentOptionsError('error-schema')`. |

## 5. Implementation files

| File                                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                                                                | `forbids`, `principalRequired`, the rate-limit brand, `RouteResponseHeader`, `RouteResponseDocumentation` (JSDoc, `@since 0.13.0`).                                                                                                                                                                                                                                                         |
| `packages/common/src/index.ts`                                                               | export the new symbols.                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/src/guards/index.ts`                                                   | `AUTHENTICATED_FORBIDS`; `requireAuth` delegation arms; the 403-capable guards.                                                                                                                                                                                                                                                                                                             |
| `packages/auth-plugin/src/policies/policy-guard.ts`                                          | `forbids: true` on both modes.                                                                                                                                                                                                                                                                                                                                                              |
| `packages/auth-plugin/src/scoped/scoped-guards.ts`                                           | `forbids: true`.                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/auth-plugin/src/middleware/rate-limit-middleware.ts`                               | brand the returned limiter.                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/decorator-plugin/src/plugin/authorization-middleware.ts`                           | `forbids: true`.                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/decorator-plugin/src/plugin/policy-registration.ts`                                | `forbids: true` on both brands.                                                                                                                                                                                                                                                                                                                                                             |
| `packages/decorator-plugin/src/decorators/openapi.ts`                                        | `ApiResponseConfig.headers`.                                                                                                                                                                                                                                                                                                                                                                |
| `packages/idempotency-plugin/src/core/options.ts`                                            | `principalRequired` in `routeIdempotencyMetadata`.                                                                                                                                                                                                                                                                                                                                          |
| `packages/openapi-plugin/src/generators/error-responses.ts` (new, internal)                  | pure functions: collect brands → `{ unauthorized, forbidden, unsupportedMedia, rateLimit?, idempotency? }`; build header objects; the `ProblemDetails` schema constant. Not exported from `src/index.ts`.                                                                                                                                                                                   |
| `packages/openapi-plugin/src/generators/openapi-generator.ts`                                | options, `OpenApiResponse.headers`, `OpenApiHeader`, `#normalizeResponse` headers, merge rule, ordering, problem content, component claim.                                                                                                                                                                                                                                                  |
| `packages/openapi-plugin/src/generators/document-metadata.ts`                                | validate `errorSchema`.                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/openapi-plugin/src/errors.ts`                                                      | `'error-schema'` reason.                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/openapi-plugin/src/services/openapi-service.ts`                                    | thread both options.                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/openapi-plugin/src/plugin/openapi-plugin.ts`                                       | destructure and pass both options.                                                                                                                                                                                                                                                                                                                                                          |
| `packages/openapi-plugin/src/index.ts`                                                       | export `OpenApiHeader`.                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/openapi-plugin/package.json` (+ generated `deno.json`, `test/deno-lane/deno.lock`) | devDependency `@setu-ts/idempotency-plugin` for the live test.                                                                                                                                                                                                                                                                                                                              |
| `packages/starters/rest-starter/src/app.ts`                                                  | `errorSchema` default.                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/cli/src/templates/rest.ts`, `microservice.ts`                                      | template args.                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/mcp-tools/src/modules/items/items.controller.ts`                                       | re-brand the wrapper.                                                                                                                                                                                                                                                                                                                                                                       |
| Docs                                                                                         | READMEs of openapi-plugin, auth-plugin, decorator-plugin, idempotency-plugin, common, rest-starter; AGENT_CARDs where a claim changes (≤2560 bytes, no foreign identifiers); `PUBLIC_API.md`; `CHANGELOG.md` `### Added` + `### Changed` (response key order, new statuses as `setu client --check` drift); ROADMAP corrections (§2); `docs/openapi`-area page if one documents derivation. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                        | src covered                                              | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/security-metadata.test.ts` (extend)                                                                   | `http.ts` security brand                                 | `forbids: true` accepted; `forbids: false`/`'yes'` → brand invalid (`securityMetadataOf` returns `undefined`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/common/test/unit/rate-limit-metadata.test.ts` (new)                                                                    | rate-limit brand                                         | in place, identity kept, non-enumerable, `Symbol.for` key, foreign value → `undefined`, non-boolean `standardHeaders` → `undefined`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/common/test/unit/idempotency-metadata.test.ts` (extend or new)                                                         | idempotency brand                                        | `principalRequired` boolean accepted, non-boolean refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/auth-plugin/test/unit/guards-security-metadata.test.ts` (new)                                                          | `guards/index.ts`, `policy-guard.ts`, `scoped-guards.ts` | a DATA TABLE of every guard factory call (including `requireAuth()`, `requireAuth({ delegation: 'forbid' })`, `{ signInPage, delegation: 'require' }`, `requirePolicy` anonymous and not, `publicRoute()`) → expected brand; `requireAuth()` has no `forbids`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/auth-plugin/test/unit/rate-limit-middleware.test.ts` (extend)                                                          | `rate-limit-middleware.ts`                               | brand present; `standardHeaders` false/true/default follows the option.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/decorator-plugin/test/unit/authorization-metadata.test.ts` (new)                                                       | `authorization-middleware.ts`, `policy-registration.ts`  | roles, permissions, policy (anonymous and not) and scoped middleware carry `forbids: true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/decorator-plugin/test/unit/openapi-decorator.test.ts` (extend)                                                         | `decorators/openapi.ts`                                  | `@ApiResponse({ status, headers })` reaches the route schema value; a `headers`-only config reaches the document as headers, not a schema (through `DecoratorPlugin`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/idempotency-plugin/test/unit/options.test.ts` (extend)                                                                 | `core/options.ts`                                        | `principalRequired` true by default, false for `principal: 'optional'`, for each key source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/openapi-plugin/test/unit/error-responses.test.ts` (new)                                                                | `error-responses.ts`                                     | the brand-collection function's branches one by one (each brand kind, combinations, GET skip).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/openapi-plugin/test/unit/derived-error-responses.test.ts` (new)                                                        | `openapi-generator.ts` derivation                        | **THE TABLE** (exported from a shared `test/fixtures/error-response-table.ts` as data): each row = a route middleware set + generator options → expected statuses, headers per status, and 2xx headers. Rows cover every §3.1 site, the WWW-Authenticate scheme conditions (bearer / oauth2 / apiKey-cookie / no `deriveSecurity`), 415, 429 with standardHeaders on/off, idempotency with `principalRequired` on/off and `required: false`, GET idempotent (none), `deriveErrorResponses: false` (none), a declared 401/429 left untouched, declared 2xx header winning case-insensitively, ascending key order. `requireAuth()` alone → no 403. |
| `packages/openapi-plugin/test/unit/response-headers.test.ts` (new)                                                               | `#normalizeResponse`, `#buildResponses`                  | wrapper with only `headers`; Zod header schema resolved; absent schema → string; `required`/`description` copied only when set; header order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/openapi-plugin/test/unit/problem-details.test.ts` (new)                                                                | `errorSchema` path, `document-metadata.ts`, `errors.ts`  | component asserted field by field against RFC 9457 (`type`, `title`, `status`, `detail`, `instance` present; no `message`; no `required`; no `additionalProperties: false`); attached to every generated error response under `application/problem+json`, not to declared ones; a registered `ProblemDetails` keeps its name and ours is suffixed; invalid value → `OpenApiDocumentOptionsError` reason `'error-schema'` from generator AND service constructors.                                                                                                                                                                                 |
| `packages/openapi-plugin/test/unit/openapi-service.test.ts` + `test/integration/document-metadata-entry-points.test.ts` (extend) | option threading                                         | both options reach the document through `OpenApiPlugin`, `OpenApiService` and `OpenApiGenerator` (non-default values).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/openapi-plugin/test/integration/derived-error-responses-live.test.ts` (new)                                            | end to end                                               | THE SAME TABLE driven against a live kernel app (AuthPlugin with `jwt` + rbac + policies, ValidationPlugin `rfc9457`, IdempotencyPlugin memory store, `errorHandler({ format: 'rfc9457' })`, route-level `rateLimitMiddleware({ max: 0 })`): for every row and every documented status, a request that triggers it answers that status with every documented header present; problem bodies carry `content-type: application/problem+json`. The live test asserts that documented headers are PRESENT; it asserts absence only where the source guarantees it: the `standardHeaders: false` limiter row sends no `RateLimit`/`RateLimit-Policy`.  |
| `packages/openapi-plugin/test/unit/openapi-generator.test.ts` (update)                                                           | ordering                                                 | `Object.keys` order of `responses` ascending (§3.9); a route with no brands keeps exactly its pre-M137b responses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/starters/rest-starter/test/unit/workers-openapi.test.ts` (extend)                                                      | `app.ts` `openApiOptionsFor`                             | default `errorSchema: 'rfc9457'` on both branches; caller `errorSchema` spread wins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CLI template unit tests (the existing rest/microservice wiring tests)                                                            | `templates/rest.ts`, `microservice.ts`                   | rendered `OpenApiPlugin(...)` args per site.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`, `client-e2e.test.ts` (run; extend client-e2e)                                 | generated output                                         | scaffolds boot; `/openapi.json` of a rest scaffold carries `components.schemas.ProblemDetails`; the generated client compiles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/mcp-tools` existing tests + `check:apps`                                                                                   | `items.controller.ts`                                    | its document now lists 429 on the limited routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 7. Verification gates

```bash
git branch --show-current   # feat/m137b-derived-error-responses
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run docs:exports
pnpm run check:docs
pnpm test:coverage packages/common packages/openapi-plugin packages/auth-plugin packages/decorator-plugin packages/idempotency-plugin packages/starters/rest-starter --no-tooling
pnpm run test:deno-lane     # after ANY manifest change (deno.json / deno.lock)
pnpm run ci:local           # final commit; cli shards cover the scaffold and client e2e
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

Every changed `src` file ≥90% branch/function/line in the ANSI-stripped tables. No security audit:
nothing here crosses a trust boundary (brands and documentation only; no runtime refusal changes —
the guards' behaviour is untouched, only their brands gain a field).

## 8. Risks & mitigations

- A brand claims a status the middleware cannot produce → the live test drives every documented
  status of every row; a row the live app cannot trigger fails.
- Option dropped at one threading layer (M137a) → the entry-points test uses non-default values
  through all three.
- Response reorder churns every generated client → one-time drift, named in the CHANGELOG; ordering
  makes later documents stable.
- M140a edits `cli/src/templates/rest.ts` → M137b's change there is one `args` field; merge
  `develop` before the PR.
- Adding a devDependency changes `deno.json` and the Deno-lane lock → regenerate both and re-run the
  Deno lane after the change (M137a lesson).
- Wrapping middleware loses the brand (mcp-tools) → README tells authors to re-brand a wrapper with
  `withRateLimitMetadata`/`withSecurityMetadata`.

## 9. Out of scope

- App-wide middleware (an app-wide `rateLimitMiddleware`, guards added through `app.middleware.add`)
  — invisible to the generator; would need a kernel listing API. No milestone owns it yet; declared
  responses cover it.
- Quota refusals raised in handler code — declared, not derived (C1).
- The 302 sign-in redirect, 501 not-configured and 503 store-unavailable responses.
- Typed `application/problem+json` error bodies in the generated client — M137c (SDK content-type
  reading).
- `Deprecation`/`Sunset` headers, `Location`/`ETag` derivation (declared headers cover them).

## 10. As built

- **Test homes.** The auth-plugin brand table extends the existing
  `test/unit/guard-security-metadata.test.ts`, and the decorator-plugin brand assertions extend
  `test/unit/plugin/authorization-enforcement.test.ts`, `policy-registration.test.ts` and
  `scoped-decorators.test.ts`, rather than the new files §6 named. `error-responses.ts` is covered
  at 100% through the table and the generator tests, so no separate `error-responses.test.ts` was
  needed.
- **Descriptions.** Derived statuses use the generator's existing description style
  (`'Unsupported media type'`, `'Too many requests'`, `'Unprocessable content'`, `'Conflict'`)
  rather than the title case §3.3–§3.5 wrote.
- **Live table.** `liveSkip` lets a row name a documented status it does not trigger, with the
  reason. Only the anonymous idempotency row uses it, for `409` and `429`, which share a scope there
  and are triggered on the authenticated row. A negative control (a claimed header the validator
  never sends) fails the live test.
- **CLI fixture.** `node-redis-cli.test.ts` records the `OpenApiPlugin({ errorSchema: 'rfc9457' })`
  line as M137b's deliberate delta against the historical capture.
