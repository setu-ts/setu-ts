# Milestone 133 — `mcp-plugin`: routes as Model Context Protocol tools (`@setu-ts/mcp-plugin`)

> **Status:** Planning. Branch: `feat/m133-mcp-plugin`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Let an application expose chosen routes to AI agents as MCP tools, served at one stateless
`POST /mcp` kernel route by the official v2 server SDK, where every tool call re-enters the kernel
pipeline in-process as the same caller. Guards, validation, tenant resolution, rate limiting,
idempotency and audit run exactly as for an HTTP caller; the plugin re-implements none of them. The
boundary: the plugin owns the MCP wire (the SDK), the tool table compiled at bootstrap, the
caller-filtered tool list, the call → route mapping and the route response → tool result mapping.
The kernel gains one public in-process dispatch entry; `common` gains an idempotency brand and takes
over M132's required-scopes state key so a second writer can use it.

- **In scope:** new `packages/mcp-plugin` (`McpPlugin`, tool declarations, compiled tool table,
  `POST /mcp` + 405 for GET/DELETE, Origin check, caller-filtered `tools/list` with a private cache
  scope, pre-SDK 401/403 for a tool the caller cannot use, in-process dispatch, result mapping);
  `IApplication.dispatch?` in `common` and its kernel implementation; `IDEMPOTENCY_METADATA` brand
  in `common`, applied by `idempotency-plugin`; `REQUIRED_SCOPES_STATE_KEY` moved to `common`; CLI
  `setu add mcp` and the agent brief; docs.
- **NOT this milestone:** CQRS commands as a second tool target (the command registry carries no
  schemas — a follow-on once it does); MCP resources, prompts, completions, elicitation, sampling
  and `subscriptions/listen` (no consumer); `x-mcp-header` mirroring (ROADMAP M133 decision 8); an
  authorization server (M132 is resource-server only); the "lethal trifecta" tool registry (named
  follow-on in ROADMAP M133 decision 8); a Workers end-to-end run under `workerd` (§8 risk R2 — a
  bundle-resolution check ships here, the live run is a follow-on); a `listChanged` tool set (the
  set is fixed at bootstrap).

## 1. Contracts verified from SOURCE (not names)

