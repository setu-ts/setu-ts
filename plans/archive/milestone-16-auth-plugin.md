# Milestone 16 — Auth Plugin (`@hono-enterprise/auth-plugin`)

> **Status:** Planning. Branch: `feat/m16-auth-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Tooling note (read before review).** This pass was produced in an Architect session with file
> tools only — no shell was available, so `git branch --show-current` and `deno task check:plan`
> could not be executed by the assistant. The plan was authored to satisfy
> [`scripts/plan-lint.ts`](scripts/plan-lint.ts) by construction (all nine required section headings
> present; no template placeholders; no undecided-alternative markers; only the one canonical plan
> file at `plans/` root). The human reviewer must (1) confirm or create the branch per Step 0 below,
> and (2) run `deno task check:plan` and paste the output; any lint finding is fixed as a plan
> first.

## 0. Objective & scope

Milestone 16 adds the authentication and authorization capability to the **existing** (currently
stub) [`@hono-enterprise/auth-plugin`](packages/auth-plugin/src/index.ts) package, plus the
committed contracts it must implement that are **missing from `common` today**. The plugin registers
three services against already-existing tokens: an
[`IJwtService`](packages/common/src/services/auth.ts:50) (JWT sign/verify/decode, HS256 + RS256 via
Web Crypto) under [`CAPABILITIES.JWT`](packages/common/src/tokens.ts:61), a new
[`IAuthService`](packages/common/src/services/auth.ts:1) under
[`CAPABILITIES.AUTH`](packages/common/src/tokens.ts:57), and a new
[`IAuthorizationService`](packages/common/src/services/auth.ts:1) (RBAC with role hierarchy) under
[`CAPABILITIES.AUTHORIZATION`](packages/common/src/tokens.ts:59). Authentication runs passive
strategies (JWT bearer token, API key) and populates
[`ctx.request.user`](packages/common/src/http.ts:47); authorization is enforced by guard middleware
factories (`requireAuth`, `requireRole`, `requirePermission`, `requireAnyRole`,
`requireAllPermissions`, `publicRoute`) that short-circuit with 401/403. A `PasswordHasher`
(PBKDF2-SHA256 via Web Crypto) supports the Local login flow.

This milestone is deliberately **phased** (mirrors the M14 → M14b and M15 → M15b splits the user
approved): M16 ships the auth core; the **Refresh-token strategy** and **rate limiting** are
deferred to **M16b** (§9). JWT itself needs no library — every cryptographic primitive (HMAC,
RSASSA-PKCS1-v1_5, PBKDF2, `importKey`) goes through
[`runtime.subtle`](packages/common/src/runtime.ts:140) and
[`runtime.randomBytes`](packages/common/src/runtime.ts:138), so the package adds **zero npm
dependencies** and is cross-runtime by construction (AI_GUIDELINES §4).

- **In scope:**
  - `common` changes (§2 C1, C2): make [`IRequest.user`](packages/common/src/http.ts:47) writable so
    auth middleware can populate it (the field is `readonly` today, so the `PUBLIC_API` example
    `ctx.request.user = user` does not even type-check, and the shipped
    [`@CurrentUser`](packages/decorator-plugin/src/resolvers/parameter-resolver.ts:124) decorator
    depends on it being set); add the missing committed contracts `IAuthService` / `IAuthStrategy` /
    `IAuthorizationService` + RBAC config types to
    [`auth.ts`](packages/common/src/services/auth.ts:1) and export them.
  - `JwtService implements IJwtService` — HS256 and RS256 via
    [`runtime.subtle`](packages/common/src/runtime.ts:140); `sign` honors
    [`JwtSignOptions`](packages/common/src/services/auth.ts:30) (`expiresIn`/`audience`/`issuer`),
    `verify` checks signature + `exp`/`nbf`/`aud`/`iss`, `decode` parses without verifying.
  - `AuthService implements IAuthService` — runs the configured passive strategies in order
    (`authenticate`); exposes `verifyCredentials` for the Local login flow.
  - `JwtStrategy` / `ApiKeyStrategy` (passive `IAuthStrategy` implementations) + `LocalStrategy`
    (holds the app-supplied credential verifier).
  - `RbacService implements IAuthorizationService` — role-hierarchy resolution + permission checks.
  - `PasswordHasher` — PBKDF2-SHA256 hash/verify via Web Crypto.
  - Guards (`requireAuth`, `requireRole`, `requirePermission`, `requireAnyRole`,
    `requireAllPermissions`, `publicRoute`) + `authMiddleware`.
  - `AuthPlugin(options): IPlugin` factory mirroring the
    [`MessagingPlugin`](packages/messaging-plugin/src/plugin/messaging-plugin.ts:74) wiring
    (register services, `onClose` cleanup).
  - Barrel exports + per-file unit tests + one integration test + fixtures, all at the per-file 90%
    bar.
  - Documentation corrections in `PUBLIC_API.md`, `ROADMAP.md`, `ARCHITECTURE.md`, and a package
    `README.md`, in the **same PR** (resolving the §2 conflicts).

- **NOT this milestone:**
  - `RefreshTokenStrategy` — deferred to **M16b**. Refresh is a thin layer over
    `sign({ expiresIn })` plus a server-side store, which is a coherent follow-up exactly as the
    messaging brokers were split M14 → M14b (§9).
  - Rate limiting (`rate-limit-middleware.ts` + storage) — deferred to **M16b**. `PUBLIC_API.md`
    itself shows rate limiting as a _separate_ plugin ([`PUBLIC_API.md:2557`](PUBLIC_API.md)), and
    it is a transport-security concern rather than identity; the user-approved phasing moves it out
    of M16 (§2 C3, §9).
  - An injected/lazy JWT **library** (`jose`, `jsonwebtoken`) — not used; Web Crypto covers
    HS256/RS256 with no dependency (§3.1).
  - OAuth2 / OIDC, SAML, session/cookie stores, MFA, passkeys — never in the M16 contract; future
    milestones (§9).
  - A live external secrets store for API keys — the app supplies the `apiKey.validate` callback; no
    store ships in the plugin (§3.4).

## 1. Contracts verified from SOURCE (not names)

Every reference below was opened in the committed source and cited at file:line. The committed
contract is the truth, not the aspirational `PUBLIC_API.md` Auth section (§2 C2).

| Reference                                         | Source (file:line)                                                                                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IJwtService`                                     | [`packages/common/src/services/auth.ts:50`](packages/common/src/services/auth.ts)                                                                                  | Exactly `sign(payload: Readonly<Record<string, unknown>>, options?: JwtSignOptions): Promise<string>` (:58), `verify<T>(token: string): Promise<T>` (:67), `decode<T>(token: string): T \| null` (:76). No `signRefresh`, no `signWithKey`, no algorithm argument — `PUBLIC_API.md`'s `auth.jwt.signRefresh()` ([`PUBLIC_API.md:878`](PUBLIC_API.md)) does **not** exist and is **not** added (refresh uses `sign({ expiresIn })`, §2 C2). `JwtService` implements exactly this.                                                        |
| `JwtSignOptions`                                  | [`packages/common/src/services/auth.ts:30`](packages/common/src/services/auth.ts)                                                                                  | Only `readonly expiresIn?: string`, `readonly audience?: string`, `readonly issuer?: string`. `sign` maps these to `exp`/`aud`/`iss` claims; `verify` enforces them when the service is configured with expected `aud`/`iss`.                                                                                                                                                                                                                                                                                                           |
| `IPrincipal`                                      | [`packages/common/src/services/auth.ts:14`](packages/common/src/services/auth.ts)                                                                                  | `readonly id: string`, `roles?: readonly string[]`, `permissions?: readonly string[]`, `claims?: Readonly<Record<string, unknown>>`. Strategies build one of these; `RbacService` reads `roles`/`permissions`; guards read it via `IAuthorizationService`.                                                                                                                                                                                                                                                                              |
| `IRequest.user`                                   | [`packages/common/src/http.ts:47`](packages/common/src/http.ts)                                                                                                    | `readonly user?: IPrincipal` today — **`readonly` is the defect** (§2 C1): auth middleware cannot assign it, yet `@CurrentUser` reads it. The runtime request builders ([`node-http-mapping.ts:48`](packages/runtime/src/adapters/node/node-http-mapping.ts), [`deno-http-mapping.ts:29`](packages/runtime/src/adapters/deno/deno-http-mapping.ts), [`bun-http-mapping.ts:29`](packages/runtime/src/adapters/bun/bun-http-mapping.ts)) never set `user`. M16 makes the field writable; builders still omit it; auth middleware sets it. |
| `@CurrentUser` reads `request.user`               | [`packages/decorator-plugin/src/resolvers/parameter-resolver.ts:124`](packages/decorator-plugin/src/resolvers/parameter-resolver.ts)                               | `return ctx.request.user;` — the shipped M9 decorator depends on the principal living at `ctx.request.user`. This forces the §2 C1 resolution (writable field) over any `ctx.state` alternative.                                                                                                                                                                                                                                                                                                                                        |
| Kernel avoids mutating readonly via cast          | [`packages/kernel/src/context/request-context.ts:31`](packages/kernel/src/context/request-context.ts)                                                              | `params` uses a getter-over-slot + `setParams` mutator "to avoid mutating a `readonly` field via a cast" (:32-34). There is **no** principal mutator on the handle, so a plugin cannot reuse that pattern — the writable-field fix (§2 C1) is the only cast-free path for the auth plugin.                                                                                                                                                                                                                                              |
| `IRequestContext`                                 | [`packages/common/src/http.ts:162`](packages/common/src/http.ts)                                                                                                   | `readonly request: IRequest` (:166), `readonly services: IServiceRegistry` (:170), `readonly state: Map<string, unknown>` (:176). Guards resolve `IAuthorizationService` via `ctx.services.get`; auth middleware sets `ctx.request.user`.                                                                                                                                                                                                                                                                                               |
| `MiddlewareFunction` / short-circuit              | [`packages/common/src/http.ts:205`](packages/common/src/http.ts)                                                                                                   | `(ctx, next) => void \| HandlerResult \| Promise<…>`. Not calling `next()` short-circuits (:182-187); guards return a 401/403 `HandlerResult` and skip `next()` (CLAUDE.md short-circuit-test mandate, §3.7).                                                                                                                                                                                                                                                                                                                           |
| `CAPABILITIES` (auth tokens)                      | [`packages/common/src/tokens.ts:57`](packages/common/src/tokens.ts)                                                                                                | `AUTH: 'authentication'` (:57), `AUTHORIZATION: 'authorization'` (:59), `JWT: 'jwt'` (:61) — all three already exist and pass the grammar. No new token needed.                                                                                                                                                                                                                                                                                                                                                                         |
| `createCapabilityToken` grammar                   | [`packages/common/src/tokens.ts:139`](packages/common/src/tokens.ts)                                                                                               | lowercase kebab segments + dot namespacing; colons illegal. M16 uses only the three bare tokens (auth is single-instance — no `name` option, §3.8).                                                                                                                                                                                                                                                                                                                                                                                     |
| `IRuntimeServices` (crypto / clock)               | [`packages/common/src/runtime.ts:138`](packages/common/src/runtime.ts)                                                                                             | `randomBytes(length): Uint8Array` (:138), `subtle: SubtleCrypto` (:140), `now(): number` (:147 — wall-clock epoch ms, for `exp`/`nbf`), `hrtime()` (:154 — monotonic). All JWT/password crypto and timestamp checks go through these — no `crypto.`/`Date.now()` in `src/` (CLAUDE.md "Never mix clocks"; AI_GUIDELINES §4).                                                                                                                                                                                                            |
| `IPlugin` / `IPluginContext`                      | [`packages/common/src/plugin.ts`](packages/common/src/plugin.ts)                                                                                                   | `IPlugin`: `name`, `version`, `provides?`, `priority?`, `register(ctx): void \| Promise<void>`. `IPluginContext`: `services`, `middleware` (:via MessagingPlugin precedent), `lifecycle.onClose(fn)`. `AuthPlugin.register()` wires services + `onClose` cleanup, mirroring [`messaging-plugin.ts:74`](packages/messaging-plugin/src/plugin/messaging-plugin.ts:74).                                                                                                                                                                    |
| `MessagingPlugin` wiring precedent                | [`packages/messaging-plugin/src/plugin/messaging-plugin.ts:74`](packages/messaging-plugin/src/plugin/messaging-plugin.ts)                                          | Factory → `IPlugin`; `ctx.services.register<IToken>(token, service)`; health via a service readiness check; `ctx.lifecycle.onClose(...)` disconnect/cleanup. `AuthPlugin` reuses this shape (no transport to `connect`, but `onClose` clears cached keys).                                                                                                                                                                                                                                                                              |
| Re-export precedent                               | [`packages/messaging-plugin/src/index.ts:53`](packages/messaging-plugin/src/index.ts) / [`packages/queue-plugin/src/index.ts`](packages/queue-plugin/src/index.ts) | Plugin factory + option types + the `common` contract types are barrel-exported; concrete service classes that the plugin instantiates (`JwtService`/`AuthService`/`RbacService`) stay **internal** like the messaging broker classes initially were; `PasswordHasher` is exported because app authors use it directly (§4).                                                                                                                                                                                                            |
| AI_GUIDELINES: runtime / no-any / secure defaults | [`AI_GUIDELINES.md:218`](AI_GUIDELINES.md) (§4), [`:278`](AI_GUIDELINES.md) (§5.2), [`:736`](AI_GUIDELINES.md) (§13.4)                                             | No runtime-specific APIs in plugins; web-standard crypto only; no `any`; secure defaults — HS256 only when a strong secret is supplied, RS256 for asymmetric; tokens rejected on any verify failure.                                                                                                                                                                                                                                                                                                                                    |
| ROADMAP M16 scope                                 | [`ROADMAP.md:1885`](ROADMAP.md)                                                                                                                                    | Deliverables: AuthPlugin; JWT/API Key/Local/Refresh strategies; RBAC with role hierarchy; guard factories; rate limiting; coverage. M16 ships JWT + API Key + Local + RBAC + guards + hashing; **Refresh + rate limiting split to M16b** (§2 C3/C4, §9).                                                                                                                                                                                                                                                                                |
| PUBLIC_API Auth (aspirational)                    | [`PUBLIC_API.md:814`](PUBLIC_API.md)                                                                                                                               | Documents `AuthenticationPlugin`, `IAuthService` (not in `common`), `auth.jwt.signRefresh()` (not in `IJwtService`), RBAC + rate-limit options. Rewritten to the committed/source surface (§2 C2); naming reconciled to `AuthPlugin` (§2 C5).                                                                                                                                                                                                                                                                                           |
| ARCHITECTURE auth row                             | [`ARCHITECTURE.md:1229`](ARCHITECTURE.md)                                                                                                                          | "JWT library optional (injected or lazy via `npm:`)" — M16 chooses **no library** (Web Crypto). Public API `AuthenticationPlugin()`/`IAuthService`/`IJwtService`/guards — reconciled naming to `AuthPlugin` and adds `IAuthorizationService` (§2 C5).                                                                                                                                                                                                                                                                                   |
| `deno.lock` (no crypto dep)                       | [`deno.lock`](deno.lock)                                                                                                                                           | No `jose`/`jsonwebtoken`/`bcrypt` entry. M16 adds none — all crypto is the built-in Web Crypto exposed by `runtime.subtle`.                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Doc deliverable (same PR)                                                                                                    |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1 | [`IRequest.user`](packages/common/src/http.ts:47) is `readonly`, so the `PUBLIC_API.md` example `ctx.request.user = user` does not type-check, and the shipped [`@CurrentUser`](packages/decorator-plugin/src/resolvers/parameter-resolver.ts:124) decorator (which returns `ctx.request.user`) can never be populated by a plugin. The kernel ([`request-context.ts:31`](packages/kernel/src/context/request-context.ts:31)) deliberately avoids casting `readonly` fields and exposes no principal mutator.                                                                                                                                                                                    | Make `user` the **one** writable field on `IRequest`: `user?: IPrincipal` (drop `readonly` on that property only — all other `IRequest` fields stay `readonly`). Auth middleware then assigns `ctx.request.user = principal` with no cast. This matches the documented behavior, makes `@CurrentUser` work, and follows the kernel's "no casting readonly" convention.                                                                                                                               | `packages/common/src/http.ts` edit + `PUBLIC_API.md` note (IRequest shape) (same PR).                                        |
| C2 | `PUBLIC_API.md` Auth section ([`PUBLIC_API.md:814`](PUBLIC_API.md)) references `IAuthService` (absent from `common`), `auth.jwt.signRefresh()` (absent from [`IJwtService`](packages/common/src/services/auth.ts:50)), and a richer surface than the committed contract.                                                                                                                                                                                                                                                                                                                                                                                                                         | **Source/common is the truth.** Add `IAuthService`, `IAuthStrategy`, `IAuthorizationService`, and RBAC config types (`RoleDefinition`, `RbacConfig`) to [`auth.ts`](packages/common/src/services/auth.ts:1) and export them. Do **not** add `signRefresh` — refresh is `sign({ expiresIn: '7d' })`. Rewrite the `PUBLIC_API.md` Auth section to the committed `IAuthService`/`IJwtService`/`IAuthorizationService` surface, real option names, and the `authenticate`/`verifyCredentials`/guard API. | `packages/common/src/services/auth.ts` + `index.ts`; `PUBLIC_API.md` Auth rewrite (same PR).                                 |
| C3 | Rate limiting is a listed M16 deliverable in `ROADMAP.md` ([`:1908`](ROADMAP.md)) and an `auth-plugin` responsibility in `ARCHITECTURE.md` ([`:1234`](ARCHITECTURE.md), [`:2013`](ARCHITECTURE.md)), but `PUBLIC_API.md`'s "how to write a plugin" example shows a **separate** `RateLimitPlugin` ([`PUBLIC_API.md:2557`](PUBLIC_API.md)).                                                                                                                                                                                                                                                                                                                                                       | The user-approved phasing moves rate limiting to **M16b** (it is transport-level, not identity). M16 ships no rate-limit code. Reconcile all three docs to state rate limiting (and the refresh strategy) land in M16b, mirroring the M14 → M14b messaging split.                                                                                                                                                                                                                                    | `ROADMAP.md` M16 reconcile + M16b sub-section; `ARCHITECTURE.md` auth row note; `PUBLIC_API.md` Auth section note (same PR). |
| C4 | `ROADMAP.md` M16 deliverables include the `RefreshTokenStrategy` ([`:1954`](ROADMAP.md)) and rate limiting; the committed [`IJwtService`](packages/common/src/services/auth.ts:50) has no refresh surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Refresh needs a server-side token store and is a clean follow-up; defer to **M16b**. Refresh access tokens are minted with the existing `sign({ expiresIn })`, so M16b needs no `common` change. Add an M16b sub-section to `ROADMAP.md`.                                                                                                                                                                                                                                                            | `ROADMAP.md` M16b sub-section (same PR).                                                                                     |
| C5 | Naming clash: `PUBLIC_API.md` ([`:821`](PUBLIC_API.md)) and `ARCHITECTURE.md` ([`:1236`](ARCHITECTURE.md)) call the factory `AuthenticationPlugin()`; `ROADMAP.md` code ([`:1894`](ROADMAP.md)) calls it `AuthPlugin({...})`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Pick **`AuthPlugin`** — it matches the package name `@hono-enterprise/auth-plugin`, the `ROADMAP.md` code example, and AI_GUIDELINES §10.4 (`XxxPlugin`). Reconcile `PUBLIC_API.md`/`ARCHITECTURE.md` from `AuthenticationPlugin` → `AuthPlugin`.                                                                                                                                                                                                                                                    | `PUBLIC_API.md` + `ARCHITECTURE.md` factory rename (same PR).                                                                |
| C6 | The `ROADMAP.md` M16 **programmatic-API code block** contradicts the committed contract two ways: it treats guards as **service methods** — `auth.requireRole('admin')` ([`:1938`](ROADMAP.md)), `auth.requirePermission('users:delete')` ([`:1944`](ROADMAP.md)) — and shows `const token = await auth.authenticate(ctx.request)` ([`:1931`](ROADMAP.md)) as if `authenticate` returned a signable token, whereas the committed [`IAuthService.authenticate`](packages/common/src/services/auth.ts:1) resolves to `IPrincipal \| null`. The same file's "Guards (as middleware factories)" list ([`:1956`](ROADMAP.md)) already contradicts its own code block by listing free-function guards. | **Committed contract + free-function guards win** (consistent with §3.3, §3.7, §4). Guards are standalone `MiddlewareFunction` factories imported from the plugin (`requireRole('admin')`), **not** methods on `IAuthService`. The login flow is `verifyCredentials({ identifier, secret }) → IPrincipal`, then `IJwtService.sign(...)` — `authenticate` never returns a token. This is a same-PR rewrite of the ROADMAP **code block itself**, not only its prose.                                  | `ROADMAP.md` M16 programmatic-API code block rewrite (same PR, alongside the C3/C5 ROADMAP edits).                           |

