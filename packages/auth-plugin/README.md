# Auth Plugin

Authentication and authorization plugin for Setu-TS: JWT and API-key authentication, local
credential verification, RBAC authorization with role hierarchy, and short-circuiting route guards.

All cryptography (HS256/RS256 JWT signing/verification and PBKDF2-SHA256 password hashing) runs
through Web Crypto via `IRuntimeServices` (`runtime.subtle` / `runtime.randomBytes`), so **no npm
package is involved in issuing or verifying a token, or in hashing a password**, and every one of
those paths is cross-runtime (Deno / Node 20+ / Bun).

The package does declare one optional driver: `RedisRateLimitStore` lazy-loads `ioredis`, which npm
therefore installs alongside this package. Nothing imports it unless you construct that store — the
default `MemoryRateLimitStore` needs no driver. See
[Optional npm drivers](https://github.com/setu-ts/setu-ts/blob/main/docs/plugins.md#optional-npm-drivers)
for what that means on npm versus Deno.

The plugin always registers JWT and authentication services. It registers authorization only when
the optional `rbac` configuration is supplied:

| Service                | Token              | Interface                                           |
| ---------------------- | ------------------ | --------------------------------------------------- |
| JWT sign/verify/decode | `'jwt'`            | `IJwtService`                                       |
| Authentication         | `'authentication'` | `IAuthService`                                      |
| Authorization (RBAC)   | `'authorization'`  | `IAuthorizationService` (when `rbac` is configured) |

Without `rbac`, the four authorization guards answer **`501 Not Implemented`** rather than throwing
— see [Guards](#guards). A configured policy that the caller fails answers
`403 Insufficient
privileges`; it never names the required role or permission.

> **Refresh tokens and rate limiting ship in this package.** `IJwtService` itself exposes only
> `sign` / `verify` / `decode`, but do not hand-roll a refresh token as `sign({ expiresIn: '7d' })`
> — that has no rotation and no replay rejection. Use `RefreshTokenService` and
> `rateLimitMiddleware`, both covered below.

## Installation

```bash
deno add @setu-ts/auth-plugin
```

## Usage

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';

app.register(AuthPlugin({
  jwt: {
    secret: config.get('JWT_SECRET'), // HS256; use privateKey/publicKey PEMs for RS256
    audience: 'my-app-users', // expected `aud`, enforced on verify
    issuer: 'my-app', // expected `iss`, enforced on verify
  },
  apiKey: {
    header: 'X-API-Key',
    validate: (key) => apiKeyService.validate(key), // (key) => Promise<IPrincipal | null>
  },
  local: {
    // (identifier, secret) => Promise<IPrincipal | null>
    verify: (identifier, secret) => userService.checkPassword(identifier, secret),
  },
  rbac: {
    roles: {
      admin: { permissions: ['*'], inherits: ['manager'] },
      manager: { permissions: ['users:read', 'users:write'], inherits: ['user'] },
      user: { permissions: ['profile:read', 'profile:write'] },
    },
  },
}));

// AuthPlugin registers passive authentication globally at priority 300.
```

## Login (Issue Token)

`IAuthService.verifyCredentials({ identifier, secret })` resolves to an `IPrincipal | null`; mint a
JWT with the separate `IJwtService` resolved from `'jwt'`.

```typescript
import type { IAuthService, IJwtService } from '@setu-ts/common';

app.router.post('/auth/login', async (ctx) => {
  const auth = ctx.services.get<IAuthService>('authentication');
  const jwt = ctx.services.get<IJwtService>('jwt');
  const { username, password } = await ctx.request.json<{ username: string; password: string }>();

  const principal = await auth.verifyCredentials({ identifier: username, secret: password });
  if (!principal) {
    return ctx.response.status(401).json({ error: 'Invalid credentials' });
  }

  const accessToken = await jwt.sign(
    { sub: principal.id, roles: principal.roles },
    { expiresIn: '1h', audience: 'my-app-users', issuer: 'my-app' },
  );
  return ctx.response.json({ accessToken });
});
```

## Strategies

- **JwtStrategy** — passive bearer-token authentication. Extracts `Authorization: Bearer <token>`,
  calls `IJwtService.verify`, and maps the claims to an `IPrincipal`.
- **IssuerStrategy** — passive bearer-token authentication for tokens an **outside identity
  provider** issued (Auth0, Entra ID, Google, Keycloak, Cognito). Configured by the `issuers`
  option, runs immediately after the JWT strategy, reads the same header and scheme, and verifies
  against the provider's published key set. See
  [Accepting tokens from an identity provider](#accepting-tokens-from-an-identity-provider).
- **ApiKeyStrategy** — passive API-key authentication. Reads the key from a configurable header
  (default `X-API-Key`) and calls the app-supplied `apiKey.validate(key)` callback.
- **SessionStrategy** — passive cookie-session authentication. Reads the session cookie through
  `ISessionService.fromHeaders` and maps the opened `SessionView` to an `IPrincipal` through the
  required `session.toPrincipal` callback; it returns `null` when no session opened or the session
  carries no identity, so the chain continues. Configured by the `session` option and never
  barrel-exported, like the other two; it requires `SessionPlugin` to be registered, or `register()`
  throws naming both plugins.
- **LocalStrategy** — explicit credentials verification. Not passive; reached only via
  `IAuthService.verifyCredentials` from a login handler.

Passive strategies run in a fixed order during `IAuthService.authenticate` — **jwt → issuers →
api-key → session → caller-supplied, in declaration order** — and the first non-null principal wins,
with `null` returned when none match. A request carrying both a bearer header and a session cookie
is therefore authenticated by the JWT, because the explicit credential runs first. Caller-supplied
strategies come from the `strategies` option and run last; a `name` colliding with any other
strategy in the assembled chain makes `register()` throw, because a strategy's `name` is its only
identity.

## RBAC

`IAuthorizationService` (the `'authorization'` service) resolves a transitive role hierarchy before
checking. A principal with `admin` satisfies `requireRole('user')` when `admin` inherits `user`
(directly or transitively). Hierarchy resolution is cycle-safe (a self/cyclic `inherits` is
ignored). The wildcard permission `'*'` — held directly by the principal or granted by any of its
(direct or inherited) roles — satisfies every `hasPermission`/`hasAllPermissions` check.

```typescript
import type { IAuthorizationService } from '@setu-ts/common';

const authz = ctx.services.get<IAuthorizationService>('authorization');
authz.hasRole(principal, 'user'); // true when principal is admin and admin inherits user
authz.hasPermission(principal, 'users:write');
authz.hasAnyRole(principal, ['admin', 'manager']);
authz.hasAllPermissions(principal, ['users:read', 'users:write']);
```

## Guards

Guards are free `MiddlewareFunction` factories (imported from the plugin, not methods on
`IAuthService`). The authorization guards resolve `IAuthorizationService` from `'authorization'`,
return **401** when no principal is attached and **403** when the check fails, and short-circuit
(they do **not** call `next()`). `authMiddleware` always calls `next()`, so an unauthenticated
request still reaches the guard.

```typescript
import {
  publicRoute,
  requireAllPermissions,
  requireAnyRole,
  requireAuth,
  requirePermission,
  requireRole,
} from '@setu-ts/auth-plugin';

app.router.get('/profile', { middleware: [requireAuth()], handler });
app.router.delete('/users/:id', { middleware: [requireAuth(), requireRole('admin')], handler });
app.router.post('/users', {
  middleware: [requireAuth(), requirePermission('users:write')],
  handler,
});
app.router.get('/reports', {
  middleware: [requireAuth(), requireAnyRole(['admin', 'manager'])],
  handler,
});
app.router.post('/bulk', {
  middleware: [requireAuth(), requireAllPermissions(['users:read', 'users:write'])],
  handler,
});
app.router.get('/health', { middleware: [publicRoute()], handler });
```

> `publicRoute` is used instead of `public` because `public` is a reserved word.

### Guards without `rbac`

`rbac` is optional, and a JWT-only registration provides no authorization service. In that
composition the four authorization guards — `requireRole`, `requirePermission`, `requireAnyRole`,
`requireAllPermissions` — answer **`501`** with the detail `Authorization is not configured`,
short-circuiting before the handler. `requireAuth()` and `publicRoute()` resolve nothing and are
unaffected.

The guards answer through the error-responder seam, so the **status and the detail text are the
invariant** while the body's shape is whatever the application configured. With no `errorHandler`
registered you get the framework-default fallback; with one, its format:

```jsonc
// no errorHandler
{ "error": "Not Implemented", "detail": "Authorization is not configured" }
// errorHandler()
{ "statusCode": 501, "message": "Not Implemented", "details": { "detail": "Authorization is not configured" } }
// errorHandler({ format: 'rfc9457' })
{ "type": "about:blank", "title": "Not Implemented", "status": 501, "detail": "Authorization is not configured", "instance": "/reports" }
```

`501` rather than `403` because nothing is wrong with the caller: the deployment cannot evaluate the
policy at all, and the condition is permanent for that deployment. A principal that genuinely fails
a policy check still gets `403`. The guards fail **closed** either way — supply `rbac` to make them
evaluate.

## Password Hashing

`PasswordHasher` is an exported utility for provisioning passwords and verifying them inside a
`local.verify` callback. It draws a random 16-byte salt and derives a 32-byte key with PBKDF2-SHA256
(100 000 iterations) via `runtime.subtle` / `runtime.randomBytes`, comparing with a fixed-time
check.

```typescript
import { PasswordHasher } from '@setu-ts/auth-plugin';

const hasher = new PasswordHasher(runtime); // IRuntimeServices resolved from the 'runtime' token
const stored = await hasher.hash('correct horse battery staple');
const ok = await hasher.verify(stored, 'correct horse battery staple'); // true
```

## Options

| Option                           | Type                                                  | Default             | Description                                                                                     |
| -------------------------------- | ----------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `jwt`                            | `JwtOptions`                                          | -                   | Optional JWT service and passive bearer strategy.                                               |
| `jwt.secret`                     | `string \| Uint8Array`                                | -                   | HS256 key. Required for HS256.                                                                  |
| `jwt.privateKey`                 | `string` (PEM)                                        | -                   | RS256 private key. Required for RS256.                                                          |
| `jwt.publicKey`                  | `string` (PEM)                                        | -                   | RS256 public key. Required for RS256.                                                           |
| `jwt.algorithm`                  | `'HS256' \| 'RS256'`                                  | inferred            | Inferred from which key material is provided.                                                   |
| `jwt.audience`                   | `string`                                              | -                   | Expected `aud`; enforced on verify.                                                             |
| `jwt.issuer`                     | `string`                                              | -                   | Expected `iss`; enforced on verify.                                                             |
| `jwt.header`                     | `string`                                              | `'authorization'`   | Header name for bearer extraction.                                                              |
| `jwt.scheme`                     | `string`                                              | `'bearer'`          | Token scheme prefix.                                                                            |
| `jwt.accessTokenRevocationStore` | `IAccessTokenRevocationStore`                         | -                   | Shared store that rejects revoked typed access tokens.                                          |
| `apiKey.header`                  | `string`                                              | `'X-API-Key'`       | Header holding the API key.                                                                     |
| `apiKey.validate`                | `(key) => Promise<IPrincipal \| null>`                | -                   | App-supplied API-key lookup.                                                                    |
| `local.verify`                   | `(identifier, secret) => Promise<IPrincipal \| null>` | -                   | App-supplied credential check.                                                                  |
| `rbac.roles`                     | `Record<string, RoleDefinition>`                      | -                   | Role → permissions + `inherits` hierarchy.                                                      |
| `session.toPrincipal`            | `(view: SessionView) => IPrincipal \| null`           | -                   | Maps the opened session to its principal; `null` continues the chain. Requires `SessionPlugin`. |
| `strategies`                     | `readonly IAuthStrategy[]`                            | -                   | Caller-supplied strategies, appended after every built-in in declaration order.                 |
| `middleware`                     | `false \| AuthMiddlewareOption`                       | `{ priority: 300 }` | Move, exclude paths from, or disable the global authentication middleware.                      |
| `issuers`                        | `readonly TrustedIssuer[]`                            | -                   | Outside identity providers whose access tokens are accepted.                                    |
| `http`                           | `IAuthHttp`                                           | `fetch`-based       | Outbound HTTP for issuer key sets, discovery documents, and the sign-in token exchange.         |
| `signIn`                         | `SignInConfig`                                        | -                   | Sign-in with outside providers; registers `IAuthSessionService`. Requires `SessionPlugin`.      |

At least one passive strategy must be configured through `jwt`, `issuers`, `apiKey`, `session`, or
`strategies`; `local` alone is a login verifier and cannot authenticate a later request. For
backend-backed strategies on public operational routes, exclusions can be explicit:

```typescript
import { AuthPlugin, DEFAULT_RATE_LIMIT_EXCLUDED_PATHS } from '@setu-ts/auth-plugin';

AuthPlugin({
  apiKey: { validate: async () => null },
  middleware: { exclude: DEFAULT_RATE_LIMIT_EXCLUDED_PATHS },
});
```

Pass `middleware: false` only when attaching `authMiddleware()` at route level yourself. Existing
applications that added a global copy should remove it; two copies remain correct but run the
strategy chain twice.

When `jwt` is supplied, omitting both `jwt.secret` (HS256) and `jwt.privateKey` + `jwt.publicKey`
(RS256) throws at construction.

## Accepting tokens from an identity provider

`jwt` verifies tokens **this application issued**, against one key it holds. `issuers` verifies
tokens **an outside identity provider issued**, against the provider's published key set, which
rotates. The two coexist: a self-issued token is recognized by the JWT strategy first, and a token
whose `iss` names a configured provider is recognized by the issuer strategy next.

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';

AuthPlugin({
  issuers: [{
    name: 'keycloak',
    issuer: 'https://id.example.com/realms/acme',
    audience: 'orders-api',
    keys: { discovery: true },
    toPrincipal: (claims) =>
      typeof claims.sub === 'string'
        ? {
          // Namespaced: `sub` is unique only within its issuer.
          id: `${claims.iss}|${claims.sub}`,
          roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
        }
        : null,
  }],
});
```

- **Routing.** A token's `iss` is read without trusting the token, only to choose the configured
  entry whose `issuer` equals it exactly. A token from an unconfigured issuer leaves the chain to
  continue; nothing else from an unverified token is used.
- **Keys.** `keys` is `{ jwksUri }` or `{ discovery: true }`, which reads `jwks_uri` from
  `<issuer>/.well-known/openid-configuration` and requires that document's `issuer` to match. Both
  URLs must be `https` (or `http` on a loopback host) and written in printable ASCII — punycode an
  IDN host, percent-encode a non-ASCII path. Keys are filtered by `kty`, `crv`, `use`, `alg`,
  `key_ops` and `kid`, so an encryption key in the same set is never used to verify a signature.
- **Algorithms.** RS256, PS256, ES256, ES384 and EdDSA (also spelled `Ed25519`), narrowed per issuer
  with `algorithms`. `none` and every `HS*` algorithm are refused before any key is looked up, so a
  token signed with HMAC using the provider's public key as the secret cannot pass.
- **Claims.** `iss` exact, `aud` must contain `audience`, `exp` required; `exp`, `nbf` and a future
  `iat` allow `clockToleranceSec` (default 30, at most 300). `toPrincipal` receives the full
  verified claims and decides where roles live — the plugin never guesses. **Namespace the id
  whenever this issuer is not the only identity source** — `sub` is unique only within its issuer,
  and a self-issued `jwt`, another issuer, an API key, a session or a custom strategy can each
  produce the same id. ``{ id: `${claims.iss}|${claims.sub}` }`` (as in the example) separates an
  outside `sub` from the other sources only if none of them can produce an id of that form — a
  self-issued `sub` or a user-chosen username could — so namespace every source (for example
  ``{ id: `local|${id}` }``) or keep the other sources' ids free of the separator.
- **Rotation.** The key set is cached for `keySet.ttlMs` (default 10 minutes). A token naming an
  unknown `kid` triggers at most one refetch per `keySet.minRefreshIntervalMs` (default 60 s), and
  concurrent refetches share one request, so forged `kid`s cannot turn requests into outbound
  fetches. If fetching fails the last good set stays usable for `keySet.maxStaleMs` (default 24 h)
  after it was last confirmed, then is dropped — a key the provider removed cannot authenticate
  indefinitely while its endpoint is unreachable. Each fetch is bounded by `keySet.fetchTimeoutMs`
  (default 5 s), 64 KiB and 64 keys, and does not follow redirects. `ttlMs` may not exceed
  `maxStaleMs`. Fetches in flight are aborted when the application begins stopping.
- **Health.** An `auth` indicator reports `up` when every issuer's key set is current, and
  `degraded` with each issuer's state (`stale`, `expired`, `unfetched`) otherwise — never `down`, so
  a provider outage does not restart the application. It reads cached state and performs no I/O, so
  it reports `unfetched` until the first token from that issuer arrives.
- **Failures** return no principal and are logged at `debug` with a fixed reason code, never the
  token.

**Give the API its own audience.** Access-token type (`typ: at+jwt`, RFC 9068) is not enforced, so a
provider's **ID token** whose `aud` equals `audience` could verify as an access token. That happens
when an API reuses a sign-in client's id as its audience; configure a distinct resource identifier
for the API instead. A token carrying Keycloak's `typ: "ID"` claim is refused either way, but other
providers do not mark their ID tokens. **Multi-tenant Entra ID** (`common`/`organizations`) is not
supported, because its discovery document carries a `{tenantid}` issuer template that cannot equal a
configured issuer; a single-tenant Entra issuer works.

## Signing a user in

`issuers` accepts a token some other client obtained. `signIn` makes **this application** the
client: it sends the user to an outside provider (Google, Microsoft Entra ID, GitHub, Keycloak) over
the OAuth 2.0 authorization-code flow with PKCE, and comes back with a session the rest of the
application recognises. It requires `SessionPlugin`, and `register()` refuses to start without it.

Configuring `signIn` does three things:

- registers `IAuthSessionService` under `CAPABILITIES.AUTH_SESSION` — the ONE place that records
  "this session is signed in as this principal";
- adds an internal `auth-session` strategy after the `session` strategy, so a signed-in session
  authenticates every later request through the global authentication middleware with no
  hand-written middleware; the principal carries `claims.amr` from the recorded methods (RFC 8176),
  overwriting any `amr` the stored principal held;
- registers, per provider, `GET <basePath>/<name>/login` and `GET <basePath>/<name>/callback`, and
  one `POST <basePath>/logout` (`basePath` defaults to `/auth`).

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { AuthPlugin } from '@setu-ts/auth-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SessionPlugin({ secret: 'replace-with-at-least-32-characters!!', store: 'memory' }),
    AuthPlugin({
      signIn: {
        providers: [
          {
            kind: 'oidc',
            name: 'keycloak',
            issuer: 'https://id.example.com/realms/acme',
            clientId: 'web',
            clientSecret: 'from-your-secret-store',
            scopes: ['openid', 'profile', 'email'],
            redirectUri: 'https://app.example.com/auth/keycloak/callback',
            // Namespaced: `sub` is unique only within its issuer.
            toPrincipal: (claims) =>
              typeof claims.sub === 'string' ? { id: `keycloak|${claims.sub}` } : null,
            rpInitiatedLogout: { postLogoutRedirectUri: 'https://app.example.com/' },
          },
          {
            // GitHub issues no ID token: the profile comes from a userinfo endpoint.
            kind: 'oauth2',
            name: 'github',
            clientId: 'Iv1.abc',
            clientSecret: 'from-your-secret-store',
            tokenEndpointAuth: 'client_secret_post',
            scopes: ['read:user'],
            authorizationEndpoint: 'https://github.com/login/oauth/authorize',
            tokenEndpoint: 'https://github.com/login/oauth/access_token',
            userinfoEndpoint: 'https://api.github.com/user',
            redirectUri: 'https://app.example.com/auth/github/callback',
            toPrincipal: (profile) => ({ id: `github|${String(profile.id)}` }),
          },
        ],
      },
    }),
  ],
});
```

A link to `/auth/keycloak/login?returnTo=/orders` starts a sign-in and lands on `/orders`
afterwards.

- **Login** mints `state` and a PKCE verifier (32 random bytes each, S256 challenge) and, for
  `oidc`, a `nonce`, stores them in the user's OWN session (at most three attempts, ten minutes
  each), and redirects to the provider. PKCE is sent for every provider, confidential clients
  included. `returnTo` is kept only when it is a same-origin path — one leading `/`, no `\`, no
  scheme, no control character, at most 256 bytes with non-ASCII percent-encoded — and otherwise
  becomes `/`; it is stored at login and never read from the callback URL, so the redirect after
  sign-in cannot be steered. When the provider's discovery document cannot be read, login answers
  `503` `provider-unavailable` rather than redirecting to an endpoint it never read.
- **Callback** refuses — `401`, or a redirect to `failureRedirect` with `?error=<code>` — with one
  of four fixed codes: `provider-denied` (the provider reported an error), `state-invalid` (unknown,
  replayed, expired, issued for another provider, or an RFC 9207 `iss` naming another issuer),
  `exchange-failed` (no code, token endpoint refused or unreachable, or the ID token failed
  verification), and `profile-unavailable` (the `oauth2` userinfo endpoint failed). Nothing the
  provider said reaches a URL, a body or a log line, and every refusal is written in the
  application's configured error format. The attempt is consumed before the code is exchanged, so a
  replayed callback fails. An `oidc` ID token is verified by the same verifier as `issuers` —
  discovery-checked keys, `iss` exact, `aud` containing `clientId` and, with several audiences,
  `azp` equal to `clientId` — and its `nonce` must match the attempt. `toPrincipal` returning `null`
  (or throwing) answers `403` `principal-refused`.
- **Sign-in** records the principal with `methods: ['fed']` and **regenerates the session id**, so a
  session id planted before authentication does not survive into the authenticated session. Provider
  tokens are handed to `onTokens` and stored nowhere else.
- **Cookies.** The callback needs the session cookie on the provider's cross-site redirect, a
  top-level `GET`, which `SameSite=Lax` (the session default) and `None` send and `Strict` does not:
  with `sameSite: 'strict'` every callback fails closed as `state-invalid`.

**Signing in without a provider.** A password login records its principal through the same contract,
so it authenticates exactly as a federated one does:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthService, IAuthSessionService } from '@setu-ts/common';

app.router.post('/login', async (ctx) => {
  const { username, password } = await ctx.request.json<{ username: string; password: string }>();
  const auth = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);
  const principal = await auth.verifyCredentials({ identifier: username, secret: password });
  if (!principal) {
    return ctx.response.status(401).json({ error: 'Invalid credentials' });
  }
  const authSession = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
  await authSession.signIn(ctx, principal, { methods: ['pwd'] });
  return ctx.response.redirect('/', 302);
});
```

