# Milestone 139a — Identity and authorization a token or a tenant can escape (`@setu-ts/auth-plugin` + `common` + `session-plugin` + `mcp-plugin` + `multi-tenancy-plugin` + `cli`)

> **Status:** Planning. Branch: `feat/m139a-identity-authorization`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

Six rows from the `0.12.0` review (`smoke/V0120-REVIEW.md`), all places where an identity escapes
the boundary it was issued for. A narrow bearer token gets its subject's whole role (V12-37). A
token without a subject becomes a shared principal (V12-18). A token or password from one tenant
works on another tenant's host (V12-19). The full-stack template's login keeps a pre-login session
id (V12-11). Form CSRF answers an MCP client's first anonymous call with `403`, so the client never
receives the `401` discovery challenge (V12-35). And `http://<name>.localhost` is refused as a
non-loopback URL (V12-34).

The milestone ships in a **patch** (`0.12.x`). Every behaviour change that could break a caller is
opt-in (`requireAuth({ credentials })`, `confineScopedTokens`, `jwt.tenantClaim`, the issuer
`tenantClaim`). The two fixes that are not opt-in only refuse defective input: a JWT with no usable
`sub` (RFC 9068 §2.2 makes `sub` REQUIRED), and widening loopback to `*.localhost`. The default flip
of `confineScopedTokens` is recorded for `0.13.0` (§9).

**Maintainer decisions (2026-11-09).** Each was put to the maintainer with framework evidence, and
the recommended option was chosen in every case:

| Row    | Decision                                                                                                          | Compared with                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V12-37 | Per-route `requireAuth({ credentials })`, plus an opt-in `confineScopedTokens` cap; default in `0.13.0`           | ASP.NET `[Authorize(AuthenticationSchemes=…)]` (per-endpoint scheme); DRF per-view `authentication_classes`; Sanctum and Passport give a token the user's full gates and leave confinement to the app; Spring Resource Server caps authorities at `SCOPE_*` by default |
| V12-19 | Opt-in `jwt.tenantClaim` and per-issuer `tenantClaim`; `local.verify` and `verifyCredentials` receive the request | Entra ("check `tid` matches"); Auth0 Organizations (an unvalidatable `org_id` makes the token invalid); Spring multitenancy ships no tenant comparison; Django `authenticate(request, **credentials)`                                                                  |
| V12-35 | mcp-plugin marks its own POST path CSRF-exempt through a `common` state key                                       | ASP.NET `.DisableAntiforgery()` per bearer endpoint; MCP 2025-06-18 authorization requires `401` + `WWW-Authenticate` for a request without a token                                                                                                                    |

Decided without a question, on the evidence:

- **V12-18:** refuse the token. RFC 9068 §2.2 requires `sub`. Spring and ASP.NET accept a token with
  an empty name, but a shared `'unknown'` id is worse than an empty one.
- **V12-11:** the template regenerates the session. Spring, Django and Laravel all rotate the
  session id inside their login call.
- **V12-34:** accept `*.localhost` for URLs the server only compares or hands to a browser. Keep the
  current rule for URLs the server fetches itself. The W3C Secure Contexts spec treats `*.localhost`
  as trustworthy because browsers hard-code it. A server's resolver may not (§3.6).

- **In scope:** the six rows above; the `common` additions they need (§4); README, `PUBLIC_API.md`
  and `CHANGELOG.md` text for every changed surface; the full-stack template's login; the status
  flip.
