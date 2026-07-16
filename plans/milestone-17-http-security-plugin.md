# Milestone 17 — HTTP Security Plugin (`@hono-enterprise/http-security-plugin`)

> **Status:** Planning. Branch: `feat/17-http-security-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Milestone 17 delivers HTTP **transport** security as a single first-party plugin,
`@hono-enterprise/http-security-plugin`. It provides five independent, composable middleware
concerns — **CORS**, **security response headers**, **CSRF**, **request-size limiting**, and
**IP security** — each registered as a global middleware function on the kernel pipeline. The
plugin owns no service and no capability token: like the `rateLimitMiddleware` shipped in M16b,
it is a pure middleware provider (`ctx.middleware.add(...)` in `register()`), and each middleware
is also exported as a standalone factory for per-route use. The package depends only on
`@hono-enterprise/common` and `@hono-enterprise/kernel` and ships with **zero npm dependencies**
— every concern is plain HTTP header / `Content-Length` logic against the committed `IRequest` /
`IResponse` contracts.

- **In scope:** `HttpSecurityPlugin(options?)` factory; five middleware factories
  (`corsMiddleware`, `securityHeadersMiddleware`, `csrfMiddleware`, `requestSizeMiddleware`,
  `ipSecurityMiddleware`); the aggregate + per-concern option types; a barrel `src/index.ts`; a
  unit test file per `src/` file; an integration test exercising real `app.inject()` requests and
  short-circuit behavior; `PUBLIC_API.md` + `ARCHITECTURE.md` corrections; README.
- **NOT this milestone:** identity-layer security (`@hono-enterprise/auth-plugin`, M16/M16b:
  JWT/API-key/RBAC/guards/refresh/rate-limit); secret management (M23, `secrets-plugin`);
  IP allow/deny lists and per-route IP policy (deferred — see §9); a cookie- or token-store-based
  CSRF synchronizer pattern (deferred — `IRequest` has no cookie access; see §9); body parsing /
  multipart upload limiting (M26, `storage-plugin` upload middleware).

## 1. Contracts verified from SOURCE (not names)

Every external reference the design leans on, verified by opening the source. A name that was not
read is not verified.

| Reference | Source (file:line) | Verified surface / fact |
| --------- | ------------------ | ----------------------- |
| `IRequest` | `packages/common/src/http.ts:32-68` | Fields: `method`, `url`, `path`, `headers: Headers`, `readonly ip?: string`, `user?`. Body via `json<T>()`/`text()`/`bytes()` (fully buffered). **No `cookies` access at all** — decisive for CSRF (§3.3). `ip` is `readonly`, so IP security cannot mutate it (§3.5). |
| `IResponse` | `packages/common/src/http.ts:83-154` | `status(code)`/`header(name,value)`/`appendHeader(name,value)` chain; terminals `json`/`text`/`send`/`redirect` return `HandlerResult`; `snapshot()` returns `{status, headers, body}` for post-`next()` inspection. `header()` overwrites; `appendHeader()` adds (used for `Vary`). |
| `IRequestContext` | `packages/common/src/http.ts:162-179` | `request`, `response`, `services`, `params`, `query`, `state: Map<string,unknown>`, `startTime`. `state` is the only writable cross-stage channel — IP security writes the resolved client IP there (§3.5). |
| `MiddlewareFunction` / `NextFunction` | `packages/common/src/http.ts:187-208` | `(ctx, next) => void \| HandlerResult \| Promise<…>`. Not calling `next()` short-circuits (required for CORS preflight / 413 / 403, §6). |
| `IPlugin` / `IPluginContext` | `packages/common/src/plugin.ts:437-458` and `376-415` | `name`/`version`/`provides?`/`priority?`/`register(ctx)`. `provides` is optional — a middleware-only plugin that registers no service is valid (verified by the M16b `rateLimitMiddleware` precedent). |
| `IMiddlewareApi.add` + `MiddlewareOptions` | `packages/common/src/plugin.ts:41-49` and `26-34` | `add(middleware, { priority?, name? })`. The plugin passes each concern's execution priority here. |
| `CAPABILITIES` | `packages/common/src/tokens.ts:39-112` | **There is no `HTTP_SECURITY` token.** Verified by reading the full constant. The plugin therefore registers no capability token and no service (§3.1). The plugin `name` `'http-security-plugin'` is lowercase kebab and needs no `createCapabilityToken`. |
| `PLUGIN_PRIORITY` | `packages/common/src/types.ts:78-89` | `HIGHEST 0 / HIGH 100 / NORMAL 500 / LOW 900 / LOWEST 1000`. Plugin registration priority (not middleware execution priority). |
| Middleware priority bands | `ARCHITECTURE.md` §10 table (root file lines ~1529-1542) | Reserved execution bands: `200 CorsMiddleware`, `250 SecurityHeadersMiddleware`, `300 AuthMiddleware`. The plugin's CORS/headers middleware use 200/250 to land in these documented bands (§3.8). |
| Plugin naming + version precedent | `packages/cache-plugin/src/plugin/cache-plugin.ts:28,74` | `PLUGIN_NAME = 'cache-plugin'` (package name without scope); `version: '0.1.0'`. M17 follows the same: name `'http-security-plugin'`, version `'0.1.0'`. |
| Middleware factory precedent | `packages/cache-plugin/src/middleware/cache-middleware.ts:41-129` | `export function xMiddleware(options?): MiddlewareFunction { return async (ctx, next) => {…} }`; short-circuit by `return;` without `next()`; add response headers via `ctx.response.header(...)`; read snapshot after `next()` when post-processing. |
| Package stub state | `packages/http-security-plugin/{deno.json,src/index.ts}` | Package already scaffolded in M0 with a stub `deno.json` (shape matches `packages/cache-plugin/deno.json`) and empty `src/index.ts`. M17 fills it in; no new workspace member is added (already in root `deno.json` line 19). |
| Dep graph | `ARCHITECTURE.md` §8 + `ROADMAP.md` "Package Dependencies" | `http-security-plugin ─► common, kernel`. No runtime dependency required (no crypto/uuid/timer/fs needed by any concern). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| -- | -------- | ------------------------ | ------------------------- |
| C1 | `ARCHITECTURE.md` §8 (http-security-plugin row) states "**all security features are opt-out (enabled by default)**". `AI_GUIDELINES.md` §13.4 pins only CORS ("defaults to no origins allowed") and security headers ("defaults to enabled") and is silent on CSRF / request-size / IP-security. `ROADMAP.md` M17 registers CSRF/request-size/IP-security via explicit option blocks (`csrf: { enabled: true }`, `requestSize: { maxBodySize }`, `ipSecurity: { trustProxy, ipHeader }`). | **Security headers register ON by default; CORS, CSRF, request-size, and IP-security are opt-in** (registered only when their option sub-object is present; each then has a secure default when enabled, e.g. CORS denies cross-origin unless `origin` is configured). This honors §13.4's hard mandates while matching ROADMAP's explicit per-concern config and avoiding a CSRF/IP default that needs app-specific context to be safe. | Edit the `@hono-enterprise/http-security-plugin` row in `ARCHITECTURE.md` §8: replace "all security features are opt-out (enabled by default)" with "secure defaults: security headers on by default; CORS/CSRF/request-size/IP-security are opt-in via their option blocks, each secure-by-default when enabled". |
| C2 | No `HTTP_SECURITY` capability token exists in `CAPABILITIES` (verified §1), yet `ARCHITECTURE.md` §8 lists only `HttpSecurityPlugin()` under "Public API" with no token and `PUBLIC_API.md` has no `HttpSecurityPlugin` section. | **The plugin registers middleware only — no capability token, no service** (the `rateLimitMiddleware` / `authMiddleware` precedent). | Add a full `## HttpSecurityPlugin()` section to `PUBLIC_API.md` (registration, options table, per-concern behavior, exports table) stating it registers no service/token; expand the `ARCHITECTURE.md` §8 "Public API" cell from `HttpSecurityPlugin()` to list the five middleware factories. |
| C3 | CSRF is conventionally cookie- or token-store-based, but `IRequest` (§1) exposes headers only — **no cookie access** and no server-side session seam owned by this plugin. | **CSRF = stateless Origin/Referer validation** for unsafe methods, plus an optional custom-header requirement (§3.3). No cookies, no token store, no `RefreshTokenStore`-style backend. | `PUBLIC_API.md` CSRF subsection documents the Origin/Referer mechanism (and the custom-header option) explicitly so no one expects a cookie synchronizer token. |