**Logging out.** `POST /auth/logout` ends the local session and redirects to `/` — or, for the one
`oidc` provider that sets `rpInitiatedLogout`, when the session signed in through that provider, to
its advertised end-session endpoint with `client_id` and `post_logout_redirect_uri`. A password
sign-in, a sign-in through another provider, or an anonymous request ends the local session only. It
is a `POST` so form CSRF applies when configured, so the logout form carries the token field;
without it every logout answers `403`:

```typescript
import { csrfTokenField } from '@setu-ts/session-plugin';

app.router.get('/account', (ctx) =>
  ctx.response.html(
    `<form method="post" action="/auth/logout">${csrfTokenField(ctx)}` +
      `<button>Sign out</button></form>`,
  ));
```

- **What sign-out revokes depends on the session strategy.** With `SessionPlugin({ store })` the
  stored entry is deleted, so a cookie copied before sign-out stops authenticating at once. With the
  default encrypted-cookie strategy nothing server-side exists to delete, and a copied cookie keeps
  authenticating until its `maxAge`. Use the store strategy wherever sign-out must be a revocation.
- **`idTokenHint: true`** stores the ID token at sign-in and sends it as `id_token_hint`, which lets
  a provider end its session without a confirmation page. An ID token routinely runs to kilobytes,
  and past the session cookie's 4096-byte budget the session plugin throws at commit — breaking the
  sign-in, not the logout — so pair it with the store strategy.