- **NOT this milestone:**
  - Making `confineScopedTokens` the default. That is breaking and ships in `0.13.0` with M139b and
    M139g (§9).
  - OpenAPI security derived from `requireAuth({ credentials })`. It belongs to M139e's docs batch
    and its follow-up, because `RouteSecurityMetadata` has no credential member today.
  - V12-36, the quota read API. It is M139c.

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JwtStrategy.authenticate`             | `packages/auth-plugin/src/strategies/jwt-strategy.ts:46-104`, `:108-111`                                                                 | Verifies, refuses a `type: 'refresh'` token and a revoked typed access token, then sets `id = getStringClaim(payload, 'sub')`. `getStringClaim` returns `'unknown'` for a missing or non-string claim (V12-18). It never reads `request.tenant`. `credential = 'header'` (`:26`).                                                                                                                            |
| `IssuerStrategy.authenticate`          | `packages/auth-plugin/src/strategies/issuer-strategy.ts:85`, `:143`                                                                      | Verifies against a trusted issuer, then `binding.issuer.toPrincipal(outcome.claims)`. No tenant comparison. `credential = 'header'` (`:46`).                                                                                                                                                                                                                                                                 |
| `IRequest.tenant`                      | `packages/common/src/http.ts:62-69`                                                                                                      | `tenant?: ITenant`, written by the multi-tenancy middleware at priority 40 (`multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:153`, `:383`). That is before authentication at 300 (`auth-plugin/src/plugin/auth-plugin.ts:71`), so a strategy can read it.                                                                                                                                            |
| `IPrincipal`                           | `packages/common/src/services/auth.ts:32-54`                                                                                             | `id`, `roles?`, `permissions?`, `scopes?` (OAuth scopes, M132), `actor?`, `claims?`. A session principal is restored from the auth-session record. Sign-in code sets no `scopes` on it (grep of `sign-in/`: `scopes` there are the scopes requested from the IdP), so `scopes !== undefined` marks a token principal.                                                                                        |
| `IAuthService.verifyCredentials`       | `packages/common/src/services/auth.ts:180-183`                                                                                           | `verifyCredentials(credentials: { identifier; secret }): Promise<IPrincipal \| null>`. No request, no tenant.                                                                                                                                                                                                                                                                                                |
| `LocalOptions.verify`, `LocalStrategy` | `packages/auth-plugin/src/interfaces/index.ts:74-79`; `services/auth-service.ts:54-80`                                                   | `verify: (identifier, secret) => Promise<IPrincipal \| null>`. `AuthService.verifyCredentials` forwards only those two values.                                                                                                                                                                                                                                                                               |
| `CREDENTIAL_SOURCE_STATE_KEY`          | `packages/common/src/state-keys.ts:114`; writer `auth-plugin/src/middleware/auth-middleware.ts`                                          | `'auth-plugin:credential-source'`, holding `'header' \| 'cookie'`. Set only when the plugin's own `AuthService` (`authenticateWithSource`) authenticated the request, so a replaced `IAuthService` leaves it unset.                                                                                                                                                                                          |
| `requireAuth` / `RequireAuthOptions`   | `packages/auth-plugin/src/guards/index.ts` (`requireAuth`); `interfaces/index.ts:690-709`                                                | Options `signInPage?` and `delegation?`, validated when the guard is built. 401 through `respondWithAuthorizationFailure(ctx, 'authentication-required')`, 403 with `'insufficient-privileges'`.                                                                                                                                                                                                             |
| RBAC guards → `IAuthorizationService`  | `guards/index.ts` (`requireRole` etc.); `services/rbac-service.ts:48`, `:145`, `:159`, `:173`, `:210`                                    | The four guards call `hasRole` / `hasPermission` / `hasAnyRole` / `hasAllPermissions` on the registered service, which is `RbacService`. DecoratorPlugin's authorization middleware resolves the same capability (`decorator-plugin/src/plugin/authorization-middleware.ts:55-59`), so a cap inside `RbacService` covers decorated routes too.                                                               |
| Scoped RBAC                            | `auth-plugin/src/scoped/scoped-policy.ts:98`, `:126-160`; `scoped/model.ts:89-100`                                                       | `ScopedEvaluator.allows(principal, target, requirement)`, with failures carrying a fixed `DenyReason` union (`'tenant-mismatch'`, …). `requireScopedRole` and `requireScopedPermission` (`scoped/scoped-guards.ts:184`, `:216`) go through it.                                                                                                                                                               |
| `AuthorizationDecisionReason`          | `packages/common/src/services/diagnostics.ts:1237-1246`                                                                                  | The closed union RBAC observations carry: `'direct-role'` … `'not-held'`, `'compound-*'`. It has no value for "refused because the principal is a confined token".                                                                                                                                                                                                                                           |
| Form CSRF exemption                    | `packages/session-plugin/src/csrf/exclude.ts:62`, `:72-108`, `:134`; `middleware/csrf-form-middleware.ts`; `session-plugin.ts:31`, `:37` | Session middleware runs at 260 and form CSRF at 325. The exemptions are the bearer rule (`isBearerExempt`) and `exclude` paths. A bearer exemption sets the internal `BEARER_EXEMPT_STATE_KEY`, and `session-middleware.ts:116` then skips the session commit. Global middleware runs before routing, so form CSRF cannot see route metadata.                                                                |
| MCP endpoint                           | `packages/mcp-plugin/src/plugin/mcp-plugin.ts:38-95`; `serve/origin.ts:4-6`; `serve/visibility.ts:20-42`                                 | `POST <path>` refuses an `Origin` not in `allowedOrigins` with 403. `null` (no Origin) is admitted. `accessGate` answers an anonymous `tools/call` of a guarded tool with `'authentication-required'`, which the bearer-challenge middleware turns into `401` + `WWW-Authenticate`. The plugin registers routes only and no global middleware today.                                                         |
| `ctx.middleware.add`                   | `multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:370-383`                                                                        | A plugin adds global middleware with `{ priority, name }`.                                                                                                                                                                                                                                                                                                                                                   |
| Loopback rules                         | `auth-plugin/src/issuers/trusted-issuer.ts:54`, `:66-88`; `passkeys/ceremonies.ts:193-195`                                               | `isAcceptableUrl` accepts `https:`, or `http:` with hostname in `{'localhost','127.0.0.1','[::1]'}`. Passkeys has a second predicate, `localhost`/`127.0.0.1` only. `isAcceptableUrl` callers: `resource-server/config.ts:57`, `:98`; `saml/config.ts:73`, `:88`; `sign-in/routes.ts:193`; `sign-in/config.ts:178`, `:222`, `:227`, `:287`; `trusted-issuer.ts:230`, `:235`; `issuers/key-set-cache.ts:301`. |
| `AuthSessionService.signIn`            | `auth-plugin/src/sign-in/auth-session-service.ts:381-440`                                                                                | Already calls `session.regenerate()` on both outcomes. V12-11 is the template only.                                                                                                                                                                                                                                                                                                                          |
| Full-stack template login              | `packages/cli/src/templates/full-stack-app-files.ts:629-644`; `getSession` `:283`                                                        | The action does `getSession(context)` (an `ISession`), then `session.set('userEmail', email)` and `redirect('/products')`. It never calls `regenerate()`.                                                                                                                                                                                                                                                    |
| Session fixation guidance              | `packages/session-plugin/README.md:158-166`                                                                                              | "Call `regenerate()` immediately after any privilege change, above all after login".                                                                                                                                                                                                                                                                                                                         |
| Node `*.localhost` resolution          | probe on this host, 2026-11-09                                                                                                           | `dns.lookup('acme.localhost')` gives `::1, 127.0.0.1` only because nsswitch has `resolve`/`myhostname` (systemd). A musl or plain-`files` resolver sends the name to DNS. So a server-fetched `http://x.localhost` URL depends on the host's resolver.                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                            | Resolution (picked side)                          | Doc deliverable (same PR)                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | session-plugin README says to call `regenerate()` after login (`:160`). The full-stack template the CLI generates does not.                                                         | The README is right. The template changes (§3.5). | None beyond the template. The auth README's "In the full-stack template" section already uses `authSession.signIn`, which regenerates. |
| C2  | auth README "In the full-stack template" (`auth-plugin/README.md:832-900`) teaches `local.verify` with no tenant, and the multi-tenancy README says nothing about password sign-in. | The recipe passes the request through (§3.3).     | Update the auth README recipe. Add a "Password sign-in under multi-tenancy" note to the multi-tenancy README.                          |

