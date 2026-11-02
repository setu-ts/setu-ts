# Milestone 132 — Resource-server authentication for agents and tools (`@setu-ts/auth-plugin`)

> **Status:** Planning. Branch: `feat/m132-resource-server-auth`. `develop` and `main` are protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Make auth-plugin a correct OAuth 2.0 resource server, which an MCP server (M133) must be and any API
serving third-party clients should be. A bearer-protected route tells a client WHY it was refused
and WHERE to get a token (RFC 6750 challenges, RFC 9728 metadata); a route can require OAuth scopes;
a trusted issuer can accept more than one audience and can insist on RFC 9068 access tokens; and a
token issued to an agent acting for a user (RFC 8693 `act`) is visible as such and can be refused
per route. The boundary: auth-plugin owns every behaviour; `common` gains three optional members
(`IPrincipal.scopes`, `IPrincipal.actor`, `RouteSecurityMetadata.scopes`); openapi-plugin reads the
new scope brand when it derives security requirements. Nothing here is MCP-specific.

- **In scope:**
  - `IPrincipal.scopes` filled from the `scope`/`scp` claim by the JWT and trusted-issuer
    strategies; a `requireScopes(...)` guard;
  - `WWW-Authenticate: Bearer` challenges on 401 and on a scope 403;
  - the `resourceServer` option: an RFC 9728 metadata document at its well-known path and the
    `resource_metadata` challenge parameter;
  - a list of accepted audiences per `TrustedIssuer`, and an opt-in RFC 9068 `typ` check;
  - `IPrincipal.actor` from the outermost `act` claim, and `requireAuth({ delegation })`;
  - the `RouteSecurityMetadata.scopes` brand and openapi-plugin's derived security reading it;
  - docs: `PUBLIC_API.md`, auth-plugin and openapi-plugin READMEs, auth-plugin `AGENT_CARD.md`,
    `CHANGELOG.md`, `docs/upgrading.md`.
- **NOT this milestone:**
  - an authorization server, Dynamic Client Registration (deprecated by MCP `2026-07-28`), Client ID
    Metadata Documents, ID-JAG (draft) — none is a resource-server behaviour;
  - `may_act` and prior actors in nested `act` (RFC 8693 §4.1: informational only);
  - signed metadata (`signed_metadata`), DPoP and mTLS-bound tokens;
  - authorization-diagnostics observations for scope decisions (M98h observes RBAC only; no
    milestone owns the extension yet — §9);
  - a `@Scopes()` decorator (`@UseGuards(requireScopes(...))` already works; no milestone yet);
  - MCP itself (M133).

## 1. Contracts verified from SOURCE (not names)

