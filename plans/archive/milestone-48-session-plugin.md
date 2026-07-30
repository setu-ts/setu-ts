# Milestone 48 — Session Plugin (`@hono-enterprise/session-plugin`)

> **Status:** Planning. Branch: `feat/m48-session-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework has no session capability: `packages/common/src/tokens.ts` declares no `SESSION` token
and `packages/auth-plugin/src` carries no cookie or session surface at all (it ships JWT, API-key,
refresh-token and RBAC auth). This milestone adds a `SESSION` capability whose default is an
encrypted, self-contained cookie — AES-256-GCM under a key derived by HKDF-SHA256, verified to
round-trip through `runtime.subtle` with zero npm dependencies — plus an opt-in server-backed store
for immediate revocation, and the session-backed **signed synchronizer-token** form CSRF that the
existing stateless Origin/Referer middleware structurally cannot provide for a
progressive-enhancement `<Form>` post.

- **In scope:** `SESSION` capability token and contracts in `common`; a shared cookie
  parse/serialize codec in `common`; `packages/session-plugin` with the cookie strategy (default),
  an `ISessionStore` port with `MemorySessionStore` and `CacheSessionStore`; secret resolution via
  `CAPABILITIES.SECRETS` with an env fallback and a rotating key list; session middleware with
  commit-on-response; session-backed form CSRF; a React Router bridge through M44's existing
  `populateLoadContext` seam; real-crypto tests including tamper rejection and rotation.
- **NOT this milestone:** the React Router app skeleton and config-key indirection that consume this
  (M36c); parameter-level decorator injection (M36b); example applications (M37); OAuth/OIDC login
  flows and the short-lived state cookie (no milestone owns these yet — the reference's
  `microsoft-oauth-state.server.ts` is out of scope and named in §9); any change to the stateless
  Origin/Referer `csrfMiddleware` in `http-security-plugin`, which stays exactly as published.

## 1. Contracts verified from SOURCE (not names)

Every row below was confirmed by opening the file at the cited line in this worktree
(`feat/m48-session-plugin`, off `main` at `c72e2f1`), not from the name and not from memory.

| Reference                           | Source (file:line)                                                                                   | Verified surface / fact                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `SESSION` token exists           | `packages/common/src/tokens.ts` (grep `SESSION`/`COOKIE` → 0 hits)                                   | The token must be added. Neighbours for format: `CACHE: 'cache'` (:51), `SECRETS: 'secrets'` (:73), `SSE: 'sse'` (:103), `WEBSOCKET: 'websocket'` (:105), `REALTIME_BACKPLANE: 'realtime-backplane'` (:111) |
| Token grammar                       | `packages/common/src/tokens.ts:146`                                                                  | `TOKEN_PATTERN` = kebab segments dot-separated; colons illegal. `'session'` is legal                                                                                                                        |
| `IResponse.appendHeader`            | `packages/common/src/http.ts:116-127`                                                                | Documented as the correct way to emit several `Set-Cookie` headers, unlike `header()` which overwrites                                                                                                      |
| `snapshot()` returns live `Headers` | `packages/common/src/http.ts:176-196` (comment :182-185)                                             | Deliberately not a defensive copy, because cloning `Headers` collapses repeated `Set-Cookie` into one comma-joined header. No response-pipeline change needed                                               |
| Headers stay mutable after terminal | `packages/kernel/src/context/response.ts:33-36`, `:38-43`, `:17-21`                                  | `appendHeader` appends to `#headers` and never consults `#ended`; terminal methods only set `#ended`. **This is what makes commit-on-response work** — a post-`next()` `appendHeader` still lands           |
| `IRequest` has no `cookies`         | `packages/common/src/http.ts:33-85`                                                                  | Fields are `method`/`url`/`path`/`headers`/`ip?`/`user?`/`tenant?`/`signal?` + `json`/`text`/`bytes`. `user?` (:48), `tenant?` (:53), `signal?` (:64) are the mutable-optional precedents                   |
| `IRequestContext.state`             | `packages/common/src/http.ts:219`                                                                    | `readonly state: Map<string, unknown>` — request-scoped data passing between middleware and handlers. The session's carrier (§3.1)                                                                          |
| `IRuntimeServices.subtle`           | `packages/common/src/runtime.ts:212`                                                                 | `readonly subtle: SubtleCrypto` — the M16 `JwtService` precedent; the whole scheme rides this                                                                                                               |
| `ISecretManager`                    | `packages/common/src/services/secrets.ts:22-44`                                                      | Exactly three methods: `get(name)` (throws if absent/denied), `has(name)`, `rotate(name, value)`. No `getMany`; the env fallback is driven by `has`/catch                                                   |
| `ICacheStore`                       | `packages/common/src/services/cache.ts:19-55`                                                        | `get<T>`, `set<T>(key, value, ttlSeconds?)`, `delete`, `has`, `clear`. TTL is **seconds**, not ms — `CacheSessionStore` must convert                                                                        |
| `parseCookies` is **not** private   | `packages/decorator-plugin/src/resolvers/parameter-resolver.ts:60-84`, exported at `src/index.ts:56` | The only cookie parser in the tree, and it is **published public API** of decorator-plugin. The ROADMAP calls it private — corrected as C1                                                                  |
| Existing CSRF is stateless          | `packages/http-security-plugin/src/middleware/csrf-middleware.ts:1-60`                               | Module doc: "No cookies or server-side token store." Options are `enabled`/`trustedOrigins`/`customHeader` only. A `<Form>` post carries no custom header, so it cannot be driven by one                    |
| Existing middleware priorities      | `packages/http-security-plugin/src/plugin/http-security-plugin.ts:24-30`                             | `IP_SECURITY: 120`, `REQUEST_SIZE: 180`, `CORS: 200`, `SECURITY_HEADERS: 250`, `CSRF: 270` (local const, not from `common`)                                                                                 |
| Documented priority table           | `ARCHITECTURE.md:1568-1581`                                                                          | 20 metrics, 30 telemetry, 40 tenant, 50 logging, 100 request-id, 200 CORS, 250 security-headers, **300 auth**, 350 authorization, 400 validation. Session must precede 300 (§3.11)                          |
| M44 `populateLoadContext` seam      | `packages/react-router-plugin/src/handler/request-bridge.ts:38-40`, `handler/load-context.ts:23-32`  | `applyDefaultLoadContext(ctx, loadContext)` then optional `populateLoadContext?.(ctx, loadContext)`. The app-supplied hook is the session bridge — no cross-plugin import (§3.12)                           |
| Web Crypto AES-GCM tag placement    | Executed against Deno in this worktree (scratchpad `verify-crypto.ts`)                               | `subtle.encrypt` returns **ciphertext‖tag concatenated** (34-byte plaintext → 50-byte output); there is no `getAuthTag()`. The reference's separate `tag` envelope segment is unreproducible → C3           |
| Scheme portability                  | Same run                                                                                             | HKDF-SHA256 → AES-256-GCM round-trips; a flipped ciphertext byte is rejected by the tag; a key from a different secret fails to open; HMAC-SHA256 from HKDF material signs and verifies                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                                                                                                     | Doc deliverable (same PR)                                                                                       |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M48 "Cookie codec placement" calls the decorator-plugin cookie parser "private to `parameter-resolver.ts:61-73`". It is exported from `decorator-plugin/src/index.ts:56` — published public API since alpha.1. | `common` owns the canonical codec. decorator-plugin's `parseCookies` **keeps its export and delegates** to it: removing a published export needs a deprecation period (§9.2), and delegating leaves exactly one implementation (§11.1) rather than two parsers.                                                              | ROADMAP M48 paragraph corrected to "exported from decorator-plugin, which will delegate to the `common` codec". |
| C2 | ROADMAP M48 floats `IRequest.cookies` as a flagged `common` widening ("adding one is a flagged widening alongside the `tenant`, `user`, `signal` precedents").                                                         | **Not added.** Nothing in this design reads it: the middleware parses `ctx.request.headers` once and puts the _session_ in `ctx.state`. A widening would oblige every `IRequest` producer (runtime adapters, kernel, `testing` package, and every test double) to populate a field with no consumer — the dead-surface rule. | ROADMAP deliverable line 1 amended: the `IRequest` widening was assessed and declined, with this reason.        |
| C3 | ROADMAP §A specifies a `v1.iv.ciphertext.tag` envelope, copied from the `node:crypto` reference where `getAuthTag()` is separate. Web Crypto concatenates the tag into the ciphertext.                                 | Envelope is **`v1.<kid>.<iv>.<sealed>`** — four segments, but the fourth is ciphertext‖tag and the second is the key id that makes rotation O(1) (§3.7). Confirmed by executing the scheme.                                                                                                                                  | ROADMAP §A envelope description corrected, noting Web Crypto's concatenated tag as the reason.                  |
| C4 | `ARCHITECTURE.md:1568-1581` priority table has no session or form-CSRF row, and `http-security-plugin` keeps its priorities in a package-local const rather than in `common`.                                          | Add rows **260 SessionMiddleware** and **275 CsrfFormMiddleware** to the documented table (§3.11). The package-local const stays package-local — centralising priorities into `common` is a refactor no milestone has approved and is out of scope.                                                                          | ARCHITECTURE §10 priority table gains both rows; the session-plugin README repeats the ordering rationale.      |
| C5 | ROADMAP M48 says "`cache-plugin` and `storage-plugin` are candidate stores".                                                                                                                                           | `CacheSessionStore` over `CAPABILITIES.CACHE` only. Sessions are small, hot, TTL-keyed values — exactly `ICacheStore`'s shape (`set(key, value, ttlSeconds)`); `IStorage` is a blob/object API with no TTL, so a storage-backed store would hand-roll expiry.                                                                | ROADMAP deliverable line 2 names the cache store and records that storage was assessed and declined.            |