- **A stored principal is a snapshot.** Roles revoked after sign-in stay in force until the session
  ends. `signIn.refreshPrincipal(stored)` re-reads it on every request: return the current
  principal, or `null` to make the request anonymous. It runs per request, so it is opt-in; a
  throwing re-read is treated as anonymous, never as the stale snapshot.

Not provided: the implicit and hybrid flows, the device flow, dynamic client registration, front-
and back-channel logout, and account linking — `toPrincipal` decides what an identity maps to.

## Refresh Tokens

`RefreshTokenService` is an app-instantiated service (like `PasswordHasher`) — it is not an
`AuthPlugin` option and registers nothing. It mints typed access + refresh pairs with distinct
random `jti`s, **rotates** on every `refresh`, and **revokes** on logout. A refresh token is a
signed JWT with `type: 'refresh'`, which bearer authentication refuses. A replayed refresh token
revokes its complete descendant family. `refresh()`/`revoke()` never throw on a bad token — invalid,
expired, or tampered input yields `null`/`false`.

To make logout invalidate the paired access credential before its normal expiry, construct one
`IAccessTokenRevocationStore` and pass that same instance to both `AuthPlugin` and
`RefreshTokenService`. `MemoryAccessTokenRevocationStore` is single-process; a multi-instance
application supplies a shared implementation. Access revocation requires `accessToken.expiresIn`, so
revocation entries are bounded. `RefreshTokenStore` implementations must persist family lineage and
make `rotate(jti, successor)` and `revokeFamily(jti)` linearizable per family; the shipped
`MemoryRefreshTokenStore` does both with lazy expiry.