No other committed-doc conflicts were found (checked the `ARCHITECTURE.md` auth flow
[`ARCHITECTURE.md:1937`](ARCHITECTURE.md) and middleware-priority table [`:1535`](ARCHITECTURE.md) —
consistent with the design once C3/C6 are reconciled).

## 3. Design decisions

### 3.1 JWT via Web Crypto (HS256 + RS256), zero npm dependencies

- **Decision:** `JwtService implements IJwtService` signs/verifies with
  [`runtime.subtle`](packages/common/src/runtime.ts:140): HS256 =
  `subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' })` + `subtle.sign`; RS256 =
  `subtle.importKey('spki'\|'pkcs8', derBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' })`
  - `subtle.sign`/`subtle.verify`, where `derBytes = pemToDer(pem, label)` (§5 `src/utils/pem.ts`) —
    the PEM armor is stripped and **standard**-base64-decoded, distinct from the base64url used for
    JWT segments. `sign(payload, options)` adds `iat` (`runtime.now()` ms→s), `exp`
    (`iat + parseDuration(expiresIn)`), `aud`, `iss`; base64url-encodes the `{ alg, typ }` header
    and payload, concatenates `header.payload`, signs, appends the signature. `verify<T>(token)`
    re-derives the signing key, `subtle.verify`s the signature, then enforces `exp`/`nbf` (against
    `runtime.now()`) and `aud`/`iss` (when the service is configured with expected values) and
    returns the payload typed `T`. `decode<T>` base64url-parses the payload without verifying (JSDoc
    warns it is not for authorization). No `jose`/`jsonwebtoken` import — ARCHITECTURE's "JWT
    library optional" is honored by choosing none.