## 3. Design decisions

### 3.1 How a handler reaches the session

- **Decision:** the middleware parses the cookie once and stores the live `Session` in `ctx.state`
  under a module-private key. The single public accessor is `SessionService.from(ctx): ISession`,
  re-exported as a free function `getSession(ctx)`. Both throw `SessionMiddlewareMissingError` when
  the key is absent. No `IRequestContext` or `IRequest` widening.
- **Why:** `ctx.state` is `Map<string, unknown>` and exists for exactly this (`http.ts:219`).
  `IRequestContext` is fully `readonly`, so adding a `session` member would force every producer
  (kernel, `testing`'s `createTestContext`, every hand-rolled double) to construct one, and would
  make the field `undefined` on any request that skipped the middleware — a lie the type would not
  show. One accessor is also what keeps §3.12's React Router path from becoming a second
  implementation.
- **Test home:** `test/unit/services/session-service.test.ts` (accessor returns the same instance
  the middleware stored; throws with a clear message when middleware never ran).

### 3.2 Commit-on-response

- **Decision:** `sessionMiddleware` awaits `next()`, then — and only when the session is **dirty**
  (mutated), **regenerated**, **destroyed**, or `rolling` is on and the session was loaded — appends
  exactly one `Set-Cookie` via `ctx.response.appendHeader`. A clean, untouched session emits no
  header at all.
- **Why:** verified sound at `kernel/src/context/response.ts:33-36` — `appendHeader` appends to the
  live `#headers` and never checks `#ended`, so the header lands even though the handler already
  called a terminal method, and `snapshot()` hands the adapter the same live `Headers` without
  cloning (`http.ts:182-185`), so repeated `Set-Cookie` values survive. Emitting on every request
  would defeat caching and rewrite the cookie on reads.
- **Test home:** `test/integration/session-commit.test.ts` (dirty → one `Set-Cookie`; clean → none;
  streaming response still gets the header; two cookies from two plugins both survive).

### 3.3 Where the session payload lives

- **Decision:** two strategies behind one service. Absent a `store` option the cookie carries the
  whole payload (**default**). With `store` set, the cookie carries only an opaque session id and
  the payload lives behind the `ISessionStore` port. The cookie is protected identically in both
  cases (§3.4), so the id is never a bare guessable string.
- **Why:** the cookie strategy is zero-dependency and Workers-portable, matching the reference and
  making the default work everywhere with no infrastructure. The store strategy buys the immediate
  revocation the reference documents as its trade-off, without making Redis a dependency of
  anything.
- **Test home:** `test/integration/store-strategy.test.ts` drives an identical read/write/destroy
  script against both strategies and asserts identical observable behavior.

### 3.4 Cookie protection mode

- **Decision:** `mode: 'encrypt' | 'sign'`, defaulting to `'encrypt'` (AES-256-GCM). `'sign'` emits
  `payload.hmac` with HMAC-SHA256 and leaves the payload readable base64url JSON.
- **Why:** encryption is the secure default (§13.4) and the reference's choice, because a cookie
  strategy cookie carries real claims. `'sign'` is the honest pairing for the store strategy, where
  the cookie holds only an opaque id and there is nothing to conceal — smaller and debuggable. Both
  modes are wired into the same `seal`/`open` seam and both are exercised, so neither is dead
  surface.
- **Test home:** `test/unit/codec/crypto.test.ts` (real `crypto.subtle`: round-trip, tamper
  rejection, and cross-mode rejection in both directions) and the non-default configuration case in
  `test/integration/session-commit.test.ts`.

### 3.5 Envelope format

- **Decision:** `v1.<kid>.<iv>.<sealed>` for `'encrypt'` and `v1.<kid>.<payload>.<hmac>` for
  `'sign'`, all segments base64url, version segment first and rejected when unrecognised. Decode
  returns `null` (never throws) on wrong segment count, unknown version, unknown `kid`, bad
  base64url, or a wrong `iv` length.
- **Why:** a fixed segment count and a leading version make the format forward-compatible and make
  every malformed input a null session rather than an exception path. `sealed` is one segment
  because Web Crypto returns ciphertext‖tag concatenated (C3).
- **Test home:** `test/unit/codec/envelope.test.ts` (table-driven: each rejection reason returns
  `null`; a valid envelope round-trips).

### 3.6 Secret resolution

- **Decision:** at `register()` the plugin resolves the secret in this order: an explicitly injected
  `secret` option wins; failing that, `CAPABILITIES.SECRETS` when registered
  (`ISecretManager.get(secretName)`, default name `'SESSION_SECRET'`, wrapped so a throw falls
  through); failing that, `runtime.env` under the same name. A secret shorter than 32 characters, or
  no secret at all, throws `SessionSecretMissingError` during `register()`.
- **Why:** fail fast at startup rather than per request. `ISecretManager.get` throws on a missing
  secret (`secrets.ts:29`) rather than returning null, so the fallback must be a caught throw — the
  same shape as the reference's `try { getSetting } catch { process.env }`.
  `optionalDependencies:
  ['secrets']` orders the plugin after the secrets plugin so the lookup
  sees it.
- **Test home:** `test/unit/secret/secret-resolver.test.ts` (all four branches, including a secrets
  manager that throws) and `test/integration/plugin-registration.test.ts` (short secret fails
  `register()`).

### 3.7 Secret rotation

- **Decision:** `secret` accepts `string | readonly string[]`. Index 0 is the **current** key
  (everything is written with it); every entry can **open**. Each key gets a `kid` = the first 8
  base64url characters of `HKDF(secret, info='kid')`, carried in the envelope, so open is an O(1)
  lookup and an unknown `kid` is a null session rather than N failed decrypt attempts.
- **Why:** deriving one key from one secret means rotation logs every user out — the reference's
  documented weakness. A `kid` is not secret (it is a one-way derivation of the secret, not the
  secret or the key), and it avoids both the envelope-free trial-decrypt loop and its timing
  profile.
- **Test home:** `test/unit/codec/crypto.test.ts` — a cookie written under an old secret still opens
  after that secret is demoted to index 1, and stops opening once dropped from the list.

### 3.8 Expiry model

- **Decision:** absolute expiry is authoritative and lives **inside** the signed/encrypted payload
  as a wall-clock `exp` stamped from `runtime.now()`; `maxAge` (default 7200 s, matching the
  reference's 2 h) sets both `exp` and the cookie's `Max-Age`. `rolling: boolean` (default `false`)
  re-issues the cookie on each response, extending `exp`. `idleTimeoutMs?` (optional, off by
  default) is enforced against a `seen` stamp in the payload. An expired or idle-timed-out session
  loads as a fresh empty session, never as a partial one.
- **Why:** a cookie's `Max-Age` is client-controlled, so a server that trusts it has no expiry at
  all — the payload stamp is the only enforceable one. `exp`/`seen` are persisted across processes
  and compared to a future wall clock, so they must be `runtime.now()`; `hrtime()` is monotonic from
  an arbitrary origin and is meaningless once serialized (the "never mix clocks" rule).
- **Test home:** `test/unit/services/session.test.ts` (expired payload → empty session; idle
  timeout; rolling extends `exp` while non-rolling does not), driving an injected clock.

### 3.9 Form CSRF strategy and package boundary

- **Decision:** session-backed form CSRF ships **in this package**, as `csrfFormMiddleware(options)`
  plus `getCsrfToken(session)`. The token is 32 random bytes from `runtime.randomBytes`, minted on
  demand and stored in the session under a reserved key; validation reads the configured field from
  the parsed body and compares it to the session's token with a constant-time comparison.
  `http-security-plugin` is not touched.
- **Why:** the token lives in session data and is protected by the session's own
  encryption/signature, so it is cohesive with sessions and needs no second cookie and no second
  secret. A verifier seam in `http-security-plugin` would mean changing an already-published
  plugin's surface and inverting its dependencies onto a session capability it must work without.
  Because a session can exist before login, the primary path always applies — which lets this drop
  the reference's signed-CSRF-cookie fallback (`csrf.server.ts:29-55`, which existed for standalone
  auth routes and pre-deployment sessions) as unnecessary surface.
- **Test home:** `test/unit/middleware/csrf-form-middleware.test.ts` (missing/blank/wrong/correct
  token; safe methods pass; a **short-circuit** assertion that a rejected post never reaches the
  handler) and `test/e2e/form-post.test.ts` for the real round-trip.

### 3.10 Cookie codec placement

- **Decision:** `parseCookie(header)` and `serializeCookie(name, value, attrs)` live in
  `packages/common/src/cookie.ts` as pure zero-dependency functions. `decorator-plugin`'s published
  `parseCookies` keeps its signature and export and becomes a delegation to `parseCookie`.
- **Why:** two packages need one codec and no plugin may import another (§2.2/§3.3) — the same
  situation as M47's `encodeFrameData`, so `common` is the principled home, and duplication is the
  only alternative. Delegating rather than removing honours §9.2 for a published export while
  leaving one implementation (§11.1). `serializeCookie` is new because nothing in the tree writes a
  cookie today; it owns `Max-Age`, `Path`, `HttpOnly`, `SameSite`, `Secure`, `Domain` so no caller
  hand-builds a header string.
- **Test home:** `test/unit/cookie.test.ts` in `packages/common` (parse: quoted values, `=` inside
  the value, no-`=` pairs skipped, empty header; serialize: every attribute, and `sameSite: 'none'`
  forcing `Secure`), plus decorator-plugin's existing `parameter-resolver` tests continuing to pass
  unchanged as the delegation's regression proof.

### 3.11 Middleware priorities

- **Decision:** `sessionMiddleware` at **260**, `csrfFormMiddleware` at **275**.
- **Why:** 260 sits after security headers (250) and before auth (300), so an auth strategy can read
  a session, and its post-`next()` commit phase wraps everything inner. 275 sits after the session
  is loaded and after the stateless Origin/Referer CSRF (270), so a request failing the cheap
  stateless check never reaches token comparison, and before auth (300) so a forged post is rejected
  before any credential work.
- **Test home:** `test/integration/plugin-registration.test.ts` asserts both registered priorities;
  `test/e2e/form-post.test.ts` proves the ordering end to end.

### 3.12 React Router bridge

- **Decision:** no change to `react-router-plugin`. The application wires the session into its
  loaders through M44's existing `populateLoadContext` hook, calling the same `getSession(ctx)`
  accessor from §3.1. The session-plugin README documents the three-line snippet and M36c adopts it.
- **Why:** `request-bridge.ts:38-40` already calls an app-supplied
  `populateLoadContext?.(ctx, loadContext)` after the defaults, which is precisely this extension
  point. A plugin-to-plugin path would violate §2.2/§3.3; an app importing both plugins is fine.
  Routing loaders through the one accessor is what keeps this from being a second entry point with
  its own defaults.
- **Test home:** `test/integration/load-context-bridge.test.ts` drives a fake `populateLoadContext`
  and asserts it receives the identical `ISession` instance the handler sees.

### 3.13 Session identity and fixation

- **Decision:** every session carries an `id` from `runtime.uuid()`. `regenerate()` mints a new id,
  keeps the data, and marks the session for re-issue; on the store strategy it additionally deletes
  the old store entry. `destroy()` clears the data, marks for deletion, and emits a `Max-Age=0`
  cookie.
- **Why:** privilege elevation on an unchanged session id is session fixation; a login flow needs
  one call that rotates the id without losing the data it just wrote. Deleting the old store row is
  what makes regeneration a real revocation on the store strategy rather than a rename.
- **Test home:** `test/unit/services/session.test.ts` and
  `test/unit/stores/memory-session-store.test.ts` (old id gone, new id present, data preserved).

### 3.14 Health indicator and shutdown

- **Decision:** a `session` health indicator reporting `{ strategy, mode, keys, store }`, where
  `store` is the store's own reachability when one is configured. `onClose` stops
  `MemorySessionStore`'s sweep timer. The cookie strategy has nothing to close.
- **Why:** every shipped plugin registers an indicator, and a store that has gone unreachable is the
  one session failure an operator cannot see from the outside. An uncleared `runtime.setInterval`
  keeps the process alive (§14.5).
- **Test home:** `test/integration/plugin-registration.test.ts` (indicator registered, degraded when
  the injected store reports unhealthy) and `test/unit/stores/memory-session-store.test.ts` (timer
  cleared).

## 4. Exported surface — every symbol names its consumer

### 4.1 `packages/common` additions

| Exported symbol        | Kind      | Consumer / real code path that READS it                                                                                                  |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.SESSION` | token     | `SessionPlugin.provides`; `ctx.services.get<ISessionService>(CAPABILITIES.SESSION)` in the middleware, the CSRF middleware, and app code |
| `ISession`             | interface | Return type of `getSession(ctx)`; implemented by the plugin's internal `Session`; read by handlers, loaders, CSRF middleware             |
| `ISessionService`      | interface | The type registered under the token; `from(ctx)` is called by `getSession` and by `csrfFormMiddleware`                                   |
| `ISessionStore`        | interface | Implemented by `MemorySessionStore`/`CacheSessionStore`; consumed by `SessionService` on the store strategy                              |
| `SessionData`          | type      | `Record<string, unknown>` payload shape; parameter/return of `ISession.get`/`set` and every `ISessionStore` method                       |
| `parseCookie`          | function  | `sessionMiddleware` (reads the session cookie); `decorator-plugin`'s `parseCookies` delegates to it                                      |
| `serializeCookie`      | function  | `sessionMiddleware` commit phase and `Session.destroy`'s `Max-Age=0` header                                                              |
| `CookieAttributes`     | interface | The `attrs` parameter of `serializeCookie`; built from `SessionPluginOptions.cookie`                                                     |

### 4.2 `packages/session-plugin` exports

| Exported symbol                 | Kind      | Consumer / real code path that READS it                                                                               |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `SessionPlugin`                 | factory   | The application's plugin list; the kernel calls its `register`                                                        |
| `SessionService`                | class     | Registered under `CAPABILITIES.SESSION` by `SessionPlugin`; `from()` called by `getSession` and CSRF middleware       |
| `getSession`                    | function  | App handlers and the M36c `populateLoadContext` snippet (§3.12); delegates to `SessionService.from`                   |
| `sessionMiddleware`             | factory   | Added by `SessionPlugin` at priority 260; also usable standalone with `autoStart: false` test apps                    |
| `csrfFormMiddleware`            | factory   | Added by `SessionPlugin` at 275 when the `csrf` option block is present                                               |
| `getCsrfToken`                  | function  | App render path (hidden form field); mints-and-stores on first call, so `csrfFormMiddleware` has something to compare |
| `MemorySessionStore`            | class     | `SessionPluginOptions.store: 'memory'`; the default store when the store strategy is chosen without a cache           |
| `CacheSessionStore`             | class     | `SessionPluginOptions.store: 'cache'`; resolves `CAPABILITIES.CACHE` and adapts seconds-based TTL                     |
| `SessionSecretMissingError`     | class     | Thrown by the secret resolver during `register()`; app-level `instanceof` and the registration test                   |
| `SessionMiddlewareMissingError` | class     | Thrown by `SessionService.from`/`getSession` when `ctx.state` has no session; consumer `instanceof`                   |
| `CsrfTokenMismatchError`        | class     | Thrown by the CSRF middleware's verifier before it converts to a 403; consumer `instanceof` and the exception filter  |
| `SessionPluginOptions`          | interface | The `SessionPlugin` parameter                                                                                         |
| `CsrfFormOptions`               | interface | The `csrf` block of `SessionPluginOptions` and the `csrfFormMiddleware` parameter                                     |
| `SessionCookieOptions`          | interface | The `cookie` block; mapped onto `CookieAttributes`                                                                    |

### 4.3 Options — every option names its consumer

| Option               | Consumer                                            | Behavior (per implementation)                                                                                                      |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `secret`             | `secret-resolver.ts`                                | `string \| readonly string[]`. Index 0 writes; all entries open (§3.7). Bypasses the secrets manager and env entirely when present |
| `secretName`         | `secret-resolver.ts`                                | Name looked up in `ISecretManager` and `runtime.env`. Default `'SESSION_SECRET'`                                                   |
| `mode`               | `codec/crypto.ts` `seal`/`open`                     | `'encrypt'` (default) AES-256-GCM; `'sign'` HMAC-SHA256 over readable base64url JSON (§3.4)                                        |
| `store`              | `SessionService` strategy branch                    | Absent → cookie strategy. `'memory'` → `MemorySessionStore`; `'cache'` → `CacheSessionStore`; an `ISessionStore` → used as given   |
| `maxAge`             | `Session` `exp` stamp + `serializeCookie` `Max-Age` | Seconds; default `7200`. Sets the authoritative payload `exp` and the cookie attribute (§3.8)                                      |
| `rolling`            | `sessionMiddleware` commit phase                    | `false` (default) commits only on change; `true` re-issues every response, extending `exp`                                         |
| `idleTimeoutMs`      | `Session` load-time validation                      | Omitted → no idle check. Set → a `seen` stamp older than this loads as a fresh empty session                                       |
| `cookie.name`        | `sessionMiddleware` read + commit                   | Default `'hono_session'`                                                                                                           |
| `cookie.path`        | `serializeCookie`                                   | Default `'/'`                                                                                                                      |
| `cookie.domain`      | `serializeCookie`                                   | Omitted → attribute absent (host-only cookie)                                                                                      |
| `cookie.sameSite`    | `serializeCookie`                                   | Default `'lax'`. `'none'` forces `Secure` regardless of `cookie.secure`                                                            |
| `cookie.secure`      | `serializeCookie`                                   | Default `true`; the escape hatch for plain-HTTP local development                                                                  |
| `cookie.httpOnly`    | `serializeCookie`                                   | Default `true`                                                                                                                     |
| `csrf`               | `SessionPlugin` middleware registration             | Absent → no CSRF middleware registered. Present → `csrfFormMiddleware` at 275                                                      |
| `csrf.fieldName`     | `csrfFormMiddleware` body lookup                    | Default `'_csrf'`                                                                                                                  |
| `csrf.headerName`    | `csrfFormMiddleware` fallback lookup                | Omitted → form field only. Set → that header is accepted too, for `fetch`-based posts                                              |
| `csrf.ignoreMethods` | `csrfFormMiddleware` method gate                    | Default `['GET','HEAD','OPTIONS']`                                                                                                 |

## 5. Implementation files

| File                                                             | Purpose                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/cookie.ts`                                  | Pure `parseCookie` / `serializeCookie` / `CookieAttributes` (§3.10)                                                     |
| `packages/common/src/services/session.ts`                        | `ISession`, `ISessionService`, `ISessionStore`, `SessionData`                                                           |
| `packages/common/src/tokens.ts`                                  | Add `SESSION: 'session'`                                                                                                |
| `packages/common/src/index.ts`                                   | Barrel: cookie codec + session contracts                                                                                |
| `packages/decorator-plugin/src/resolvers/parameter-resolver.ts`  | `parseCookies` delegates to `common`'s `parseCookie` (C1)                                                               |
| `packages/session-plugin/deno.json`                              | Manifest, version matching the workspace, `common` specifier pinned like its siblings                                   |
| `packages/session-plugin/src/index.ts`                           | Barrel exports (§4.2)                                                                                                   |
| `packages/session-plugin/src/plugin/session-plugin.ts`           | `SessionPlugin` factory: secret resolution, service registration, middleware at 260/275, health, `onClose`              |
| `packages/session-plugin/src/services/session-service.ts`        | `SessionService` — strategy branch, `from(ctx)`, load/commit orchestration                                              |
| `packages/session-plugin/src/services/session.ts`                | Internal `Session` — `get`/`set`/`has`/`delete`/`clear`/`regenerate`/`destroy`, dirty tracking, `exp`/`seen` validation |
| `packages/session-plugin/src/services/get-session.ts`            | Free-function `getSession(ctx)` delegating to `SessionService.from`                                                     |
| `packages/session-plugin/src/codec/envelope.ts`                  | base64url helpers + envelope encode/decode returning `null` on every malformed input (§3.5)                             |
| `packages/session-plugin/src/codec/crypto.ts`                    | HKDF key derivation, `kid` fingerprint, `seal`/`open` for both modes over `runtime.subtle`                              |
| `packages/session-plugin/src/codec/timing-safe.ts`               | Constant-time byte comparison (Web Crypto has no `timingSafeEqual`)                                                     |
| `packages/session-plugin/src/secret/secret-resolver.ts`          | Four-branch resolution + length validation + key-list normalisation (§3.6)                                              |
| `packages/session-plugin/src/stores/memory-session-store.ts`     | `Map`-backed store with a swept expiry and a clearable timer                                                            |
| `packages/session-plugin/src/stores/cache-session-store.ts`      | `ICacheStore`-backed store, ms→s TTL conversion, key prefix                                                             |
| `packages/session-plugin/src/middleware/session-middleware.ts`   | Load before `next()`, commit after (§3.2)                                                                               |
| `packages/session-plugin/src/middleware/csrf-form-middleware.ts` | Method gate, token extraction, constant-time compare, 403 short-circuit                                                 |
| `packages/session-plugin/src/errors.ts`                          | The three exported error classes                                                                                        |
| `packages/session-plugin/README.md`                              | Purpose, both strategies, both modes, rotation, the CSRF-strategy choice, the M44 bridge snippet                        |
| `deno.json`                                                      | Add `./packages/session-plugin` to `workspace`                                                                          |
| `scripts/release-packages.ts`                                    | Add the package to the ordered publish allow-list                                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Every `src/` file above appears in the `src covered` column. All tests use `describe`/`it` from
`@std/testing/bdd` with `expect` from `@std/expect`, from the first line.

| Test file                                                                   | src covered                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/cookie.test.ts`                                  | `common/src/cookie.ts`                                            | `parseCookie(header: string \| null): Record<string,string>` — empty/null header, `=` inside value, pairs without `=` skipped, whitespace trimmed. `serializeCookie(name, value, attrs?: CookieAttributes): string` — every attribute rendered; `sameSite:'none'` forces `Secure`; `maxAge: 0` still emitted                 |
| `packages/session-plugin/test/unit/codec/envelope.test.ts`                  | `codec/envelope.ts`                                               | `decodeEnvelope(raw: string): Envelope \| null` returns `null` for each of: wrong segment count, unknown version, bad base64url, wrong `iv` length, empty sealed. `encodeEnvelope` round-trips                                                                                                                               |
| `packages/session-plugin/test/unit/codec/crypto.test.ts`                    | `codec/crypto.ts`                                                 | **Real `crypto.subtle`, no fake.** `seal`/`open` round-trip in both modes; a flipped ciphertext byte yields `null` (tamper); a `'sign'` envelope rejected in `'encrypt'` mode and the reverse; rotation — an old-key cookie opens while the key is still listed and stops once dropped; two secrets produce different `kid`s |
| `packages/session-plugin/test/unit/codec/timing-safe.test.ts`               | `codec/timing-safe.ts`                                            | Equal arrays `true`; differing length `false` without indexing past the end; same length differing content `false`                                                                                                                                                                                                           |
| `packages/session-plugin/test/unit/secret/secret-resolver.test.ts`          | `secret/secret-resolver.ts`                                       | All four branches: injected `secret`; `ISecretManager.get` success; `get` **throwing** → env fallback; neither → `SessionSecretMissingError`. Short secret rejected. `string` and `string[]` both normalise to a key list                                                                                                    |
| `packages/session-plugin/test/unit/services/session.test.ts`                | `services/session.ts`                                             | `get`/`set`/`has`/`delete`/`clear` and dirty tracking (a `get` alone leaves it clean); `regenerate()` new id + data kept; `destroy()` clears and marks deleted; expired `exp` → empty session; `idleTimeoutMs` against a `seen` stamp; injected clock, so no `Date.now()`                                                    |
| `packages/session-plugin/test/unit/services/session-service.test.ts`        | `services/session-service.ts`, `services/get-session.ts`          | `from(ctx)` returns the instance the middleware stored; `getSession(ctx)` returns the identical instance; both throw `SessionMiddlewareMissingError` when `ctx.state` is empty; both strategies load and commit                                                                                                              |
| `packages/session-plugin/test/unit/stores/memory-session-store.test.ts`     | `stores/memory-session-store.ts`                                  | `read`/`write`/`destroy`; a TTL-expired entry reads `null`; the sweep evicts; `close()` clears the timer (asserted via an injected timer seam, so no real wall-clock wait)                                                                                                                                                   |
| `packages/session-plugin/test/unit/stores/cache-session-store.test.ts`      | `stores/cache-session-store.ts`                                   | Against a fake `ICacheStore` **recording calls**: `write(id, data, 7200_000)` arrives as `set(key, value, 7200)` — the ms→s conversion asserted, not assumed; prefixed keys; `delete` on destroy; a `get` returning `null` yields `null`                                                                                     |
| `packages/session-plugin/test/unit/middleware/session-middleware.test.ts`   | `middleware/session-middleware.ts`                                | No cookie → fresh session; valid cookie → restored data; tampered cookie → fresh session and no throw; clean session → **no** `Set-Cookie`; dirty → exactly one; `rolling: true` → one on every response                                                                                                                     |
| `packages/session-plugin/test/unit/middleware/csrf-form-middleware.test.ts` | `middleware/csrf-form-middleware.ts`                              | Safe methods pass untouched; missing/blank/wrong token → 403 and a **short-circuit assertion that the handler never ran**; correct token passes; `headerName` accepted when configured; `getCsrfToken` mints once and is stable within a session                                                                             |
| `packages/session-plugin/test/unit/errors.test.ts`                          | `errors.ts`                                                       | Each error's `name`, `message`, and `instanceof Error`                                                                                                                                                                                                                                                                       |
| `packages/session-plugin/test/integration/plugin-registration.test.ts`      | `plugin/session-plugin.ts`                                        | Real kernel app: service resolvable under `CAPABILITIES.SESSION`; middleware at 260 and 275; health indicator registered and degraded when the store reports unhealthy; short secret fails `register()`; `csrf` absent → no CSRF middleware; `onClose` stops the sweep                                                       |
| `packages/session-plugin/test/integration/session-commit.test.ts`           | `middleware/session-middleware.ts`, `services/session-service.ts` | Through `inject()`: write on one request, **read it back** on the next with the returned cookie; a streaming response still carries the `Set-Cookie`; a second plugin's cookie survives alongside it; the **non-default** `mode: 'sign'` configuration drives the same script                                                |
| `packages/session-plugin/test/integration/store-strategy.test.ts`           | `services/session-service.ts`, both stores                        | One read/write/destroy/regenerate script run against the cookie strategy, `'memory'`, and an injected fake, asserting identical observable behavior; `regenerate` deletes the old store row                                                                                                                                  |
| `packages/session-plugin/test/integration/load-context-bridge.test.ts`      | `services/get-session.ts`                                         | A fake `populateLoadContext` receives the identical `ISession` instance the handler sees, proving §3.12 is one implementation and not two                                                                                                                                                                                    |
| `packages/session-plugin/test/e2e/form-post.test.ts`                        | end-to-end                                                        | Real kernel app: `GET` a form page (token minted into the session), `POST` it back with cookie + field → accepted; the same `POST` with a stale token from a different session → 403; ordering relative to the stateless CSRF proven                                                                                         |

No file in this milestone loads an npm package, so the guarded real-import test that external-dep
code requires does not apply. The `runtime.subtle` path is the analogous risk and is covered by
`codec/crypto.test.ts` running against **real** Web Crypto rather than a fake, per the "exercise the
REAL path once" rule.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m48-session-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Additionally, before reporting done:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/session-plugin/src packages/common/src/cookie.ts   # must be empty
grep -rn "Deno.test" packages/session-plugin/test             # must be empty
```

## 8. Risks & mitigations

- A `Set-Cookie` appended after the handler ran could be dropped by an adapter that snapshots early
  → the mechanism is verified at `kernel/src/context/response.ts:33-36` and
  `common/src/http.ts:182-185`, and `session-commit.test.ts` asserts it through `inject()` including
  the streaming case, so a regression fails a test rather than silently losing sessions.
- A cookie-strategy session larger than the ~4 KB browser cookie limit would be silently truncated
  by the client → the commit path measures the serialized header and throws a clear error above a
  configurable threshold, rather than emitting a cookie the browser will discard. Covered in
  `session-middleware.test.ts`.
- `CacheSessionStore` shares a cache with application data, so a `clear()` elsewhere would log
  everyone out → the store namespaces every key with a prefix, and the README states plainly that a
  shared cache means a shared blast radius and that a dedicated cache instance is the production
  recommendation.
- HKDF is available in Deno's Web Crypto, but a runtime lacking it would fail at first request → key
  derivation happens once during `register()`, so an unsupported runtime fails at startup with a
  named error instead of per request.
- `'sign'` mode leaves the payload readable, and a user could pick it for the cookie strategy while
  storing real claims → the JSDoc and README state that `'sign'` exposes its payload and is intended
  for the store strategy's opaque id; `'encrypt'` remains the default so the insecure choice is
  never the accidental one.

## 9. Out of scope

- **OAuth/OIDC login flows and the short-lived state cookie.** The reference's
  `microsoft-oauth-state.server.ts` signs an OIDC state cookie with the session secret. This
  milestone ships the secret resolution and the cookie codec such a flow would use, but no OAuth
  milestone exists yet; a reader expecting "sessions" to include social login gets the primitives,
  not the flow.
- **Flash messages.** The conventional companion to server-rendered sessions
  (`session.flash('error', …)` consumed once on the next render). Deliberately deferred: it is a
  read-once semantic on top of `ISession`, and adding it now would ship a method with no consumer in
  the tree until M36c has a UI to render it.
- **Cluster-wide session enumeration and forced logout of a single user.** Requires an index from
  user id to session ids that neither `ICacheStore` nor the cookie strategy can provide; belongs
  with the presence milestone that M47 already deferred a cluster-wide `size` to.
- **Centralising `MIDDLEWARE_PRIORITY` into `common`.** `http-security-plugin` keeps its own local
  copy (C4); unifying them is an approved-refactor question, not this milestone's.
- **The React Router app skeleton** that consumes this (M36c) and **parameter-level decorator
  injection** (M36b).

---

## 10. Deviations from this plan during implementation (recorded at archival)

The plan held up in substance; five things changed in the doing, each for a reason found in source.

1. **`getCsrfToken(session)` became `getCsrfToken(ctx)`.** Minting needs a random source, and a bare
   `ISession` has none. Taking `ctx` lets it resolve `CAPABILITIES.RUNTIME` for `randomBytes` under
   that token's own documented interface, instead of reaching through the session service and
   violating the token↔interface binding rule.
2. **`signBytes` was cut before it shipped.** §3.9 stores the token in session data, which the
   session's own encryption already authenticates, so a detached signature had no consumer — dead
   surface by the rule, removed rather than exported.
3. **Two files were added and one renamed.** `src/options.ts` owns option resolution, so the plugin
   and the service read one resolved shape without importing each other; `src/csrf/token.ts` and
   `src/csrf/verify.ts` split minting from verification, which is what let `verifyCsrfToken` become
   a public entry point sharing one implementation with the middleware (a React Router action
   conventionally validates inline rather than via middleware). `toBuffer` was added to
   `codec/envelope.ts` — a deliberate local copy of auth-plugin's internal helper, per the M30b
   `pemToDer` precedent, because Web Crypto's `BufferSource` rejects `Uint8Array<ArrayBufferLike>`.
4. **A fifth error type, `SessionTooLargeError`, was added.** §8 named the oversized-cookie risk but
   left the mechanism implicit; it needed a named error to be a real mitigation rather than a note.
5. **A sixth doc conflict (C6) surfaced.** `decorator-plugin`'s `parseCookies` does not
   percent-decode, does not strip quoting, and is last-occurrence-wins, so delegating to the correct
   codec changes published behaviour. Shipped as a CHANGELOG'd defect fix rather than duplicating
   the parser (§11.1) or adding a decode toggle nobody would want, following the M14d/M30b precedent
   for deliberate corrections during `0.1.x`.

Not deviations, but worth recording: the `IRequest.cookies` widening the ROADMAP floated was
**declined** (C2) and no `common` interface was widened at all; every planned test file was written,
plus `options.test.ts` and `errors.test.ts` that the plan's table did not name.