```typescript
import {
  AuthPlugin,
  MemoryAccessTokenRevocationStore,
  MemoryRefreshTokenStore,
  RefreshTokenService,
} from '@setu-ts/auth-plugin';
import type { IJwtService, IRuntimeServices } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { createRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';

const accessTokenRevocations = new MemoryAccessTokenRevocationStore(createRuntimeServices());
const app = createApplication({
  plugins: [
    RuntimePlugin(),
    AuthPlugin({
      jwt: { secret: config.get('JWT_SECRET'), accessTokenRevocationStore: accessTokenRevocations },
    }),
  ],
});
await app.start();
const jwt = app.services.get<IJwtService>('jwt');
const runtime = app.services.get<IRuntimeServices>('runtime');

const refresh = new RefreshTokenService({
  jwt,
  store: new MemoryRefreshTokenStore(runtime),
  runtime,
  accessToken: { expiresIn: '15m' },
  refreshTokenExpiresIn: '30d',
  accessTokenRevocationStore: accessTokenRevocations,
});

const pair = await refresh.issue(principal); // { accessToken, refreshToken }
const next = await refresh.refresh(pair.refreshToken); // new pair; old token now rejected
await refresh.revoke(next!.refreshToken); // logout
```

| Option                       | Type                          | Default     | Description                                                               |
| ---------------------------- | ----------------------------- | ----------- | ------------------------------------------------------------------------- |
| `jwt`                        | `IJwtService`                 | -           | Signs/verifies both tokens.                                               |
| `store`                      | `RefreshTokenStore`           | -           | Rotation/revocation backend.                                              |
| `runtime`                    | `IRuntimeServices`            | -           | `randomBytes` (jti) + `now()` (expiry).                                   |
| `accessToken.expiresIn`      | `string`                      | jwt default | Access-token lifetime.                                                    |
| `accessToken.audience`       | `string`                      | -           | `aud` on both tokens; enforced on verify.                                 |
| `accessToken.issuer`         | `string`                      | -           | `iss` on both tokens; enforced on verify.                                 |
| `refreshTokenExpiresIn`      | `string`                      | `'7d'`      | Refresh-token lifetime (JWT `exp` AND record).                            |
| `accessTokenRevocationStore` | `IAccessTokenRevocationStore` | -           | Shared access-token invalidation store; requires `accessToken.expiresIn`. |