- **Why:** Web Crypto is web-standard and identical across Deno/Node/Bun (AI_GUIDELINES §4), so the
  package stays dependency-free (AI_GUIDELINES §12.1, §14.4) and there is no inject-or-lazy seam or
  guarded real-import test to maintain — every branch is exercised directly with deterministic keys.
  The algorithm choice comes from `JwtOptions` (`HS256` when `secret` is set; `RS256` when
  `publicKey`/`privateKey` are set); supplying neither throws at registration.
- **Test home:** `test/unit/jwt-service.test.ts` — HS256 sign→verify round-trip; RS256 sign
  (private) → verify (public); tampered payload → verify rejects; expired (`exp` in the past via a
  fake clock) → rejects; `nbf`-future → rejects; wrong `aud`/`iss` → rejects; `decode` returns the
  payload and ignores tampering; malformed token → `decode` returns `null` / `verify` rejects.

### 3.2 Principal attachment — make `IRequest.user` writable (no cast)

- **Decision:** The auth middleware runs `IAuthService.authenticate(ctx.request)`; on a non-null
  principal it assigns `ctx.request.user = principal`. This requires the §2 C1 `common` edit (drop
  `readonly` on `user`). Guards and `@CurrentUser` then read `ctx.request.user`.
- **Why:** The shipped
  [`@CurrentUser`](packages/decorator-plugin/src/resolvers/parameter-resolver.ts:124) reads
  `ctx.request.user`, so the principal must live there (an alternative `ctx.state` flow would
  silently break that decorator). The kernel offers no principal mutator and forbids casting
  `readonly` fields ([`request-context.ts:32`](packages/kernel/src/context/request-context.ts:32)),
  so the only cast-free path is a writable field. Only `user` becomes writable; every other
  `IRequest` field stays `readonly`.