## 3. Design decisions

### 3.1 V12-18 — a JWT without a usable `sub` is refused

- **Decision:** `JwtStrategy.authenticate` returns `null` when `sub` is absent, not a string, or the
  empty string. `getStringClaim` and its `'unknown'` fallback are deleted. Every other claim keeps
  its current treatment.
- **Why:** RFC 9068 §2.2 makes `sub` REQUIRED. A shared `'unknown'` id merges every such caller's
  grants, idempotency records and ownership. `null` means anonymous, as for any other invalid token,
  so guarded routes answer `401`.
- **Versioning:** this is the one non-opt-in refusal in a patch, and it is deliberate. An app that
  mints service tokens without `sub` stops authenticating them. The CHANGELOG records it under
  **Security**, not BREAKING, with migration text: put the client id in `sub` (RFC 9068 §2.2 does
  this for client-credentials tokens). The PR description names it for the maintainer.
- **Test home:** `test/unit/jwt-strategy.test.ts`: a table with `sub` missing, `42`, `''`, `null`
  and `['a']`, each giving `null`, and a `sub: 'u1'` control giving the principal.

### 3.2 V12-19 (bearer) — opt-in tenant binding for JWT and trusted-issuer tokens

- **Decision:** add `JwtOptions.tenantClaim?: string` and `TrustedIssuer.tenantClaim?: string`. Each
  must be a non-empty string naming a claim, or `AuthPluginConfigurationError` is thrown at
  registration. When it is set **and** `request.tenant` is defined, the strategy reads that claim
  from the **verified** payload. It returns `null` unless the claim is a string equal to
  `request.tenant.id`. For the issuer strategy the check runs on `outcome.claims` **before**
  `toPrincipal`, and a refusal is reported through the existing `TokenRefusalReporter`
  (`issuer-strategy.ts:24`) with reason `'tenant-mismatch'`, like `'act-malformed'`; the reason
  carries no tenant id. When `request.tenant` is undefined (tenancy off, or a host with no tenant),
  a token **without** the claim is accepted as before, and a token **carrying** the claim is
  refused: a tenant-bound token never acts outside a tenant.
- **Why:** Entra and Auth0 both tell the resource server to reject a token whose tenant does not
  match. The check reads only the verified payload, because the multi-tenancy `jwt` resolver reads
  an **unverified** claim. Accepting an unbound token on a tenant-less request keeps platform hosts
  working. Refusing a bound one there closes the case where a tenant admin's token reaches platform
  routes with its `admin` role. It ships opt-in because the versioning policy forbids a breaking
  change in a patch.
- **Test home:** `jwt-strategy.test.ts` and `issuer-strategy.test.ts`, each a table: a matching
  claim gives the principal; a different, missing or non-string claim gives `null`; no
  `request.tenant` gives the principal for an unbound token and `null` for a bound one; no
  `tenantClaim` with a mismatched tenant gives the principal (off by default).
  `auth-plugin-options.test.ts` and `trusted-issuer-options.test.ts` cover the refusal of `''` and
  `42`. An integration test in `test/integration/tenant-binding.test.ts` runs AuthPlugin and
  MultiTenancyPlugin (header resolver): a token minted for `acme` gets `200` on the `acme` tenant
  and `401` on `globex`.

### 3.3 V12-19 (password) — the request reaches `local.verify`

- **Decision:** `LocalOptions.verify` becomes
  `(identifier: string, secret: string, request?: IRequest) => Promise<IPrincipal | null>`.
  `IAuthService.verifyCredentials` in `common` gains an optional second parameter,
  `request?: IRequest`. `AuthService` forwards it, and `LocalStrategy.verify` passes it as the third
  argument. Neither the framework nor `common` reads the tenant here. The application's lookup
  scopes by `request?.tenant?.id`, and the README recipe is rewritten to show it
  (`verifyCredentials({ identifier, secret }, ctx.request)`).
- **Why:** Django passes the request to `authenticate` for the same reason. Only the application
  knows where users live, so the framework cannot scope the lookup. The fix is to give the
  application the tenant. Both additions are optional parameters, so an existing callback or an
  `IAuthService` implementor still type-checks.
- **Test home:** `test/unit/local-strategy.test.ts` and `auth-service.test.ts` assert that the
  request reaches the callback, and that `undefined` is passed when the caller passes none. The
  integration test in `tenant-binding.test.ts` has a `verify` that scopes by tenant: the same email
  and password sign in on `acme` and get `null` on `globex`.

### 3.4 V12-37 — per-route credential restriction and an opt-in scope cap