## Rate Limiting

`rateLimitMiddleware(options)` is a standalone fixed-window limiter, independent of `AuthPlugin` and
registered under no capability token. Over-limit requests are short-circuited with **429**
(`Retry-After` always set; `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset` set unless
`standardHeaders: false` — `Reset` and `Retry-After` are both delta-seconds). The default store is
in-memory (single-process); use `RedisRateLimitStore` for multi-instance deployments (pass an
ioredis-compatible `client`, or `npm:ioredis@5.x` is lazily imported on first use).

The 429 body uses `@setu-ts/common`'s error-responder seam, so it follows the application's
configured error format. The operational paths `/live`, `/ready`, `/health`, `/metrics`,
`/openapi.json`, and `/docs` are exempt by default through `DEFAULT_RATE_LIMIT_EXCLUDED_PATHS`; an
`exclude` list replaces the defaults, so spread the constant to extend them. `RedisRateLimitStore`
prefixes its keys with `'setu:ratelimit:'` by default; set `keyPrefix` per application when several
share Redis, or `''` to keep pre-M90a keys.

`RedisRateLimitStore` is constructed by the application, so no plugin wires its connection errors.
Pass `connectionErrorReporter` (built with `createConnectionErrorReporter` from `@setu-ts/common`
over your logger) and the `'error'` events of the client it builds are logged — first error at
`warn`, repeats at `debug`, recovery at `info` — rather than printed by `ioredis` to `console.error`
on every reconnect attempt. An injected `client` never gets a listener.