- **Test home:** `test/unit/auth-middleware.test.ts` asserts that after the middleware runs,
  `ctx.request.user` equals the authenticated principal (read back through the public surface), and
  is absent when no strategy matched.

### 3.3 The committed `IAuthService` / `IAuthStrategy` / `IAuthorizationService` contracts

- **Decision:** Added to [`auth.ts`](packages/common/src/services/auth.ts:1) (types only — `auth.ts`
  gains `import type { IRequest } from '../http.ts'`, a type-only edge that erases at runtime so no
  runtime cycle):
  - `IAuthStrategy { readonly name: string; authenticate(request: IRequest): Promise<IPrincipal | null> }`
    — the custom-strategy extension point.
  - `IAuthService { authenticate(request: IRequest): Promise<IPrincipal | null>; verifyCredentials(credentials: { readonly identifier: string; readonly secret: string }): Promise<IPrincipal | null> }`.
  - `RoleDefinition { readonly permissions?: readonly string[]; readonly inherits?: readonly string[] }`;
    `RbacConfig { readonly roles: Readonly<Record<string, RoleDefinition>> }`.
  - `IAuthorizationService { hasRole(principal, role): boolean; hasPermission(principal, permission): boolean; hasAnyRole(principal, roles): boolean; hasAllPermissions(principal, permissions): boolean }`.
    `AuthService` runs the **passive** strategies (`JwtStrategy`, `ApiKeyStrategy`) in configured
    order for `authenticate` — the first non-null principal wins, `null` if none match
    (unauthenticated). `verifyCredentials` delegates to `LocalStrategy` for the login flow.
    `RbacService` resolves the role hierarchy transitively before checking.
- **Why:** These are resolved-by-token services consumed across plugins/app code, so per the
  framework pattern (ports in `common`, §1) they are committed contracts — not plugin-internal.
  ARCHITECTURE already lists `IAuthService` as public API ([`:1236`](ARCHITECTURE.md)); M16 makes
  that true and adds the matching authorization contract for the existing `authorization` token.
  Passive-vs-Local split avoids the anti-pattern of reading the request body on every protected
  request (§3.4).
- **Test home:** `test/unit/auth-service.test.ts` (first-matching-strategy wins; null when all skip;
  `verifyCredentials` delegates); `test/unit/rbac-service.test.ts` (direct + inherited
  role/permission resolution, transitive hierarchy, `hasAnyRole`/`hasAllPermissions`).

### 3.4 Strategies — passive extractors vs. explicit Local login

- **Decision:** `JwtStrategy` (extracts `Bearer <token>` from the `authorization` header, calls
  `IJwtService.verify`, maps claims → `IPrincipal`) and `ApiKeyStrategy` (extracts the key from a
  configurable header, default `X-API-Key`, calls the app-supplied `apiKey.validate(key)`) are
  **passive** — registered in the `authenticate` chain; each returns `null` when its credential is
  absent so it is skipped. `LocalStrategy` is **not** passive: it holds the app-supplied
  `local.verify(identifier, secret)` callback and is reached only via
  `IAuthService.verifyCredentials` (a login handler calls it, then mints a JWT with
  `IJwtService.sign`). `LocalStrategy` does not implement `IAuthStrategy` (it has no header to
  extract) — it is an internal collaborator.
- **Why:** Running username/password verification on every protected request would consume the body
  before the handler and re-hash on each call. The passport-style split (passive header strategies
  on the chain; local invoked at the login route) is the standard, efficient model and keeps
  `authenticate` side-effect-free w.r.t. the body.
- **Test home:** `test/unit/jwt-strategy.test.ts` (bearer present → principal; absent → null; bad
  scheme → null); `test/unit/api-key-strategy.test.ts` (key present + validate resolves → principal;
  absent → null; validate rejects/returns null → null); `test/unit/local-strategy.test.ts` (`verify`
  delegates to the callback; null principal on miss).

### 3.5 RBAC with role hierarchy