- **Decision (route):** `RequireAuthOptions.credentials?: 'any' | 'cookie' | 'header'`, default
  `'any'`. Any other value is refused when the guard is built (`AuthPluginConfigurationError`). With
  `'cookie'` or `'header'`, a principal counts as signed in only when
  `ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY)` equals the option. Otherwise the guard treats the
  request as unauthenticated: `401`, or the `signInPage` redirect for a navigation. An unset source
  (a replaced `IAuthService`) never matches, so the check fails closed. `delegation` is checked
  after the credential.
- **Decision (cap):** add `AuthPluginOptions.confineScopedTokens?: boolean`, default `false`. When
  `true`, a principal whose `scopes` is an array is refused by the following, with `scopes` alone
  satisfying none of them:
  - **RBAC:** `RbacService.hasRole`, `hasPermission`, `hasAnyRole` and `hasAllPermissions` return
    `false`. This covers the four guards and DecoratorPlugin's `@Roles` / `@Permissions`.
  - **Scoped RBAC:** `ScopedEvaluator.allows` returns `false` with a new `DenyReason`,
    `'token-confined'`. This covers `requireScopedRole` and `requireScopedPermission`.

  A token principal reaches its routes through `requireScopes`, which is unchanged. RBAC
  observations record the refusal under a new `AuthorizationDecisionReason`, `'token-confined'`,
  added in `common`. `requirePolicy` is not capped: a policy receives the principal and can read
  `scopes` itself, and the README says so.

- **Why:** the route option is the ASP.NET and DRF mechanism. The cap gives Spring's guarantee — a
  delegated token cannot widen to its subject's role — without taking roles away from a first-party
  token that carries no `scope` claim. Putting the cap in the two services, not the guards, gives
  one implementation for every entry point (guards, decorators, programmatic `hasRole`). It is
  opt-in for the patch; the default flips in `0.13.0` (§9).
- **Test home:** `guards.test.ts` holds a table of every `credentials` value against source
  `'header'`, `'cookie'` and unset, plus the refusal of `'bearer'`. A test in
  `require-auth-sign-in-page.test.ts` shows a bearer request on a `credentials: 'cookie'` page being
  redirected. `rbac-service.test.ts` and `scoped/scoped-policy.test.ts` hold the cap table: on or
  off, `scopes` `undefined`, `[]` or `['x']`. The integration test
  `test/integration/scoped-token-confinement.test.ts` is the V12-37 reproduction: an admin token
  minted with `scope: 'envelopes:read'` gets `403` from a `requireScopedPermission` and a
  `requireRole('admin')` route with the cap on and `200` with it off. It gets `200` on a
  `requireScopes('envelopes:read')` route with the cap on or off, and a session-signed-in admin
  keeps `200` with the cap on. The same file also covers a decorated `@Roles('admin')` route — the
  two entry points under the non-default configuration.

### 3.5 V12-11 — the template login regenerates the session

- **Decision:** the generated `app/routes/_auth/login.tsx` action calls `session.regenerate()`
  before `session.set('userEmail', email)`. A comment cites session fixation and points to
  `authSession.signIn` as the real path, which regenerates on its own. The generated-file baselines
  are recaptured.
- **Why:** every framework compared rotates the session id at login. The placeholder is what every
  full-stack project starts from.
- **Test home:** `packages/cli/test/unit/full-stack-template.test.ts` asserts that `regenerate()`
  comes before `set('userEmail'`. The scaffold e2e (`scaffold-runs-e2e`) boots the template and
  proves the change at runtime: a session cookie planted before login differs from the cookie the
  login redirect sets.

### 3.6 V12-34 — one loopback module, two URL rules

- **Decision:** a new internal module, `auth-plugin/src/utils/loopback.ts`, exports two predicates
  (internal, not on the barrel):
  - `isLoopbackName(hostname)`: `localhost`, any name ending in `.localhost`, `127.0.0.1` or
    `[::1]`. The hostname is already lowercased by `URL`.
  - `isLoopbackAddress(hostname)`: the current set, `localhost`, `127.0.0.1` and `[::1]`.

  `trusted-issuer.ts` replaces `isAcceptableUrl` with two functions that keep its printable-ASCII
  rule. `isAcceptableUrl` uses `isLoopbackName` and is for URLs the server compares or hands to a
  browser. `isAcceptableFetchUrl` uses `isLoopbackAddress` and is for URLs the server fetches. Each
  call site is classified:

  | Call site                                                                                                  | Rule  |
  | ---------------------------------------------------------------------------------------------------------- | ----- |
  | `resource-server/config.ts:57` `authorizationServers`, `:98` `resource`                                    | name  |
  | `saml/config.ts:73` `idp.ssoUrl`, `:88` `acsUrl` (browser redirects)                                       | name  |
  | `sign-in/config.ts:178` `redirectUri`, `:227` `postLogoutRedirectUri`                                      | name  |
  | `sign-in/config.ts:287` `authorizationEndpoint`                                                            | name  |
  | `sign-in/config.ts:287` `tokenEndpoint`, `userinfoEndpoint`                                                | fetch |
  | `sign-in/config.ts:222` OIDC `issuer`, which drives discovery                                              | fetch |
  | `sign-in/routes.ts:193` discovery `authorization_endpoint` and `end_session_endpoint`                      | name  |
  | `sign-in/routes.ts:193` discovery `token_endpoint`                                                         | fetch |
  | `trusted-issuer.ts:230` `keys.jwksUri`, `:235` discovery URL, `key-set-cache.ts:301` discovered `jwks_uri` | fetch |

  `routes.ts` gets two predicates (`isBrowserEndpoint` and `isFetchEndpoint`) in place of
  `isEndpoint`. Passkeys' private `isLoopbackHost` is deleted, and `ceremonies.ts:243` uses
  `isLoopbackName` minus `[::1]`. That exclusion is kept as a named rule in `loopback.ts`, because
  an RP ID can never contain a colon. The refusal messages for the fetch rule say
  `http on localhost, 127.0.0.1 or [::1]`, and those for the name rule say
  `http on a localhost name`, so an operator sees which rule refused.