| Reference                                           | Source (file:line)                                                          | Verified surface / fact                                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IPrincipal`                                        | `packages/common/src/services/auth.ts:16-25`                                | `{ id; roles?; permissions?; claims? }` — no scopes, no actor                                                                                                                                                 |
| JWT strategy principal mapping                      | `packages/auth-plugin/src/strategies/jwt-strategy.ts:74, 118-140`           | `id` = `sub`; `roles`/`permissions` from same-named string[] claims; `claims` = every key except `sub roles permissions iat exp nbf aud iss type jti`, so `scope`/`scp`/`act` pass through raw                |
| Trusted-issuer strategy                             | `packages/auth-plugin/src/strategies/issuer-strategy.ts:129-133`            | refuses claims `typ === 'ID'`, then returns `binding.issuer.toPrincipal(outcome.claims)` — the app maps claims                                                                                                |
| `TrustedIssuer.audience`                            | `packages/auth-plugin/src/interfaces/index.ts:174-223` (field at 186)       | a single `string`                                                                                                                                                                                             |
| `compileIssuers` audience check                     | `packages/auth-plugin/src/issuers/trusted-issuer.ts:28, 147-148, 212`       | `CompiledIssuer.audience: string`; refuses a non-string or empty audience; sign-in reuses it with `audience: clientId` (`sign-in/config.ts:256`)                                                              |
| `isAcceptableUrl`                                   | `packages/auth-plugin/src/issuers/trusted-issuer.ts:63`                     | https, or http on loopback, printable ASCII — the URL rule this plan reuses                                                                                                                                   |
| Verifier audience check                             | `packages/auth-plugin/src/issuers/jwt-verifier.ts:66, 79, 90, 172-173`      | `#audience: string`; `aud` string-or-array, `audiences.includes(this.#audience)`; no `typ` check; internal (not in the barrel)                                                                                |
| Auth middleware                                     | `packages/auth-plugin/src/middleware/auth-middleware.ts:42-90`              | never responds; swallows strategy throws; an invalid token and no token both leave `ctx.request.user` null; `authMiddleware()` is exported and takes no options                                               |
| Plugin middleware registration                      | `packages/auth-plugin/src/plugin/auth-plugin.ts:67, 540`                    | `ctx.middleware.add(...)` at `AUTH_MIDDLEWARE_PRIORITY = 300`; `middleware: false` skips it (`interfaces/index.ts:287`)                                                                                       |
| Guards                                              | `packages/auth-plugin/src/guards/index.ts:168` and siblings                 | plain `MiddlewareFunction`s branded with `withSecurityMetadata`; refuse via `respondWithAuthorizationFailure` and return without `next()`; arguments validated at build time (`AuthPluginConfigurationError`) |
| `RequireAuthOptions`                                | `packages/auth-plugin/src/interfaces/index.ts:640`                          | `signInPage` only                                                                                                                                                                                             |
| Authorization responder                             | `packages/common/src/errors/authorization-responder.ts:74, 91`              | four `AuthorizationFailure`s; `respondWithAuthorizationFailure(target, failure)`                                                                                                                              |
| `ErrorResponseInit`                                 | `packages/common/src/errors/error-responder.ts:163`                         | no headers field — a challenge cannot travel through the responder                                                                                                                                            |
| Response headers after the handler                  | `packages/kernel/src/context/response.ts:90-98`                             | `header()`/`appendHeader()` write a mutable `Headers` until the snapshot; `json()`/`send()` set `#ended` but do not freeze headers                                                                            |
| Pipeline order                                      | `packages/kernel/src/pipeline/middleware-pipeline.ts:74`                    | ascending priority, ties by registration index; route middleware (guards) runs after every global middleware                                                                                                  |
| Error handler position                              | `packages/exceptions/src/middleware/error-handler.ts:18`                    | priority 0 — OUTSIDE the auth band, so a thrown 401 passes back through a priority-300 middleware as an exception                                                                                             |
| `httpStatusHintOf`                                  | `packages/common/src/errors/status-hint.ts:175`                             | reads the hint `AuthorizationDeniedError` carries (`policies/errors.ts:41-66`)                                                                                                                                |
| `RouteSecurityMetadata` / `isRouteSecurityMetadata` | `packages/common/src/http.ts:736-742, 812-818`                              | `{ authenticated: boolean }` only; the guard accepts any object with a boolean `authenticated`                                                                                                                |
| openapi derived security                            | `packages/openapi-plugin/src/generators/openapi-generator.ts:867-882`       | `deriveSecurity: { scheme }` yields `[{ [scheme]: [] }]` — the scopes array is always empty                                                                                                                   |
| Request state                                       | `packages/common/src/http.ts:390`                                           | `IRequestContext.state: Map<string, unknown>` — the per-request channel this plan uses between a guard and the challenge middleware                                                                           |
| `'www-authenticate'` elsewhere                      | `packages/idempotency-plugin/src/constants.ts:180`                          | the only occurrence: stripped from idempotent replays; nothing sets the header today                                                                                                                          |
| Name clash: "scope"                                 | `packages/auth-plugin/src/scoped/*`, `interfaces/index.ts:310-318, 818-936` | M110b's `ScopeRef`/`requireScopedRole` mean a tenant/org scope, not an OAuth scope — the JSDoc of every new symbol says which                                                                                 |

**Established resource servers compared (read 2026-11-01, primary sources):**