- **Decision:** `RbacService implements IAuthorizationService`, constructed with `RbacConfig`.
  `hasRole(principal, role)` is true if `role` is in `principal.roles` or any principal role
  transitively `inherits` `role` (e.g. `admin` inherits `user` → a principal with `admin` satisfies
  `requireRole('user')`). `hasPermission(principal, permission)` is true if `permission` is in
  `principal.permissions` or any of the principal's (direct + inherited) roles grants it via
  `RoleDefinition.permissions`. Hierarchy resolution is memoized per service instance (built once at
  construction — the "hoist per-request work to registration time" rule, CLAUDE.md). Cycle-safe: a
  `visited` set guards the transitive walk; a self/cyclic `inherits` is ignored, not
  infinite-looped.
- **Why:** The committed `IPrincipal` already carries `roles`/`permissions`, but hierarchy needs the
  config; centralizing resolution in `IAuthorizationService` keeps guards DRY and testable.
- **Test home:** `test/unit/rbac-service.test.ts` — direct role/permission match; one- and
  multi-level inheritance; permission inherited through an inherited role; `hasAnyRole` (any-of) and
  `hasAllPermissions` (all-of); cyclic `inherits` does not hang and resolves the acyclic part.

### 3.6 Password hashing — PBKDF2-SHA256 via Web Crypto

- **Decision:** `PasswordHasher` (constructed with `IRuntimeServices`) exposes
  `hash(secret: string): Promise<string>` and
  `verify(stored: string, secret: string): Promise<boolean>`. `hash` draws a 16-byte salt from
  [`runtime.randomBytes`](packages/common/src/runtime.ts:138), derives 32 bytes with
  `subtle.deriveBits(PBKDF2(HMAC-SHA-256, iterations=100000), key, 256)`, and stores the PHC-like
  string `pbkdf2$<iterations>$<base64url(salt)>$<base64url(hash)>`. `verify` parses the stored
  string, re-derives with the same salt/iterations, and compares with a constant-time check
  (`subtle`-derived equal-length compare via a fixed-time loop, never `===` on the raw hash).
- **Why:** ARCHITECTURE mandates "password hashing via runtime crypto" ([`:1238`](ARCHITECTURE.md));
  PBKDF2-SHA256 is in Web Crypto, so no `bcrypt`/`argon2` dependency (cross-runtime, §12.2). It is
  an exported utility because app authors hash at provisioning and verify inside their
  `local.verify` callback.
- **Test home:** `test/unit/password-hasher.test.ts` — `hash` → `verify` round-trip; wrong secret →
  `false`; different salts → different stored strings; a tampered stored string (wrong format) →
  `verify` returns `false` (never throws).

### 3.7 Guards short-circuit (401/403), `publicRoute`, and the short-circuit test mandate

- **Decision:** Guards are `MiddlewareFunction` factories. `requireAuth()` reads `ctx.request.user`;
  absent → `ctx.response.status(401).json(...)` and **no `next()`**.
  `requireRole`/`requirePermission`/ `requireAnyRole`/`requireAllPermissions` resolve
  `IAuthorizationService` via `ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION)`,
  then: no principal → 401; principal present but the check fails → 403
  (`ctx.response.status(403).json(...)`, no `next()`); pass → `await next()`. `publicRoute()` always
  `await next()` (explicit opt-out, paralleling the `@Public` decorator interop). The auth
  middleware (`authMiddleware`) **always** `await next()` — it authenticates only; it never
  short-circuits (so an unauthenticated request still reaches guards).
- **Why:** Separates Authentication (populate `user`) from Authorization (enforce, short-circuit),
  matching [`ARCHITECTURE.md:422`](ARCHITECTURE.md). Resolving the authz service at request time
  (not import time) follows the "communicate via tokens" rule and lets a test swap the service.
- **Test home:** `test/unit/guards.test.ts` — each guard: pass case calls `next`; 401 case sets
  status and does **not** call `next` (a downstream spy asserts it was not invoked — the CLAUDE.md
  short-circuit mandate); 403 case likewise; `requireAnyRole`/`requireAllPermissions` all-of/any-of
  semantics; `publicRoute()` always continues. `test/unit/auth-middleware.test.ts` — sets `user` and
  calls `next` whether or not a principal was found.

### 3.8 Single-instance plugin (no `name` option), wiring, and `onClose`