- **Why:** the W3C Secure Contexts spec, Chrome and Firefox treat `*.localhost` as loopback, and the
  row's refusals are all identifiers or browser URLs. A URL the server fetches over `http` relies on
  the host resolver (§1 probe), and the survey's rule is "never infer loopback from DNS". So the
  fetch rule stays exactly as it was.
- **Test home:** `test/unit/loopback.test.ts` (new) is a table of hostnames run through both
  predicates: `acme.localhost`, `a.b.localhost`, `localhost`, `127.0.0.1`, `[::1]`, `notlocalhost`,
  `localhost.evil.test`, `evil-localhost` and `127.0.0.2`. Each site's test file asserts one
  name-rule URL and one fetch-rule URL at that site: `resource-server-config.test.ts`,
  `saml-options.test.ts`, `sign-in-config.test.ts`, `discovery.test.ts`,
  `trusted-issuer-options.test.ts`, `key-set-cache.test.ts` and `passkey-options.test.ts`. That
  makes the classification table above test data, not prose.

### 3.7 V12-35 — mcp-plugin marks its POST path exempt from form CSRF

- **Decision:**
  - **The key.** `common` exports `CSRF_EXEMPT_STATE_KEY = 'session-plugin:csrf-exempt'`, a request
    state flag that form CSRF honours.
  - **The marker.** McpPlugin registers one global middleware, named `mcp-csrf-exempt`, at priority
    `320`: after authentication at 300 and before form CSRF at 325. It sets the flag to `true` only
    when the method is `POST` and `ctx.request.path === resolved.path`.
  - **What session-plugin does with it.** `isCsrfExempt` also returns `true` when the flag is
    `true`. `applyCsrfExemption` then sets `BEARER_EXEMPT_STATE_KEY` for that request too, so the
    session is not committed. The key is renamed internally to `NO_COMMIT_STATE_KEY`, because it now
    means "exempted, never commit".
  - **What stays.** The MCP route keeps its own `Origin` check. Inner tool requests have their own
    paths and are verified by form CSRF as before.
- **Why:** the MCP endpoint does not use form CSRF for protection, and the MCP spec requires a
  `401` + `WWW-Authenticate` for a call without a token. A cross-site browser `POST` carries
  `Origin`, which the route refuses unless allow-listed, and the SDK requires
  `Content-Type: application/json`, which a simple cross-site request cannot send. The flag is set
  by in-process code only and names one exact path, so no header or input can set it. Not committing
  the session matches the bearer exemption: an MCP call has no business writing a browser session.
- **Test home:**
  - `packages/mcp-plugin/test/integration/mcp-csrf-composition.test.ts` (new) runs SessionPlugin
    `{ csrf: {} }`, AuthPlugin with `resourceServer` and McpPlugin. An anonymous `tools/call` of a
    `requireScopes` tool gets `401` with `WWW-Authenticate: Bearer … resource_metadata="…"`, not
    `403`. A cross-site `Origin` still gets `403`. A `POST` to another path without a token still
    gets the CSRF `403` (negative control). No `Set-Cookie` appears on the `/mcp` response.
  - `session-plugin/test/unit/csrf/bearer-exemption.test.ts` holds the flag table: `true`, absent
    and `'true'` (string, not exempt).
  - `common/test/unit/state-keys.test.ts` pins the literal value.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `IAuthService.verifyCredentials` gains an **optional**
parameter, and `LocalOptions.verify` an optional third. A two-parameter implementation still
satisfies both. `AuthorizationDecisionReason` widens an output union by `'token-confined'`; a
consumer switching on it exhaustively without a default needs a case. That is recorded as a
CHANGELOG note, not a BREAKING entry, following the precedent of the M98 reason widenings.

| Exported symbol                                                    | Kind               | Consumer / real code path that READS it                                                                                   |
| ------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `CSRF_EXEMPT_STATE_KEY` (`common`)                                 | const              | Written by McpPlugin's `mcp-csrf-exempt` middleware; read by session-plugin `isCsrfExempt`.                               |
| `AuthorizationDecisionReason` `'token-confined'` (`common`)        | type member        | Emitted by `RbacService` through the authorization observer when the cap refuses; diagnostics-plugin forwards the reason. |
| `IAuthService.verifyCredentials(credentials, request?)` (`common`) | interface change   | Called by applications (README recipe); `AuthService` forwards `request` to `LocalStrategy`.                              |
| `RequireAuthOptions.credentials` (`auth-plugin`)                   | option             | Read by `requireAuth` when the guard is built and on each request.                                                        |
| `AuthPluginOptions.confineScopedTokens`                            | option             | Read in `auth-plugin.ts` and passed to `RbacService` and `ScopedEvaluator`.                                               |
| `JwtOptions.tenantClaim`                                           | option             | Read by `JwtStrategy`.                                                                                                    |
| `TrustedIssuer.tenantClaim`                                        | option             | Read by `IssuerStrategy` through the compiled issuer.                                                                     |
| `LocalOptions.verify` third parameter                              | callback signature | Called by `LocalStrategy.verify`.                                                                                         |

### 4.1 Options — every option names its consumer