| Reference                                         | Source (file:line)                                                                                                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IApplication`                                    | `packages/common/src/plugin.ts:435-492`                                                                                                                         | `router`, `middleware`, `services`, `register`, `start`, `stop`, `fetch(request)` (:470), `diagnostics?`. No `inject`, no dispatch entry. `fetch` delegates to the registered `IHttpAdapter` and rejects without one (`kernel/src/application/application.ts:921-929`).                                                                                                                                                                                   |
| `IPluginContext.app`                              | `packages/common/src/plugin.ts:500-539`; `kernel/src/application/application.ts:642`                                                                            | `app: IApplication` is the concrete kernel `Application` (`this`). `lifecycle` has `onRegister/onInit/onBootstrap/onRequest/onResponse/onError/onStopping/onShutdown/onClose` (`plugin.ts:324-399`) — no `onReady`.                                                                                                                                                                                                                                       |
| kernel `inject`                                   | `packages/kernel/src/application/application.ts:187-195, 947-1033`; `inject-body.ts:120-189`                                                                    | `IKernelApplication` only. Takes `{ip?, method, url, headers?, body?}`; no signal (the context falls back to a never-aborting signal, `context/request-context.ts:146-149`); refuses a streaming RESPONSE (1013-1021); decodes bytes to a string. Not fit for tool dispatch — §3.3 adds `dispatch`.                                                                                                                                                       |
| `#handleRequest` / nested state                   | `packages/kernel/src/application/application.ts:1052-1129, 1168-1222, 1438-1485`                                                                                | Each call builds a brand-new `RequestContext` (`createRequestContext`, 1090): new `ctx.id`, `ctx.state`, `slot`, `defer`, `request.user`/`tenant` empty; runs `onRequest` hooks → global pipeline → `#dispatch` → route middleware → handler → `onResponse`; answers 503 once `#stopping` (1053).                                                                                                                                                         |
| `InjectedRequest`                                 | `packages/kernel/src/application/inject-body.ts:144-189`                                                                                                        | The kernel's own `IRequest` implementation (ip, body bytes, no signal). The dispatch request type (§3.3) is a sibling class in the same module family.                                                                                                                                                                                                                                                                                                    |
| request identity                                  | `packages/common/src/request-identity.ts:71-114, 225-249, 272-280`; `auth-plugin/src/middleware/auth-middleware.ts:42-90`                                       | `user`/`tenant` take one implicit write; `replacePrincipal` bypasses. `authMiddleware` always re-authenticates from the request's headers and never reads an existing principal — so an inner request reaches the caller's principal only by carrying the caller's credential headers (§3.4).                                                                                                                                                             |
| `IRouterApi.listRoutes` / `RouteInfo`             | `packages/common/src/plugin.ts:58-72, 82-163`; `kernel/src/router/router.ts:617-624`                                                                            | `listRoutes(): readonly RouteInfo[]`, `RouteInfo = {method, path, owner?, definition}`. openapi-plugin (`openapi-plugin.ts:240-243`) and auth-plugin (`auth-plugin.ts:621-628`) read it in `onBootstrap`, the convention for "every route is registered". `router.match` is not on the contract.                                                                                                                                                          |
| `RouteDefinition` / `RouteSchema`                 | `packages/common/src/http.ts:1091-1098, 515-578`                                                                                                                | `{handler, middleware?, schema?}`; `RouteSchema.body/query/params/headers` are documentation-only (`unknown`), `response?: Record<number, unknown>`.                                                                                                                                                                                                                                                                                                      |
| validation brand                                  | `packages/common/src/http.ts:850, 867-872, 900, 929, 946-962`; `validation-plugin/src/middleware/validation-middleware.ts:218, 383`                             | `VALIDATION_METADATA`, `RouteValidationMetadata {target, schema}`, `validationMetadataOf(middleware)`; both `validateXxx` helpers and the service brand the closure a route holds. openapi's `#effectiveSchema` (`openapi-generator.ts:807-853`) is the precedent: last brand per target wins.                                                                                                                                                            |
| Zod → JSON Schema                                 | `packages/openapi-plugin/src/transformers/zod-to-openapi.ts:411, 438`                                                                                           | The repo's only converter duck-types Zod v4's `toJSONSchema` and adapts to the OpenAPI 3.1 dialect. MCP wants plain JSON Schema 2020-12, which Zod emits directly; no shared converter is reused (§3.2).                                                                                                                                                                                                                                                  |
| response status / schemas                         | `packages/common/src/http.ts:982-1054`; `openapi-generator.ts:902-910, 1056-1130`                                                                               | `responseMetadataOf(handler)?.status` (decorator `@HttpCode`); `RouteSchema.response[status]` is a bare schema or `{schema?, description?}`.                                                                                                                                                                                                                                                                                                              |
| security brand                                    | `packages/common/src/http.ts:610, 737-750, 778-833`; `auth-plugin/src/guards/index.ts:195-522`                                                                  | `RouteSecurityMetadata {authenticated, scopes?}` via `securityMetadataOf`; `requireScopes` brands `{authenticated: true, scopes}`, `publicRoute` brands `{authenticated: false}`, the other guards `{authenticated: true}`.                                                                                                                                                                                                                               |
| required-scopes state key                         | `packages/auth-plugin/src/resource-server/challenge.ts:28, 82-95`; `guards/index.ts:313`                                                                        | `REQUIRED_SCOPES_STATE_KEY = 'auth-plugin:required-scopes'`, internal to auth-plugin; `bearer-challenge` re-validates the list as scope tokens before writing `scope=`.                                                                                                                                                                                                                                                                                   |
| state-key convention                              | `packages/common/src/state-keys.ts:2-13, 50-114`; `test/state-key-convention.test.ts`                                                                           | Cross-package keys live in `common/src/state-keys.ts` as constants named `<writer-package>:<kebab-key>`.                                                                                                                                                                                                                                                                                                                                                  |
| idempotency                                       | `packages/idempotency-plugin/src/middleware/idempotent.ts:43-51`; `src/service/idempotency-service.ts:71`; `common/src/services/idempotency.ts:246-293`         | `idempotent(options?)` and `IIdempotencyService.middleware(options?)` return bare closures — **no brand**. Key source default is the `Idempotency-Key` header (`IdempotencyKeySource`); GET/HEAD/OPTIONS are skipped (`http-middleware.ts:126`).                                                                                                                                                                                                          |
| rate limiting                                     | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:31-91, 158, 297`                                                                                  | A plain `MiddlewareFunction`, usable per route; default key `user:<id>` → client IP → `anonymous`. Unbranded.                                                                                                                                                                                                                                                                                                                                             |
| error responder / Problem Details                 | `packages/common/src/errors/error-responder.ts:52, 163-189, 245-271`; `exceptions/src/formatters/problem-details.ts:56-77`                                      | `respondWithError(ctx, {status, title, detail?, …})`; Problem Details `{type, title, status, detail, instance?, errors?: [{field, message, code?}]}`; without the exceptions plugin the body is `{error, detail?}`. `respondWithAuthorizationFailure` (common) answers 401/403 through it.                                                                                                                                                                |
| `OptionalDependencyUnavailableError` + peer shape | `packages/common/src/errors/optional-dependency.ts:43-60`; `graphql-plugin/src/runtime/graphql-loader.ts:35-44`; `test/optional-peer-required-by.test.ts:48-60` | Lazy `await import('<pkg>')` inside `try`, `requiredBy` a literal equal to the package name; peer + `peerDependenciesMeta.optional`.                                                                                                                                                                                                                                                                                                                      |
| `CAPABILITIES` grammar                            | `packages/common/src/tokens.ts:39-313, 325-353`                                                                                                                 | Not used: §2 C1.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SDK `createMcpHandler`                            | `@modelcontextprotocol/server@2.4.0` `dist/createMcpHandler-*.d.mts:206-360, 455-496`                                                                           | `createMcpHandler(factory, {legacy?: 'stateless'\|'reject', onerror?, responseMode?: 'auto'\|'sse'\|'json', maxRequestBodySize?, …})` → `{fetch(request, {authInfo?, parsedBody?}), close, notify, bus}`. Factory gets `{era, authInfo?, requestInfo?}`. `responseMode: 'json'` never streams. The entry does no Origin/Host validation and no token verification.                                                                                        |
| SDK `McpServer`                                   | `dist/mcp-*.d.mts:2811-2870, 3370-3392`; `dist/mcp-oHn3ureC.mjs:1595-1660`                                                                                      | `new McpServer(info, {capabilities, instructions, cacheHints})`; `cacheHints['tools/list']` sets `ttlMs`/`cacheScope` (default `0`/`private`). `registerTool(name, {title, description, inputSchema, outputSchema, annotations, scopeChallenge, _meta}, cb)`. Unknown tool → `ProtocolError(InvalidParams)` (-32602); **any error thrown in the callback becomes `isError` carrying `error.message`** (1612-1615) — the executor must never throw (§3.6). |
| `StandardSchemaWithJSON`                          | `dist/mcp-*.d.mts:1349-1392`; `dist/src-*.mjs:5384-5396`                                                                                                        | `{'~standard': {version, vendor, validate, jsonSchema: {input(opts), output(opts)}}}`; the SDK calls `jsonSchema[io]({target})` per `tools/list` and `validate` per call.                                                                                                                                                                                                                                                                                 |
| `AuthInfo`                                        | `dist/mcp-*.d.mts:774-810`                                                                                                                                      | `{token: string; clientId: string; scopes: string[]; expiresAt?; resource?: URL; resourceMetadataUrl?; extra?}` — pass-through only.                                                                                                                                                                                                                                                                                                                      |
| MCP spec 2026-07-28                               | `modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http`, `/server/tools`, `/server/utilities/caching`                               | Origin MUST be validated, present-and-invalid → 403; single JSON-RPC message per POST; legacy GET/DELETE SHOULD answer 405; `tools/list` MAY vary by authorization, `private` scope MUST NOT be shared across authorization contexts; servers MUST rate-limit tool invocations and return structured results conforming to `outputSchema`; tool names SHOULD be 1–128 of `A-Za-z0-9_-.`, unique; annotations untrusted; `listChanged` optional.           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                                                                                                   | Doc deliverable (same PR)                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| C1  | ROADMAP M133 "Package(s)" names "an MCP capability token" in `common`                                                     | No token: nothing in this milestone resolves one (the plugin is configured, not looked up), and a token with no reader is dead surface                                                                                                                                                                     | ROADMAP M133 "Package(s)" line amended                        |
| C2  | ROADMAP M133 decision 2: "a route with none [validation metadata] is refused at registration"                             | Refused only where input is expected: a body-carrying method (POST/PUT/PATCH) with no body brand; a route with no inputs, or only path parameters, is accepted (§3.2)                                                                                                                                      | ROADMAP M133 decision 2 amended                               |
| C3  | ROADMAP M133 "docs and an example"                                                                                        | The example is the README's runnable walkthrough plus the integration-test app; no new `apps/*` member (the apps gate would need an MCP client in CI for no added proof)                                                                                                                                   | ROADMAP M133 "Package(s)" line amended                        |
| C4  | ROADMAP M133 gate "Runs on Node, Deno, Bun and Workers"                                                                   | Node (full suite) and the Deno lane (one proof file) run here. Bun: the compat lane tests only published packages, so a `compat/compat.test.mjs` row (import + one tool call) is added and runs once 0.13.0 is published; Bun is named unproven until then. Workers gets a bundle-resolution check (§8 R2) | ROADMAP M133 gate amended to name what ran and the follow-on  |
| C5  | `REQUIRED_SCOPES_STATE_KEY` is internal to auth-plugin (M132 §3.3) but mcp-plugin must also record required scopes (§3.5) | Move the constant to `common/src/state-keys.ts`, same value; auth-plugin imports it. Its JSDoc names both writers and the one reader                                                                                                                                                                       | PUBLIC_API common state-keys table; M132 JSDoc in auth-plugin |

## 3. Design decisions

### 3.1 The plugin, its options, and the endpoint

- **Decision:** `McpPlugin(options: McpPluginOptions): IPlugin`, name `mcp`. Options:
  `tools?: readonly McpToolDeclaration[]` (optional since §3.12: route markers are the primary way
  to declare tools; startup refuses when the list and the markers together yield none), `path?`
  (default `/mcp`), `serverInfo?: {name, version}` (default `{name: 'setu-mcp', version: VERSION}`),
  `instructions?`, `allowedOrigins?: readonly string[]`, `legacy?: 'stateless' | 'reject'` (default
  `'stateless'`, passed to `createMcpHandler`), `maxResultBytes?` (default 1 MiB), `timeoutMs?`
  (default 30 000, §3.11). Every option is validated at construction
  (`McpPluginConfigurationError`). In `register()` the plugin registers `POST <path>` as an ordinary
  route, and `GET`/`DELETE <path>` answering `405` with `Allow: POST`. In `onBootstrap` it compiles
  the tool table (§3.2) and lazily loads the SDK (§3.8). The POST handler: (1) Origin check (§3.7);
  (2) reads the body once with `ctx.request.text()` (bounded by the runtime's `maxBodyBytes` on the
  adapter path) and parses it with `JSON.parse`; (3) the pre-SDK access gate (§3.5) on the parsed
  value; (4) builds the SDK `Request` — the outer URL, method and headers, `signal: ctx.signal` so a
  client disconnect aborts the call — records the per-request call context (§3.4) in a module-level
  `WeakMap<Request, CallContext>` keyed by that object, and calls the SDK handler's
  `fetch(request, {parsedBody})`; a body that does not parse is passed as the raw text instead of
  `parsedBody`, so the SDK answers its own JSON-RPC parse error (-32700); (5) copies the SDK
  `Response` status and headers onto `ctx.response` and its body as a stream
  (`ctx.response.stream`), never buffered: `responseMode: 'json'` keeps 2026-era answers to one JSON
  body, but the 2025-era stateless leg may answer with an event stream.
- **Why:** an ordinary route means global middleware (tenant resolution, request logging, rate
  limiting, the bearer challenge) runs on `POST /mcp`. `json` mode loses only mid-call
  notifications, which this plugin never emits. `legacy: 'stateless'` serves the 2025-era clients
  most agents use today from the same tool set (maintainer decision 2026-11-02).
- **Test home:** `test/unit/options.test.ts`, `test/integration/mcp-endpoint.test.ts`.

### 3.2 Tool declarations and the compiled tool table

- **Decision:**
  `McpToolDeclaration = { name; description; title?; route: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path }; repeatable?: true }`.
  At construction: `name` must match `^[A-Za-z0-9_.-]{1,64}$` (64, not the spec's 128: real clients
  reject longer names — §3.12) and be unique (case-sensitive); `description` non-empty; `route.path`
  must not equal the plugin's own `path`. In `onBootstrap`, each declaration binds to the
  `RouteInfo` from `ctx.router.listRoutes()` whose `method` and registered `path` pattern equal it
  exactly; no match refuses startup. The compiled entry holds, frozen, everything a request needs:
  - **Input schema** — one JSON Schema object (2020-12) merging: every path parameter of the pattern
    (`:id` → a required string property, or the `params` brand's property schema when one exists);
    the `query` brand's object properties; the `body` brand's object properties. Schemas come from
    Zod v4's
    `schema.toJSONSchema({target: 'draft-2020-12', io: 'input', unrepresentable: 'throw'})`,
    duck-typed as openapi-plugin does; a brand whose schema lacks `toJSONSchema`, or throws, refuses
    startup. Refusals: a body-carrying method (POST/PUT/PATCH) without a `body` brand; a body or
    query schema whose root is not `type: 'object'` with `properties`; a property name appearing in
    two of the three sources; a query property whose type is not a scalar or an array of scalars;
    `$defs` in both query and body (body `$defs` alone are hoisted to the root). `required` is the
    union; `additionalProperties` is the body's setting (`false` when there is no body). The source
    of each top-level property (`path` | `query` | `body`) is recorded.
  - **Output schema** — the success status is `responseMetadataOf(handler)?.status ?? 200`; when
    `RouteSchema.response[status]` (bare or `{schema}`) is a Zod schema whose JSON Schema root is
    `type: 'object'`, it becomes the tool's `outputSchema` and the Zod schema is kept to check
    results (§3.6). Otherwise the tool has no `outputSchema`.
  - **Annotations** — `readOnlyHint: method === 'GET'`;
    `idempotentHint: method ∈ {GET, PUT, DELETE} || idempotency-branded || repeatable`. Never
    declared by the application.
  - **Security** — the union of the route middleware's security brands: `authenticated` (any brand
    true) and `requiredScopes` (sorted union of `scopes`).
  - **Retry safety** — a POST or PATCH route is refused unless one of its middleware carries the
    idempotency brand (§3.4) or the declaration says `repeatable: true` (ROADMAP M133 decision 7).
- **Why:** declared, opt-in tools (ROADMAP M133 decision 2). A flat argument object is what models
  call best; refusing collisions keeps the split back into path/query/body unambiguous. Everything
  costly (JSON Schema conversion, brand reading) happens once at bootstrap (AI_GUIDELINES §14).
- **Test home:** `test/unit/declaration.test.ts` (name/description/path refusal table),
  `test/unit/compile-tools.test.ts` (binding, schema merge table, refusal table, output schema,
  annotations, security union, retry refusal).

### 3.3 `IApplication.dispatch` — the public in-process entry

- **Decision:** `common` adds an optional member
  `dispatch?(request: Request, options?: DispatchOptions): Promise<Response>` with
  `DispatchOptions = { readonly ip?: string }`. The kernel implements it: builds a
  `DispatchedRequest` (`IRequest`) from the `Request` — method, URL, headers, `signal` (the
  `Request`'s), `raw` (the `Request`), body read lazily from the `Request` (bytes, a stream
  allowed), `ip` from options — and runs it through `#handleRequest`, the same path an
  adapter-served request takes (hooks, global pipeline, route middleware, handler, deferred
  cleanups, 503 while stopping). It returns a native `Response` built from the snapshot; a streaming
  snapshot is returned as a stream and its deferred cleanups run when the stream ends, as the
  adapters do. No adapter is required.
- **Why:** `fetch` needs an adapter and loses the client IP (the per-IP limiter and IP security
  would see none); `inject` has no signal and refuses streams (§1). An optional member is additive
  under the versioning policy. It grants nothing a local HTTP request could not do.
- **Test home:** `packages/kernel/test/unit/dispatch.test.ts`.

### 3.4 Calling a tool: the inner request, identity and idempotency

- **Decision:** the tool callback builds one inner `Request`:
  - **URL** — the outer request's origin + the route pattern with each path parameter replaced by
    `encodeURIComponent(String(value))`; a path value that is empty, `.` or `..` is refused (a tool
    error, §3.6) so URL normalization can never move the call to another route. Query properties are
    appended with `URLSearchParams` (arrays as repeated keys). Remaining arguments form the JSON
    body for POST/PUT/PATCH/DELETE when the route has a body brand; an argument with no destination
    is a tool error.
  - **Headers** — the outer request's headers, minus `content-length`, `content-type`,
    `transfer-encoding`, `accept`, `accept-encoding`, `connection`, `idempotency-key`,
    `last-event-id` and every `mcp-*` header (`origin` is kept: §3.7 has already accepted it, and
    CSRF checks on the inner request need it); plus `accept: application/json`,
    `content-type: application/json` when there is a body, and the idempotency key below. Identity
    is carried ONLY by forwarding the caller's credential and tenant headers: authentication and
    tenant resolution re-run and reach the same principal and tenant (maintainer decision
    2026-11-02). There is no in-process identity channel to forge.
  - **Idempotency** — `common` adds `IDEMPOTENCY_METADATA`
    (`Symbol.for('setu.idempotency.metadata')`), `RouteIdempotencyMetadata { idempotent: true }`,
    `withIdempotencyMetadata`, and `idempotencyMetadataOf`, the same pattern as the validation
    brand. `idempotent()` and `IdempotencyService.middleware()` brand the closures they return (the
    decorator path uses the service, so it is covered). For a branded route the inner request
    carries `Idempotency-Key: mcp-<base64url(SHA-256(canonical JSON of [toolName, arguments]))>`,
    computed with `runtime.subtle`; canonical JSON sorts object keys. The idempotency plugin scopes
    keys per principal, so a client's retry replays the stored result and does not repeat the side
    effect. Two deliberate identical calls within the record's TTL also replay — documented.
  - **Dispatch** — `ctx.app.dispatch(request, {ip: outer.ip})`, the inner `Request` constructed with
    `signal` = the SDK's `ctx.mcpReq.signal`. An app without `dispatch` (a non-kernel
    `IApplication`) refuses startup in `onBootstrap`.
- **Why:** forwarding is the only path on which nothing new can be forged, and every per-request
  control (rate limits keyed by user or IP, tenant, audit) sees the same caller.
- **Test home:** `test/unit/inner-request.test.ts` (URL/query/body split table, encoding, `.`/`..`
  refusal, header strip table), `test/unit/idempotency-key.test.ts` (canonical JSON, stable key),
  `packages/common/test/unit/idempotency-metadata.test.ts`,
  `packages/idempotency-plugin/test/unit/idempotent-brand.test.ts`,
  `test/integration/mcp-tool-call.test.ts`.

### 3.5 The caller-filtered tool list and the pre-SDK access gate

- **Decision:** per request the plugin computes the caller's visible tools from the compiled
  security: a tool is hidden when its route is authenticated and there is no principal, or when it
  requires scopes the principal's `scopes` lack. Roles, permissions and policies are not evaluated —
  a role-guarded tool stays visible and its route refuses a call (an `isError` result, §3.6). The
  factory registers only the visible tools, so `tools/list` lists exactly those and the SDK treats
  any other name as unknown (a hidden tool inside a 2025-era JSON-RPC batch, which the gate below
  does not inspect, is therefore answered `-32602` and never dispatched).
  `cacheHints['tools/list'] = {ttlMs: 0, cacheScope: 'private'}` is set explicitly, never `public`.
  Before the SDK sees the body, a single JSON-RPC `tools/call` request naming a HIDDEN compiled tool
  is answered at the HTTP level: no principal →
  `respondWithAuthorizationFailure(ctx, 'authentication-required')` (401); missing scopes →
  `ctx.state.set(REQUIRED_SCOPES_STATE_KEY, requiredScopes)` then `'insufficient-privileges'` (403).
  auth-plugin's `bearer-challenge` middleware, already on the outer request, writes
  `WWW-Authenticate` for both — M132's single writer stays the only writer (maintainer decision
  2026-11-02). An unknown name goes to the SDK and is answered `-32602`. No `authInfo` is passed to
  the SDK: the factory reads the caller's principal, and the tool callbacks the outer headers and
  IP, from the call context the POST handler recorded under the SDK `Request` object
  (`McpRequestContext.requestInfo`), so no stand-in token is invented and nothing about the caller
  travels through the SDK.
- **Why:** spec: a list MAY vary by authorization and such a list MUST NOT go out under a shared
  scope. The step-up challenge lets a client learn which scopes to request; answering before the SDK
  means the hidden tool's route never runs.
- **Test home:** `test/unit/visibility.test.ts` (visibility table),
  `test/integration/mcp-access.test.ts` (two principals, two lists; `cacheScope: 'private'`; 401 and
  403 challenges on hidden calls with the handler not run; unknown → `-32602`).

### 3.6 Route response → tool result: one table, the executor never throws

- **Decision:** the tool callback wraps all work in `try`/`catch` and always returns a result; it
  never throws (the SDK would put `error.message` in the result). The inner response is read up to
  `maxResultBytes`; "JSON" below means a `Content-Type` of `application/json` or any `+json` media
  type (Problem Details is `application/problem+json`). The mapping is a data table the test
  iterates:

  | Inner response                                                 | Tool result                                                                                                              |
  | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
  | 2xx, JSON, tool has `outputSchema`, body passes the Zod schema | `structuredContent` = body, plus one `text` block with the JSON                                                          |
  | 2xx, JSON, tool has `outputSchema`, body fails it              | `isError`, text `The tool returned a result that does not match its output schema.`                                      |
  | 2xx, JSON, no `outputSchema`                                   | one `text` block with the JSON                                                                                           |
  | 2xx, `text/*`                                                  | one `text` block with the body                                                                                           |
  | 2xx, empty body (incl. 204)                                    | one empty `text` block                                                                                                   |
  | 2xx, any other content type                                    | `isError`, text `The tool returned a result type it cannot deliver.`                                                     |
  | 3xx                                                            | `isError`, text `The tool answered with a redirect, which is not followed.`                                              |
  | 4xx, Problem Details or `{error, detail}` JSON                 | `isError`, text `<title>: <detail>` (detail omitted when absent) plus one line `<field>: <message>` per `errors[]` entry |
  | 4xx, any other body                                            | `isError`, text `The request was refused (<status>).`                                                                    |
  | 5xx, any body                                                  | `isError`, text `The tool failed.`                                                                                       |
  | body over `maxResultBytes`                                     | `isError`, text `The tool result is too large.` (read stopped, stream cancelled)                                         |
  | argument with no destination, or a `.`/`..`/empty path value   | `isError`, text `The tool received an argument it cannot use.`                                                           |
  | the call exceeded `timeoutMs` (§3.11)                          | `isError`, text `The tool timed out.`                                                                                    |
  | dispatch rejected, or the call aborted                         | `isError`, text `The tool failed.`                                                                                       |

  The tool's input and output `StandardSchemaWithJSON` objects are pass-throughs (`validate` returns
  the value; `jsonSchema` returns the compiled schema): the route's own validation is the single
  input validator, and its 400/422 Problem Details arrive as the `isError` row above; the output
  check is the plugin's own Zod `safeParse` in the table, so the SDK's output check never produces a
  message of its own.

- **Why:** spec: execution, validation and business failures are `isError` so the model can correct
  itself; protocol failures are JSON-RPC errors. A 4xx body is exactly what the same caller would
  get over HTTP; a 5xx body never leaves the server.
- **Test home:** `test/unit/result-mapping.test.ts` (the table as data, each row asserting the full
  result object, forbidden fields absent), `test/integration/mcp-tool-call.test.ts`.

### 3.7 Origin validation

- **Decision:** before anything else, a POST with an `Origin` header is refused `403` (through
  `respondWithError`, title `Forbidden`) unless the Origin equals the request URL's own origin or is
  listed in `allowedOrigins` (each entry validated at construction as an absolute `http(s)` origin
  with no path). A request without `Origin` (a non-browser client) passes.
- **Why:** spec MUST (DNS rebinding); the SDK entry does none.
- **Test home:** `test/unit/origin.test.ts`, one row in `test/integration/mcp-endpoint.test.ts`.

### 3.8 Lazy SDK load and the per-request server

- **Decision:** `@modelcontextprotocol/server` is an optional peer (`^2.4.0`), loaded in
  `src/sdk/loader.ts` with `mod = await import('@modelcontextprotocol/server')` awaited inside
  `try`, the `catch` throwing
  `OptionalDependencyUnavailableError('@modelcontextprotocol/server', {requiredBy: '@setu-ts/mcp-plugin', cause})`.
  The loader is an injection seam (`loadSdk` option of an internal factory) for unit tests; one
  guarded test imports the real package. One `createMcpHandler` is built at `onBootstrap` and closed
  in `onShutdown`. Its factory builds a `McpServer` per request and registers the compiled tools —
  binding only, no schema work.
- **Why:** AI_GUIDELINES §12.2 and the CLAUDE.md lazy-import rule (Workers bundling).
- **Test home:** `test/unit/sdk-loader.test.ts`, `test/integration/sdk-real.test.ts`.

### 3.9 Rate limiting

- **Decision:** the plugin adds no limiter. Tool invocations are limited by the application's own
  limiters, which run on the inner request: a global `rateLimitMiddleware` counts every tool call
  (and the outer `POST /mcp`), and a limiter in a route's middleware limits that tool alone. The
  README states the spec MUST and shows the per-tool form.
- **Why:** a plugin limiter would duplicate auth-plugin's (one capability, one implementation), and
  mcp-plugin cannot import it.
- **Test home:** `test/integration/mcp-tool-call.test.ts` (a route limiter refuses the second call →
  `isError` 429 row).

### 3.10 CLI and agent brief

- **Decision:** `ADDABLE` gains
  `['mcp', {pkg: 'mcp-plugin', peers: {packages: ['@modelcontextprotocol/server']}}]`, not
  zero-config (tools must be declared). `PACKAGE_DATA` gains `mcp-plugin` with no tokens. The
  package ships an `AGENT_CARD.md` under the 2560-byte cap.
- **Test home:** existing `packages/cli/test/unit/commands/add.test.ts` rows;
  `test/agent-card-gate.test.ts`.

### 3.11 Per-call timeout

- **Decision:** option `timeoutMs?` (default 30 000; a safe integer from 1 to 600 000, else
  `McpPluginConfigurationError`). Each tool call gets an `AbortController` aborted by
  `runtime.setTimeout(timeoutMs)` or by the SDK's `ctx.mcpReq.signal`, whichever fires first; the
  inner `Request` carries the controller's signal, so the route's `ctx.signal` aborts. The dispatch
  and the result read are raced against the deadline, as auth-plugin's sign-in `attempt` does, so a
  route that ignores its signal cannot hold the call open; the timer is cleared on every path. A
  deadline hit answers `isError` `The tool timed out.`; a client abort keeps `The tool failed.`
- **Why:** the MCP spec asks clients to time out tool calls, and FastMCP (per-tool `timeout`) and
  fastapi_mcp (10 s) bound them server-side; without one a hung route holds the outer request and
  the shutdown drain open (maintainer decision 2026-11-02, after the framework survey). The runtime
  timer, not `AbortSignal.timeout`, so a test's fake clock controls it.
- **Test home:** `test/unit/options.test.ts` (refusal and default rows),
  `test/unit/server-factory.test.ts` (fake clock: a hung dispatch answers `The tool timed out.` and
  the inner signal is aborted; a dispatch that ignores its signal still answers; the timer is
  cleared after a fast call; a client abort still answers `The tool failed.`),
  `test/integration/mcp-tool-call.test.ts` (a route that waits on its signal sees it aborted).

### 3.12 Declaring a tool on the route: `mcpTool()` and `@McpTool()`

- **Decision:** a route is marked as a tool where it is defined, by one brand both styles write and
  one compiler reads.
  - **`common`** adds `MCP_TOOL_METADATA` (`Symbol.for('setu.mcp-tool.metadata')`),
    `RouteMcpToolMetadata { name?; description?; title?; repeatable?: true }`,
    `withMcpToolMetadata(middleware, meta)` and `mcpToolMetadataOf(middleware)`, the same pattern as
    the validation and idempotency brands. The reader's guard accepts only the documented member
    types and reads anything else as absent.
  - **Functional:** mcp-plugin exports `mcpTool(meta?: RouteMcpToolMetadata): MiddlewareFunction`, a
    pass-through (`(ctx, next) => next()`) carrying the brand, placed in a route's `middleware`.
  - **Class-based:** decorator-plugin adds `@McpTool(meta?)` as a method decorator only, with no
    class-level form, so exposure stays per method. It stores the metadata. `registerOnRouter`
    appends one pass-through middleware branded with it, filling `name` when absent from
    `@ApiOperation`'s `operationId`, else the method name. decorator-plugin imports nothing from
    mcp-plugin.
  - **Discovery:** in `onBootstrap` the compiler takes every route whose middleware carries the
    brand, plus every `tools` declaration (bound by method and path, §3.2). Both feed the same
    compile step, so every §3.2 rule applies to both: body brand, retry safety, schema merge and
    collisions, output schema, annotations.
  - **Name:** the marker's `name`, else the route's `schema.operationId`. Never derived from the
    path. Then checked against `^[A-Za-z0-9_.-]{1,64}$`.
  - **Description:** the marker's `description`, else `schema.description`, else `schema.summary`.
  - **Refusals** (`McpPluginConfigurationError`, each naming the route):
    - no name or no description resolvable;
    - a name outside the grammar;
    - two markers on one route;
    - a route both marked and listed in `tools`;
    - a duplicate tool name across both sources;
    - a marker on a HEAD or OPTIONS route;
    - a marked or listed route with no declared security intent;
    - no tools at all.

    A route has declared security intent when it carries a security brand (any auth-plugin guard,
    `publicRoute`, decorator `@Roles`/`@Permissions`/policies, `@UseGuards(requireScopes(…))`) or a
    declared `schema.security` (which decorator `@Public` sets to `[]`). An app that enforces
    authentication with global middleware declares `schema.security` on the route.
- **Why:**
  - The framework survey (2026-11-02) found that every framework-native integration marks tools per
    handler (MCP-Nest `@Tool`, Spring `@Tool`/`@McpTool`, Laravel `Tool` classes, C#
    `[McpServerTool]`). Both bulk converters default to every route, and FastMCP's own docs say the
    result is worse. MCP-Nest shows the cost of a second registration path: runtime-registered tools
    skip its pipeline. One brand and one compiler avoids that.
  - Path-derived names (`read_user_users__user_id__get`) are the most-reported pitfall, and real
    clients reject names over 64 characters. MCP-Nest and Mastra refuse a missing description at
    startup.
  - Requiring security intent keeps a route that is unguarded only by oversight from becoming an
    anonymous agent tool (§8a T21).
  - DI needs nothing new: a tool call re-enters the route, so a decorated controller's constructor
    and request-scoped injection, guards, pipes and `@Idempotent` apply unchanged (maintainer
    question 2026-11-02).
- **Test home:**
  - `packages/common/test/unit/mcp-tool-metadata.test.ts`: brand round trip; forged or ill-typed
    members read as absent.
  - `mcp-plugin/test/unit/mcp-tool-marker.test.ts`: the pass-through calls `next` once and carries
    the brand.
  - `mcp-plugin/test/unit/discovery.test.ts`: name and description resolution table; the refusal
    table above as data; list and markers merged; security-intent table (brand, `publicRoute`,
    `schema.security: []`, none).
  - `packages/decorator-plugin/test/unit/mcp-tool-decorator.test.ts`: method-only; name filled from
    `operationId`, then the method name; the brand is present on the registered route's middleware.
  - `mcp-plugin/test/integration/mcp-markers.test.ts`, through the real SDK client:
    - a functional `mcpTool()` route;
    - a decorated controller with an injected service, `@McpTool()` and
      `@UseGuards(requireScopes('orders:read'))`: listed only for a caller with the scope, its call
      runs the controller with the injected service;
    - `McpPlugin({})` with no `tools`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — `IApplication.dispatch` is optional, the MCP tool brand and
`@McpTool` are additive, the new brand and state key are additive, and moving
`REQUIRED_SCOPES_STATE_KEY` keeps its value. Ships in minor 0.13.0 with M132.

| Exported symbol                                                                                                 | Kind        | Consumer / real code path that READS it                                                     |
| --------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `McpPlugin` (mcp-plugin)                                                                                        | function    | applications; `setu add mcp`                                                                |
| `McpPluginOptions`, `McpToolDeclaration` (mcp-plugin)                                                           | types       | `McpPlugin`'s parameter                                                                     |
| `McpPluginConfigurationError` (mcp-plugin)                                                                      | class       | thrown by construction/bootstrap refusals; applications catch it                            |
| `VERSION` (mcp-plugin)                                                                                          | const       | default `serverInfo.version`; `test/version-constant.test.ts`                               |
| `IApplication.dispatch`, `DispatchOptions` (common)                                                             | member/type | mcp-plugin tool calls                                                                       |
| `IDEMPOTENCY_METADATA`, `RouteIdempotencyMetadata`, `withIdempotencyMetadata`, `idempotencyMetadataOf` (common) | brand       | idempotency-plugin writes; mcp-plugin reads (retry safety, key, `idempotentHint`)           |
| `REQUIRED_SCOPES_STATE_KEY` (common, moved)                                                                     | const       | auth-plugin `requireScopes` and mcp-plugin write; auth-plugin `bearer-challenge` reads      |
| `mcpTool` (mcp-plugin)                                                                                          | function    | functional routes; read back by the §3.12 compiler through the brand                        |
| `MCP_TOOL_METADATA`, `RouteMcpToolMetadata`, `withMcpToolMetadata`, `mcpToolMetadataOf` (common)                | brand       | mcp-plugin `mcpTool()` and decorator-plugin `@McpTool` write; the mcp-plugin compiler reads |
| `McpTool` (decorator-plugin)                                                                                    | decorator   | class-based controllers; `registerOnRouter` writes the brand                                |

### 4.1 Options — every option names its consumer

| Option                                           | Consumer                                | Behavior (per implementation)                                                              |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tools`                                          | `compileTools` (bootstrap)              | the tool table; refusals per §3.2                                                          |
| marker `name`/`description`/`title`/`repeatable` | §3.12 compiler                          | tool identity and retry safety for a marked route; the same rules as a `tools` declaration |
| `path`                                           | `register()` route registration         | endpoint path; a tool may not bind to it                                                   |
| `serverInfo`                                     | per-request `McpServer`                 | `serverInfo` in `initialize` / `server/discover`                                           |
| `instructions`                                   | per-request `McpServer`                 | server instructions                                                                        |
| `allowedOrigins`                                 | Origin check (§3.7)                     | extra accepted origins                                                                     |
| `legacy`                                         | `createMcpHandler`                      | 2025-era serving posture                                                                   |
| `maxResultBytes`                                 | result reader (§3.6)                    | bound on the inner response body read                                                      |
| `timeoutMs`                                      | tool callback (§3.11)                   | per-call deadline; aborts the inner request and answers `The tool timed out.`              |
| tool `repeatable`                                | `compileTools` retry check, annotations | admits a POST/PATCH route without the idempotency brand; `idempotentHint`                  |
| `DispatchOptions.ip`                             | kernel `DispatchedRequest`              | `ctx.request.ip` of the inner request                                                      |

## 5. Implementation files

| File                                                                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/mcp-plugin/src/index.ts`                                                                        | barrel: `McpPlugin`, `McpPluginOptions`, `McpToolDeclaration`, `McpPluginConfigurationError`, `VERSION`                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/mcp-plugin/src/version.ts`                                                                      | `VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/mcp-plugin/src/errors.ts`                                                                       | `McpPluginConfigurationError`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp-plugin/src/options.ts`                                                                      | option and declaration validation (§3.1, §3.2 construction refusals, §3.7 origins)                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/mcp-plugin/src/compile/json-schema.ts`                                                          | Zod → JSON Schema duck-typing and the input merge (§3.2)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/mcp-plugin/src/compile/compile-tools.ts`                                                        | binding to `listRoutes`, output schema, annotations, security, retry check (§3.2)                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/mcp-plugin/src/call/inner-request.ts`                                                           | inner `Request` construction and header strip (§3.4)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/mcp-plugin/src/call/idempotency-key.ts`                                                         | canonical JSON and key (§3.4)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp-plugin/src/call/result-mapping.ts`                                                          | bounded read and the §3.6 table                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/mcp-plugin/src/serve/visibility.ts`                                                             | visible set, pre-SDK gate, `authInfo` (§3.5)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/mcp-plugin/src/serve/origin.ts`                                                                 | Origin check (§3.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/mcp-plugin/src/sdk/loader.ts`                                                                   | lazy SDK import (§3.8)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/mcp-plugin/src/sdk/server-factory.ts`                                                           | per-request `McpServer`, pass-through input schema, tool callback (§3.5, §3.6, §3.8)                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/mcp-plugin/src/route/mcp-tool.ts` (new)                                                         | `mcpTool()` (§3.12)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/mcp-plugin/src/compile/discovery.ts` (new)                                                      | marker discovery, name/description resolution, merge with `tools`, §3.12 refusals                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/mcp-plugin/src/plugin/mcp-plugin.ts`                                                            | `McpPlugin`: routes, bootstrap, POST handler, shutdown (§3.1)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp-plugin/{package.json,deno.json,tsconfig.json,README.md,AGENT_CARD.md,LICENSE}`              | package scaffolding, optional peer                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/common/src/plugin.ts`                                                                           | `IApplication.dispatch?`, `DispatchOptions`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/common/src/http.ts`                                                                             | idempotency brand                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/common/src/state-keys.ts`                                                                       | `REQUIRED_SCOPES_STATE_KEY`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/common/src/index.ts`                                                                            | new exports                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/kernel/src/application/application.ts`                                                          | `dispatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/kernel/src/application/dispatched-request.ts` (new)                                             | `DispatchedRequest`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/idempotency-plugin/src/middleware/idempotent.ts`, `src/service/idempotency-service.ts`          | apply the brand                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/auth-plugin/src/resource-server/challenge.ts`, `src/guards/index.ts`                            | import the moved key                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/cli/src/commands/add.ts`, `src/agents/package-data.ts`                                          | `setu add mcp`, package data                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/common/src/http.ts` (MCP tool brand)                                                            | §3.12 brand                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/decorator-plugin/src/decorators/mcp.ts` (new), `src/plugin/decorator-plugin.ts`, `src/index.ts` | `@McpTool` and its branded pass-through (§3.12)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| repo lists                                                                                                | `pnpm-workspace.yaml`, `tsconfig.json` reference, `typedoc.check.json`, `compat/package.json` and a `compat/compat.test.mjs` row (§2 C4), `scripts/release-packages.ts`, `scripts/generate-api-docs.ts`, `scripts/jsr-metadata.ts`, `test/agent-card-gate.test.ts`, `test/package-readme-fence-compiler.test.ts`, `test/api-docs-generation.test.ts` (count), `test/deno-lane/lane.config.json`, `test/set-jsr-metadata-dry-run.test.ts`, `test/unit/jsr-sunset.test.ts` |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                        | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-plugin/test/unit/options.test.ts`                           | `options.ts`, `errors.ts`                              | refusal table (empty tools, bad path, bad origin, bad `maxResultBytes`, bad `legacy`); defaults                                                                                                                                                                                                                                                                                                                       |
| `mcp-plugin/test/unit/declaration.test.ts`                       | `options.ts`                                           | name grammar table (0, 1, 128, 129 chars; bad characters), duplicate, empty description, route path = endpoint path                                                                                                                                                                                                                                                                                                   |
| `mcp-plugin/test/unit/compile-tools.test.ts`                     | `compile/compile-tools.ts`, `compile/json-schema.ts`   | binding (exact method+pattern, no match refused); merge table (params from pattern, params brand, query, body, collisions, non-object roots, non-scalar query, `$defs`); POST without body brand refused; output schema present/absent; annotations table; security union; POST/PATCH retry refusal vs brand vs `repeatable`                                                                                          |
| `mcp-plugin/test/unit/inner-request.test.ts`                     | `call/inner-request.ts`                                | URL substitution and encoding, `.`/`..`/empty refused, query arrays, body split, header strip table, accept/content-type set                                                                                                                                                                                                                                                                                          |
| `mcp-plugin/test/unit/idempotency-key.test.ts`                   | `call/idempotency-key.ts`                              | key-order independence, different args → different keys, stable known vector                                                                                                                                                                                                                                                                                                                                          |
| `mcp-plugin/test/unit/result-mapping.test.ts`                    | `call/result-mapping.ts`                               | the §3.6 table as data, full result objects, `isError` absent on success rows, no 5xx text leaks, size bound cancels the stream                                                                                                                                                                                                                                                                                       |
| `mcp-plugin/test/unit/visibility.test.ts`                        | `serve/visibility.ts`                                  | visibility table (anonymous/authenticated × public/authenticated/scoped), gate decisions (single `tools/call` only; arrays and other methods pass through)                                                                                                                                                                                                                                                            |
| `mcp-plugin/test/unit/origin.test.ts`                            | `serve/origin.ts`                                      | no Origin, same origin, listed, unlisted, malformed                                                                                                                                                                                                                                                                                                                                                                   |
| `mcp-plugin/test/unit/sdk-loader.test.ts`                        | `sdk/loader.ts`                                        | injected failing import → `OptionalDependencyUnavailableError` with `requiredBy`                                                                                                                                                                                                                                                                                                                                      |
| `mcp-plugin/test/unit/server-factory.test.ts`                    | `sdk/server-factory.ts`                                | pass-through schema shape; the call context is read from the `WeakMap` by `requestInfo` and no `authInfo` is passed; only visible tools registered; callback never throws (a throwing dispatch yields the generic row); `cacheHints` private                                                                                                                                                                          |
| `mcp-plugin/test/integration/sdk-real.test.ts`                   | `sdk/loader.ts`                                        | guarded real import of `@modelcontextprotocol/server`                                                                                                                                                                                                                                                                                                                                                                 |
| `mcp-plugin/test/integration/mcp-endpoint.test.ts`               | `plugin/mcp-plugin.ts`                                 | kernel app + the SDK's own client (`@modelcontextprotocol/client`, devDependency): 405 on GET/DELETE, Origin 403, an unparsable body answered `-32700` by the SDK, legacy and modern clients both list tools (the client's `fetch` option bound to `app.fetch`; a legacy event-stream answer arrives intact through `ctx.response.stream`), startup refusals surface                                                  |
| `mcp-plugin/test/integration/mcp-access.test.ts`                 | `plugin/mcp-plugin.ts`, `serve/visibility.ts`          | two principals with different scopes get different lists; `cacheScope: 'private'`; hidden call → 401 / 403 `insufficient_scope` with the handler not run (short-circuit); unknown → `-32602`                                                                                                                                                                                                                          |
| `mcp-plugin/test/integration/mcp-tool-call.test.ts`              | `sdk/server-factory.ts`, `call/*`                      | a call runs the route's guard, validation, tenant and audit hook (each recorded); a validation refusal → `isError` with field lines; a thrown handler → `The tool failed.` and no message; a retried POST through `idempotent()` runs the handler once; a route limiter's 429 → `isError`; aborting the client request aborts the route handler's `ctx.signal`; a hidden tool inside a 2025 batch is never dispatched |
| `mcp-plugin/test/unit/barrel-exports.test.ts`                    | `index.ts`, `version.ts`                               | exact export list                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mcp-plugin/test/unit/mcp-tool-marker.test.ts`                   | `route/mcp-tool.ts`                                    | pass-through calls `next` once; brand present                                                                                                                                                                                                                                                                                                                                                                         |
| `mcp-plugin/test/unit/discovery.test.ts`                         | `compile/discovery.ts`                                 | §3.12 resolution table, refusal table, security-intent table, list + markers merged                                                                                                                                                                                                                                                                                                                                   |
| `mcp-plugin/test/integration/mcp-markers.test.ts`                | `plugin/mcp-plugin.ts`, `compile/discovery.ts`         | functional marker, decorated controller with DI + `requireScopes` guard, `McpPlugin({})` through the real client                                                                                                                                                                                                                                                                                                      |
| `common/test/unit/mcp-tool-metadata.test.ts`                     | `http.ts` (MCP brand)                                  | round trip; ill-typed members absent                                                                                                                                                                                                                                                                                                                                                                                  |
| `decorator-plugin/test/unit/mcp-tool-decorator.test.ts`          | `decorators/mcp.ts`, `decorator-plugin.ts`             | method-only; name from `operationId` then method name; brand on the registered route                                                                                                                                                                                                                                                                                                                                  |
| `kernel/test/unit/dispatch.test.ts`                              | `application.ts` (`dispatch`), `dispatched-request.ts` | global middleware + hooks run; ip and signal reach `ctx`; a streamed request body and a streamed response; deferred cleanups after the stream; 503 while stopping; no adapter needed                                                                                                                                                                                                                                  |
| `common/test/unit/idempotency-metadata.test.ts`                  | `http.ts` (brand)                                      | brand round trip; a forged non-object value read as absent                                                                                                                                                                                                                                                                                                                                                            |
| `idempotency-plugin/test/unit/idempotent-brand.test.ts`          | `idempotent.ts`, `idempotency-service.ts`              | both entry points brand, behavior unchanged                                                                                                                                                                                                                                                                                                                                                                           |
| `auth-plugin` existing `bearer-challenge`/`require-scopes` tests | `challenge.ts`, `guards/index.ts`                      | unchanged, now importing the moved key                                                                                                                                                                                                                                                                                                                                                                                |
| `cli/test/unit/commands/add.test.ts` (existing)                  | `add.ts`, `package-data.ts`                            | `setu add mcp` adds the package and the SDK peer                                                                                                                                                                                                                                                                                                                                                                      |
| Deno lane `mcp-plugin` proof                                     | `plugin/mcp-plugin.ts`                                 | one list + one call against a kernel app under Deno                                                                                                                                                                                                                                                                                                                                                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m133-mcp-plugin
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local            # final commit; plus the Deno lane and both publish gates
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Per-file coverage ≥ 90% (branch/function/line) on every changed `src` file, read ANSI-stripped.

## 8a. Design security review

Completed 2026-11-02, before the committed-tree audit. It records the flows, trust boundaries,
assets, attackers, approved budgets, the threats considered with their resolutions, and the
obligations the audit must probe. The audit checks the code against this section; it does not
re-derive the threat model.

### 8a.1 Reviewed flows

- **F1 — `POST /mcp`.** Global middleware runs first: tenant resolution, authentication, rate
  limiting, `bearer-challenge`. Then the plugin runs, in this order:
  1. Origin check (§3.7).
  2. Bounded body read and JSON parse.
  3. Pre-SDK access gate (§3.5).
  4. The SDK: protocol validation, then `tools/list` or `tools/call`.
  5. The response is copied as a stream.
- **F2 — `tools/list`.** The per-request `McpServer` registers only the tools visible to the caller,
  with cache hint `{ttlMs: 0, cacheScope: 'private'}` and `listChanged: false`.
- **F3 — `tools/call` of a visible tool.**
  1. The arguments are split into path, query and body (§3.4).
  2. An inner `Request` is built with the forwarded headers and, for an idempotency-branded route, a
     derived `Idempotency-Key`.
  3. `IApplication.dispatch` runs the whole pipeline again: authentication and tenancy from the
     forwarded headers, route guards, validation, idempotency, the handler.
  4. A bounded read and the §3.6 mapping produce the tool result.
- **F4 — `tools/call` of a hidden tool.** The pre-SDK gate answers 401, or 403 with the required
  scopes recorded. `bearer-challenge` writes `WWW-Authenticate`. Nothing is dispatched.
- **F5 — a retried call.** The same tool and arguments produce the same key, so the idempotency
  plugin replays the stored result within the caller's tenant and principal scope.
- **F6 — `IApplication.dispatch`.** A public in-process entry. Any plugin can build a `Request` and
  run it through the pipeline with an `ip` it chooses.
- **F7 — tool discovery.** At bootstrap the compiler reads the MCP tool brand from route middleware
  (functional `mcpTool()`, decorated `@McpTool`) and the `tools` list, through one compile step.

### 8a.2 Trust boundaries

- **B1 — network → `POST /mcp`.** Headers, body, the JSON-RPC envelope and tool arguments are all
  attacker-controlled.
- **B2 — tool arguments → inner URL and body.** Values chosen by the caller, or by a model driving
  the caller, become path segments, query parameters and JSON fields of a second request.
- **B3 — outer identity → inner identity.** Credential and tenant headers cross into a second
  pipeline run. No identity object crosses.
- **B4 — inner response → client and model.** The route's output becomes a tool result a model
  reads.
- **B5 — in-process code → `dispatch`.** Plugin code is trusted. `dispatch` grants it nothing a
  local HTTP request could not do, except choosing the `ip` it reports (accepted: §8a.5 T16).

### 8a.3 Assets

- **A1 — route authorization.** A tool call reaches exactly its bound route, as exactly the caller.
- **A2 — tenant isolation.** The inner call resolves the caller's tenant and no other.
- **A3 — the route table.** No argument can steer a call to another route.
- **A4 — error internals.** No 5xx body, stack or thrown message reaches a client.
- **A5 — the idempotency store.** No caller can read or replay another caller's stored result.
- **A6 — per-caller tool lists.** A filtered list is never shared across authorization contexts.
- **A7 — availability.** One request cannot cost unboundedly more than one HTTP call to the same
  routes.

### 8a.4 Attackers

- **X1 — remote, no credentials.** Sends arbitrary JSON-RPC, headers and arguments.
- **X2 — remote, valid credentials with few scopes, or the wrong tenant.**
- **X3 — a web page in a victim's browser.** Attempts DNS rebinding, or a cross-origin POST that
  rides the victim's cookies.
- **X4 — a model under prompt injection.** Chooses hostile arguments for an authorized caller:
  traversal values, other tenants' ids, oversized inputs.
- **X5 — a hostile or buggy route.** Returns a huge, streaming, redirecting or malformed response.

### 8a.5 Threats and resolutions

| #   | Threat                                                                                                                  | Resolution (a claim about the code)                                                                                                                                 | Obligation |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| T1  | Confused deputy: the inner call gets authority the caller lacks                                                         | Identity crosses only as the caller's own forwarded headers. No principal object, token or marker is passed in-process. `authInfo` is not passed to the SDK         | O1         |
| T2  | Caller-chosen `Idempotency-Key` replays a stored result or forces a collision                                           | The outer `idempotency-key` is stripped. The key is derived from the tool name and canonical arguments. The idempotency plugin scopes it per tenant and principal   | O1, O8     |
| T3  | Route steering through path arguments (`..`, `.`, `/`, `%2F`, `%2E%2E`, empty)                                          | Each value is `encodeURIComponent`-ed. Empty, `.` and `..` are refused before the URL is built. The bound pattern is fixed at bootstrap                             | O6         |
| T4  | Argument smuggling: an argument with no destination, or one shadowing another source                                    | Collisions across path, query and body are refused at bootstrap. An argument with no destination is a tool error                                                    | O6         |
| T5  | A hidden tool's route runs for a caller who may not see it                                                              | The pre-SDK gate answers before dispatch. Only visible tools are registered, so a hidden name inside a batch is `-32602`                                            | O3, O10    |
| T6  | Tool existence disclosed by 401/403 vs `-32602`                                                                         | **Accepted** (maintainer decision 2026-11-02): the step-up challenge must name the scopes. Undeclared names stay `-32602`                                           | O10        |
| T7  | A filtered list cached and served to another caller                                                                     | `cacheScope: 'private'` and `ttlMs: 0` are set explicitly                                                                                                           | O2         |
| T8  | DNS rebinding or cross-origin POST with cookies                                                                         | A present Origin must be the endpoint's own or listed, else 403 before parsing. A browser always sends Origin on such a POST                                        | O4         |
| T9  | Error disclosure through a tool result                                                                                  | The callback never throws. 5xx, abort and dispatch failures map to fixed text. 4xx shows only what the same caller gets over HTTP                                   | O5         |
| T10 | Self-recursion: a tool bound to `POST /mcp`                                                                             | Refused at construction                                                                                                                                             | O7         |
| T11 | A repeated non-idempotent call duplicates a side effect                                                                 | POST/PATCH are refused at bootstrap without the brand or `repeatable`. A branded retry replays                                                                      | O8         |
| T12 | A huge or never-ending route response exhausts memory                                                                   | The read stops at `maxResultBytes` and cancels the stream. The option has an upper bound (budget below)                                                             | O9         |
| T13 | A disconnected client keeps an inner handler running                                                                    | The outer `ctx.signal` is passed to the SDK `Request`. The SDK signal is passed to the inner `Request`. Abort is checked before dispatch and before mapping         | O11        |
| T14 | Cross-tenant access through a path-parameter tenant id                                                                  | Not prevented by the plugin, by design: the route's own tenant and membership checks decide, exactly as over HTTP. The plugin adds no path the HTTP route lacks     | O12        |
| T15 | Batch amplification: one 2025-era HTTP body carrying many `tools/call` entries                                          | **Accepted with a probe:** each batched call is its own inner request through the app's global limiters. The body itself is bounded by the runtime's `maxBodyBytes` | O13        |
| T16 | In-process code calls `dispatch` with a forged `ip`                                                                     | **Accepted:** in-process code is trusted (B5). `dispatch` is documented as adding no privilege beyond a local request                                               | —          |
| T17 | Prompt injection through route output                                                                                   | **Out of scope:** the lethal-trifecta registry is a named follow-on (ROADMAP M133 decision 8). The README says tool output is untrusted model input                 | —          |
| T18 | Brands treated as authorization: a forged security brand hides a tool, or a forged idempotency brand admits a POST tool | Brands only shape the list and the startup refusal. The route's guards still enforce every call (class 10). Forging needs application code, which is trusted        | O3         |
| T19 | A non-array `principal.scopes` substring-matches                                                                        | Visibility treats a non-array `scopes` as holding none (fixed in review, M132 F-2 class)                                                                            | O14        |
| T20 | A hung route holds the call, the outer request and the shutdown drain open                                              | A per-call deadline (§3.11) aborts the inner request and races the result                                                                                           | O15        |
| T21 | A route unguarded by oversight becomes a tool any anonymous agent can call                                              | A marked or listed route needs declared security intent (a security brand or `schema.security`), else startup refuses (§3.12)                                       | O16        |

### 8a.6 Approved budgets

- **`maxResultBytes`.** Default 1 MiB. Must be a safe positive integer, at most 64 MiB. A value
  outside that range refuses construction. The 64 MiB cap is a design requirement added by this
  review: the code currently accepts any safe positive integer and must be fixed.
- **Outer body.** Bounded by the runtime's `maxBodyBytes` on the adapter path. The plugin adds no
  bound of its own.
- **Tool names.** 1–64 characters of `[A-Za-z0-9_.-]`, unique. No limit on the number of tools: they
  are declared by the application.
- **Per call.** One inner dispatch per `tools/call`. No retries inside the plugin. Deadline
  `timeoutMs`: default 30 s, at most 10 minutes.

### 8a.7 Obligations the audit probes (each with a positive control)

| #   | Obligation                                                                                                                                                                                                                   | Probe and positive control                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | The inner request carries no outer `mcp-*`, `idempotency-key`, `content-*`, `accept*` or `transfer-encoding` headers; an accepted `origin` is forwarded (§3.4); a principal is reached only through the forwarded credential | Canary values in every stripped header, read back by a recording route. Control: a forwarded custom header arrives. A credential the inner auth refuses yields an anonymous inner call (401 `isError`), while the same credential over HTTP gets the same 401 |
| O2  | `tools/list` never carries `cacheScope: 'public'`                                                                                                                                                                            | Read the raw 2026-era result. Control: an SDK server built with `public` shows the field, proving the probe reads it                                                                                                                                          |
| O3  | A hidden tool's route never runs                                                                                                                                                                                             | Call counters on hidden routes; 401 and 403 with `WWW-Authenticate` listing the required scopes. Control: the same call with the scopes runs the route once                                                                                                   |
| O4  | A present, unlisted, cross-origin `Origin` is refused before parsing                                                                                                                                                         | Hostile Origin with a malformed body gets 403, not a parse error. Controls: own origin and a listed origin pass; no Origin passes                                                                                                                             |
| O5  | No 5xx body, stack or thrown message reaches a result                                                                                                                                                                        | Canaries in a 500 body, a thrown error message and a rejected dispatch; search the whole response. Control: a 422 detail canary DOES arrive                                                                                                                   |
| O6  | No argument moves the call to another route                                                                                                                                                                                  | `..`, `.`, empty, `/`, `%2F`, `%2E%2E`, `..%2F` against a pattern with a sibling route; the sibling's counter stays 0. Control: a plain value reaches the bound route                                                                                         |
| O7  | A tool cannot bind to the MCP endpoint                                                                                                                                                                                       | Construction refusal, including a trailing-slash variant. Control: a different path is accepted                                                                                                                                                               |
| O8  | POST/PATCH without the brand or `repeatable` refuse startup; a branded retry runs the handler once; a caller's `Idempotency-Key` is ignored                                                                                  | Retry the same call twice: counter 1. A caller-supplied key equal to another call's derived key does not replay that call. Control: different arguments run twice                                                                                             |
| O9  | The inner read is bounded                                                                                                                                                                                                    | An endless streaming route is cancelled at `maxResultBytes`. `maxResultBytes` above 64 MiB, `Infinity`, `NaN` and 0 refuse construction. Control: a body exactly at the bound succeeds                                                                        |
| O10 | Hidden and unknown calls never dispatch, including inside a 2025-era batch                                                                                                                                                   | Route counters stay 0. Control: a visible tool in the same batch runs                                                                                                                                                                                         |
| O11 | A client disconnect aborts the inner handler                                                                                                                                                                                 | Abort the outer request mid-call and observe `ctx.signal.aborted` in the handler. Control: an uninterrupted call completes                                                                                                                                    |
| O12 | A tenant path parameter is decided by the route, as over HTTP                                                                                                                                                                | Another tenant's id via MCP and via HTTP: same refusal. Control: the caller's own tenant id succeeds                                                                                                                                                          |
| O13 | Each batched call passes the app's global limiter                                                                                                                                                                            | A global `rateLimitMiddleware` with `max: 2`; a batch of 3 calls yields at most 2 successes. Control: `max: 10` gives 3                                                                                                                                       |
| O14 | Non-array `principal.scopes` holds none                                                                                                                                                                                      | A mapper returning the raw `scope` string `'xreadx'`: the `read` tool is hidden and its call answers 403. Control: `['read']` shows it                                                                                                                        |
| O15 | A call is bounded by `timeoutMs` even when the route ignores its signal                                                                                                                                                      | A route that never settles and ignores `ctx.signal`: the result is `The tool timed out.` within the deadline. Control: a route that answers before the deadline succeeds                                                                                      |
| O16 | No tool is exposed without declared security intent                                                                                                                                                                          | A marked route with no guard and no `schema.security` refuses startup. Controls: `publicRoute`, `@Public`, `requireAuth` and `@UseGuards(requireScopes(…))` each start                                                                                        |

### 8a.8 Committed-tree audit

Required: the change crosses the authentication boundary (B1, B3), turns network input into routing
(B2), and adds a public dispatch entry (B5). Run by a freshly spawned Claude agent — not Codex, not
the implementing context — per `.roo/skills/security-audit/SKILL.md`, on the PR's head commit, after
`ci:local` and both publish gates. The audit record goes in the PR.

## 8. Risks & mitigations

- R1 The SDK is new (2.4.0, 2026-10-23) and its internals move → depend only on the public exports
  named in §1, pin the peer to `^2.4.0`, and keep one real-SDK integration suite.
- R2 Workers: the SDK has a `workerd` condition but is unproven there, and AJV code generation is
  replaced by the cf-worker validator only on that condition → ship a check that esbuild with the
  `workerd` condition resolves the guarded import; the live `workerd` run is a named follow-on.
- R3 Re-verifying the caller's token on every tool call doubles verification cost → measured in the
  PR (one call, JWT strategy) and documented; issuer key sets are cached, so it is CPU only.
- R4 A route that streams a large response holds memory up to `maxResultBytes` → the read stops at
  the bound and cancels the stream.
- R5 Two intentional identical calls to an idempotency-branded tool within the TTL replay → the
  README states it and shows varying an argument (e.g. a client reference) when repetition is meant.

## 9. Out of scope

- CQRS commands as tools — waits for the command registry to carry schemas.
- MCP resources, prompts, completions, sampling, elicitation and subscriptions — no consumer yet.
- `x-mcp-header`, the authorization server, the lethal-trifecta registry — ROADMAP M133 decision 8.
- A live Workers (`workerd`) run — follow-on (R2).