- **Decision:** `AuthPlugin(options): IPlugin` builds `JwtService`, the strategies, `AuthService`,
  `RbacService`, `PasswordHasher`, and registers them under the three bare tokens
  (`jwt`/`authentication`/`authorization`) with
  `provides: ['jwt', 'authentication', 'authorization']`. There is **no** `name` option and no
  multi-instance support — unlike queue/messaging, auth has a single logical instance and a `name`
  option with no consumer would be dead surface (CLAUDE.md "every symbol must be read on a real code
  path"). `onClose` clears any cached imported keys. The plugin `name` is `auth-plugin`, `version`
  matches [`deno.json`](packages/auth-plugin/deno.json).
- **Why:** The kernel throws on a duplicate bare-token provider, so a second `AuthPlugin`
  registration fails fast — which is the correct behavior for auth. Declaring `provides` documents
  the capability surface for the resolver.
- **Test home:** `test/unit/auth-plugin.test.ts` — `register()` resolves `IJwtService` under `jwt`,
  `IAuthService` under `authentication`, `IAuthorizationService` under `authorization`; `provides`
  lists the three tokens; options with no `secret`/keys throw; `onClose` runs without error.

### 3.9 `expiresIn` parsing is a pure helper

- **Decision:** `parseDuration(value: string): number` (internal, in `src/utils/duration.ts`) parses
  `expiresIn` strings (`"30s"`, `"5m"`, `"1h"`, `"7d"`, or a bare integer-as-seconds) to
  milliseconds; throws on an unparseable value. Used only by `JwtService.sign`.
- **Why:** A pure, deterministic helper is trivially unit-testable to full branch coverage and keeps
  the JWT file focused on crypto.
- **Test home:** `test/unit/duration.test.ts` — each unit, bare-integer seconds, and an invalid
  value throwing.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                         | Kind                       | Consumer / real code path that READS it                                                              |
| ------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `AuthPlugin`                                                                                            | factory (fn)               | `app.register(AuthPlugin({ … }))` — user entry point; returns `IPlugin`.                             |
| `AuthPluginOptions`                                                                                     | type                       | The `AuthPlugin(options)` parameter; user-typed config (jwt/apiKey/local/rbac sections).             |
| `JwtOptions`                                                                                            | type                       | `AuthPluginOptions.jwt`; consumed by `JwtService` construction + `JwtStrategy`.                      |
| `ApiKeyOptions`                                                                                         | type                       | `AuthPluginOptions.apiKey`; consumed by `ApiKeyStrategy`.                                            |
| `LocalOptions`                                                                                          | type                       | `AuthPluginOptions.local`; consumed by `LocalStrategy` / `AuthService.verifyCredentials`.            |
| `RbacConfig`                                                                                            | type                       | `AuthPluginOptions.rbac`; consumed by `RbacService`; also re-exported from `common` for app authors. |
| `RoleDefinition`                                                                                        | type                       | `RbacConfig.roles` values; re-exported from `common`.                                                |
| `PasswordHasher`                                                                                        | class                      | App provisioning code (`hash`) and the app-supplied `local.verify` callback (`verify`).              |
| `authMiddleware`                                                                                        | fn                         | `app.middleware.add(authMiddleware())` — global authentication that populates `ctx.request.user`.    |
| `requireAuth`                                                                                           | fn                         | `middleware: [requireAuth()]` on protected routes.                                                   |
| `requireRole`                                                                                           | fn                         | `middleware: [requireRole('admin')]`.                                                                |
| `requirePermission`                                                                                     | fn                         | `middleware: [requirePermission('users:write')]`.                                                    |
| `requireAnyRole`                                                                                        | fn                         | `middleware: [requireAnyRole(['admin','manager'])]`.                                                 |
| `requireAllPermissions`                                                                                 | fn                         | `middleware: [requireAllPermissions(['users:read','users:write'])]`.                                 |
| `publicRoute`                                                                                           | fn                         | `middleware: [publicRoute()]` explicit bypass (parallels `@Public`).                                 |
| `IAuthService`, `IJwtService`, `IAuthorizationService`, `IAuthStrategy`, `IPrincipal`, `JwtSignOptions` | re-exported `common` types | Consumers import contracts from the plugin package (messaging/queue precedent).                      |

**Intentionally not exported** (internal, resolved by token or plugin-private): `JwtService`,
`AuthService`, `RbacService`, `JwtStrategy`, `ApiKeyStrategy`, `LocalStrategy`, and `parseDuration`
(`parseDuration` is exported from its **file** for direct unit test, not from the barrel).

### 4.1 Options — every option names its consumer

| Option                             | Consumer                                          | Behavior (per implementation)                                                          |
| ---------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `jwt.secret`                       | `JwtService` (HS256 key)                          | string/Uint8Array → HS256 signing+verify key. Required for HS256.                      |
| `jwt.privateKey` / `jwt.publicKey` | `JwtService` (RS256 keys)                         | PEM strings → RS256 sign (private) / verify (public). Required for RS256.              |
| `jwt.algorithm`                    | `JwtService` key selection                        | `'HS256' \| 'RS256'`; inferred from which key is set when omitted.                     |
| `jwt.audience` / `jwt.issuer`      | `JwtService.verify`                               | Expected `aud`/`iss`; verify rejects on mismatch when set.                             |
| `jwt.header` / `jwt.scheme`        | `JwtStrategy` extraction                          | Header name (`authorization`) + scheme (`bearer`) to extract the token.                |
| `apiKey.header`                    | `ApiKeyStrategy` extraction                       | Header holding the key; default `X-API-Key`.                                           |
| `apiKey.validate`                  | `ApiKeyStrategy`                                  | `(key) => Promise<IPrincipal \| null>` — app-supplied lookup.                          |
| `local.verify`                     | `LocalStrategy` / `AuthService.verifyCredentials` | `(identifier, secret) => Promise<IPrincipal \| null>` — app-supplied credential check. |
| `rbac.roles`                       | `RbacService`                                     | `Record<string, RoleDefinition>` — role→permissions and `inherits` hierarchy.          |

No option is declared without a reader. There is deliberately **no** `name` option (§3.8), no
`rateLimit` option (deferred to M16b, §2 C3), and no `refresh` option (M16b, §2 C4). Option objects
in `register()` are built by assigning only defined values (mirrors
[`messaging-plugin.ts:107`](packages/messaging-plugin/src/plugin/messaging-plugin.ts:107)) to
satisfy `exactOptionalPropertyTypes` ([`deno.json:57`](deno.json)).

## 5. Implementation files

| File                                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                             | Drop `readonly` on `IRequest.user` (§2 C1). One-line surgical edit.                                                                                                                                                                                                                                                                                                       |
| `packages/common/src/services/auth.ts`                    | Add `IAuthService`, `IAuthStrategy`, `IAuthorizationService`, `RoleDefinition`, `RbacConfig` (§2 C2, §3.3). Types only.                                                                                                                                                                                                                                                   |
| `packages/common/src/index.ts`                            | Export the new auth types.                                                                                                                                                                                                                                                                                                                                                |
| `packages/auth-plugin/src/interfaces/index.ts`            | `AuthPluginOptions`, `JwtOptions`, `ApiKeyOptions`, `LocalOptions`, `RbacConfig`/`RoleDefinition` re-export; types-only, no runtime branches.                                                                                                                                                                                                                             |
| `packages/auth-plugin/src/utils/duration.ts`              | `parseDuration(value): number` — pure `expiresIn` parser.                                                                                                                                                                                                                                                                                                                 |
| `packages/auth-plugin/src/utils/base64url.ts`             | `encodeBase64Url`/`decodeBase64Url` — pure helpers for JWT segments and salt/hash storage.                                                                                                                                                                                                                                                                                |
| `packages/auth-plugin/src/utils/pem.ts`                   | `pemToDer(pem: string, label: 'PUBLIC KEY' \| 'PRIVATE KEY'): Uint8Array` — pure helper: strips the PEM armor, **standard**-base64-decodes the body (NOT base64url — PEM uses the `+`/`/`/`=` alphabet), and returns the DER bytes fed to `subtle.importKey('spki'\|'pkcs8', …)` for RS256 (§3.1). Throws on a missing/wrong armor label. Internal; unit-tested directly. |
| `packages/auth-plugin/src/services/jwt-service.ts`        | `JwtService implements IJwtService` — HS256/RS256 via `runtime.subtle`; `sign`/`verify`/`decode`. Internal.                                                                                                                                                                                                                                                               |
| `packages/auth-plugin/src/services/auth-service.ts`       | `AuthService implements IAuthService` — passive strategy chain + `verifyCredentials`. Internal.                                                                                                                                                                                                                                                                           |
| `packages/auth-plugin/src/services/rbac-service.ts`       | `RbacService implements IAuthorizationService` — transitive role-hierarchy resolution. Internal.                                                                                                                                                                                                                                                                          |
| `packages/auth-plugin/src/services/password-hasher.ts`    | `PasswordHasher` — PBKDF2-SHA256 hash/verify. Exported.                                                                                                                                                                                                                                                                                                                   |
| `packages/auth-plugin/src/strategies/jwt-strategy.ts`     | `JwtStrategy implements IAuthStrategy` — bearer extraction + `IJwtService.verify`. Internal.                                                                                                                                                                                                                                                                              |
| `packages/auth-plugin/src/strategies/api-key-strategy.ts` | `ApiKeyStrategy implements IAuthStrategy` — header extraction + `validate`. Internal.                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/src/strategies/local-strategy.ts`   | `LocalStrategy` — holds `local.verify`; reached via `verifyCredentials`. Internal.                                                                                                                                                                                                                                                                                        |
| `packages/auth-plugin/src/guards/index.ts`                | `requireAuth`/`requireRole`/`requirePermission`/`requireAnyRole`/`requireAllPermissions`/`publicRoute` — short-circuiting middleware factories. Exported. (Consolidates the ROADMAP's three guard files into one DRY file; see §9 reconciliation note.)                                                                                                                   |
| `packages/auth-plugin/src/middleware/auth-middleware.ts`  | `authMiddleware()` — runs `IAuthService.authenticate`, sets `ctx.request.user`, `await next()`. Exported.                                                                                                                                                                                                                                                                 |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`          | `AuthPlugin(options): IPlugin` — builds services + strategies, registers under the three tokens, `provides`, `onClose` cleanup (mirrors messaging wiring).                                                                                                                                                                                                                |
| `packages/auth-plugin/src/index.ts`                       | Barrel: `AuthPlugin`, option types, `PasswordHasher`, `authMiddleware`, the six guards; re-export `IAuthService`/`IJwtService`/`IAuthorizationService`/`IAuthStrategy`/`IPrincipal`/`JwtSignOptions`/`RbacConfig`/`RoleDefinition`.                                                                                                                                       |
| `packages/auth-plugin/deno.json`                          | Already exists (`name`, `version`, `exports`); no change — zero dependencies (Web Crypto only).                                                                                                                                                                                                                                                                           |
| `packages/auth-plugin/README.md`                          | New package README (purpose, install, usage, options, strategies, guards) — AI_GUIDELINES §7.1 / §8.6.                                                                                                                                                                                                                                                                    |
| `PUBLIC_API.md`                                           | Rewrite the Auth section to the committed surface; fix `IRequest.user` note; `AuthenticationPlugin`→`AuthPlugin`; mark refresh+rate-limit as M16b (§2 C2/C3/C5).                                                                                                                                                                                                          |
| `ROADMAP.md`                                              | Reconcile M16 (core auth ships now; refresh + rate limiting → M16b), add an M16b sub-section (§2 C3/C4), and rewrite the M16 programmatic-API **code block** so guards are free functions and `authenticate` returns `IPrincipal \| null` (§2 C6).                                                                                                                        |
| `ARCHITECTURE.md`                                         | Auth row: rename to `AuthPlugin`, note M16 ships JWT/API Key/Local + RBAC + guards and that refresh + rate limiting follow in M16b; note JWT needs no library (Web Crypto).                                                                                                                                                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Every test file's first framework import is `import { describe, it } from '@std/testing/bdd';` with
assertions from `@std/expect`. `Deno.test` is banned in this repo — do not scaffold in it and
convert later. Fixtures live under `test/fixtures/` and are excluded from coverage. Every test call
type-checks against the committed signatures from §1. Web Crypto is real in the Deno test runner, so
crypto paths are exercised directly with deterministic keys — there is **no** lazy `npm:` import and
therefore no guarded real-import test to write.

| Test file                                   | src covered                                                               | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/duration.test.ts`                | `src/utils/duration.ts`                                                   | `parseDuration('30s')`/`'5m'`/`'1h'`/`'7d'` → expected ms; bare integer → seconds; invalid (`'abc'`) throws.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/base64url.test.ts`               | `src/utils/base64url.ts`                                                  | `encodeBase64Url`/`decodeBase64Url` round-trip arbitrary bytes incl. empty and multi-byte; not the standard base64 alphabet (`-`/`_`, no padding).                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/pem.test.ts`                     | `src/utils/pem.ts`                                                        | `pemToDer` decodes a known SPKI public-key PEM and a PKCS8 private-key PEM to the expected DER bytes (round-trips into `subtle.importKey`); tolerates CRLF/trailing whitespace in the armor; a missing/wrong `-----BEGIN … -----` label throws; a body with base64url chars (not standard base64) is rejected.                                                                                                                                                                                                                         |
| `test/unit/jwt-service.test.ts`             | `src/services/jwt-service.ts`                                             | `sign(payload, { expiresIn, audience, issuer }): Promise<string>`/`verify<T>(token): Promise<T>`/`decode<T>(token): T \| null` against [`IJwtService`](packages/common/src/services/auth.ts:50): HS256 round-trip; RS256 sign-with-private/verify-with-public; tampered payload → verify rejects; `exp` past (fake clock) → rejects; `nbf` future → rejects; `aud`/`iss` mismatch → rejects; `decode` returns payload ignoring tampering; malformed → `decode` `null` / `verify` rejects; missing key material throws at construction. |
| `test/unit/password-hasher.test.ts`         | `src/services/password-hasher.ts`                                         | `hash(secret): Promise<string>`/`verify(stored, secret): Promise<boolean>` round-trip; wrong secret → `false`; distinct salts → distinct stored; tampered/malformed stored → `false` (never throws).                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/rbac-service.test.ts`            | `src/services/rbac-service.ts`                                            | `hasRole`/`hasPermission`/`hasAnyRole`/`hasAllPermissions` against `IAuthorizationService`: direct match; one- and multi-level `inherits`; permission inherited through an inherited role; `hasAnyRole` any-of / `hasAllPermissions` all-of; cyclic `inherits` does not hang and resolves the acyclic part.                                                                                                                                                                                                                            |
| `test/unit/jwt-strategy.test.ts`            | `src/strategies/jwt-strategy.ts`                                          | `authenticate(request): Promise<IPrincipal \| null>` against `IAuthStrategy`: valid bearer header → principal mapping `sub`/roles/permissions/claims; absent header → `null`; wrong scheme → `null`; invalid token (verify rejects) → `null`.                                                                                                                                                                                                                                                                                          |
| `test/unit/api-key-strategy.test.ts`        | `src/strategies/api-key-strategy.ts`                                      | `authenticate(request)`: key present + `validate` resolves → principal; absent header → `null`; `validate` returns `null` → `null`; custom header name honored.                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/local-strategy.test.ts`          | `src/strategies/local-strategy.ts`                                        | `verify(identifier, secret)` delegates to the configured `local.verify`; returns the principal or `null` on miss; propagates the callback's resolved value.                                                                                                                                                                                                                                                                                                                                                                            |
| `test/unit/auth-service.test.ts`            | `src/services/auth-service.ts`                                            | `authenticate(request): Promise<IPrincipal \| null>` runs strategies in order — first non-null wins; all return `null` → `null`; `verifyCredentials({ identifier, secret }): Promise<IPrincipal \| null>` delegates to `LocalStrategy`.                                                                                                                                                                                                                                                                                                |
| `test/unit/guards.test.ts`                  | `src/guards/index.ts`                                                     | For each guard against `MiddlewareFunction`: pass → `next` invoked; 401 (no principal) → status set, `next` **not** invoked (downstream spy asserts zero calls — short-circuit mandate); 403 (principal present, check fails) → status set, `next` not invoked; `requireAnyRole` any-of / `requireAllPermissions` all-of; `publicRoute()` always continues; guard resolves `IAuthorizationService` from `ctx.services`.                                                                                                                |
| `test/unit/auth-middleware.test.ts`         | `src/middleware/auth-middleware.ts`                                       | `authMiddleware()` runs `authenticate`, sets `ctx.request.user` to the principal (read back through `IRequest.user`) and calls `next`; when `authenticate` returns `null`, `user` is absent and `next` is still called (no short-circuit).                                                                                                                                                                                                                                                                                             |
| `test/unit/auth-plugin.test.ts`             | `src/plugin/auth-plugin.ts` (+ `src/interfaces/index.ts` via compilation) | `AuthPlugin(options): IPlugin` `register()` resolves `IJwtService` under `jwt`, `IAuthService` under `authentication`, `IAuthorizationService` under `authorization`; `provides` lists the three tokens; options without any key material throw; HS256 path (secret) and RS256 path (keys) both build; `onClose` resolves.                                                                                                                                                                                                             |
| `test/unit/barrel-exports.test.ts`          | `src/index.ts`                                                            | Asserts `AuthPlugin`, the option types, `PasswordHasher`, `authMiddleware`, the six guards, and the re-exported `IAuthService`/`IJwtService`/`IAuthorizationService`/`IAuthStrategy`/`IPrincipal`/`JwtSignOptions`/`RbacConfig`/`RoleDefinition` are exported, and that `JwtService`/`AuthService`/`RbacService`/strategies/`parseDuration` are **not**.                                                                                                                                                                               |
| `test/integration/auth-integration.test.ts` | end-to-end through the plugin                                             | Registers `AuthPlugin({ jwt:{secret}, rbac:{roles} })` against a fake runtime; signs a token, sends it via the bearer header through `authMiddleware` + `requireRole`, and asserts the handler received `ctx.request.user` and was reached; a request with no token through `requireAuth` returns 401 and the handler is **not** called; a principal lacking the role through `requireRole` returns 403; a `verifyCredentials` login flow mints a usable token.                                                                        |
| `test/fixtures/fake-runtime.ts`             | (fixture)                                                                 | Fake `IRuntimeServices` exposing `subtle` = the real Web Crypto (`globalThis.crypto.subtle`), `randomBytes` backed by `crypto.getRandomValues`, a controllable `now()` (to drive `exp`/`nbf` deterministically), and `uuid`. Cross-checked against how the real runtime sets them — no `Date.now()`.                                                                                                                                                                                                                                   |

The interface-only files (`src/interfaces/index.ts`, the `common` type additions) have no runtime
branches and are covered wherever tests compile against the option/contract types (messaging
precedent: `interfaces/index.ts` is interface-only and covered by the plugin tests).

Per-file bar: every new `src/*.ts` file targets ≥90% branch / function / line. Because all crypto is
real Web Crypto with deterministic inputs, every branch (HS256 vs RS256, each verify-failure path,
each strategy null/match path, each guard 401/403/pass path) is reachable directly — there is no
environment-gated import line to leave uncovered.

## 7. Verification gates

```bash
git branch --show-current        # MUST be feat/m16-auth-plugin, never main
deno task check:plan             # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage          # read ANSI-stripped per-file table; >=90% branch/function/line on every src file
```

After implementation, also grep for constructs the gates miss (CLAUDE.md "Before reporting a task
done"):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/auth-plugin/src
```

Branch + lint hand-off: the assistant produced this plan in a file-tools-only Architect session (no
shell). Before review, the human confirms `git branch --show-current` is `feat/m16-auth-plugin`
(create it from `main` if absent: `git switch -c feat/m16-auth-plugin`) and runs
`deno task check:plan`; any finding is fixed as a plan first.

## 8. Risks & mitigations

- **Web Crypto availability/shape across runtimes.** Mitigation: `runtime.subtle` is the committed
  abstraction ([`runtime.ts:140`](packages/common/src/runtime.ts:140)) and is real Web Crypto on
  Deno/Node 20+/Bun; the integration test exercises the real path. No runtime-specific `crypto.`
  call lives in `src/`.
- **Constant-time comparison bypass / timing leak in `PasswordHasher.verify`.** Mitigation: `verify`
  re-derives and compares with a fixed-time loop over equal-length digests, never `===` on the raw
  hash; the unit test asserts wrong-secret → `false`.
- **Role-hierarchy infinite loop on cyclic `inherits`.** Mitigation: a `visited` set in the
  transitive walk; a dedicated test asserts a cyclic config resolves without hanging (§3.5).
- **Circular type import between `http.ts` and `auth.ts`.**
  [`http.ts`](packages/common/src/http.ts:12) already imports `IPrincipal` from `services/auth.ts`;
  §3.3 adds `import type { IRequest }` back into `auth.ts` for
  `IAuthStrategy.authenticate(request: IRequest)`, forming a type-only cycle. Mitigation: it is
  `import type` on both edges, so it erases at emit (no runtime cycle) and satisfies
  `verbatim-module-syntax`; the implementer confirms `deno task check` stays clean after the edit.
  If it ever tripped the checker, the fallback is to keep `IAuthStrategy` in `auth.ts` but type its
  parameter via a local structural read rather than importing `IRequest` — not expected to be
  needed.
- **`readonly user` edit regresses an `IRequest` consumer.** Mitigation: only `user` becomes
  writable; all other fields stay `readonly`; `deno task check` across the workspace catches any
  regressions; the shipped `@CurrentUser` path is unchanged (it only reads).
- **Guard short-circuit silently broken (downstream still runs).** Mitigation: mandatory
  short-circuit tests assert a downstream spy is **not** invoked on 401/403 (CLAUDE.md mandate,
  §3.7).
- **`exactOptionalPropertyTypes` is on.** Mitigation: option objects in `register()` are built by
  assigning only defined values (mirrors
  [`messaging-plugin.ts:107`](packages/messaging-plugin/src/plugin/messaging-plugin.ts:107)).
- **`PUBLIC_API.md`/`ARCHITECTURE.md` drift.** Mitigation: corrected as named same-PR deliverables
  (§2 C2/C3/C5).
- **Scope creep into refresh/rate-limiting.** Mitigation: split to M16b up front (§0, §9) rather
  than shipping half-built features; the committed
  [`IJwtService`](packages/common/src/services/auth.ts:50) needs no refresh surface, so M16b is a
  pure addition.

## 9. Out of scope

- `RefreshTokenStrategy` — deferred to **M16b**. Refresh access tokens are
  `sign({ expiresIn: '7d' })`; the follow-up adds a pluggable server-side token store and a refresh
  endpoint helper. Mirrors the M14 → M14b messaging-broker split.
- Rate limiting (`rate-limit-middleware.ts` + memory/redis storage) — deferred to **M16b**.
  `PUBLIC_API.md`'s own example treats it as a separate plugin ([`:2557`](PUBLIC_API.md)); it is
  transport-level, not identity (§2 C3).
- An injected/lazy JWT **library** (`jose`/`jsonwebtoken`) — not used; Web Crypto covers HS256/RS256
  with zero dependencies (§3.1).
- OAuth2/OIDC, SAML, session/cookie stores, MFA, passkeys/WebAuthn, API-key store implementations —
  never in the M16 contract; future milestones.
- Multi-instance auth (`name` option / dot-namespaced tokens) — auth has a single logical instance;
  the option would be dead surface (§3.8). A second registration fails fast at the kernel, which is
  correct.
- Separate ROADMAP guard files (`require-auth.ts`/`require-role.ts`/`require-permission.ts`) —
  consolidated into one `src/guards/index.ts` because the guards share resolve-check-short-circuit
  logic (DRY, AI_GUIDELINES §11.1); documented here as a reconciliation, exactly as M13 omitted the
  ROADMAP's empty handler re-export shells
  ([`plans/archive/milestone-13-cqrs-plugin.md`](plans/archive/milestone-13-cqrs-plugin.md) §C4).
- Cross-plugin bridges (auth ↔ audit, auth ↔ events) — none; plugins communicate only via capability
  tokens.