| Option                         | Consumer                         | Behavior (per implementation)                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requireAuth({ credentials })` | `guards/index.ts` `requireAuth`  | `'any'` (default) keeps today's behaviour. `'cookie'` and `'header'` admit only a principal whose recorded credential source matches; a mismatch or an unset source gives `401` (or the sign-in redirect). Any other value is refused when the guard is built. |
| `confineScopedTokens`          | `RbacService`; `ScopedEvaluator` | `false` (default) keeps today's behaviour. `true` makes a principal with array `scopes` fail every role, permission and scoped check. `requireScopes` and `requirePolicy` are unaffected. A non-boolean is refused at registration.                            |
| `jwt.tenantClaim`              | `JwtStrategy`                    | Unset: no comparison. Set: when `request.tenant` exists, the verified claim must be a string equal to `tenant.id`, or the token gives `null`. `''` or a non-string is refused at registration.                                                                 |
| `issuers[].tenantClaim`        | `IssuerStrategy`                 | Same rule as `jwt.tenantClaim`, on `outcome.claims` before `toPrincipal`. Validated in `compileIssuers`.                                                                                                                                                       |

## 5. Implementation files

| File                                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/index.ts`                                                             | Barrel: export `CSRF_EXEMPT_STATE_KEY`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/common/src/state-keys.ts`                                                        | `CSRF_EXEMPT_STATE_KEY`, with JSDoc that names the writer (McpPlugin), the reader (form CSRF) and the "in-process, exact path only" rule.                                                                                                                                                                                                                                                                                                                                             |
| `packages/common/src/services/auth.ts`                                                     | Optional `request?: IRequest` on `verifyCredentials`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/common/src/services/diagnostics.ts`                                              | `'token-confined'` in `AuthorizationDecisionReason`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/auth-plugin/src/strategies/jwt-strategy.ts`                                      | §3.1 `sub` refusal; §3.2 `tenantClaim`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/auth-plugin/src/strategies/issuer-strategy.ts`                                   | §3.2 issuer `tenantClaim`.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/auth-plugin/src/issuers/trusted-issuer.ts`                                       | `tenantClaim` validation in `compileIssuers`; the `isAcceptableUrl` / `isAcceptableFetchUrl` split.                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/auth-plugin/src/issuers/key-set-cache.ts`                                        | Use `isAcceptableFetchUrl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/auth-plugin/src/utils/loopback.ts` (new)                                         | `isLoopbackName`, `isLoopbackAddress`, and the passkey rule.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/auth-plugin/src/resource-server/config.ts`                                       | Name rule, per §3.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/auth-plugin/src/saml/config.ts`                                                  | Name rule, per §3.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/auth-plugin/src/sign-in/config.ts`                                               | Per-field rule, per §3.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/auth-plugin/src/sign-in/routes.ts`                                               | `isBrowserEndpoint` / `isFetchEndpoint` in place of `isEndpoint`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/src/passkeys/ceremonies.ts`                                          | Delete `isLoopbackHost`; use the passkey rule from `loopback.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/src/guards/index.ts`                                                 | `credentials` on `requireAuth`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/auth-plugin/src/services/rbac-service.ts`                                        | The cap, and the `'token-confined'` observation.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/auth-plugin/src/scoped/scoped-policy.ts`, `scoped/model.ts`, `scoped/options.ts` | The cap in `ScopedEvaluator`, the `'token-confined'` `DenyReason`, and the compiled flag.                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/auth-plugin/src/services/auth-service.ts`                                        | Forward `request` from `verifyCredentials` to `LocalStrategy.verify`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                                           | Validate `confineScopedTokens` and `jwt.tenantClaim`, and pass them on.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/auth-plugin/src/interfaces/index.ts`                                             | The option types and the `LocalOptions.verify` signature, with JSDoc carrying `@since` of the next patch.                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/session-plugin/src/csrf/exclude.ts`                                              | Honour `CSRF_EXEMPT_STATE_KEY`; rename `BEARER_EXEMPT_STATE_KEY` to `NO_COMMIT_STATE_KEY`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/session-plugin/src/middleware/session-middleware.ts`                             | Read the renamed key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/mcp-plugin/src/plugin/mcp-plugin.ts`                                             | Register the `mcp-csrf-exempt` middleware.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp-plugin/src/serve/csrf-exempt.ts` (new)                                       | The marker middleware factory (internal).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/src/templates/full-stack-app-files.ts`                                       | §3.5 `regenerate()` in the login action, plus recaptured template baselines.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Docs                                                                                       | `auth-plugin/README.md` (`credentials`, `confineScopedTokens`, `tenantClaim`, `sub` refusal, rewritten recipe); `multi-tenancy-plugin/README.md` (password sign-in and bearer binding); `session-plugin/README.md` (`CSRF_EXEMPT_STATE_KEY` in the exemptions list); `mcp-plugin/README.md` (form-CSRF composition); `PUBLIC_API.md` (every row in §4); `CHANGELOG.md` (Unreleased: Fixed for V12-18, V12-11, V12-34, V12-35; Added for the options; Security for V12-37 and V12-19). |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                         | src covered                                                       | Key assertions (and the signature each call type-checks against)                                                                       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-plugin/test/unit/jwt-strategy.test.ts`                                                      | `strategies/jwt-strategy.ts`                                      | §3.1 table; §3.2 table, with `new JwtStrategy({ jwtService, tenantClaim })` and `authenticate(request)` where `request.tenant` is set. |
| `auth-plugin/test/unit/issuer-strategy.test.ts`                                                   | `strategies/issuer-strategy.ts`                                   | §3.2 issuer table; `toPrincipal` not called and `'tenant-mismatch'` reported on a mismatch.                                            |
| `auth-plugin/test/unit/trusted-issuer-options.test.ts`                                            | `issuers/trusted-issuer.ts`                                       | `tenantClaim` refusals; per-site URL rules for `jwksUri` and the discovery URL.                                                        |
| `auth-plugin/test/unit/key-set-cache.test.ts`                                                     | `issuers/key-set-cache.ts`                                        | A discovered `jwks_uri` on `acme.localhost` is refused (fetch rule).                                                                   |
| `auth-plugin/test/unit/loopback.test.ts` (new)                                                    | `utils/loopback.ts`                                               | §3.6 hostname table through all three predicates.                                                                                      |
| `auth-plugin/test/unit/resource-server-config.test.ts`                                            | `resource-server/config.ts`                                       | `resource: 'http://acme.localhost:3000'` compiles; `http://acme.example` is refused.                                                   |
| `auth-plugin/test/unit/saml-options.test.ts`                                                      | `saml/config.ts`                                                  | `acsUrl` and `idp.ssoUrl` on `*.localhost` accepted.                                                                                   |
| `auth-plugin/test/unit/sign-in-config.test.ts`                                                    | `sign-in/config.ts`                                               | Per-field table: the name-rule and fetch-rule fields.                                                                                  |
| `auth-plugin/test/unit/discovery.test.ts`                                                         | `sign-in/routes.ts`                                               | `authorization_endpoint` on `*.localhost` resolves; `token_endpoint` on `*.localhost` gives `discovery-endpoint-invalid`.              |
| `auth-plugin/test/unit/passkey-options.test.ts`                                                   | `passkeys/ceremonies.ts`                                          | `http://acme.localhost:3000` origin accepted; `http://[::1]` still refused.                                                            |
| `auth-plugin/test/unit/guards.test.ts`, `test/integration/require-auth-sign-in-page.test.ts`      | `guards/index.ts`                                                 | §3.4 credentials table; refusal of an unknown value; redirect on a credential mismatch.                                                |
| `auth-plugin/test/unit/rbac-service.test.ts`                                                      | `services/rbac-service.ts`                                        | Cap table for all four methods; the observation carries `'token-confined'`.                                                            |
| `auth-plugin/test/unit/scoped/scoped-policy.test.ts`, `scoped/scoped-options.test.ts`             | `scoped/scoped-policy.ts`, `scoped/model.ts`, `scoped/options.ts` | Cap table; `DenyReason` `'token-confined'` reported.                                                                                   |
| `auth-plugin/test/unit/local-strategy.test.ts`, `auth-service.test.ts`                            | `services/auth-service.ts`                                        | `verifyCredentials(c, request)` reaches `verify(id, secret, request)`; without a request the third argument is `undefined`.            |
| `auth-plugin/test/unit/auth-plugin-options.test.ts`                                               | `plugin/auth-plugin.ts`                                           | Refusals: `confineScopedTokens: 'yes'`, `jwt.tenantClaim: ''`. Wiring: the cap reaches both services.                                  |
| `auth-plugin/test/integration/tenant-binding.test.ts` (new)                                       | end to end                                                        | §3.2 and §3.3 cross-tenant cases with MultiTenancyPlugin.                                                                              |
| `auth-plugin/test/integration/scoped-token-confinement.test.ts` (new)                             | end to end                                                        | §3.4 V12-37 reproduction, including the decorated route.                                                                               |
| `session-plugin/test/unit/csrf/bearer-exemption.test.ts`, `middleware/session-middleware.test.ts` | `csrf/exclude.ts`, `middleware/session-middleware.ts`             | Flag table; no commit for an exempted request.                                                                                         |
| `mcp-plugin/test/unit/csrf-exempt.test.ts` (new)                                                  | `serve/csrf-exempt.ts`                                            | Sets the flag only for `POST` on the exact path (`GET`, a prefix path and a trailing slash do not).                                    |
| `mcp-plugin/test/integration/mcp-csrf-composition.test.ts` (new)                                  | `plugin/mcp-plugin.ts`                                            | §3.7.                                                                                                                                  |
| `common/test/unit/state-keys.test.ts`                                                             | `state-keys.ts`                                                   | Literal value pinned.                                                                                                                  |
| `cli/test/unit/full-stack-template.test.ts` + scaffold e2e                                        | `templates/full-stack-app-files.ts`                               | §3.5.                                                                                                                                  |