## 3. Design decisions

Every behavior a planned test asserts has a decision here. Each seam resolves to exactly ONE
mechanism.

### 3.1 Surface model — middleware-only, no capability token, no service

- **Decision:** `HttpSecurityPlugin` returns an `IPlugin` whose `register(ctx)` calls
  `ctx.middleware.add(concern, { priority, name })` for each enabled concern. It sets
  `provides: []` (omitted) and registers **no service** under any token. The five concerns are
  also exported as standalone `MiddlewareFunction` factories for per-route use.
- **Why:** `CAPABILITIES` has no `HTTP_SECURITY` token (§1) and no consumer in M17 needs a
  resolvable security service; a service with no reader is dead surface (CLAUDE "every symbol names
  its consumer"). The middleware factories are the real surface, identical to the shipped
  `rateLimitMiddleware` model.
- **Test home:** `test/unit/http-security-plugin.test.ts` asserts which middleware get added for a
  given options shape (default → headers only; explicit blocks → those concerns) by driving a real
  `app.inject()` request and observing presence/absence of each concern's observable effect.

### 3.2 Defaults — security headers on; everything else opt-in

- **Decision:** When `headers` is omitted the security-headers middleware still registers with a
  secure default header set; `headers: { enabled: false }` turns it off. `cors`, `csrf`,
  `requestSize`, and `ipSecurity` register **only when their option sub-object is present**; inside
  each, an `enabled` flag defaults to `true` (so `{}` enables it, `{ enabled: false }` disables),
  matching ROADMAP's `csrf: { enabled: true }`. When CORS is enabled its `origin` defaults to an
  empty allowlist (deny all cross-origin) per §13.4.
- **Why:** Resolves conflict C1. Security headers are unconditionally safe and mandated on by
  §13.4; the other four need app context (CORS allowlist, CSRF trusted origins, a size budget,
  proxy-trust decision) to be meaningful, so opt-in avoids shipping a default that would be a no-op
  at best and a footgun at worst.
- **Test home:** `test/unit/http-security-plugin.test.ts` covers (a) default options → headers
  present, CORS/CSRF/size/IP inactive; (b) each opt-in block present → its concern active;
  (c) `enabled: false` on a present block → concern inactive.

### 3.3 CSRF — stateless Origin/Referer validation (no cookies)

- **Decision:** For unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`), the CSRF middleware reads
  the `Origin` header (falling back to `Referer`'s origin when `Origin` is absent), compares its
  scheme+host against a configured `trustedOrigins` allowlist, and short-circuits with **403** +
  JSON body when the value is missing unconfigured-deny behavior or does not match. Safe methods
  (`GET`, `HEAD`, `OPTIONS`) and requests with neither header when `trustedOrigins` is empty are
  passed through. An optional `customHeader` option additionally requires that header to be present
  on unsafe methods (a CSRF defense, since simple-form submits cannot set custom headers without a
  preflight). No cookie synchronizer token, no server-side token store.
- **Why:** `IRequest` has no cookie access (§1, conflict C3); the Origin/Referer check is the
  OWASP-recommended stateless CSRF defense and needs nothing beyond `request.headers`. The custom
  header adds defense-in-depth for API-style clients.
- **Test home:** `test/unit/csrf-middleware.test.ts` asserts: unsafe + allowed origin → `next()`
  called; unsafe + disallowed origin → 403 short-circuit (handler not run); unsafe + no origin
  (empty allowlist) → pass-through; safe method → pass-through; `customHeader` set + header absent
  → 403; `customHeader` set + header present → pass-through.

### 3.4 Request-size — Content-Length enforcement, 413 short-circuit

- **Decision:** The request-size middleware reads the request's `Content-Length` header; if it is
  present and exceeds `maxBodySize` (bytes), it short-circuits with **413 Payload Too Large** + JSON
  body without calling `next()` or reading the body. Requests with no `Content-Length` (or a value
  within the limit) pass through.
- **Why:** `IRequest` body accessors (`json/text/bytes`) fully buffer the body — there is no
  streaming hook in the contract, so the only pre-read size signal is `Content-Length`. Enforcing
  before any processing is the DoS value of the feature; consuming the body just to measure it would
  defeat that purpose.
- **Test home:** `test/unit/request-size-middleware.test.ts` asserts: `Content-Length` over limit →
  413 and `next()` not called; at/under limit → pass-through; absent `Content-Length` →
  pass-through; response body shape on 413.

### 3.5 IP security — resolve + publish client IP (no short-circuit)

- **Decision:** The IP-security middleware resolves the client IP and writes it to
  `ctx.state.set('clientIp', ip)`. Resolution: when `trustProxy` is `true` and `ipHeader` is set,
  read `ctx.request.headers.get(ipHeader)` and take the **leftmost** (first) address; otherwise use
  `ctx.request.ip` (which may be `undefined`). It never short-circuits.
- **Why:** `ctx.request.ip` is `readonly` (§1), so the resolved IP cannot be written back to the
  request; `ctx.state` is the committed cross-stage channel (§1, §10). The plugin resolves — it does
  not block; allow/deny policy is deferred (§9).
- **Test home:** `test/unit/ip-security-middleware.test.ts` asserts: `trustProxy` + `X-Forwarded-For:
  1.2.3.4, 10.0.0.1` → `state.get('clientIp') === '1.2.3.4'`; `trustProxy: false` → falls back to
  `request.ip`; missing header → `request.ip` fallback; `next()` always called.

### 3.6 CORS — origin matching + preflight short-circuit

- **Decision:** `origin` accepts `boolean` (`true` = reflect the request Origin, `false` = deny
  all), a single `string`, a `readonly string[]` allowlist, or `(origin, ctx) => string | boolean |
  Promise<…>`. On a match the middleware sets `Access-Control-Allow-Origin` (the specific origin,
  never `*` when `credentials: true`), appends the request Origin to `Vary`, and sets
  `Access-Control-Allow-Credentials: true` when `credentials: true`. An `OPTIONS` request carrying
  `Origin` + `Access-Control-Request-Method` is treated as a **preflight**: on an allowed origin it
  responds **204** with `Allow-Methods`/`Allow-Headers`/`Max-Age` (from options) and **short-circuits
  (no `next()`)**; on a disallowed origin it responds 204 with no CORS headers. Non-preflight
  requests with an allowed Origin get CORS headers added then call `next()`; requests with no
  `Origin` are not CORS requests and pass through untouched.
- **Why:** Standard CORS semantics; reflecting a specific origin (not `*`) is required when
  credentials are involved. Preflight must short-circuit so the route handler is never entered for a
  cross-origin preflight.
- **Test home:** `test/unit/cors-middleware.test.ts` covers each `origin` variant, credentials
  reflection, preflight 204 short-circuit (handler not run), disallowed-origin preflight (no CORS
  headers), and the no-Origin pass-through.

### 3.7 Security headers — set on response before `next()`, overwrite

- **Decision:** The middleware sets each configured header on `ctx.response` via `header(name,
  value)` **before** calling `next()`, so the value persists on the shared response builder through
  the handler and any short-circuit downstream. Configurable headers: `Content-Security-Policy`,
  `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`. The default set (applied when `headers` is omitted) is a conservative secure
  baseline. `header()` overwrites any prior value; a per-header `false`/`undefined` in the options
  omits that header from the default set.
- **Why:** Response headers set on the same `IResponse` survive downstream writes (the kernel
  serializes whatever is on `ctx.response`); setting them up front guarantees they are present even
  if a downstream guard short-circuits with its own body.
- **Test home:** `test/unit/security-headers-middleware.test.ts` asserts the exact default header
  set field-by-field, that a custom value overrides a default, that `enabled: false` omits all, and
  that headers are still present when `next()` short-circuits downstream.

### 3.8 Middleware execution priorities (per `ctx.middleware.add`)

- **Decision:** ip-security `120`, request-size `180`, cors `200`, security-headers `250`, csrf
  `270`. (Plugin registration priority is `PLUGIN_PRIORITY.NORMAL`; it only adds middleware, so its
  registration order relative to other plugins is not load-bearing.)
- **Why:** CORS `200` and headers `250` land in the reserved bands from `ARCHITECTURE.md` §10.
  Resolving the client IP early (`120`) makes `state.clientIp` available to every downstream stage;
  rejecting oversized bodies before CORS (`180`) saves work; CSRF after headers but before auth
  (`300`) keeps it in the security band.
- **Test home:** Asserted via the integration test by registering the plugin on a real app and
  confirming execution order through observable side effects (e.g. `clientIp` in state before the
  handler runs, 413 before CORS headers would be added).

### 3.9 Rejection response shape

- **Decision:** The 413 (request-size) and 403 (CSRF) short-circuits return a plain JSON body
  `ctx.response.status(code).json({ error: '<Reason>', message: '<text>' })`, matching the
  `rateLimitMiddleware` 429 body shape from M16b. The plugin does **not** depend on
  `@hono-enterprise/exceptions`' RFC 7807 formatter (a separate package); a consistent, dependency-
  free JSON error body keeps this plugin's zero-dependency invariant.
- **Why:** Dependency-free, consistent with the existing in-framework limiter, and unambiguous to
  test field-by-field (CLAUDE "spec-named output asserted field-by-field").
- **Test home:** `test/unit/request-size-middleware.test.ts` and `csrf-middleware.test.ts` assert the
  exact status + `{ error, message }` body.

## 4. Exported surface — every symbol names its consumer

| Exported symbol | Kind | Consumer / real code path that READS it |
| --------------- | ---- | --------------------------------------- |
| `HttpSecurityPlugin` | factory (`IPlugin`) | `app.register(HttpSecurityPlugin({...}))`; its `register()` adds the five middleware via `ctx.middleware.add`. |
| `corsMiddleware` | factory (`MiddlewareFunction`) | `HttpSecurityPlugin.register()` (global, priority 200); app code per-route `middleware: [corsMiddleware({...})]`; unit + integration tests. |
| `securityHeadersMiddleware` | factory (`MiddlewareFunction`) | `HttpSecurityPlugin.register()` (global, priority 250); per-route use; tests. |
| `csrfMiddleware` | factory (`MiddlewareFunction`) | `HttpSecurityPlugin.register()` (global, priority 270); per-route use; tests. |
| `requestSizeMiddleware` | factory (`MiddlewareFunction`) | `HttpSecurityPlugin.register()` (global, priority 180); per-route use; tests. |
| `ipSecurityMiddleware` | factory (`MiddlewareFunction`) | `HttpSecurityPlugin.register()` (global, priority 120); per-route use; tests. |
| `HttpSecurityPluginOptions` | type | Parameter of `HttpSecurityPlugin`; read by app authors and the plugin's option normalization. |
| `CorsOptions` | type | Parameter of `corsMiddleware`; read by `HttpSecurityPlugin` when `cors` is configured. |
| `SecurityHeadersOptions` | type | Parameter of `securityHeadersMiddleware`; read by `HttpSecurityPlugin` when `headers` is configured/omitted. |
| `CsrfOptions` | type | Parameter of `csrfMiddleware`; read by `HttpSecurityPlugin` when `csrf` is configured. |
| `RequestSizeOptions` | type | Parameter of `requestSizeMiddleware`; read by `HttpSecurityPlugin` when `requestSize` is configured. |
| `IpSecurityOptions` | type | Parameter of `ipSecurityMiddleware`; read by `HttpSecurityPlugin` when `ipSecurity` is configured. |
| `ContentSecurityPolicyOptions`, `StrictTransportSecurityOptions` | types | Fields of `SecurityHeadersOptions`; consumed by the headers middleware when those headers are configured. |

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation) |
| ------ | -------- | ----------------------------- |
| `HttpSecurityPluginOptions.cors?` | plugin `register()` → `corsMiddleware` | Presence enables CORS (priority 200). Absent → CORS inactive. |
| `HttpSecurityPluginOptions.headers?` | plugin `register()` → `securityHeadersMiddleware` | Omitted → default secure header set (priority 250). `{ enabled: false }` → off. Sub-fields override individual headers. |
| `HttpSecurityPluginOptions.csrf?` | plugin `register()` → `csrfMiddleware` | Presence enables CSRF (priority 270); `{ enabled: false }` → off. |
| `HttpSecurityPluginOptions.requestSize?` | plugin `register()` → `requestSizeMiddleware` | Presence enables size limiting (priority 180). |
| `HttpSecurityPluginOptions.ipSecurity?` | plugin `register()` → `ipSecurityMiddleware` | Presence enables IP resolution (priority 120). |
| `CorsOptions.origin` | `corsMiddleware` | `boolean \| string \| readonly string[] \| (origin, ctx) => …`; default empty allowlist (deny cross-origin). |
| `CorsOptions.credentials` | `corsMiddleware` | When `true`, emit `Access-Control-Allow-Credentials: true` and reflect a specific origin (never `*`). |
| `CorsOptions.methods` / `allowedHeaders` / `exposedHeaders` / `maxAge` | `corsMiddleware` | Preflight `Allow-Methods`/`Allow-Headers`, response `Access-Control-Expose-Headers`, preflight `Max-Age`. |
| `CsrfOptions.trustedOrigins` | `csrfMiddleware` | Allowlist of scheme+host values the Origin/Referer must match on unsafe methods. |
| `CsrfOptions.customHeader` | `csrfMiddleware` | When set, unsafe methods must carry this header or the request is rejected 403. |
| `RequestSizeOptions.maxBodySize` | `requestSizeMiddleware` | Byte ceiling compared against the `Content-Length` header; over → 413. |
| `IpSecurityOptions.trustProxy` | `ipSecurityMiddleware` | When `true`, read `ipHeader` instead of the socket `request.ip`. |
| `IpSecurityOptions.ipHeader` | `ipSecurityMiddleware` | Header name read (leftmost address) when `trustProxy` is `true`; default `X-Forwarded-For`. |
| `SecurityHeadersOptions.enabled` | `securityHeadersMiddleware` | `false` disables the default header set. |
| `SecurityHeadersOptions.contentSecurityPolicy` / `strictTransportSecurity` / `xFrameOptions` / `xContentTypeOptions` / `referrerPolicy` / `permissionsPolicy` | `securityHeadersMiddleware` | Per-header overrides; `false` omits that header from the default set. |

## 5. Implementation files

| File | Purpose |
| ---- | ------- |
| `src/index.ts` | Barrel: re-exports `HttpSecurityPlugin`, the five middleware factories, and all option types. Updated `PUBLIC_API.md` mirrors this exactly. |
| `src/plugin/http-security-plugin.ts` | Plugin factory: option normalization (default-on headers, opt-in others, `enabled` flags) and `register(ctx)` that adds each enabled concern via `ctx.middleware.add(fn, { priority, name })`. Owns `HttpSecurityPluginOptions`. |
| `src/middleware/cors-middleware.ts` | `corsMiddleware(options)` + `CorsOptions`. Origin matching (bool/string/array/fn), preflight 204 short-circuit, credentials handling, `Vary` append. |
| `src/middleware/security-headers-middleware.ts` | `securityHeadersMiddleware(options)` + `SecurityHeadersOptions` + `ContentSecurityPolicyOptions` + `StrictTransportSecurityOptions`. Default secure header set, per-header overrides, set before `next()`. |
| `src/middleware/csrf-middleware.ts` | `csrfMiddleware(options)` + `CsrfOptions`. Stateless Origin/Referer validation for unsafe methods + optional `customHeader`; 403 short-circuit. |
| `src/middleware/request-size-middleware.ts` | `requestSizeMiddleware(options)` + `RequestSizeOptions`. `Content-Length` check → 413 short-circuit. |
| `src/middleware/ip-security-middleware.ts` | `ipSecurityMiddleware(options)` + `IpSecurityOptions`. Resolve client IP (trustProxy/ipHeader leftmost, else `request.ip`) → `ctx.state.set('clientIp', ip)`. |
| `packages/http-security-plugin/README.md` | Package purpose, install, registration example, per-concern options, the no-token note. |
| `packages/http-security-plugin/deno.json` | Already a valid stub from M0 (matches cache-plugin shape); may add `"name"`/`"version"` only if missing. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Tests use `@std/testing/bdd` `describe`/`it` + `@std/expect` (never `Deno.test`). Unit tests drive
each middleware with a recording fake `IRequestContext`; the integration test drives a real kernel
app via `app.inject()`. Every src file has a named test file; the per-file 90% branch/function/line
bar is decided here.

| Test file | src covered | Key assertions (signatures type-checked against §1/§4) |
| --------- | ----------- | ------------------------------------------------------ |
| `test/unit/http-security-plugin.test.ts` | `src/plugin/http-security-plugin.ts` | Default options → only security-headers middleware active (observed via `inject()`); each opt-in block → its concern active; `enabled: false` on a present block → concern inactive; plugin `name === 'http-security-plugin'`, `version === '0.1.0'`, no `provides`; `register()` does not throw with empty options. |
| `test/unit/cors-middleware.test.ts` | `src/middleware/cors-middleware.ts` | Each `origin` variant (bool/string/array/fn) allow/deny; credentials reflection + no `*`; preflight (`OPTIONS`+`Origin`+`ACRM`) allowed → 204 + `Allow-*` headers and `next()` NOT called; preflight disallowed → 204 no CORS headers; no `Origin` → pass-through `next()` called; `Vary: Origin` appended. |
| `test/unit/security-headers-middleware.test.ts` | `src/middleware/security-headers-middleware.ts` | Default header set asserted field-by-field; custom value overrides default; per-header `false` omits it; `enabled: false` → none; headers persist when downstream short-circuits. |
| `test/unit/csrf-middleware.test.ts` | `src/middleware/csrf-middleware.ts` | Unsafe + allowed origin → pass; unsafe + disallowed → 403 `{error,message}` + handler not run; unsafe + no origin (empty allowlist) → pass; safe method → pass; `customHeader` absent on unsafe → 403; present → pass. |
| `test/unit/request-size-middleware.test.ts` | `src/middleware/request-size-middleware.ts` | `Content-Length` > `maxBodySize` → 413 `{error,message}` + `next()` not called; ≤ → pass; absent `Content-Length` → pass. |
| `test/unit/ip-security-middleware.test.ts` | `src/middleware/ip-security-middleware.ts` | `trustProxy` + `X-Forwarded-For: 1.2.3.4, 10.0.0.1` → `state.get('clientIp') === '1.2.3.4'`; `trustProxy:false` → `request.ip`; missing header → `request.ip`; `next()` always called. |
| `test/unit/barrel-exports.test.ts` | `src/index.ts` | Every intended export is present on the module namespace; no unintended runtime exports. |
| `test/integration/http-security-integration.test.ts` | cross-concern via real app | Drives `app.inject()` through `HttpSecurityPlugin({...all on...})`: oversized POST → 413 (handler not run); CSRF bad-origin POST → 403 (handler not run); CORS preflight → 204 (handler not run); a valid same-origin GET → 200 with security headers + `state.clientIp` populated. Proves short-circuits stop downstream stages (CLAUDE mandatory). |
| `test/fixtures/fake-request-context.ts` | (fixture, excluded from coverage) | Builds a recording `IRequestContext`: captures `response.status()`/`header()`/`appendHeader()` calls and the terminal body; supports `method`, `headers`, `ip`, `url`, `user`; `services` registry with `runtime` registered. Pattern follows `packages/decorator-plugin/test/fixtures/fake-request-context.ts` extended with `ip` + a recording response. |

**External dependencies:** none. Because the package has no `npm:` import, no guarded real-import
test is needed (the guarded-real-import rule applies only to external-dep code; this package has
none).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/17-http-security-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

End-of-task self-audit grep (must be empty, comments excepted):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/http-security-plugin/src
```

This package lives outside `packages/runtime`, so it must use no runtime-specific APIs and no
`Date.now()` (none of the concerns need a clock). With the gates green, flip the milestone: set the
`ROADMAP.md` "Progress Tracking" row 17 to `✅`, add the M17 entry to `CLAUDE.md` "Current status",
point "Next milestone" at 18, and (in the same PR) `git mv plans/milestone-17-http-security-plugin.md
plans/archive/`.

## 8. Risks & mitigations

- **Risk:** A client omits `Content-Length` and streams an oversized body; the request-size
  middleware cannot pre-limit a buffered body. **Mitigation:** Documented (§3.4); the middleware
  enforces on `Content-Length`, the only pre-read signal in the contract. Runtime-adapter-level
  streaming limits are out of scope (§9).
- **Risk:** Origin/Referer-based CSRF can be bypassed by an attacker who controls a subdomain or
  does not send the header on a same-site request. **Mitigation:** Documented limitation; the
  optional `customHeader` requirement adds defense-in-depth; a cookie synchronizer is deferred until
  `IRequest` gains cookie access (§9).
- **Risk:** `trustProxy: true` with a spoofable `X-Forwarded-For` could let a client forge the
  resolved IP. **Mitigation:** `trustProxy` defaults to off and is explicitly opt-in; leftmost-IP
  selection is the documented behavior; consumers must only enable it behind a trusted proxy (README
  warning).
- **Risk:** Default-on security headers could change an app's existing header behavior. **Mitigation:**
  `headers: { enabled: false }` disables the whole set and per-header `false` omits individual
  headers; documented in PUBLIC_API + README.
- **Risk:** Two concerns both writing `Vary`/response headers could conflict. **Mitigation:** CORS
  uses `appendHeader('Vary', 'Origin')` (additive); security headers use `header()` for their own
  distinct header names; no overlap by construction.

## 9. Out of scope

- **IP allow/deny lists and geo policy** — deferred; this milestone resolves and publishes the client
  IP only. Blocking policy is a later addition to this package (no milestone assigned yet).
- **Cookie / synchronizer-token CSRF** — deferred until `IRequest` exposes cookie access (a `common`
  contract change owned by a future milestone). M17 ships stateless Origin/Referer + custom-header
  CSRF only.
- **Streaming / chunked body size enforcement** — deferred; requires a streaming body seam on
  `IRequest` + runtime-adapter support (out of this package's contract).
- **Identity-layer security** (auth, rate limiting) — owned by `@hono-enterprise/auth-plugin`
  (M16/M16b).
- **Per-request OpenAPI documentation of the security middleware** — owned by a future OpenAPI
  milestone; this plugin contributes no schema.