| Behaviour           | Spring Security 7.x                                               | ASP.NET Core JwtBearer / MCP C# SDK                                       | MCP TS SDK 2.4.0                                                 | RFC                                            | This plan                                                                               |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Scope claims        | `scope` (split on space) else `scp` (array or string); not merged | none in JwtBearer                                                         | verifier fills `AuthInfo.scopes`                                 | RFC 8693 §4.2 / 9068: `scope`, space-separated | Spring's rule                                                                           |
| 401, no credentials | `Bearer resource_metadata="…"`, no `error`                        | bare `Bearer`, no `error`                                                 | `error="invalid_token"` (deviates from RFC 6750 §3.1)            | 6750 §3.1: SHOULD NOT carry an error code      | `Bearer` (+ `resource_metadata` when configured), no `error`                            |
| 401, bad token      | `error="invalid_token"`, description, `error_uri`                 | `error="invalid_token"`, description interpolating token values unescaped | `error="invalid_token"` + description                            | 6750: SHOULD carry `error`                     | `error="invalid_token"`, NO description (nothing token-derived reaches the header)      |
| 403, missing scope  | `error="insufficient_scope"`, fixed description, no `scope=`      | 403 with no header                                                        | `error="insufficient_scope"`, `scope="…"`, `resource_metadata`   | 6750: SHOULD; MAY list `scope`                 | `error="insufficient_scope"`, `scope="<required>"`, `resource_metadata` when configured |
| Audience            | not by default; one value, `aud.contains`                         | `ValidAudiences` list, any match                                          | `expectedResource` single                                        | 9068 §4: MUST contain an expected identifier   | a list, any match                                                                       |
| `typ: at+jwt`       | opt-in builder; the default REJECTS `at+jwt`                      | `ValidTypes` null = any                                                   | —                                                                | 9068 §4: MUST                                  | opt-in per issuer; default accepts any `typ` (today's behaviour)                        |
| RFC 9728 document   | since 7.0; `resource` derived from the REQUEST URL                | MCP SDK: derived from request, path-suffixed                              | `resource` from configured URL; `Access-Control-Allow-Origin: *` | 3.3: `resource` MUST equal the identifier      | from CONFIGURED `resource` only — never the `Host` header                               |
| `act`               | none                                                              | `ValidateActor` default false                                             | —                                                                | 8693 §4.1: outermost = current actor           | outermost `act` → `principal.actor`; nested ignored                                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                     | Doc deliverable (same PR)                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| C1  | ROADMAP M132 decision 1 names the guard `requireScopes` while the guard family is `requireRole`/`requirePermission`/`requireAllPermissions`, and M110b already owns "scope" for tenant grants | keep `requireScopes` (the MCP SDK's name, plural because it is ALL-of like the RFC's `scope` list); every JSDoc says "OAuth scopes, not M110b scoped grants" | auth-plugin README guards table and `PUBLIC_API.md` row state the distinction |
| C2  | ROADMAP M132 decision 3 leaves open whether the resource identifier must be among an issuer's audiences                                                                                       | NOT required (§3.6): Entra and others issue non-URL audiences; the app lists what its issuer stamps                                                          | ROADMAP M132 decision 3 amended to the decided rule                           |
| C3  | `RouteSecurityMetadata`'s JSDoc says it "deliberately carries authentication PRESENCE only … roles and permissions are not represented"                                                       | scopes ARE represented (§3.8) — they are part of an OAuth security requirement, unlike roles; roles stay out                                                 | the JSDoc and the `PUBLIC_API.md` prose (common section) rewritten            |

## 3. Design decisions

### 3.1 Scopes on the principal

- **Decision:** optional `IPrincipal.scopes?: readonly string[]` (OAuth 2.0 scopes; JSDoc says not
  M110b grants). One internal parser, `parseScopeClaim(claims)` in `src/resource-server/claims.ts`:
  if `scope` is present it alone is read — a string split on ASCII spaces with empty entries dropped
  — and `scp` is ignored; otherwise `scp` is read as a string (split the same way) or an array of
  strings. Any other shape, or a non-string array entry, yields no scopes (`undefined`), never a
  partial list. Duplicates are removed, order kept. The JWT strategy sets `scopes` from it; the
  trusted-issuer strategy sets `scopes` on the principal `toPrincipal` returned ONLY when that
  principal has no `scopes` member, so an app's own mapping wins. `claims` is unchanged (the raw
  claim stays where it was). Principals from api-key, session, auth-session, SAML, passkeys and
  sign-in get scopes only if the app's own mapper sets them.
- **Why:** Spring Security's rule (§1 table), the only one of the three that defines a precedence;
  scopes are standardized by RFC 8693 §4.2 and RFC 9068 §2.2.3, so reading them is not the "guess
  where a provider puts roles" that `toPrincipal` exists to avoid.
- **Test home:** `test/unit/resource-server-claims.test.ts` (the parse table as data), the two
  strategy tests.

### 3.2 `requireScopes(...scopes)`

