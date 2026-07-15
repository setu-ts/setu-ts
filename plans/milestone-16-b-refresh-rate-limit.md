# Milestone 16b — Auth Plugin: Refresh Tokens & Rate Limiting (`@hono-enterprise/auth-plugin`)

> **Status:** Planning. Branch: `feat/16b-refresh-rate-limit`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Tooling note (read before review).** This pass was produced in an Architect session with file
> tools only — no shell was available, so `git branch --show-current` and `deno task check:plan`
> could not be executed by the assistant. The plan was authored to satisfy
> [`scripts/plan-lint.ts`](scripts/plan-lint.ts) by construction: all nine required section headings
> present; no template placeholders; no undecided-alternative markers (the marker words appear only
> inside backticks, which the linter strips); only the one canonical plan file at `plans/` root (the
> filename uses `milestone-16-b-…` because the root-hygiene regex `/milestone-\d+-[a-z0-9.-]+/` does
> not span the letter `b`, matching the archived `milestone-14-b-messaging-brokers.md` precedent).
> The human reviewer must (1) confirm or create the branch per Step 0 below, and (2) run
> `deno task check:plan` and paste the output; any lint finding is fixed as a plan first.

## 0. Objective & scope

Milestone 16b delivers the two concerns the M16 plan deliberately deferred to the auth-plugin's
follow-up: **refresh tokens** (token rotation, revocation, and a refresh endpoint helper) and **rate
limiting** (a transport-level, fixed-window request limiter with memory and Redis storage). Both are
**pure additions** to the already-shipped [`@hono-enterprise/auth-plugin`](packages/auth-plugin/src/index.ts)
(M16, PR #35): no `@hono-enterprise/common` contract changes, no new capability tokens, and the
existing [`AuthPlugin`](packages/auth-plugin/src/plugin/auth-plugin.ts:42) factory, its `provides`
array, and its option shape are **untouched** (refresh is an app-instantiated service; rate limiting
is a standalone middleware independent of identity). This mirrors the M14 → M14b and M15 → M15b
follow-up splits the user already approved (see the archived
[`milestone-16-auth-plugin.md`](plans/archive/milestone-16-auth-plugin.md) §9).

Refresh tokens are JWTs minted through the existing [`IJwtService.sign({ expiresIn })`](packages/common/src/services/auth.ts:60)
(thin layer over `sign`, per [`ROADMAP.md:1992`](ROADMAP.md)) carrying a `type: 'refresh'` claim and
a random `jti`; a pluggable server-side store tracks each `jti` so the service can **rotate** (revoke
the presented refresh token, mint a fresh pair) and **revoke** (logout). Rate limiting is a
fixed-window counter exposed as a `MiddlewareFunction` factory (`rateLimitMiddleware`) backed by a
store interface with a memory implementation and a Redis implementation (lazy `npm:ioredis` import).
Rate limiting is treated as a concern **separate from identity** ([`ROADMAP.md:1998`](ROADMAP.md)):
it does not touch the principal and does not require `AuthPlugin` to be registered.

- **In scope:**
  - `RefreshTokenService` (exported, app-instantiated) — `issue` / `refresh` (rotation) / `revoke`
    over a pluggable store; refresh tokens are signed JWTs with `type: 'refresh'` + `jti`.
  - `RefreshTokenStore` interface + `MemoryRefreshTokenStore` (default backend).
  - `rateLimitMiddleware(options)` (exported middleware factory) — fixed-window counter, 429
    short-circuit with `Retry-After` and `RateLimit-*` headers, configurable key resolver.
  - `RateLimitStore` interface + `MemoryRateLimitStore` + `RedisRateLimitStore` (inject-or-lazy
    `npm:ioredis@5.x`, guarded real-import test).
  - New option/result types, barrel-export additions, and a `test.permissions` block in
    [`packages/auth-plugin/deno.json`](packages/auth-plugin/deno.json) so the guarded ioredis import
    test can run (mirroring [`packages/cache-plugin/deno.json`](packages/cache-plugin/deno.json)).
  - Per-file unit tests for every new `src/` file (90% bar), one guarded real-import test for the
    Redis store, one integration test, a new `fake-ioredis-client` fixture, and an updated
    `barrel-exports` test.
  - Same-PR doc deliverables: `PUBLIC_API.md` (refresh + rate-limit sections, de-deferred),
    `ROADMAP.md` (M16b deliverables checked, progress row flipped, stale line-315 comment fixed),
    `ARCHITECTURE.md` (auth row: refresh + rate-limit now shipped in M16b), and the package
    `README.md` (refresh + rate-limit usage).

- **NOT this milestone:**
  - A **Redis refresh-token store** — deferred (the `RefreshTokenStore` interface is pluggable so a
    Redis backend is a later drop-in; see §9).
  - Refresh-token **family / reuse-detection cascade** (revoking an entire token family on reuse) —
    deferred; M16b revokes the single presented `jti` and rejects reuse of a revoked `jti` (§3.2, §9).
  - Rate limiting as a **standalone `RateLimitPlugin` plugin factory** registered under a
    `'rate-limit'` capability token — realized instead as a decoupled middleware factory; a
    token/service would need a common change and has no cross-plugin consumer in M16b (§3.7, §9).
  - A **sliding-window** rate-limit algorithm — fixed-window ships; sliding window is a later option (§9).
  - `@hono-enterprise/common` contract changes of any kind — none required (§3.7).
  - OAuth2/OIDC, SAML, session/cookie stores, MFA, passkeys — never in the M16 lineage; future work.

## 1. Contracts verified from SOURCE (not names)

Every reference below was opened in the committed source and cited at file:line. The committed
contract is the truth, not the aspirational docs (§2).

| Reference | Source (file:line) | Verified surface / fact |
| --- | --- | --- |
| `IJwtService` (refresh mints via `sign`) | [`packages/common/src/services/auth.ts:52`](packages/common/src/services/auth.ts) | Exactly `sign(payload, options?): Promise<string>` (:60), `verify<T>(token): Promise<T>` (:69), `decode<T>(token): T \| null` (:78). No `signRefresh`. Refresh tokens are `sign({ sub, type:'refresh', jti }, { expiresIn })`; `refresh()` calls `verify` then `sign` again. The `type`/`jti` claims are plain payload fields — no contract change. |
| `JwtSignOptions` | [`packages/common/src/services/auth.ts:32`](packages/common/src/services/auth.ts) | Only `expiresIn?` (:34), `audience?` (:36), `issuer?` (:38). Refresh uses `expiresIn` for the refresh-token lifetime and (when configured) `audience`/`issuer` so `verify` enforces them. |
| `IAuthService` has no refresh surface | [`packages/common/src/services/auth.ts:128`](packages/common/src/services/auth.ts) | Only `authenticate(request)` (:135) and `verifyCredentials({ identifier, secret })` (:142). There is **no** `refresh`/`revoke`/`issue` method — so refresh is NOT added to this committed interface. M16b keeps `RefreshTokenService` as a package-exported class (no common change), reached directly by the app's login/refresh/logout handlers. |
| `IAuthStrategy` is passive header-only | [`packages/common/src/services/auth.ts:110`](packages/common/src/services/auth.ts) | `{ readonly name; authenticate(request: IRequest): Promise<IPrincipal \| null> }` (:119). A refresh token arrives in the request **body** at a dedicated endpoint, not as a passive header credential, so a refresh flow is NOT an `IAuthStrategy`. This forces the §2 C2 resolution: ship `RefreshTokenService`, not a `RefreshTokenStrategy`. |
| `IPrincipal` | [`packages/common/src/services/auth.ts:16`](packages/common/src/services/auth.ts) | `id` (:18), `roles?` (:20), `permissions?` (:22), `claims?` (:24). `RefreshTokenService.issue` snapshots the whole principal into the store record so `refresh` can re-mint an access token without re-querying the app. |
| `CAPABILITIES` (no refresh/rate-limit token) | [`packages/common/src/tokens.ts:39`](packages/common/src/tokens.ts) | `AUTH:'authentication'` (:57), `AUTHORIZATION:'authorization'` (:59), `JWT:'jwt'` (:61). There is **no** rate-limit token and **no** refresh token. Adding one would be a common change; M16b adds neither (§3.7). `createCapabilityToken` (:139) enforces lowercase-kebab + dot namespacing — unused here. |
| `IRequest` (rate-limit key + headers) | [`packages/common/src/http.ts:32`](packages/common/src/http.ts) | `readonly headers: Headers` (:40), `readonly ip?: string` (:42), `user?: IPrincipal` (:47). Rate limiting keys on `request.ip` by default (fallback `'anonymous'`); an authenticated key resolver may read `request.user?.id`. The body is read only on refresh routes, never by the limiter. |
| `IResponse` (429 + headers) | [`packages/common/src/http.ts:83`](packages/common/src/http.ts) | `status(code): IResponse` (:90), `header(name, value): IResponse` overwrite (:98), `json<T>(body): HandlerResult` (:118), `appendHeader` (:110). The limiter emits `429` + `Retry-After` + `RateLimit-*` via `header()` and short-circuits by returning `json(...)` without `next()` (§3.5). |
| `MiddlewareFunction` / short-circuit mandate | [`packages/common/src/http.ts:205`](packages/common/src/http.ts) | `(ctx, next) => void \| HandlerResult \| Promise<…>`. Returning a `HandlerResult` without calling `next()` short-circuits (:182-187). The rate-limit 429 path MUST short-circuit and be proven so by a downstream-not-invoked test (CLAUDE.md short-circuit mandate). |
| `IRuntimeServices` (clock + random) | [`packages/common/src/runtime.ts:106`](packages/common/src/runtime.ts) | `randomBytes(length): Uint8Array` (:138), `uuid(): string` (:131), `subtle` (:140), `now(): number` wall-clock epoch ms (:147), `hrtime()` monotonic (:154). The refresh `jti` is `randomBytes`; all window/expiry math uses `now()` — no `Date.now()` in `src/` (CLAUDE.md "Never mix clocks"). |
| `IPluginContext` / `IPlugin` | [`packages/common/src/plugin.ts:376`](packages/common/src/plugin.ts) | `services` (:378), `middleware` (:380), `lifecycle` (:396), `runtime` (:402). `IPlugin` (:437): `name`/`version`/`provides?`/`register(ctx)`. The middleware resolves `IRuntimeServices` via `ctx.services.get(CAPABILITIES.RUNTIME)` at request time (the "communicate via tokens" rule). AuthPlugin's `register`/`provides` are unchanged (§3.7). |
| Redis inject-or-lazy precedent | [`packages/cache-plugin/src/stores/redis-store.ts:18`](packages/cache-plugin/src/stores/redis-store.ts) | `await import('npm:ioredis@5.x')` (:18-21); `resolveClient` prefers an injected client, otherwise lazy-loads (:52-67); `validateClient` checks the exact structural methods (:30-41). `RedisRateLimitStore` follows this exact seam (injected client, otherwise lazy `npm:ioredis@5.x`) with its own minimal structural interface (`incr`/`pexpire`/`pttl`/`del`/`quit`) and a guarded real-import test. |
| `ioredis` resolved version | [`deno.lock:20`](deno.lock) | `"npm:ioredis@5": "5.11.1"` (:20; package record :124). The lazy specifier is `npm:ioredis@5.x` (matches the cache/messaging precedent); `deno.lock` resolves it to 5.11.1. No entry is added to any `imports` map — the dynamic specifier is the dependency. |
| test.permissions precedent | [`packages/cache-plugin/deno.json:5`](packages/cache-plugin/deno.json) | `{ "test": { "permissions": { "read": true, "import": true, "env": true, "sys": ["hostname"] } } }`. The auth-plugin [`deno.json`](packages/auth-plugin/deno.json) lacks this block; M16b adds it so the guarded `import('npm:ioredis@5.x')` test can run (named deliverable, §5). |
| ROADMAP M16b scope | [`ROADMAP.md:1990`](ROADMAP.md) | "Refresh Tokens & Rate Limiting (deferred)": `RefreshTokenStrategy` over `sign({ expiresIn })` + pluggable store + refresh-endpoint helper (:1996-1997); rate limiting `src/middleware/rate-limit-middleware.ts` + memory/redis storage, "separate capability rather than identity" (:1998-1999); "No common contract change is required" (:1992-1994). |
| ROADMAP M17 does NOT include rate limiting | [`ROADMAP.md:2003`](ROADMAP.md) | M17 (`http-security-plugin`) deliverables (:2053-2055) and implementation files (:2035-2041) list CORS, headers, CSRF, request-size, ip-security — **no** rate-limit file. The stale line-315 comment ("rate limit" under http-security-plugin) is the only M17 reference; §2 C1 corrects it. |
| PUBLIC_API Auth + RateLimitPlugin example | [`PUBLIC_API.md:814`](PUBLIC_API.md) / [`:2598`](PUBLIC_API.md) | Auth section phasing note (:827-829) says refresh + rate-limit are deferred to M16b and a refresh token is "simply `sign({ expiresIn: '7d' })`". The "Basic Plugin" example (:2598-2638) sketches a standalone `RateLimitPlugin` registering a `'rate-limit'` service — illustrative of how to write a plugin, realized in M16b as the decoupled `rateLimitMiddleware` (no token). Reconciled in §2 C3/C4. |
| ARCHITECTURE auth row | [`ARCHITECTURE.md:1237`](ARCHITECTURE.md) | "Refresh-token strategy + rate limiting → M16b" (:1238); auth strategies list "Refresh Token — Issue new access tokens (M16b, deferred)" (:1970). Both become "shipped in M16b" in the same-PR doc edit. |
| Existing auth-plugin barrel + options | [`packages/auth-plugin/src/index.ts:28`](packages/auth-plugin/src/index.ts) | Current exports (factory, option types, `PasswordHasher`, `authMiddleware`, six guards, common re-exports). M16b ADDS refresh + rate-limit symbols here; nothing is removed. `AuthPluginOptions` ([`interfaces/index.ts:66`](packages/auth-plugin/src/interfaces/index.ts)) gains no `refresh`/`rateLimit` field (§3.7). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| # | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| --- | --- | --- | --- |
| C1 | Rate-limit **ownership** is stated three ways. [`ROADMAP.md:315`](ROADMAP.md) lists "rate limit" under `http-security-plugin`; [`PUBLIC_API.md:2598`](PUBLIC_API.md) sketches a standalone `RateLimitPlugin`; but the M16b section ([`ROADMAP.md:1998`](ROADMAP.md)) explicitly assigns rate limiting to the auth-plugin (`src/middleware/rate-limit-middleware.ts` + memory/redis storage), and M17's actual deliverables ([`ROADMAP.md:2053`](ROADMAP.md)) contain **no** rate-limit file. | **M16b owns rate limiting in the auth-plugin** (matches the M16 deferral and the M16b ROADMAP section). It ships as the decoupled `rateLimitMiddleware` + memory/Redis stores — independent of `AuthPlugin` and of M17. The line-315 comment is corrected to remove "rate limit" from the http-security-plugin blurb; M17 is unchanged. | `ROADMAP.md` line-315 comment fix + M16b sub-section kept authoritative; `PUBLIC_API.md` note (§C3/C4) (same PR). |
| C2 | "Refresh token **strategy**" naming. [`ROADMAP.md:1996`](ROADMAP.md), [`ARCHITECTURE.md:1970`](ARCHITECTURE.md), and the archived M16 plan all call it `RefreshTokenStrategy`; the committed [`IAuthStrategy`](packages/common/src/services/auth.ts:110) is a **passive header extractor** whose `authenticate(request)` returns a principal or `null`. A refresh token is submitted in the request body at a dedicated endpoint, not extracted passively, so it cannot be an `IAuthStrategy`. | Ship **`RefreshTokenService`** (exported class), not a strategy implementing `IAuthStrategy`. The service exposes `issue` / `refresh` / `revoke` and is reached directly by the app's login/refresh/logout route handlers (like the exported [`PasswordHasher`](packages/auth-plugin/src/services/password-hasher.ts) utility). Reconcile `ROADMAP.md`/`ARCHITECTURE.md`/`PUBLIC_API.md`/`README.md` from `RefreshTokenStrategy` → `RefreshTokenService`. | `ROADMAP.md` + `ARCHITECTURE.md` + `PUBLIC_API.md` + `README.md` rename (same PR). |
| C3 | The PUBLIC_API "Basic Plugin" example ([`PUBLIC_API.md:2598`](PUBLIC_API.md)) realizes rate limiting as a `RateLimitPlugin` that registers a `'rate-limit'` service via `ctx.middleware.add`, `ctx.health.register`, `ctx.cli.register`. That example is illustrative of plugin shape; committing to a `'rate-limit'` capability token + service would be a common change and the service has no cross-plugin consumer in M16b. | Rate limiting ships as the **decoupled `rateLimitMiddleware(options)` factory** (added via `app.middleware.add(rateLimitMiddleware({...}))`, the same convention as [`authMiddleware`](packages/auth-plugin/src/middleware/auth-middleware.ts)), with NO registered service and NO capability token. This honors ROADMAP's "separate capability rather than identity" as "separate from identity / decoupled," not "registered under a token." A registered `RateLimitPlugin` + token remains a possible future milestone (§9). | `PUBLIC_API.md` rate-limit section (factory + stores, no token) (same PR). |
| C4 | Refresh **storage backend**: [`ROADMAP.md:1996`](ROADMAP.md) says "pluggable server-side token store" (no backend named), while the rate-limit bullet ([`:1998`](ROADMAP.md)) explicitly says "memory/redis storage." A reader could expect a Redis refresh store too. | Rate limiting ships **memory + Redis** (ROADMAP-explicit); refresh ships **memory + a pluggable `RefreshTokenStore` interface** and a `RedisRefreshTokenStore` is deferred (§9). Defensible because refresh says "pluggable store" with no named backend; the interface makes a later Redis drop-in trivial. | `ROADMAP.md` M16b sub-section + `PUBLIC_API.md` refresh section note (Redis refresh store deferred) (same PR). |
| C5 | The M16 plan's exported-surface table ([`milestone-16-auth-plugin.md`](plans/archive/milestone-16-auth-plugin.md) §4) deliberately states there is "no `rateLimit` option … no `refresh` option" on `AuthPlugin`. A reader might assume M16b wires refresh/rate-limit INTO `AuthPlugin({ ... })`. | `AuthPlugin`'s option shape, `provides` array, and `register()` are **unchanged**. Refresh is app-instantiated (`new RefreshTokenService({ jwt, store, runtime })`); rate limiting is a standalone middleware. M16b is pure addition (new files + barrel exports + `deno.json` test.permissions) — it does not touch the shipped, tested [`auth-plugin.ts`](packages/auth-plugin/src/plugin/auth-plugin.ts:42). This is stated explicitly so no implementer adds a `refresh`/`rateLimit` option to `AuthPluginOptions`. | `PUBLIC_API.md` registration section note (refresh + rate-limit are standalone, not AuthPlugin options) (same PR). |

No other committed-doc conflicts were found (checked the ARCHITECTURE middleware-priority table and
auth flow narrative — consistent with the design once C1/C2 are reconciled).

## 3. Design decisions

### 3.1 Refresh token = signed JWT (`sign({ expiresIn })`) with `type: 'refresh'` + `jti`, plus a server store

- **Decision:** `RefreshTokenService` (exported, app-instantiated via `new RefreshTokenService(options)`,
  where `options: { jwt: IJwtService; store: RefreshTokenStore; runtime: IRuntimeServices; accessToken?: { expiresIn?; audience?; issuer? }; refreshTokenExpiresIn?: string }`,
  default `refreshTokenExpiresIn: '7d'`). `issue(principal)` mints `accessToken = jwt.sign({ sub, roles, permissions, claims }, accessToken-opts)`
  and `refreshToken = jwt.sign({ sub: principal.id, type: 'refresh', jti }, { expiresIn: refreshTokenExpiresIn, audience?, issuer? })`,
  where `jti = encodeBase64Url(runtime.randomBytes(16))`; it stores a record keyed by `jti` holding
  the principal snapshot and an `expiresAt` (derived from `refreshTokenExpiresIn` via the existing
  [`parseDuration`](packages/auth-plugin/src/utils/duration.ts) helper, plus `runtime.now()`). The
  refresh token IS a JWT, so its signature and `exp` are enforced by [`jwt.verify`](packages/common/src/services/auth.ts:69)
  — the store only adds rotation + revocation. No `jose`/`jsonwebtoken`; no common change.
- **Why:** "thin layer over `sign({ expiresIn })`" ([`ROADMAP.md:1994`](ROADMAP.md)) + "pluggable
  server-side token store" ([`:1996`](ROADMAP.md)) — a signed refresh JWT with a tracked `jti`
  satisfies both: the JWT is self-verifying, the store enables rotation and explicit logout. Reusing
  the shipped [`JwtService`](packages/auth-plugin/src/services/jwt-service.ts:29) keeps zero new
  crypto and one signing path.
- **Test home:** `test/unit/refresh-token-service.test.ts` — `issue` returns a pair whose refresh
  token `verify`s with `type:'refresh'` and a `jti`; `refresh` on a valid token returns a NEW pair
  and rotates (the old `jti` is revoked — a second `refresh` with the old token returns `null`);
  `refresh` on an expired/tampered token returns `null` (verify rejects); `refresh` on a revoked
  token returns `null`; `revoke` removes the token; access-token claims round-trip.

### 3.2 Refresh rotation + revocation semantics (single-token, no family cascade)

- **Decision:** `refresh(refreshToken): Promise<TokenPair | null>` runs `jwt.verify` (signature +
  `exp` + configured `aud`/`iss`), reads `payload.type === 'refresh'` and `payload.jti`, looks the
  `jti` up in the store; if the record is missing or `revoked`, it returns `null` (a reused /
  post-rotation refresh token is rejected). Otherwise it **revokes the presented `jti`** (rotation)
  and issues a fresh access + refresh pair from the stored principal snapshot. `revoke(refreshToken): Promise<boolean>`
  verifies the JWT, revokes its `jti`, and returns whether a live record was removed. **Token-family
  / reuse-cascade** revocation (invalidating an entire family when one rotated member is replayed) is
  explicitly out of scope (§9); reuse of a revoked `jti` returning `null` is the M16b guarantee.
- **Why:** Rotation defeats refresh-token replay for the common case while staying simple and fully
  testable against in-memory state. Full family tracking adds a `familyId` graph with no M16b
  consumer and is deferred rather than half-built (CLAUDE.md "no half-built features").
- **Test home:** `test/unit/refresh-token-service.test.ts` — rotation invalidates the old token;
  replaying a rotated token yields `null`; `revoke` then `refresh` yields `null`; concurrent double
  `refresh` of one token: first wins, second yields `null` (memory store resolves serially in tests).

### 3.3 Refresh store port + memory implementation (Redis deferred)

- **Decision:** A package-exported interface
  `RefreshTokenStore { save(record: RefreshTokenRecord): Promise<void>; get(jti: string): Promise<RefreshTokenRecord | null>; revoke(jti: string): Promise<void> }`
  (in `src/stores/refresh-token-store.ts`), where `RefreshTokenRecord { jti; principalId; principal: IPrincipal; expiresAt: number; revoked: boolean }`.
  `MemoryRefreshTokenStore` (`src/stores/memory-refresh-token-store.ts`) holds a `Map<jti, record>`,
  lazily expiring entries on `get` (when `runtime.now() >= expiresAt` it deletes and returns `null`)
  so the map does not grow without bound. The interface is exported so a `RedisRefreshTokenStore` can
  be dropped in later without touching `RefreshTokenService`.
- **Why:** ROADMAP calls the store "pluggable"; an interface + default memory backend gives rotation
  and revocation now, keeps the service backend-agnostic, and bounds memory via lazy expiry.
- **Test home:** `test/unit/memory-refresh-token-store.test.ts` — `save` then `get` returns the
  record; `revoke` makes `get` return `null`; an expired record is evicted on `get` (drive `runtime.now()`
  forward via the fake runtime's `setNow`); missing `jti` → `null`.

### 3.4 Rate limiting = standalone fixed-window middleware factory, store-backed

- **Decision:** `rateLimitMiddleware(options): MiddlewareFunction` (exported), options
  `{ windowMs: number; max: number; store?: RateLimitStore; keyGenerator?: (ctx) => string; message?: string; standardHeaders?: boolean }`
  (`standardHeaders` defaults `true`). When `store` is omitted the middleware lazily builds a
  `MemoryRateLimitStore` from the `IRuntimeServices` it resolves via `ctx.services.get(CAPABILITIES.RUNTIME)`
  on the first request (memoized, so it is built once per app — not per request). The default
  `keyGenerator` returns `ctx.request.ip ?? 'anonymous'`. On each request it calls
  `store.increment(key, windowMs) → { count, resetTime }`; if `count > max` it short-circuits with
  `ctx.response.status(429).header('Retry-After', ...).header('RateLimit-*', ...).json({ error, message })`
  and does NOT call `next()`; otherwise it sets the `RateLimit-*` headers and `await next()`.
- **Why:** A factory matching [`authMiddleware`](packages/auth-plugin/src/middleware/auth-middleware.ts)
  is the auth-plugin convention (added via `app.middleware.add(...)`). Fixed-window is the simplest
  correct algorithm and is fully deterministic against a memory store or an injected fake. The limiter
  is independent of `AuthPlugin` (rate limiting is transport-level, "separate from identity",
  [`ROADMAP.md:1998`](ROADMAP.md)).
- **Test home:** `test/unit/rate-limit-middleware.test.ts` — under-limit request calls `next` and sets
  headers; the `max+1`-th request returns 429, sets `Retry-After`/`RateLimit-*`, and a downstream spy
  is NOT invoked (short-circuit mandate); a custom `keyGenerator` isolates callers; the default memory
  store path is exercised when no `store` is supplied; `standardHeaders: false` omits the headers.

### 3.5 Rate-limit 429 response shape, headers, and the short-circuit mandate

- **Decision:** The over-limit response is `429 Too Many Requests` with header
  `Retry-After: <ceil((resetTime - now)/1000)>` and, when `standardHeaders` is on,
  `RateLimit-Limit: <max>`, `RateLimit-Remaining: 0`, `RateLimit-Reset: <ceil(resetTime/1000)>`
  (the IETF draft header names), and a JSON body `{ error: 'Too Many Requests', message: options.message ?? 'Rate limit exceeded' }`.
  `now`/`resetTime` come from `runtime.now()` (never `Date.now()`). The middleware returns the
  `HandlerResult` from `ctx.response.json(...)` WITHOUT calling `next()`, so downstream middleware and
  the handler do not run and cannot overwrite the 429.
- **Why:** `Retry-After` is the standard client backoff signal; `RateLimit-*` headers are
  interoperable and cheap. Short-circuiting is the CLAUDE.md-mandated behavior for any stage that
  responds without continuing.
- **Test home:** `test/unit/rate-limit-middleware.test.ts` asserts the exact 429 status, the three
  `RateLimit-*` header values, a positive `Retry-After`, the JSON body shape, AND that a downstream
  spy registered after the limiter has zero invocations on the over-limit request.

### 3.6 Rate-limit stores: memory + Redis (inject-or-lazy, guarded real-import)

- **Decision:** Package-exported interface
  `RateLimitStore { increment(key: string, windowMs: number): Promise<RateLimitResult>; reset(key: string): Promise<void> }`,
  `RateLimitResult { count: number; resetTime: number }` (in `src/stores/rate-limit-store.ts`).
  `MemoryRateLimitStore(runtime)` keeps a `Map<key, { count; windowStart }>` and resets the window
  when `runtime.now() >= windowStart + windowMs`. `RedisRateLimitStore` (in
  `src/stores/redis-rate-limit-store.ts`) follows the cache
  [`RedisStore`](packages/cache-plugin/src/stores/redis-store.ts:78) seam exactly: prefer an injected
  client, otherwise lazy `await import('npm:ioredis@5.x')`; it implements the fixed window with
  `INCR` (create-or-increment) + `PEXPIRE` on first increment + `PTTL` for `resetTime`, against a
  minimal structural `IRateLimitRedisClient { incr; pexpire; pttl; del; quit }` validated by a
  `validateClient`-style guard. `reset(key)` is `DEL`. It needs no `runtime` (Redis owns the TTL).
- **Why:** ROADMAP requires "memory/redis storage" ([`:1998`](ROADMAP.md)); the inject-or-lazy seam
  keeps ioredis an optional, real dependency (never a `globalThis.__` shim — CLAUDE.md "A lazily-loaded
  optional dep must ACTUALLY load"), and the structural interface lets a fake client unit-test every
  branch while one guarded test exercises the real `npm:ioredis@5.x` import (resolves to 5.11.1,
  [`deno.lock:20`](deno.lock)).
- **Test home:** `test/unit/memory-rate-limit-store.test.ts` (window reset on time advance; counts;
  `reset`); `test/unit/redis-rate-limit-store.test.ts` (injected-fake-client path: first increment
  calls `INCR` + `PEXPIRE`; subsequent increments skip `PEXPIRE`; `PTTL` drives `resetTime`; `reset`
  calls `DEL`; `quit` on `disconnect`; injected-client shape validation rejects a bad client; AND one
  guarded test that does `await import('npm:ioredis@5.x')` and asserts it resolves, skipped when the
  package is absent — per the CLAUDE.md real-import mandate).

### 3.7 No `@hono-enterprise/common` change; `AuthPlugin` registration untouched

- **Decision:** M16b adds **no** type/token/interface to `common` and **no** field to
  [`AuthPluginOptions`](packages/auth-plugin/src/interfaces/index.ts:66). `RefreshTokenService` is an
  exported class the app constructs (paralleling [`PasswordHasher`](packages/auth-plugin/src/services/password-hasher.ts));
  `rateLimitMiddleware` is an exported factory. `AuthPlugin.register` and its `provides: [jwt, authentication, authorization]`
  ([`auth-plugin.ts:55`](packages/auth-plugin/src/plugin/auth-plugin.ts)) are not edited, so the M16
  tested surface is untouched and there is no new capability token for the kernel resolver to dedupe.
- **Why:** Both features are reachable without a resolved-by-token service (refresh holds the
  injected `IJwtService`; the limiter owns its store). Adding tokens would be a common change with no
  cross-plugin consumer — dead surface (CLAUDE.md "every symbol must be read on a real code path").
- **Test home:** `test/unit/barrel-exports.test.ts` (updated) asserts the new symbols ARE exported and
  that no new capability-token constant exists; `test/unit/auth-plugin.test.ts` (unchanged) still
  passes — confirming `AuthPlugin`'s `provides`/`register` are unmodified.

### 3.8 `exactOptionalPropertyTypes` discipline in option objects

- **Decision:** All new option objects are built by assigning only defined values (the pattern
  [`auth-plugin.ts:74-88`](packages/auth-plugin/src/plugin/auth-plugin.ts) already uses to satisfy
  [`exactOptionalPropertyTypes`](deno.json)); optional fields are omitted, never set to `undefined`.
- **Why:** The repo turns this flag on and lint fails on `undefined`-assigned optional properties.
- **Test home:** covered by compilation (`deno task check`) across the new files; the unit tests
  construct services/middleware with a mix of omitted and supplied optional fields.

## 4. Exported surface — every symbol names its consumer

| Exported symbol | Kind | Consumer / real code path that READS it |
| --- | --- | --- |
| `RefreshTokenService` | class | App login/refresh/logout route handlers: `new RefreshTokenService({ jwt, store, runtime })`, then `issue` / `refresh` / `revoke`. |
| `RefreshTokenOptions` | type | The `RefreshTokenService` constructor parameter; user-typed config. |
| `TokenPair` | type | Return type of `RefreshTokenService.issue` / `refresh`; consumed by handlers that return `{ accessToken, refreshToken }`. |
| `RefreshTokenStore` | interface | App authors implementing a custom backend (e.g. a future `RedisRefreshTokenStore`); passed as `RefreshTokenOptions.store`. |
| `RefreshTokenRecord` | type | The record shape `RefreshTokenStore` implementers produce/consume; referenced by custom-store implementations. |
| `MemoryRefreshTokenStore` | class | Default `RefreshTokenOptions.store` backend passed to `RefreshTokenService`. |
| `rateLimitMiddleware` | fn | `app.middleware.add(rateLimitMiddleware({ windowMs, max }))` — global/per-route rate limiting, independent of `AuthPlugin`. |
| `RateLimitOptions` | type | The `rateLimitMiddleware(options)` parameter. |
| `RateLimitResult` | type | The `RateLimitStore.increment` return shape; read by `rateLimitMiddleware` to set headers and decide 429. |
| `RateLimitStore` | interface | Custom-store implementers; passed as `RateLimitOptions.store`. |
| `MemoryRateLimitStore` | class | Default store built by `rateLimitMiddleware` when `store` is omitted, and directly injectable. |
| `RedisRateLimitStore` | class | `rateLimitMiddleware({ store: new RedisRateLimitStore({ url }) })` for multi-instance deployments. |

**Intentionally not exported** (internal): the lazy `loadIoredis` helper, the `IRateLimitRedisClient`
structural interface and its `validateClient` guard (consumed only by `RedisRateLimitStore`), and the
rate-limit/refresh internal helper functions. The new symbols are additions only; all existing M16
exports ([`index.ts:28-60`](packages/auth-plugin/src/index.ts)) remain unchanged.

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation) |
| --- | --- | --- |
| `RefreshTokenOptions.jwt` | `RefreshTokenService` | The resolved `IJwtService`; used to sign/verify both access and refresh tokens. |
| `RefreshTokenOptions.store` | `RefreshTokenService` | `RefreshTokenStore` backend for rotation/revocation. |
| `RefreshTokenOptions.runtime` | `RefreshTokenService` / `MemoryRefreshTokenStore` | `IRuntimeServices` for `randomBytes` (`jti`) and `now()` (expiry math). |
| `RefreshTokenOptions.accessToken.expiresIn`/`audience`/`issuer` | `RefreshTokenService.issue` | Passed to `jwt.sign` for the access token; defaults to a short lifetime. |
| `RefreshTokenOptions.refreshTokenExpiresIn` | `RefreshTokenService.issue` | Refresh-token lifetime (default `'7d'`); also sets the record `expiresAt`. |
| `RateLimitOptions.windowMs` | `RateLimitStore.increment` / middleware | Fixed-window length in ms. |
| `RateLimitOptions.max` | `rateLimitMiddleware` | Max requests per window per key; `count > max` triggers 429. |
| `RateLimitOptions.store` | `rateLimitMiddleware` | Optional `RateLimitStore`; defaults to a memoized `MemoryRateLimitStore(runtime)`. |
| `RateLimitOptions.keyGenerator` | `rateLimitMiddleware` | `(ctx) => string`; default `ctx.request.ip ?? 'anonymous'`. |
| `RateLimitOptions.message` | `rateLimitMiddleware` (429 body) | Custom message; default `'Rate limit exceeded'`. |
| `RateLimitOptions.standardHeaders` | `rateLimitMiddleware` | Emit `RateLimit-*` headers (default `true`); when `false`, only `Retry-After` is set. |
| `RedisRateLimitStore` ctor `url` / `client` | `RedisRateLimitStore` | Redis URL (default `redis://localhost:6379`) or an injected ioredis-compatible client (bypasses the lazy import). |

No option is declared without a reader. There is deliberately **no** `refresh`/`rateLimit` field on
`AuthPluginOptions` (§3.7), **no** new capability token, and **no** `name` option.

## 5. Implementation files

| File | Purpose |
| --- | --- |
| `packages/auth-plugin/src/services/refresh-token-service.ts` | `RefreshTokenService` — `issue` / `refresh` (rotation) / `revoke` over a `RefreshTokenStore`, minting refresh JWTs via the injected `IJwtService`. Exported. |
| `packages/auth-plugin/src/stores/refresh-token-store.ts` | `RefreshTokenStore` interface + `RefreshTokenRecord` + `TokenPair` types. Interface-only; covered by impl + compilation. Exported. |
| `packages/auth-plugin/src/stores/memory-refresh-token-store.ts` | `MemoryRefreshTokenStore implements RefreshTokenStore` — `Map`-backed with lazy expiry via `runtime.now()`. Exported. |
| `packages/auth-plugin/src/stores/rate-limit-store.ts` | `RateLimitStore` interface + `RateLimitResult` type. Interface-only; covered by impl + compilation. Exported. |
| `packages/auth-plugin/src/stores/memory-rate-limit-store.ts` | `MemoryRateLimitStore implements RateLimitStore` — fixed-window counter keyed by `runtime.now()`. Exported. |
| `packages/auth-plugin/src/stores/redis-rate-limit-store.ts` | `RedisRateLimitStore implements RateLimitStore` — inject-or-lazy `npm:ioredis@5.x`, `INCR`+`PEXPIRE`+`PTTL` window, structural `IRateLimitRedisClient` + `validateClient` guard. Exported. |
| `packages/auth-plugin/src/middleware/rate-limit-middleware.ts` | `rateLimitMiddleware(options): MiddlewareFunction` — fixed-window limiter, 429 short-circuit + `Retry-After` + `RateLimit-*`, default memory store, configurable key. (Path matches [`ROADMAP.md:1998`](ROADMAP.md).) Exported. |
| `packages/auth-plugin/src/interfaces/index.ts` | EXTEND with the new option/result/store re-exports (`RefreshTokenOptions`, `RateLimitOptions`, `RateLimitResult`, `RefreshTokenStore`, `RefreshTokenRecord`, `RateLimitStore`, `TokenPair`). Types only; no runtime branches; no change to `AuthPluginOptions`. |
| `packages/auth-plugin/src/index.ts` | EXTEND the barrel: export `RefreshTokenService`, `MemoryRefreshTokenStore`, `rateLimitMiddleware`, `MemoryRateLimitStore`, `RedisRateLimitStore`, and the option/result/store types. Existing exports untouched. |
| `packages/auth-plugin/deno.json` | Add the `test.permissions` block (`read`, `import`, `env`, `sys: ["hostname"]`) mirroring [`packages/cache-plugin/deno.json`](packages/cache-plugin/deno.json) so the guarded `import('npm:ioredis@5.x')` test can run. No new `imports` entry (the dynamic specifier IS the dependency). |
| `packages/auth-plugin/README.md` | Add Refresh Tokens and Rate Limiting sections (usage, options, code examples). AI_GUIDELINES §7.1 / §8.6. |
| `PUBLIC_API.md` | Add Refresh (`RefreshTokenService` + store + login/refresh/logout example) and Rate Limiting (`rateLimitMiddleware` + stores + usage) sections; update the Auth Exports table; de-defer the M16b phasing note; note refresh/rate-limit are standalone (not `AuthPlugin` options). Reconcile §2 C2/C3/C4/C5. |
| `ROADMAP.md` | M16b deliverables checked (refresh + rate-limit); progress-tracking row `16b` flipped to `✅`; fix the stale line-315 comment (remove "rate limit" from the http-security blurb); keep the M16b sub-section authoritative. |
| `ARCHITECTURE.md` | Auth row: refresh + rate-limit now shipped in M16b (no longer "→ M16b"); strategies list `Refresh Token` → `RefreshTokenService`. Reconcile §2 C2. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Every test file's first framework import is `import { describe, it } from '@std/testing/bdd';` with
assertions from `@std/expect`. `Deno.test` is banned in this repo. Fixtures live under `test/fixtures/`
and are excluded from coverage. Every test call type-checks against the committed signatures from §1.
The shared [`fake-runtime.ts`](packages/auth-plugin/test/fixtures/fake-runtime.ts) fixture already
exposes real Web Crypto, a controllable `now()` (via `setNow`), `randomBytes`, and `uuid` — sufficient
for refresh/rate-limit timing and `jti` tests; no change to it is required.

| Test file | src covered | Key assertions (and the signature each call type-checks against) |
| --- | --- | --- |
| `test/unit/refresh-token-service.test.ts` | `src/services/refresh-token-service.ts` | Against `RefreshTokenService`: `issue(principal): Promise<TokenPair>` returns a pair; the refresh token `await jwt.verify(...)` has `type:'refresh'` + `jti` and `exp` honoring `refreshTokenExpiresIn`; access-token claims round-trip. `refresh(token): Promise<TokenPair \| null>` on a valid token returns a NEW pair and ROTATES (a second `refresh` of the original token returns `null`); expired/tampered refresh token → `null`; revoked token → `null`. `revoke(token): Promise<boolean>` removes the token. Drives expiry via `setNow`. |
| `test/unit/memory-refresh-token-store.test.ts` | `src/stores/memory-refresh-token-store.ts` | `save` then `get` returns the record; `revoke` then `get` returns `null`; an expired record (advance `setNow` past `expiresAt`) is evicted on `get` and returns `null`; missing `jti` → `null`. |
| `test/unit/rate-limit-middleware.test.ts` | `src/middleware/rate-limit-middleware.ts` | Against `MiddlewareFunction`: under-limit request calls `next` and sets `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset`; the `max+1`-th request returns **429**, sets a positive `Retry-After`, the `RateLimit-*` headers (`Remaining: 0`), the JSON body `{ error, message }`, and a downstream spy is **NOT** invoked (short-circuit mandate). Custom `keyGenerator` isolates two callers into separate counters. Default memory store path exercised when `store` is omitted. `standardHeaders: false` omits `RateLimit-*` (keeps `Retry-After`). Resolves `IRuntimeServices` via `ctx.services.get(CAPABILITIES.RUNTIME)`. |
| `test/unit/memory-rate-limit-store.test.ts` | `src/stores/memory-rate-limit-store.ts` | `increment(key, windowMs): Promise<RateLimitResult>` counts up within a window; advancing `runtime.now()` past `windowMs` resets the window to 1 and returns a fresh `resetTime`; `reset(key)` zeroes the counter; `resetTime` is `windowStart + windowMs`. |
| `test/unit/redis-rate-limit-store.test.ts` | `src/stores/redis-rate-limit-store.ts` | Injected-fake-client path (from `test/fixtures/fake-ioredis-client.ts`): first `increment` calls `incr` then `pexpire`; the second within-window `increment` calls `incr` but NOT `pexpire`; `pttl` drives `resetTime`; `reset` calls `del`; `disconnect` calls `quit`; an injected client missing required methods is rejected by the structural guard. PLUS one **guarded** test that does `await import('npm:ioredis@5.x')` and asserts it resolves to a constructor, skipped when the package is absent (CLAUDE.md real-import mandate). |
| `test/unit/barrel-exports.test.ts` (UPDATED) | `src/index.ts` (+ `src/interfaces/index.ts`) | Asserts `RefreshTokenService`, `MemoryRefreshTokenStore`, `rateLimitMiddleware`, `MemoryRateLimitStore`, `RedisRateLimitStore`, and the option/result/store types ARE exported; asserts the lazy loader and `IRateLimitRedisClient`/`validateClient` are NOT exported; and that all prior M16 exports remain present. |
| `test/integration/refresh-rate-limit-integration.test.ts` | end-to-end through the plugin | Builds a `RefreshTokenService` with the resolved `IJwtService` + a `MemoryRefreshTokenStore` against the fake runtime; runs a login → `issue` → `refresh` rotation round-trip asserting the new access token authenticates via `JwtStrategy` + `authMiddleware`; `revoke` then `refresh` fails. Separately registers `rateLimitMiddleware({ windowMs, max })` against a fake runtime/app and asserts `max` requests pass and the `max+1`-th returns 429 with the downstream handler not reached. |
| `test/fixtures/fake-ioredis-client.ts` (NEW) | (fixture) | A fake ioredis-compatible client implementing `incr`/`pexpire`/`pttl`/`del`/`quit` (and `connect`) with in-memory counters + per-key TTL, recording calls for assertion — mirrors [`packages/cache-plugin/test/fixtures/fake-ioredis-client.ts`](packages/cache-plugin/test/fixtures/fake-ioredis-client.ts). |

The interface-only files (`src/stores/refresh-token-store.ts`, `src/stores/rate-limit-store.ts`, and
the `src/interfaces/index.ts` additions) have no runtime branches and are covered wherever tests
compile against them (messaging/cache precedent: interface-only store files are covered by their impl
tests + compilation).

Per-file bar: every new `src/*.ts` file targets ≥90% branch / function / line. All non-Redis logic is
deterministic (memory stores, controllable `runtime.now()`, real Web Crypto) so every branch is
reachable directly. The single environment-gated line is the real `await import('npm:ioredis@5.x')` in
`RedisRateLimitStore`, which stays behind the one guarded real-import test, while every branch AROUND
it (injected vs lazy, client validation, INCR/PEXPIRE/PTTL/DEL/QUIT) is unit-tested via the injected
fake client (CLAUDE.md: the branching logic must not live only behind a skipped test).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/16b-refresh-rate-limit, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

After implementation, also grep for constructs the gates miss (CLAUDE.md "Before reporting a task
done"):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/auth-plugin/src
```

The result must be empty (comments excepted). `Date.now()` outside `packages/runtime` is a
clock-mixing smell; `globalThis.__` is a fake-lazy-import smell. Refresh `jti` and all rate-limit /
refresh timing go through `runtime.randomBytes` / `runtime.now()`.

Branch + lint hand-off: the assistant produced this plan in a file-tools-only Architect session (no
shell). Before review, the human confirms `git branch --show-current` is `feat/16b-refresh-rate-limit`
(create it from the current tip if absent: `git switch -c feat/16b-refresh-rate-limit`) and runs
`deno task check:plan`; any finding is fixed as a plan first.

## 8. Risks & mitigations

- **Refresh-token replay across instances (memory store is per-process).** Mitigation: the
  `RefreshTokenStore` interface is pluggable; single-process memory is the documented M16b default and
  a `RedisRefreshTokenStore` is a later drop-in (§9). Rotation + reuse-rejection (`null` on a revoked
  `jti`) is the in-process guarantee.
- **Refresh-token reuse / family attack not fully neutralized.** Mitigation: M16b revokes the
  presented `jti` on rotation and rejects any replay of a revoked `jti`; full family-cascade
  revocation is explicitly deferred (§3.2, §9) rather than half-built.
- **Unbounded memory growth in the memory stores.** Mitigation: `MemoryRefreshTokenStore` lazily
  expires records on `get`; `MemoryRateLimitStore` naturally churns keys as windows roll over; both are
  single-process and documented as such (a Redis backend bounds growth via TTL for rate limiting).
- **Redis fixed-window counter atomicity / boundary race.** Mitigation: `INCR`+`PEXPIRE`+`PTTL` is
  correct for a per-key counter (INCR is atomic); the small race at a window boundary is acceptable
  for M16b and noted — a Lua `EVAL` is a later hardening, not a correctness blocker for a single
  counter.
- **ioredis lazy import silently non-functional (the `globalThis.__` anti-pattern).** Mitigation:
  `RedisRateLimitStore` uses a real `await import('npm:ioredis@5.x')` (resolves to 5.11.1,
  [`deno.lock:20`](deno.lock)) with one guarded real-import test, and every branch around it is
  unit-tested via the injected fake client (§3.6). The `deno.json` `test.permissions` block is added so
  that guarded import can actually run.
- **Clock mixing (epoch vs monotonic) in window/expiry math.** Mitigation: all timing uses
  `runtime.now()` (wall-clock epoch ms); the post-implementation grep gate catches any `Date.now()`
  in `src/` (§7). `Retry-After`/`RateLimit-Reset` are derived from the same `runtime.now()` base.
- **Destabilizing the shipped M16 `AuthPlugin`.** Mitigation: M16b does not edit
  [`auth-plugin.ts`](packages/auth-plugin/src/plugin/auth-plugin.ts) or `AuthPluginOptions`; it only
  adds files + barrel exports + `deno.json` test config (§3.7). The unchanged `auth-plugin.test.ts`
  regression-proofs the registration surface.
- **`exactOptionalPropertyTypes` failures.** Mitigation: option objects assign only defined values
  (§3.8), mirroring the existing `auth-plugin.ts` pattern.
- **Public-API drift.** Mitigation: `PUBLIC_API.md` / `ROADMAP.md` / `ARCHITECTURE.md` / `README.md`
  corrections ship as named same-PR deliverables (§2 C1-C5, §5).

## 9. Out of scope

- A **Redis `RefreshTokenStore`** — deferred; the `RefreshTokenStore` interface is pluggable so a
  Redis backend is a later drop-in (§3.3, §2 C4). M16b ships the memory backend only.
- Refresh-token **family / reuse-cascade** revocation (invalidating a whole family on reuse of a
  rotated member) — deferred; M16b revokes the single presented `jti` and rejects replay of a revoked
  `jti` (§3.2).
- Rate limiting as a **standalone `RateLimitPlugin`** registered under a `'rate-limit'` capability
  token — realized as the decoupled `rateLimitMiddleware` instead; a registered token/service would be
  a common change with no cross-plugin consumer in M16b (§3.7, §2 C3).
- A **sliding-window** rate-limit algorithm — fixed-window ships; sliding window is a later option.
- Distributed/global rate-limit coordination beyond a shared Redis store.
- `@hono-enterprise/common` contract changes of any kind — none required (§3.7).
- OAuth2/OIDC, SAML, session/cookie stores, MFA, passkeys/WebAuthn — never in the M16 lineage; future
  milestones.
- Wiring refresh or rate limiting into `AuthPlugin({ ... })` — both are standalone (refresh is
  app-instantiated; rate limiting is a standalone middleware), so `AuthPluginOptions` is unchanged.