Every new behaviour test must fail without its fix. The implementer runs each new test against the
unfixed source once and records the failure in the hand-off.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m139a-identity-authorization
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common auth-plugin session-plugin mcp-plugin cli   # per-file ≥90%, ANSI-stripped
pnpm run test:deno-lane
pnpm run ci:local            # on the final commit (cli shard boots scaffolds)
pnpm run release:publish --dry-run
pnpm run release:verify <next patch>
```

The PR also needs a **committed-tree security audit** (ROADMAP: M139a is security-audited). It
follows `.roo/skills/security-audit/SKILL.md` and is run by a freshly spawned Claude agent that did
not implement the milestone, never by Codex. Its record goes in the PR, and it covers at least:

- the tenant comparison reads verified claims only;
- an unset credential source fails closed;
- the CSRF flag cannot be set from request input, and covers only the exact path and `POST`;
- the fetch-rule sites still refuse `*.localhost`.

The full obligation list is §8a.

## 8a. Design security review

Completed 2026-11-09, before implementation, against the source cited in §1.

- **Reviewed flows:**
  - F1 a bearer JWT verified and mapped to a principal (`sub`, tenant claim);
  - F2 a trusted-issuer token, the same checks, before `toPrincipal`;
  - F3 `requireAuth({ credentials })` deciding from the recorded credential source;
  - F4 the RBAC and scoped-RBAC checks with `confineScopedTokens` on, through guards, decorators and
    direct `hasRole`;
  - F5 password sign-in through `verifyCredentials(credentials, request)`;
  - F6 the template login rotating the session id;
  - F7 an anonymous and a cookie-carrying `POST /mcp` passing the CSRF marker, then the route's
    `Origin` check;
  - F8 URL validation under the name and fetch rules.
- **Assets:**
  - route access and the grants behind it;
  - tenant isolation (data and identity);
  - the principal id that grants, idempotency records and ownership key on;
  - the browser session id;
  - the trust of keys fetched for verification.
- **Attackers:**
  - a client holding a valid narrow (scoped or delegated) token for a privileged user;
  - a tenant user or token reaching for another tenant, or for the platform host;
  - a token issuer, or the app's own mint, producing a token without `sub`;
  - a cross-site page driving a signed-in browser (CSRF, session fixation);
  - an unauthenticated client sending arbitrary headers and paths;
  - a host resolver that does not map `*.localhost` to loopback.
- **Obligations the audit probes** (each needs a positive control showing that the allowed case
  still passes):
  - **O1** A JWT with `sub` missing, non-string or `''` gives `401` on a guarded route; no principal
    id `'unknown'` is reachable anywhere in `src/`.
  - **O2** With `tenantClaim` set, a token for tenant A gives `401` on tenant B, both JWT and
    issuer. The comparison reads the verified payload, never the multi-tenancy resolver's unverified
    decode. A bound token on a tenant-less request gives `401`.
  - **O3** Password sign-in: the request reaches `verify`. Under the README recipe, A's credentials
    on B's host give no session.
  - **O4** `credentials: 'cookie'` refuses a bearer-only request, and `'header'` refuses a
    cookie-only request. An unset source refuses both. A request that cannot set the state key from
    input cannot widen it: probe a forged `auth-plugin:credential-source` header and query
    parameter.
  - **O5** With the cap on, the V12-37 reproduction (a scoped admin token) gets `403` on every RBAC
    and scoped-RBAC entry point, decorated routes included. A session admin and a `requireScopes`
    route keep `200`.
  - **O6** After the template login, the session id differs from the pre-login id. An attacker's
    planted cookie is not authenticated.
  - **O7** No request header, query or body sets `CSRF_EXEMPT_STATE_KEY`. Only `POST` on the exact
    MCP path is exempt: `/mcp/`, `/MCP`, `/%6Dcp` and `/mcp/extra` are each probed, and each still
    gets form CSRF, or does not reach the MCP route. A cross-site `Origin` on `/mcp` still gets
    `403`. An exempted `/mcp` response carries no `Set-Cookie`. A tool call made with a session
    cookie and no CSRF token is still refused on its inner request. A query string does not change
    the path (`/mcp?x` is `/mcp`), so it is the MCP route and stays exempt by design, still behind
    the Origin check.
  - **O8** The fetch-rule sites refuse `http://acme.localhost`. The name-rule sites refuse
    `http://localhost.evil.test`, `http://evil-localhost` and `http://127.0.0.2`.