The default key resolves in this order: the authenticated principal, the client IP published by
`ipSecurityMiddleware` (see `http-security-plugin`), `IRequest.ip`, and only then one global
`'anonymous'` bucket — shared by every caller for whom none of the three resolved.

`IRequest.ip` is the step worth knowing about: **no first-party adapter can populate it**, because a
web `Request` carries no peer address, so it is set only by a custom `IHttpAdapter`. On the shipped
runtimes, then, an unauthenticated request with no `ipSecurityMiddleware` reaches the shared bucket
and the example below is **not** per IP.

To make it per caller, register `ipSecurityMiddleware` with `trustProxy` **and** the constraint that
matches your deployment — or pass your own `keyGenerator`. `trustProxy` on its own takes the
forwarded header's **leftmost** entry, which is safe only behind a proxy that OVERWRITES that
header. The standard nginx idiom **appends**, and there the leftmost entry is supplied by the
caller: a client rotating forged `X-Forwarded-For` values would get a fresh bucket per request,
which is a weaker position than the shared `'anonymous'` one it replaced. Supply `trustedProxies`
(your proxies' addresses or CIDR blocks) or `proxyHops` so the header is walked right to left and
the first entry your infrastructure did not add is the client.

```typescript
import {
  DEFAULT_RATE_LIMIT_EXCLUDED_PATHS,
  rateLimitMiddleware,
  RedisRateLimitStore,
} from '@setu-ts/auth-plugin';

// Keyed by the authenticated user. Absent a principal AND a client IP, every
// caller shares ONE 'anonymous' bucket — see the key-resolution order above.
app.middleware.add(rateLimitMiddleware({
  windowMs: 60_000,
  max: 100,
  exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
}));

// Redis-backed, keyed by authenticated user
rateLimitMiddleware({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (ctx) => ctx.request.user?.id ?? ctx.request.ip ?? 'anonymous',
  store: new RedisRateLimitStore({
    url: 'redis://localhost:6379',
    runtime,
    keyPrefix: 'orders-api:rl:',
  }),
});
```

| Option            | Type                     | Default                 | Description                                                              |
| ----------------- | ------------------------ | ----------------------- | ------------------------------------------------------------------------ |
| `windowMs`        | `number`                 | -                       | Window length in ms.                                                     |
| `max`             | `number`                 | -                       | Max requests per window per key.                                         |
| `store`           | `RateLimitStore`         | `MemoryRateLimitStore`  | Counter backend.                                                         |
| `keyGenerator`    | `(ctx) => string`        | `ip ?? 'anonymous'`     | Caller identity for the counter.                                         |
| `message`         | `string`                 | `'Rate limit exceeded'` | 429 body message.                                                        |
| `standardHeaders` | `boolean`                | `true`                  | Emit `RateLimit-*` headers.                                              |
| `exclude`         | `readonly PathPattern[]` | six operational paths   | Paths skipped entirely; strings match exactly and regexps test the path. |

## Guards and OpenAPI

Every guard this package returns is branded with `RouteSecurityMetadata` from `@setu-ts/common`, so
[`@setu-ts/openapi-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/openapi-plugin)
can document which operations require authentication without either package importing the other. Set
`OpenApiPlugin({ deriveSecurity: { scheme: 'bearerAuth' } })` and a route carrying `requireAuth()`
is documented as protected; one carrying `publicRoute()` is documented as public.

The brand is symbol-keyed and non-enumerable — guard behaviour is unchanged — and it carries
authentication presence only. An OpenAPI security requirement names a scheme, not a role, so
`requireRole('admin')` documents that authentication is required and nothing about the role.

## License

MIT

## Exports

| Export                              | Kind      |
| ----------------------------------- | --------- |
| `authMiddleware`                    | function  |
| `AuthPlugin`                        | function  |
| `defaultRateLimitKey`               | function  |
| `publicRoute`                       | function  |
| `rateLimitMiddleware`               | function  |
| `requireAllPermissions`             | function  |
| `requireAnyRole`                    | function  |
| `requireAuth`                       | function  |
| `requirePermission`                 | function  |
| `requireRole`                       | function  |
| `AuthPluginConfigurationError`      | class     |
| `MalformedPasswordHashError`        | class     |
| `MemoryAccessTokenRevocationStore`  | class     |
| `MemoryRateLimitStore`              | class     |
| `MemoryRefreshTokenStore`           | class     |
| `PasswordHasher`                    | class     |
| `RedisRateLimitStore`               | class     |
| `RefreshTokenService`               | class     |
| `DEFAULT_RATE_LIMIT_EXCLUDED_PATHS` | const     |
| `DEFAULT_RATE_LIMIT_KEY_PREFIX`     | const     |
| `ApiKeyOptions`                     | interface |
| `AuthMiddlewareOption`              | interface |
| `AuthorizationDiagnosticsOptions`   | interface |
| `AuthPluginOptions`                 | interface |
| `IAccessTokenRevocationStore`       | interface |
| `IAuthHttp`                         | interface |
| `IAuthorizationDiagnosticsSource`   | interface |
| `IAuthorizationService`             | interface |
| `IAuthService`                      | interface |
| `IAuthStrategy`                     | interface |
| `IJwtService`                       | interface |
| `IPrincipal`                        | interface |
| `JwtOptions`                        | interface |
| `JwtSignOptions`                    | interface |
| `LocalOptions`                      | interface |
| `OAuth2Provider`                    | interface |
| `OidcProvider`                      | interface |
| `ProviderTokens`                    | interface |
| `RateLimitOptions`                  | interface |
| `RateLimitResult`                   | interface |
| `RateLimitStore`                    | interface |
| `RbacConfig`                        | interface |
| `RefreshTokenOptions`               | interface |
| `RefreshTokenRecord`                | interface |
| `RefreshTokenStore`                 | interface |
| `RoleDefinition`                    | interface |
| `SessionAuthOptions`                | interface |
| `SignInConfig`                      | interface |
| `SignInProviderBase`                | interface |
| `TokenPair`                         | interface |
| `TrustedIssuer`                     | interface |
| `IRefreshTokenRotation`             | type      |
| `IssuerAlgorithm`                   | type      |
| `IssuerKeySource`                   | type      |
| `RefreshPrincipal`                  | type      |
| `SignInProvider`                    | type      |
| `TokenEndpointAuth`                 | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#authplugin-setu-tsauth-plugin).