- **Decision:** `requireScopes(first: string, ...rest: string[]): MiddlewareFunction`, ALL-of.
  Built-time validation: each scope matches RFC 6749 §3.3 `scope-token`
  (`1*( %x21 / %x23-5B / %x5D-7E )` — no space, `"` or `\`), duplicates refused, else
  `AuthPluginConfigurationError`. Behaviour: no principal →
  `respondWithAuthorizationFailure(ctx, 'authentication-required')` (401); a principal whose
  `scopes` lacks any required scope (absent `scopes` lacks all) → records the required list in
  `ctx.state` under an internal key and answers `'insufficient-privileges'` (403); otherwise
  `await next()`. The guard does not resolve `CAPABILITIES.AUTHORIZATION` (scopes are on the
  principal; no RBAC needed). Branded `withSecurityMetadata({ authenticated: true, scopes })`.
- **Why:** OAuth semantics (a token carries all scopes a call needs; the MCP SDK and RFC 6750's
  `scope` attribute list them all). Reusing `'insufficient-privileges'` keeps the Problem Details
  body and the common union unchanged; the scope detail travels in the challenge header (§3.3).
- **Test home:** `test/unit/require-scopes.test.ts` including the short-circuit test (a refused call
  never reaches the handler), `test/integration/resource-server.test.ts`.

### 3.3 One challenge writer — an internal `bearer-challenge` middleware

- **Decision:** when `jwt`, `issuers` or `resourceServer` is configured, the plugin registers an
  internal global middleware named `bearer-challenge` at priority 300 (the auth band, registered
  before `auth`; independent of `middleware: false`, because it reads only the request and the
  response). It runs `await next()` and then, only if the response has no `WWW-Authenticate` header
  yet:
  - status **401** → `Bearer`, plus `error="invalid_token"` when the request carried an
    `Authorization` header whose scheme is `Bearer` (case-insensitive) — otherwise no error
    parameter (RFC 6750 §3.1);
  - status **403** with the §3.2 state entry → `Bearer error="insufficient_scope", scope="a b"`;
  - any other status (including M124's 302 sign-in redirect) → nothing. `resource_metadata="<url>"`
    is appended to both forms when `resourceServer` is configured. A thrown error whose
    `httpStatusHintOf(error)?.status` is 401 gets the 401 header before the error is rethrown (the
    error handler at priority 0 keeps headers already set; §1). No `error_description`, no `realm`,
    no `error_uri`: every value in the header comes from configuration or from build-time-validated
    scope tokens, so nothing the request supplied is ever echoed. The header is built by one
    internal function, `formatBearerChallenge({ error?, scopes?, resourceMetadata? })`, which quotes
    values and is the only writer.
- **Why:** every 401 producer in the repo (auth-plugin guards, policy and scoped guards, decorator
  `@Roles`/`@Permissions`, `AuthorizationDeniedError` thrown) gets the challenge from ONE
  implementation without each learning about headers, and `ErrorResponseInit` (no headers field)
  stays untouched. Not echoing token text avoids the ASP.NET Core interpolation the survey found (§1
  table). A cookie-only app (no bearer strategy) gets no Bearer challenge.
- **Test home:** `test/unit/bearer-challenge.test.ts` (formatter as a table; each status and request
  shape), `test/integration/resource-server.test.ts` (a decorated `@Roles` 401, a thrown
  `AuthorizationDeniedError`, an app-set header left alone, a redirect untouched).

### 3.4 `resourceServer` option and the RFC 9728 document

- **Decision:** `AuthPluginOptions.resourceServer?: ResourceServerOptions`:
  `{ resource: string; authorizationServers?: readonly string[]; scopesSupported?: readonly string[]; resourceName?: string }`.
  Compiled once at `register()` by `compileResourceServer`, which refuses
  (`AuthPluginConfigurationError`): a `resource` that fails `isAcceptableUrl`, or carries a query,
  fragment or userinfo; an `authorizationServers` entry that fails `isAcceptableUrl`; a
  `scopesSupported` entry that is not a `scope-token`; an empty `resourceName`. Derived values: the
  metadata path is `/.well-known/oauth-protected-resource` followed by the resource's path with any
  trailing `/` removed (RFC 9728 §3.1); the metadata URL is the resource's origin plus that path.
  `authorizationServers` defaults to the distinct `issuer` values of `issuers` when omitted. The
  document — `resource` (exactly the configured string), `authorization_servers`,
  `scopes_supported`, `resource_name`, `bearer_methods_supported: ["header"]` — omits every absent
  or empty member (RFC 9728 §3.2) and is serialized ONCE. A `GET` route at the metadata path answers
  200 `application/json` with `Cache-Control: public, max-age=300` and
  `Access-Control-Allow-Origin: *`. The route is not guarded; the router's duplicate refusal covers
  a collision.
- **Why:** `resource` comes from configuration, never from the request's `Host`, so a spoofed host
  cannot make the server publish metadata naming another resource (Spring and the MCP C# SDK derive
  it from the request; RFC 9728 §3.3 makes the client refuse a mismatch, which a configured value
  never produces behind a proxy). `bearer_methods_supported` is `header` because both bearer
  strategies read only the `Authorization` header. The CORS header matches the MCP SDK: the document
  is public and browser-based clients fetch it.
- **Test home:** `test/unit/resource-server-config.test.ts` (refusal table, path/URL derivation
  table incl. root and nested paths), `test/integration/resource-server.test.ts` (document field by
  field, forbidden members absent, headers).

### 3.5 Audience binding — a list per issuer

- **Decision:** `TrustedIssuer.audience: string | readonly string[]`. `compileIssuers` normalizes to
  a non-empty `readonly string[]` (`CompiledIssuer.audiences`), refusing an empty list, a non-string
  or empty entry, and a duplicate. The verifier accepts a token whose `aud` (string or array)
  contains ANY configured audience. Sign-in's reuse (`audience: clientId`) keeps working unchanged.
  `JwtOptions.audience` (the local HS256/RS256 signer) stays a single string.
- **Why:** ASP.NET Core's `ValidAudiences` (§1 table); an MCP server is often reachable under more
  than one identifier during a migration.
- **Test home:** `test/unit/trusted-issuer-options.test.ts`, `test/unit/jwt-verifier.test.ts`
  (existing files, new rows).

### 3.6 The resource identifier is not forced into the audience list

- **Decision:** configuring `resourceServer` does NOT require `resource` among any issuer's
  audiences, and no option enforces it. The README says that the audience list IS the RFC 8707 / MCP
  "issued for me" check, and that it should name what the authorization server stamps for this
  resource. No token is forwarded anywhere: the plugin has no outbound path that carries an inbound
  token (MCP: servers "MUST NOT accept or transit any other tokens").
- **Why:** Entra issues `api://<guid>` or app-id audiences, Auth0 an API identifier; forcing the URL
  would refuse valid deployments.
- **Test home:** none (a documented non-behaviour; §6 asserts only that a non-URL audience works).

### 3.7 RFC 9068 `typ`, opt-in

- **Decision:** `TrustedIssuer.requireAccessTokenType?: boolean` (default `false`). When `true` the
  verifier refuses, before key lookup, a header `typ` that is not `at+jwt` or `application/at+jwt`
  compared ASCII-case-insensitively (RFC 7515 `typ` is a media type), with a new verifier reason
  `typ-mismatch` reported through the existing failure reporter.
- **Why:** RFC 9068 §4 makes it a MUST, but Entra and Keycloak do not stamp it; Spring's default
  even rejects `at+jwt`. Opt-in is the only default that changes no deployment.
- **Test home:** `test/unit/jwt-verifier.test.ts`.

### 3.8 Scopes in route security metadata, read by openapi

- **Decision:** `RouteSecurityMetadata.scopes?: readonly string[]` (optional).
  `isRouteSecurityMetadata` additionally rejects a present `scopes` that is not an array of strings.
  `requireScopes` brands `{ authenticated: true, scopes }`. openapi-plugin's `#deriveSecurity`
  collects the scopes of every authenticated brand on the route and emits
  `[{ [scheme]: <sorted unique scopes> }]` (empty when none) — a declared `schema.security` still
  wins.
- **Why:** the derived document today says "authenticated" with an empty scope list even on a
  scope-guarded route; OpenAPI 3.1 allows the list for every scheme type. M133 reads the same brand
  to learn a route's required scopes.
- **Test home:** `packages/common/test/unit/security-metadata.test.ts` (guard rows),
  `packages/openapi-plugin/test/unit/openapi-generator.test.ts` (existing).

### 3.9 The actor of a delegated token

- **Decision:** optional `IPrincipal.actor?: IPrincipalActor` where `IPrincipalActor` is
  `{ readonly id: string; readonly claims: Readonly<Record<string, unknown>> }`. Internal
  `parseActClaim(claims)`: absent `act` → no actor; `act` a non-array object whose `sub` is a
  non-empty string (else whose `client_id` is) → `{ id, claims: <act's own members except act> }`;
  any other `act` → the TOKEN is refused (JWT strategy returns `null`; issuer strategy reports a new
  reason `act-malformed`). Nested `act` is never read and never exposed (RFC 8693 §4.1). The JWT
  strategy sets `actor`; the issuer strategy sets it on the mapped principal only when that
  principal has no `actor` member, and always applies the malformed-`act` refusal before
  `toPrincipal` runs. `RequireAuthOptions.delegation?: 'allow' | 'forbid' | 'require'` (default
  `'allow'`, today's behaviour): with a principal present, `'forbid'` and an actor, or `'require'`
  and none, answer `'insufficient-privileges'` (403). Validated at build time.
- **Why:** an agent acting for a user must not pass as the user where a route forbids it, and a
  token whose delegation cannot be identified must not pass as a direct user (fail closed).
- **Test home:** `test/unit/resource-server-claims.test.ts`, `test/unit/guards.test.ts` (existing,
  new rows), the strategy tests.

### 3.10 Wiring and the public barrel

- **Decision:** `auth-plugin.ts` compiles `resourceServer` with the issuers, registers the metadata
  route and the `bearer-challenge` middleware (§3.3 condition). The barrel adds `requireScopes` and
  the type `ResourceServerOptions`; common's barrel adds `IPrincipalActor`. Nothing else is
  exported.
- **Why:** the free functions under `src/resource-server/` are internal seams for unit tests.
- **Test home:** `test/integration/resource-server.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — every new contract member is optional (`IPrincipal.scopes`,
`IPrincipal.actor`, `RouteSecurityMetadata.scopes`), and `TrustedIssuer.audience` only widens a type
the application supplies. Two behaviour changes for callers, both in `CHANGELOG.md` and
`docs/upgrading.md`: 401s on an app with a bearer strategy gain a `WWW-Authenticate` header
(additive, a `### Changed` entry); and a token whose `act` claim is malformed, accepted today, is
refused (§3.9) — a `BREAKING` entry, so the milestone **ships in minor 0.13.0**, the slot the
maintainer chose for M132–M136 on 2026-11-01.

| Exported symbol                         | Kind           | Consumer / real code path that READS it                                            |
| --------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `requireScopes` (auth-plugin)           | function       | application routes; brands read by openapi `#deriveSecurity` and (M133) mcp-plugin |
| `ResourceServerOptions` (auth-plugin)   | type           | `AuthPluginOptions.resourceServer`, compiled by `compileResourceServer`            |
| `IPrincipal.scopes` (common)            | optional field | `requireScopes`; M133 tool-list filtering                                          |
| `IPrincipal.actor` / `IPrincipalActor`  | field / type   | `requireAuth({ delegation })`; application audit/handlers                          |
| `RouteSecurityMetadata.scopes` (common) | optional field | openapi `#deriveSecurity`; M133                                                    |
| `TrustedIssuer.audience` (widened)      | field          | `compileIssuers` → verifier                                                        |
| `TrustedIssuer.requireAccessTokenType`  | field          | verifier `typ` check                                                               |
| `RequireAuthOptions.delegation`         | field          | `requireAuth`                                                                      |

### 4.1 Options — every option names its consumer

| Option                                 | Consumer                   | Behavior (per implementation)                                                          |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `resourceServer.resource`              | `compileResourceServer`    | metadata path/URL, document `resource`, challenge `resource_metadata`                  |
| `resourceServer.authorizationServers`  | `compileResourceServer`    | document `authorization_servers`; default = issuers' `issuer` values; omitted if empty |
| `resourceServer.scopesSupported`       | `compileResourceServer`    | document `scopes_supported`; omitted if absent                                         |
| `resourceServer.resourceName`          | `compileResourceServer`    | document `resource_name`; omitted if absent                                            |
| `TrustedIssuer.audience` (list)        | `compileIssuers`, verifier | any-match                                                                              |
| `TrustedIssuer.requireAccessTokenType` | verifier                   | `typ` must be `at+jwt` / `application/at+jwt`                                          |
| `RequireAuthOptions.delegation`        | `requireAuth`              | `allow` / `forbid` / `require`                                                         |

## 5. Implementation files

| File                                                               | Purpose                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/common/src/services/auth.ts`                             | `IPrincipal.scopes?`, `IPrincipal.actor?`, `IPrincipalActor`                       |
| `packages/common/src/http.ts`                                      | `RouteSecurityMetadata.scopes?`, `isRouteSecurityMetadata`                         |
| `packages/common/src/index.ts`                                     | export `IPrincipalActor`                                                           |
| `packages/auth-plugin/src/resource-server/claims.ts` (new)         | `parseScopeClaim`, `parseActClaim`, `isScopeToken`                                 |
| `packages/auth-plugin/src/resource-server/config.ts` (new)         | `compileResourceServer`: validation, path/URL derivation, serialized document      |
| `packages/auth-plugin/src/resource-server/challenge.ts` (new)      | `formatBearerChallenge`, the `bearer-challenge` middleware, the internal state key |
| `packages/auth-plugin/src/resource-server/metadata-route.ts` (new) | registers the `GET` metadata route                                                 |
| `packages/auth-plugin/src/guards/index.ts`                         | `requireScopes`; `requireAuth({ delegation })`                                     |
| `packages/auth-plugin/src/interfaces/index.ts`                     | `ResourceServerOptions`, `TrustedIssuer` fields, `RequireAuthOptions.delegation`   |
| `packages/auth-plugin/src/strategies/jwt-strategy.ts`              | `scopes`, `actor`, malformed-`act` refusal                                         |
| `packages/auth-plugin/src/strategies/issuer-strategy.ts`           | default `scopes`/`actor` fill, `act-malformed`                                     |
| `packages/auth-plugin/src/issuers/trusted-issuer.ts`               | audience list normalization                                                        |
| `packages/auth-plugin/src/issuers/jwt-verifier.ts`                 | any-audience match, `typ-mismatch`                                                 |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                   | wiring (§3.10)                                                                     |
| `packages/auth-plugin/src/index.ts`                                | barrel: `requireScopes`, `ResourceServerOptions`                                   |
| `packages/openapi-plugin/src/generators/openapi-generator.ts`      | derived scopes                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                         | src covered                                                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-plugin/test/unit/resource-server-claims.test.ts` (new)      | `resource-server/claims.ts`                                              | scope table as data: `scope` string, `scope` + `scp` (scope wins), `scp` array, `scp` string, empty string, non-string entry → undefined, duplicates; act table: absent, `sub`, `client_id` fallback, nested act dropped, array/string/number/empty → malformed; `isScopeToken` table incl. space, `"`, `\`                                                                         |
| `auth-plugin/test/unit/resource-server-config.test.ts` (new)      | `resource-server/config.ts`                                              | refusal table (http non-loopback, query, fragment, userinfo, bad AS URL, bad scope, empty name); path/URL table (`https://h`, `https://h/`, `https://h/mcp`, `https://h/a/b/`); document members omitted when empty; default AS list from issuers                                                                                                                                   |
| `auth-plugin/test/unit/bearer-challenge.test.ts` (new)            | `resource-server/challenge.ts`                                           | formatter table; middleware: 401 no header → bare; 401 + `Authorization: Bearer x` → `invalid_token`; `Authorization: Basic` → bare; 403 with state → `insufficient_scope` + `scope`; 403 without state → none; 302 → none; existing header kept; thrown 401 hint → header then rethrow; `resource_metadata` present only when configured; no request text in any header            |
| `auth-plugin/test/unit/require-scopes.test.ts` (new)              | `guards/index.ts` (`requireScopes`)                                      | build-time refusals; 401 anonymous; 403 + state entry for missing one of two; pass with both; principal without `scopes` → 403; SHORT-CIRCUIT: handler not run on refusal; brand carries scopes                                                                                                                                                                                     |
| `auth-plugin/test/unit/guards.test.ts` (existing, new rows)       | `guards/index.ts` (`delegation`)                                         | allow/forbid/require × actor/no actor; invalid `delegation` refused at build; signInPage combined                                                                                                                                                                                                                                                                                   |
| `auth-plugin/test/unit/jwt-strategy.test.ts` (existing)           | `strategies/jwt-strategy.ts`                                             | `scopes` and `actor` set; malformed `act` → null; claims unchanged                                                                                                                                                                                                                                                                                                                  |
| `auth-plugin/test/unit/issuer-strategy.test.ts` (existing)        | `strategies/issuer-strategy.ts`                                          | default fill; app's `scopes`/`actor` win; `act-malformed` reported before `toPrincipal`                                                                                                                                                                                                                                                                                             |
| `auth-plugin/test/unit/trusted-issuer-options.test.ts` (existing) | `issuers/trusted-issuer.ts`                                              | string → list; list; empty list, empty entry, duplicate refused; sign-in clientId path                                                                                                                                                                                                                                                                                              |
| `auth-plugin/test/unit/jwt-verifier.test.ts` (existing)           | `issuers/jwt-verifier.ts`                                                | any of two audiences; none matches; `typ` table (`at+jwt`, `AT+JWT`, `application/at+jwt`, `JWT`, absent) with the flag on and off                                                                                                                                                                                                                                                  |
| `auth-plugin/test/integration/resource-server.test.ts` (new)      | `resource-server/metadata-route.ts`, `plugin/auth-plugin.ts`, `index.ts` | kernel app with `issuers` + `resourceServer`: document field by field and forbidden members absent; `Cache-Control`/ACAO; 401 challenge on a `requireAuth` route, a decorated `@Roles` route and a thrown `AuthorizationDeniedError`; 403 `insufficient_scope` end to end with a real signed token; cookie-only app sends no Bearer challenge; `middleware: false` still challenges |
| `common/test/unit/security-metadata.test.ts` (existing)           | `common/src/http.ts`                                                     | `scopes` accepted; non-array or non-string entry refused                                                                                                                                                                                                                                                                                                                            |
| `openapi-plugin/test/unit/openapi-generator.test.ts` (existing)   | `openapi-generator.ts`                                                   | scopes from two guards merged, sorted, unique; declared security wins; `[]` without scopes                                                                                                                                                                                                                                                                                          |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m132-resource-server-auth
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

- **Reviewed flows:** F1 a bearer request refused (401 challenge built from config and request shape
  only); F2 a scope refusal (403 challenge listing the route's REQUIRED scopes — never the token's);
  F3 the metadata document (public, static, from configuration); F4 token verification with an
  audience list and an optional `typ` check; F5 an `act`-bearing token mapped to `principal.actor`,
  or refused when malformed; F6 `requireAuth({ delegation })`.
- **Assets:** route access; the resource's identity as advertised to clients; the integrity of the
  principal (a delegated token must not pass as the user); response headers (no injection).
- **Attackers:** an unauthenticated client sending arbitrary `Authorization`, `Host` and
  `X-Forwarded-*` headers; a client with a valid token for another resource or with fewer scopes; a
  token issuer stamping a hostile or deeply nested `act`.
- **Obligations the audit probes (each with a positive control):** O1 no request-supplied byte in
  any `WWW-Authenticate` value; O2 the document's `resource` never follows `Host`/forwarded headers;
  O3 a token for an audience not in the list is refused; O4 a malformed `act` is refused, not
  ignored; O5 `requireScopes` short-circuits; O6 `scope=` lists only the route's required scopes; O7
  a cookie-only app gains no Bearer challenge; O8 `typ` check runs before key lookup when enabled.
- **Committed-tree audit:** yes — the change crosses the authentication boundary. Run by a fresh
  agent per `.roo/skills/security-audit/SKILL.md` on the PR's head commit; record in the PR.

## 8. Risks & mitigations

- A 401 produced by app code outside the plugin (a handler setting 401 itself) gains a Bearer
  challenge → correct for a bearer-protected API; an app-set header is never overwritten (§3.3
  test).
- A middleware ordered between the error handler and the auth band that swallows a thrown 401 and
  writes its own response → the post-`next()` branch still sees status 401 and adds the header.
- `IPrincipal.scopes` read as tenant scopes because of M110b's vocabulary → JSDoc and README name
  the difference (C1).
- The well-known path behind a reverse proxy that strips a prefix → the document is still correct
  (the URL comes from `resource`); the README says the route must be reachable at that URL.

## 9. Out of scope

- Authorization diagnostics for scope decisions — M98h's observer covers RBAC methods only; a
  follow-on with no milestone yet.
- A `@Scopes()` decorator — `@UseGuards(requireScopes(...))` covers it; no milestone yet.
- `may_act`, prior actors, signed metadata, DPoP, mTLS-bound tokens, an authorization server — not
  resource-server behaviours this milestone's consumers need; no milestone.
- MCP — M133.