- **Committed-tree audit:** yes. The change crosses the authentication, authorization and tenancy
  boundaries, and the ROADMAP names M139a as audited. It is run by a fresh Claude agent per
  `.roo/skills/security-audit/SKILL.md`, on the PR's head commit. The record goes in the PR.

## 8. Risks & mitigations

- **A request carrying both a session cookie and a bearer token is recorded as `'header'`.** Header
  strategies run first (`auth-plugin.ts:263`, `:287`, `:332` before `:345`, `:434`). So on a
  `credentials: 'cookie'` route, a browser that also sends a bearer gets `401`. That fails closed.
  The README states it, and a test in `guards.test.ts` pins it.
- **Application middleware that replaces the principal after authentication leaves the recorded
  source stale for that request.** The JSDoc of `credentials` says the source describes the plugin's
  own authentication. An app that swaps principals must also set the key, or use `'any'`.

- **A replaced `IAuthService` records no credential source, so `credentials: 'cookie'` refuses every
  request.** That is the intended fail-closed behaviour. The JSDoc and README say so, and a test
  pins it.
- **`confineScopedTokens` on an app whose OIDC access tokens carry `scope: 'openid profile'` takes
  roles away from those users.** The option is opt-in in this patch, and the README names the case
  and the remedy: map scopes to `requireScopes` routes, or use a session. The `0.13.0` default flip
  must carry the same note in its BREAKING entry.
- **Renaming the internal session-plugin key misses a reader.** Grep both names before the rename
  lands; the session-middleware test pins the no-commit behaviour.
- **The MCP marker's path comparison drifts from the route's path.** Both read `resolved.path`, and
  the unit test covers a trailing slash and a prefix path.

## 9. Out of scope

- **`confineScopedTokens` as the default.** It is breaking, so it ships in `0.13.0`. This PR adds a
  line to the ROADMAP's M139 sequence paragraph that names it as part of the `0.13.0` batch with
  M139b and M139g.
- **`RouteSecurityMetadata` naming the credential restriction for OpenAPI.** It belongs to M139e or
  a later docs/contract letter. Today `requireAuth({ credentials })` documents a route as
  authenticated without saying which scheme.
- **`*.localhost` on URLs the server fetches.** It stays refused on purpose (§3.6). A dev issuer
  publishes its JWKS on `http://localhost:<port>`.
- **The `0.13.0` row re-run that closes these rows in `smoke/DEFECTS.md`.** A row closes only after
  a re-run on a newly published version.
