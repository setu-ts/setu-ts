# Auth Plugin

Authentication and authorization plugin for Setu-TS: JWT and API-key authentication, local
credential verification, RBAC authorization with role hierarchy, and short-circuiting route guards.

All cryptography (HS256/RS256 JWT signing/verification and PBKDF2-SHA256 password hashing) runs
through Web Crypto via `IRuntimeServices` (`runtime.subtle` / `runtime.randomBytes`), so **no npm
package is involved in issuing or verifying a token, or in hashing a password**, and every one of
those paths is cross-runtime (Deno / Node 20+ / Bun).

The package declares two optional drivers, which npm therefore installs alongside it:
`RedisRateLimitStore` lazy-loads `ioredis`, and a `saml` sign-in provider lazy-loads
`@node-saml/node-saml` (which needs the `nodejs_compat` flag on Cloudflare Workers). Nothing imports
either unless you construct that store or configure that provider — the defaults need no driver. See
[Optional npm drivers](https://github.com/setu-ts/setu-ts/blob/main/docs/plugins.md#optional-npm-drivers)
for what that means on npm versus Deno.

The plugin always registers JWT and authentication services. It registers authorization only when
the optional `rbac` configuration is supplied:

| Service                | Token               | Interface                                           |
| ---------------------- | ------------------- | --------------------------------------------------- |
| JWT sign/verify/decode | `'jwt'`             | `IJwtService`                                       |
| Authentication         | `CAPABILITIES.AUTH` | `IAuthService`                                      |
| Authorization (RBAC)   | `'authorization'`   | `IAuthorizationService` (when `rbac` is configured) |

The authentication capability is named `CAPABILITIES.AUTH` (value `'authentication'`) — there is no
`CAPABILITIES.AUTHENTICATION` member.

Without `rbac`, the four authorization guards answer **`501 Not Implemented`** rather than throwing
— see [Guards](#guards). A configured policy that the caller fails answers
`403 Insufficient privileges`; it never names the required role or permission.

> **Refresh tokens and rate limiting ship in this package.** `IJwtService` itself exposes only
> `sign` / `verify` / `decode`, but do not hand-roll a refresh token as `sign({ expiresIn: '7d' })`
> — that has no rotation and no replay rejection. Use `RefreshTokenService` and
> `rateLimitMiddleware`, both covered below.

## Installation

```bash
deno add npm:@setu-ts/auth-plugin
```

## Usage

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';

app.register(
  AuthPlugin({
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
  }),
);

// AuthPlugin registers passive authentication globally at priority 300.
```

## Login (Issue Token)

`IAuthService.verifyCredentials({ identifier, secret })` resolves to an `IPrincipal | null`; mint a
JWT with the separate `IJwtService` resolved from `'jwt'`.

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthService, IJwtService } from '@setu-ts/common';

app.router.post('/auth/login', async (ctx) => {
  const auth = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);
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

## JWT time boundaries

The first-party `JwtService.verify` (the `IJwtService` registered under `'jwt'`) reads time as
fractional seconds, `runtime.now() / 1000`, with no clock tolerance. It rejects with `Token expired`
once `now >= exp`, and with `Token not yet valid` while `now < nbf`. At `nbf` the token passes the
not-before check; at `exp` it fails the expiry check. Previously, a token could be accepted for up
to one second after `exp`; clients must refresh before `exp`.

The outside-issuer verifier configured through `issuers` also uses fractional seconds, but applies
`clockToleranceSec`: it rejects as expired once `now >= exp + clockToleranceSec` (previously `>`),
and as not yet valid while `now + clockToleranceSec < nbf` (unchanged). The tolerance defaults to 30
seconds and is at most 300 seconds.

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
  throws naming both plugins. `toPrincipal` is synchronous and reads only the session, so this
  strategy cannot re-check the account on each request; for a deactivation or a "sign out
  everywhere" to take effect before the session ends, use `signIn: { providers: [] }` with
  `refreshPrincipal` and `sessionStamp` instead (see
  [Ending every session of a user](#ending-every-session-of-a-user)).
- **LocalStrategy** — explicit credentials verification. Not passive; reached only via
  `IAuthService.verifyCredentials` from a login handler.

Passive strategies run in a fixed order during `IAuthService.authenticate` — **jwt → issuers →
api-key → session → caller-supplied, in declaration order** — and the first non-null principal wins,
with `null` returned when none match. A request carrying both a bearer header and a session cookie
is therefore authenticated by the JWT, because the explicit credential runs first. Caller-supplied
strategies come from the `strategies` option and run last; a `name` colliding with any other
strategy in the assembled chain makes `register()` throw, because a strategy's `name` is its only
identity.

Every strategy resolves to an `IPrincipal`:

| Field         | Type                                | Meaning                                 |
| ------------- | ----------------------------------- | --------------------------------------- |
| `id`          | `string`                            | Stable subject identifier (required).   |
| `roles`       | `readonly string[]`                 | Role names held by the principal.       |
| `permissions` | `readonly string[]`                 | Permission names held by the principal. |
| `claims`      | `Readonly<Record<string, unknown>>` | Additional claims from the credential.  |

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

## Authorization Policies

Roles answer "does this principal hold this role, anywhere". A **policy** answers "may this
principal do this, to this target" — asynchronously, with the target as an argument. Attribute rules
("the author of this post", "an approver of this amount") are written as policies; there is no
attribute engine. AuthPlugin always registers an `IAuthorizationPolicyService` under
`CAPABILITIES.AUTHORIZATION_POLICIES`, independent of `rbac`.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, definePolicy, requirePolicy } from '@setu-ts/auth-plugin';

interface Post {
  readonly authorId: string;
}

const posts = new Map<string, Post>();

const postPolicy = definePolicy({
  name: 'post',
  abilities: {
    update: (principal, post: Post | undefined) => post?.authorId === principal.id,
    read: { anonymous: true, check: () => true },
  },
  before: (principal) => (principal.roles?.includes('admin') === true ? true : undefined),
});

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    AuthPlugin({ jwt: { secret: 'replace-with-a-secret-of-32-chars!' }, policies: [postPolicy] }),
  ],
});

app.router.patch('/posts/:id', {
  middleware: [requirePolicy(postPolicy, 'update', (ctx) => posts.get(ctx.params.id ?? ''))],
  handler: (ctx) => ctx.response.json({ ok: true }),
});
```

The rules are fixed: only a literal `true` allows; a throwing or rejecting check denies and is
logged once (never the target); an anonymous request is refused `401` before a check runs unless the
ability is declared `{ anonymous: true, check }`; for a signed-in principal `before` runs first —
`true` allows, `undefined` falls through, anything else denies; a denied signed-in principal gets
`403` with the same body `requireRole` writes; with no policy service the guard answers `501`. A
guard naming a policy or ability that is not registered makes `app.start()` fail, naming the route —
except on a route added after `start()` or a guard added as global middleware, where it fails closed
per request.

Inside a handler, `can(principal, policy, ability, target)` resolves a boolean and `authorize(...)`
rejects a denial with `AuthorizationDeniedError`, which `errorHandler` answers with the guard's own
`401`/`403` body. An unknown policy or ability rejects both with `UnknownPolicyError`. Class-form
policies and the `@RequirePolicy` decorator live in `@setu-ts/decorator-plugin`. The full guide is
[Authorization](https://github.com/setu-ts/setu-ts/blob/main/docs/authorization.md).

## Scoped Roles

A role held **in a scope** — one tenant, organisation, team or region — rather than everywhere.
`scopedRbac` (requires `rbac`) defines one built-in policy, `scoped-rbac`, on the policy evaluator:
every catalogue permission and role is checkable, and the target is the scope.

```typescript
import { scopeFromParam } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireScopedPermission, requireScopedRole } from '@setu-ts/auth-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    AuthPlugin({
      jwt: { secret: 'replace-with-a-secret-of-32-chars!' },
      rbac: {
        roles: {
          approver: { permissions: ['invoices:approve'] },
          'org-admin': { permissions: [] },
        },
      },
      scopedRbac: {
        sources: [
          {
            kind: 'static',
            grants: [{ subject: 'ann', role: 'approver', scope: { type: 'tenant', id: 'acme' } }],
          },
        ],
        // A child tenant inherits its parent's grants.
        inheritsFrom: (scope) => (scope.id === 'acme-eu' ? [{ type: 'tenant', id: 'acme' }] : []),
      },
    }),
  ],
});

// Default scope: the resolved request tenant (`MultiTenancyPlugin`).
app.router.post('/invoices/:id/approve', {
  middleware: [requireScopedPermission('invoices:approve')],
  handler: (ctx) => ctx.response.json({ ok: true }),
});

app.router.get('/orgs/:orgId', {
  middleware: [requireScopedRole('org-admin', { scope: scopeFromParam('orgId', 'organisation') })],
  handler: (ctx) => ctx.response.json({ ok: true }),
});
```

<!-- version:history -->

Several roles are any-of, several permissions all-of. A guard naming a permission or role outside
the catalogue fails `app.start()`. Grant sources (`static`, `claims`, `custom` — including
`createDatabaseGrantSource` from `@setu-ts/database-plugin`) are unioned, and **one failing source
denies the whole check**. A route scope naming another tenant than the resolved request tenant
denies. `grantableIn` limits where a role may be granted; `customRoles` lets a tenant define roles
that bundle catalogue permissions; `timing` is `'request'` (default — a revocation applies on the
next request), `{ kind: 'cache', ttlMs, maxEntries }` (within `ttlMs`) or `'sign-in'` (stored in the
auth session — until sign-out); a `custom` source sees only the principal's id and `iss`, so its
answer is safe to share, while a `claims` source is mapped from the credential on every check and
never cached, since two tokens for one principal can carry different claims. **Only grants decide a
scoped check:** the `roles` and `permissions` a principal carries itself (a JWT `roles` claim, a
`'*'` permission) count in no scope unless `principalAuthorityIsGlobal: true`, which makes each one
global — the behaviour before 0.10.0. The unscoped `requireRole`/`requirePermission` guards read the
principal either way. A direct `policies.can(...)` call made while serving a request passes the
request as the target's `context`, or the tenant comparison is skipped. Every bound
(`sourceTimeoutMs`, `maxGrantsPerPrincipal`, `maxScopeDepth`, `maxScopeNodes`, `maxCustomRoles`,
`maxPermissionsPerRole`) refuses an out-of-range value at construction, and exceeding one denies.
The decorator form is `@ScopedRoles`/`@ScopedPermissions` in `@setu-ts/decorator-plugin`. Full
guide:
[Scoped Roles](https://github.com/setu-ts/setu-ts/blob/main/docs/authorization.md#scoped-roles).

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

### Sending a browser to the sign-in page

`requireAuth({ signInPage })` answers an unauthenticated **page navigation** with a `302` to the
sign-in page, carrying the requested path and query as `returnTo`. Every other unauthenticated
request — `fetch()`, an API client, a form `POST` — keeps the `401`.

```typescript
import { requireAuth } from '@setu-ts/auth-plugin';

const signedIn = requireAuth({ signInPage: '/login' });
app.router.get('/account', { middleware: [signedIn], handler });
// GET /account from a browser tab → 302 Location: /login?returnTo=%2Faccount
// GET /account from fetch() or curl → 401
```

A request is a navigation when it is a `GET` or `HEAD`, is not `X-Requested-With: XMLHttpRequest`,
and carries `Sec-Fetch-Mode: navigate` — or, from a client that sends no `Sec-Fetch-Mode`, an
`Accept` that names `text/html` or `application/xhtml+xml`. A bare `*/*` is not enough: `curl` and
most HTTP clients send it. This is the rule Laravel, Devise, ASP.NET Core and Spring Security apply.
A `POST` is never redirected, because the redirect would turn it into a `GET` and drop its body.

- **`signInPage`** must be a same-origin absolute path (`safeReturnTo` keeps it unchanged); anything
  else throws `AuthPluginConfigurationError` when the guard is built. Its own query and fragment are
  kept, and `returnTo` is added beside them.
- **`returnTo`** is the requested path and query passed through `safeReturnTo`, so a path longer
  than 256 bytes becomes `/`. Your login handler should apply `safeReturnTo` again before it
  redirects back: the query string is the client's to change.
- **Caching.** Both unauthenticated answers append `Accept`, `Sec-Fetch-Mode` and `X-Requested-With`
  to `Vary`, keeping any `Vary` already set (CORS appends `Origin`), so a shared cache cannot serve
  a browser's redirect to an API client.
- **No loop.** A request for the sign-in page's own path answers `401`, so a sign-in page placed
  behind the guard by mistake cannot redirect to itself.
- **Role and permission guards stay `401`.** List `requireAuth({ signInPage })` first:
  `[requireAuth({ signInPage: '/login' }), requireRole('admin')]`. A decorated controller takes the
  guard through `@UseGuards(requireAuth({ signInPage: '/login' }))`; `@RequirePolicy` answers its
  own `401`.

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
via `runtime.subtle` / `runtime.randomBytes`, comparing with a fixed-time check. New hashes use
**600,000 iterations** (OWASP's 2023 guidance) unless `iterations` says otherwise — an integer from
100,000 to 10,000,000, refused at construction otherwise. `verify` reads the count stored in each
hash, so a hash made at another count keeps verifying, and `needsRehash(stored)` reports a hash made
with fewer iterations than configured, so it can be replaced the next time its password is known.

```typescript
import { PasswordHasher } from '@setu-ts/auth-plugin';

const hasher = new PasswordHasher(runtime); // IRuntimeServices resolved from the 'runtime' token
const stored = await hasher.hash('correct horse battery staple');
const ok = await hasher.verify(stored, 'correct horse battery staple'); // true

// On a successful sign-in, upgrade a hash made at a lower count:
if (ok && hasher.needsRehash(stored)) {
  const upgraded = await hasher.hash('correct horse battery staple');
  // …persist `upgraded` in place of `stored`
}
```

A hash costs about 80 ms on Node at 600,000 iterations (15 ms at 100,000), so keep a sign-in route
behind `rateLimitMiddleware`. A deployed Cloudflare Worker is reported to refuse PBKDF2 counts above
100,000 (local workerd accepts 600,000; this is not verified against a deployed Worker), so a
Workers application passes `new PasswordHasher(runtime, { iterations: 100_000 })`.

## Options

| Option                           | Type                                                  | Default             | Description                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jwt`                            | `JwtOptions`                                          | -                   | Optional JWT service and passive bearer strategy.                                                                                                                                                                                               |
| `jwt.secret`                     | `string \| Uint8Array`                                | -                   | HS256 key. Required for HS256.                                                                                                                                                                                                                  |
| `jwt.privateKey`                 | `string` (PEM)                                        | -                   | RS256 private key. Required for RS256.                                                                                                                                                                                                          |
| `jwt.publicKey`                  | `string` (PEM)                                        | -                   | RS256 public key. Required for RS256.                                                                                                                                                                                                           |
| `jwt.algorithm`                  | `'HS256' \| 'RS256'`                                  | inferred            | Inferred from which key material is provided.                                                                                                                                                                                                   |
| `jwt.audience`                   | `string`                                              | -                   | Expected `aud`; enforced on verify.                                                                                                                                                                                                             |
| `jwt.issuer`                     | `string`                                              | -                   | Expected `iss`; enforced on verify.                                                                                                                                                                                                             |
| `jwt.header`                     | `string`                                              | `'authorization'`   | Header name for bearer extraction.                                                                                                                                                                                                              |
| `jwt.scheme`                     | `string`                                              | `'bearer'`          | Token scheme prefix.                                                                                                                                                                                                                            |
| `jwt.accessTokenRevocationStore` | `IAccessTokenRevocationStore`                         | -                   | Shared store that rejects revoked typed access tokens.                                                                                                                                                                                          |
| `apiKey.header`                  | `string`                                              | `'X-API-Key'`       | Header holding the API key.                                                                                                                                                                                                                     |
| `apiKey.validate`                | `(key) => Promise<IPrincipal \| null>`                | -                   | App-supplied API-key lookup.                                                                                                                                                                                                                    |
| `local.verify`                   | `(identifier, secret) => Promise<IPrincipal \| null>` | -                   | App-supplied credential check.                                                                                                                                                                                                                  |
| `rbac.roles`                     | `Record<string, RoleDefinition>`                      | -                   | Role → permissions + `inherits` hierarchy.                                                                                                                                                                                                      |
| `policies`                       | `readonly PolicyDefinition[]`                         | `[]`                | Authorization policies from `definePolicy`, checked when `AuthPlugin(...)` is called (malformed or duplicate names refuse). The policy service is registered whether or not this is set. See [Authorization Policies](#authorization-policies). |
| `scopedRbac`                     | `ScopedRbacOptions`                                   | -                   | Scoped RBAC: grant sources, scope inheritance, custom roles, timing and bounds. Requires `rbac`.                                                                                                                                                |
| `session.toPrincipal`            | `(view: SessionView) => IPrincipal \| null`           | -                   | Maps the opened session to its principal; `null` continues the chain. Requires `SessionPlugin`.                                                                                                                                                 |
| `strategies`                     | `readonly IAuthStrategy[]`                            | -                   | Caller-supplied strategies, appended after every built-in in declaration order.                                                                                                                                                                 |
| `middleware`                     | `false \| AuthMiddlewareOption`                       | `{ priority: 300 }` | Move, exclude paths from, or disable the global authentication middleware.                                                                                                                                                                      |
| `issuers`                        | `readonly TrustedIssuer[]`                            | -                   | Outside identity providers whose access tokens are accepted.                                                                                                                                                                                    |
| `http`                           | `IAuthHttp`                                           | `fetch`-based       | Outbound HTTP for issuer key sets, discovery documents, and the sign-in token exchange.                                                                                                                                                         |
| `signIn`                         | `SignInConfig`                                        | -                   | Sign-in with outside providers; registers `IAuthSessionService`. Requires `SessionPlugin`.                                                                                                                                                      |

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
  issuers: [
    {
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
    },
  ],
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
  `iat` allow `clockToleranceSec` (default 30, at most 300). Expiry is refused at
  `now >= exp + clockToleranceSec`; not-before is refused while `now + clockToleranceSec < nbf`.
  `toPrincipal` receives the full verified claims and decides where roles live — the plugin never
  guesses. **Namespace the id whenever this issuer is not the only identity source** — `sub` is
  unique only within its issuer, and a self-issued `jwt`, another issuer, an API key, a session or a
  custom strategy can each produce the same id. ``{ id: `${claims.iss}|${claims.sub}` }`` (as in the
  example) separates an outside `sub` from the other sources only if none of them can produce an id
  of that form — a self-issued `sub` or a user-chosen username could — so namespace every source
  (for example ``{ id: `local|${id}` }``) or keep the other sources' ids free of the separator.
- **Rotation.** The key set is cached for `keySet.ttlMs` (default 10 minutes). A token naming an
  unknown `kid` triggers at most one refetch per `keySet.minRefreshIntervalMs` (default 60 s), and
  concurrent refetches share one request, so forged `kid`s cannot turn requests into outbound
  fetches. If fetching fails the last good set stays usable for `keySet.maxStaleMs` (default 24 h)
  after it was last confirmed, then is dropped — a key the provider removed cannot authenticate
  indefinitely while its endpoint is unreachable. Each fetch is bounded by `keySet.fetchTimeoutMs`
  (default 5 s), 64 KiB and 64 keys, and does not follow redirects. `ttlMs` may not exceed
  `maxStaleMs`. Fetches in flight are aborted when the application begins stopping.
- **Health.** The `auth` indicator stays `up`; `data.current` is true only when every issuer's key
  set is current. `data.issuers` carries `stale`, `expired` and `unfetched` states. Shared issuer
  faults do not withdraw this replica from `/ready`. It reads cached state and performs no I/O, so
  it reports `unfetched` until the first token from that issuer arrives.
- **Failures** return no principal and are logged at `debug` with a fixed reason code, never the
  token. A key-set refresh failure — a provider the operator cannot reach — is the exception: it
  logs `auth-plugin: issuer '<name>' key-set refresh failed (<reason>)` at `warn` once per change of
  reason per issuer, and repeats at `debug`; a successful refresh resets it. Both lines carry the
  fixed reason code, never the token.

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
- registers, per `oidc`/`oauth2` provider, `GET <basePath>/<name>/login` and
  `GET <basePath>/<name>/callback`, and one `POST <basePath>/logout` (`basePath` defaults to
  `/auth`); a `saml` provider gets its own three routes — see
  [SAML 2.0 single sign-on](#saml-20-single-sign-on).

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
  `503` `provider-unavailable` rather than redirecting to an endpoint it never read, and logs
  `auth-plugin: signIn['<provider>'] provider unavailable (<reason>)` at `warn` on the first or a
  changed reason and at `debug` on a repeat — so a persistent outage cannot flood the log from an
  unauthenticated route.
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

**Signing in without a provider.** `signIn: { providers: [] }` is a password-only sign-in: there are
no provider routes, and `signIn` still supplies the auth-session capability, the per-request
`refreshPrincipal` and `sessionStamp` checks, and the logout route. A password login records its
principal through the same contract, so it authenticates exactly as a federated one does, and
`safeReturnTo` validates the `returnTo` that `requireAuth({ signInPage })` sent:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthService, IAuthSessionService } from '@setu-ts/common';
import { safeReturnTo } from '@setu-ts/auth-plugin';

app.router.post('/login', async (ctx) => {
  const { username, password } = await ctx.request.json<{ username: string; password: string }>();
  const auth = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);
  const principal = await auth.verifyCredentials({ identifier: username, secret: password });
  if (!principal) {
    return ctx.response.status(401).json({ error: 'Invalid credentials' });
  }
  const authSession = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
  await authSession.signIn(ctx, principal, { methods: ['pwd'] });
  return ctx.response.redirect(safeReturnTo(ctx.query.returnTo), 303);
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
  ),
);
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
- **Ending every session of one user** is `signIn.sessionStamp` — see below.
- **`IAuthSessionService.current(ctx)` is the stored snapshot**: neither re-read runs, so it still
  returns a user whose session `refreshPrincipal` or the stamp has ended. Decide who may act from
  `ctx.request.user`, which the `auth-session` strategy re-checked. The plugin's own passkey
  registration routes re-check the same way.

### Ending every session of a user

Keep a stamp on your user record — a `sessionVersion` counter, or a prefix of the password hash as
Laravel, Django and Devise do — and give `signIn` a reader for it. `IAuthSessionService.signIn`
records a SHA-256 digest of the stamp; every request compares the digest of the current stamp with
it, in constant time. Change the stamp and every session of that user answers anonymous on its next
request — `ctx.request.user` is unset, and passkey registration refuses it — on the cookie strategy
as well as the store strategy.

```typescript
import type { IPrincipal } from '@setu-ts/common';
import { AuthPlugin } from '@setu-ts/auth-plugin';

declare const users: {
  find(id: string): Promise<{ active: boolean; roles: string[]; sessionVersion: number } | null>;
};

// Principals this request's refreshPrincipal just loaded. A snapshot read back
// from the session is a new object and never in here.
const loaded = new WeakSet<IPrincipal>();

AuthPlugin({
  signIn: {
    providers: [],
    // One user load per request: the re-read carries the stamp in a claim…
    refreshPrincipal: async (stored) => {
      const user = await users.find(stored.id);
      if (user?.active !== true) return null;
      const principal: IPrincipal = {
        id: stored.id,
        roles: user.roles,
        claims: { sessionVersion: String(user.sessionVersion) },
      };
      loaded.add(principal);
      return principal;
    },
    // …and the stamp reader takes it only from a principal refreshPrincipal
    // loaded; at sign-in (or for anything else) it reads the user record.
    sessionStamp: async (principal) => {
      const claim = principal.claims?.sessionVersion;
      if (loaded.has(principal) && typeof claim === 'string') return claim;
      const user = await users.find(principal.id);
      return user === null ? null : String(user.sessionVersion);
    },
  },
});
```

The claim shortcut is safe only for a principal `refreshPrincipal` loaded **on this request**. A
reader that trusts the claim on any principal also trusts the stored snapshot — which is what it
receives at sign-in, and on every request when `refreshPrincipal` is not configured — and then a
bump never ends anything. Without `refreshPrincipal`, read the stamp from the user record.

- **The reader runs at sign-in and on every request.** At sign-in it receives the principal you pass
  to `signIn`; on a request, the principal `refreshPrincipal` returned (or the stored snapshot
  without one). A reader that throws, or returns anything but a string or `null`, makes the request
  anonymous; at sign-in the same failure rejects `signIn` and records nothing.
- **`null` means "no stamp"** and matches only a session recorded with none. Enabling `sessionStamp`
  on a running application ends every existing session whose user already has a stamp.
- **Only the digest is stored.** Under `SessionPlugin({ mode: 'sign' })` the client can read the
  cookie, so a password-hash prefix never reaches it as the stamp — but a claim you put on the
  principal you pass to `signIn` IS stored. Put a secret-derived stamp in the reader, not in the
  signed-in principal's claims; a counter is safe in either.
- **Sign out everywhere** is one write: `UPDATE users SET session_version = session_version + 1`.
- **Keep the current session through a password change** by signing it in again after the bump, with
  the methods it already recorded — passing only `['pwd']` would send an MFA session back to the
  second-factor step. A re-sign-in also forgets the provider-session keys, so RP-initiated logout no
  longer reaches the provider for a federated user:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { AuthMethod, IAuthSessionService } from '@setu-ts/common';
import { requireAuth } from '@setu-ts/auth-plugin';

declare const users: { bumpSessionVersion(id: string): Promise<void> };

app.router.post('/account/password', {
  middleware: [requireAuth()],
  handler: async (ctx) => {
    const principal = ctx.request.user!;
    // …verify the current password and store the new hash…
    await users.bumpSessionVersion(principal.id);
    const methods = (principal.claims?.amr ?? []) as AuthMethod[];
    const authSession = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
    // Only the id: the request's principal still carries the OLD sessionVersion
    // claim, which the stamp reader would record. refreshPrincipal reloads the rest.
    await authSession.signIn(ctx, { id: principal.id }, { methods });
    return ctx.response.json({ ok: true });
  },
});
```

Two account flows are recipes rather than features:

- **Forced password reset.** Have `refreshPrincipal` add a claim such as `mustResetPassword: true`
  and register a middleware that refuses every route but the reset page while the claim is set.
- **Admin impersonation** is not provided. An application that needs it signs the admin in as the
  target principal with a claim naming the real admin (`impersonatedBy`), records both ids through
  `@setu-ts/audit-plugin`, and ends the impersonation with an ordinary sign-in as the admin.

Listing a user's sessions with their IP address and device needs a server-side session index, which
`ISessionStore` does not have; it is not provided.

Not provided: the implicit and hybrid flows, the device flow, dynamic client registration, front-
and back-channel logout, and account linking — `toPrincipal` decides what an identity maps to.

## SAML 2.0 single sign-on

A `saml` provider makes the application a SAML 2.0 **service provider** (SP) for an enterprise
identity provider (Entra ID, Okta, ADFS, Keycloak, Google Workspace). It joins the same
`signIn.providers` list and lands in the same signed-in session, with `methods: ['fed']`, so
`signIn.mfa` and `requireMfa()` apply to it exactly as to an OpenID Connect sign-in.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { AuthPlugin } from '@setu-ts/auth-plugin';

const idpSigningCert = '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SessionPlugin({ secret: 'replace-with-at-least-32-characters!!', store: 'memory' }),
    AuthPlugin({
      signIn: {
        providers: [
          {
            kind: 'saml',
            name: 'corp',
            entityId: 'https://app.example.com/saml',
            idp: {
              entityId: 'https://sts.example.com/acme',
              ssoUrl: 'https://sts.example.com/acme/saml2',
              // Several certificates let a signing-key rotation overlap.
              certs: [idpSigningCert],
            },
            acsUrl: 'https://app.example.com/auth/corp/acs',
            // A NameID is unique only within its issuer: namespace it.
            toPrincipal: (profile) => ({
              id: `corp|${profile.nameID}`,
              claims: { email: profile.attributes.email },
            }),
          },
        ],
      },
    }),
  ],
});
```

Three routes per provider:

- `GET <basePath>/<name>/login` — issues an AuthnRequest over the **HTTP-Redirect** binding and
  redirects to `idp.ssoUrl`. `?returnTo=` follows the same same-origin rule as the other providers
  and is stored server-side. If the pending request cannot be stored the route answers `503`
  `provider-unavailable` rather than redirecting.
- `POST <basePath>/<name>/acs` — the assertion consumer service, over the **HTTP-POST** binding.
- `GET <basePath>/<name>/metadata` — the SP descriptor (`application/samlmetadata+xml`) to register
  with the IdP: the entity id, the ACS URL, `AuthnRequestsSigned="false"` and
  `WantAssertionsSigned="true"`.

**What the ACS checks.** The assertion must be signed by one of `idp.certs` (a signature only on the
response envelope is not enough, and an unsigned or encrypted assertion is refused); its `Issuer`
must equal `idp.entityId`; its `Audience` must be `entityId`; every `SubjectConfirmationData` must
name `acsUrl` as its `Recipient` and carry an `InResponseTo` naming the consumed request (the
response envelope is unsigned when only the assertion is, so its own `InResponseTo` cannot bind the
assertion); `NotBefore`/`NotOnOrAfter` must hold with 60 seconds of skew; the response's
`InResponseTo` must name a pending request this server issued for this provider, and that request is
consumed — once; the assertion `ID` must not have been used before; and the browser must present the
binding cookie set at login. Two posts of one captured response cannot both sign in. The `Issuer`
and `NameID` the plugin checks and hands to `toPrincipal` are read from the signed assertion's own
`<Issuer>` and `<Subject><NameID>` elements — never from the library's profile object, where a
same-named IdP attribute could stand in for them — and an assertion missing either is refused.
**IdP-initiated (unsolicited) login is refused**: it has no request to bind to. XML signature
verification, including resistance to signature-wrapping, is delegated to
[`@node-saml/node-saml`](https://github.com/node-saml/node-saml) rather than hand-written.

**Refusals** answer `401` — or redirect to `failureRedirect` with `?error=<code>` — with one of two
fixed codes, and the library's own message reaches only the `debug` log:

| Code                | Meaning                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `assertion-invalid` | The response did not verify, answered no pending request, or reused an assertion id.                               |
| `state-invalid`     | The response answers a login this browser did not start: another browser's request, or a missing or wrong binding. |

`toPrincipal` returning `null` (or throwing) answers `403` `principal-refused`. A sign-in held for a
second factor redirects to `signIn.mfa.challengePath` when set.

**Why a second cookie.** The IdP returns by a cross-site `POST`, which the session cookie's default
`SameSite=Lax` does not accompany, so the pending request cannot live in the session. It lives in
the provider's `store`, and the browser that started the login is bound to it by `__Host-setu-saml`
(`SameSite=None; Secure; HttpOnly; Path=/; Max-Age=600`). Without that binding an attacker could
start a login, obtain a valid response for their own account, and make a victim's browser post it.
Do **not** set the session cookie to `SameSite=None` to "make SAML work" — it is unnecessary.
Because the binding is one cookie per browser, a login started in a second tab replaces the first
tab's, which then fails closed; retrying succeeds.

**The ACS runs on a new session.** The `Lax` session cookie is not sent with the IdP's `POST`, so
the session middleware opens an empty session, `signIn` writes the identity into it, and its cookie
replaces the browser's previous one. Anything the previous session held is gone (on the store
strategy its entry is orphaned until its own expiry). Do not keep state across a SAML sign-in in the
session; `returnTo` is the supported way to resume.

**Several replicas need a shared store.** The default `MemorySamlRequestStore` is correct for ONE
process: a login started on one replica and answered on another is refused. Implement
`ISamlRequestStore` over a shared backend; `consumeRequest` and `claimAssertionId` MUST be atomic.

**The login route is unauthenticated, so bound what it can cost.** Each `GET …/login` records a
pending request for its lifetime. `MemorySamlRequestStore` caps how many it holds
(`maxPendingRequests`, default `DEFAULT_MAX_PENDING_SAML_REQUESTS` = 10,000): past the cap the
OLDEST pending request is evicted, so its login fails closed and is retried while memory stays
bounded. A shared store needs its own bound (a TTL and a size limit). Rate-limit the login route as
well, and set `RuntimePlugin({ maxBodyBytes })` — the ACS reads a form body, and a SAML response is
a few kilobytes, so a cap of tens of kilobytes is ample.

**CSRF composition.** The IdP's `POST` carries no form token, so with the session plugin's form CSRF
the ACS path must be in `csrf.exclude`. The `Origin` is the subtler half: an IdP that serves
`Referrer-Policy: no-referrer` (Keycloak does) makes the browser post the ACS with `Origin: null`,
which no origin allowlist can admit safely — `trustedOrigins: ['null']` would admit every
opaque-origin `POST` on every route. The documented recipe therefore puts the ACS path in
`http-security-plugin`'s `csrf.exclude` too, so BOTH checks exempt the path rather than trusting an
origin. Exempting it is sound because the signed assertion, the single-use request and the binding
cookie are the ACS's own defences. Keep `trustedOrigins` only for an IdP that sends a real origin.

```typescript
import { SessionPlugin } from '@setu-ts/session-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';

SessionPlugin({
  secret: 'replace-with-at-least-32-characters!!',
  csrf: { exclude: ['/auth/corp/acs'] },
});
HttpSecurityPlugin({ csrf: { exclude: ['/auth/corp/acs'] } });
```

**The library.** `@node-saml/node-saml` is imported lazily when a `saml` provider is configured,
awaited in `register()`, so a missing package fails at startup with `SamlRuntimeLoadError` rather
than at the first login. Pass `module` to inject it instead. On Cloudflare Workers it needs the
`nodejs_compat` compatibility flag; without it the library cannot bundle, and the error says so.

Not provided: IdP-initiated login, encrypted assertions, single logout, the Artifact binding, signed
AuthnRequests, and acting as an IdP.

## Multi-Factor Authentication (TOTP)

`signIn.mfa` adds a TOTP second factor to any sign-in flow that records its principal through
`IAuthSessionService` — a federated callback, a password login, or both. It is off by default;
nothing changes until you set `signIn.mfa.required`.

`TotpService` is an app-instantiated service (like `PasswordHasher` and `RefreshTokenService`) — it
is not an `AuthPlugin` option and registers nothing. It computes RFC 6238 TOTP codes (HMAC-SHA1,
30-second step, 6 digits, ±1 step window) from a base32 secret, and it verifies them against an
`ITotpStore`. The shipped `MemoryTotpStore` is single-process; a multi-instance application supplies
a shared implementation, and must implement `stageSecret`, `confirmSecret`, `claimStep`,
`reserveAttempt` and `consumeRecoveryCode` as single atomic operations (a compare-and-set or a
transaction) — each one closes a race that a read followed by a write reopens.

A shared `ITotpStore` implementation must preserve these operations across replicas:

| Method                                                  | Operation / return contract                                                                                                                                                                                                           | Race closed                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `getEnrolment(principalId)`                             | Read the enrolment or `null`; memory returns a copy                                                                                                                                                                                   | Read without mutating the stored record                                      |
| `stageSecret(principalId, secret, label)`               | Atomically create an unconfirmed record with step 0; replace secret/label on an unconfirmed record; on a confirmed record set pending fields, keeping the active secret. Never reset an existing step or confirmation. Returns `void` | Re-enrolment cannot undo a concurrent step claim                             |
| `confirmSecret(principalId, secret, minStep)`           | Atomically confirm only the still-awaiting secret, clear pending fields, raise the claimed step to at least `minStep`. `true` when applied; `false` without changes if missing or replaced                                            | A code checked for an old candidate cannot confirm a new one                 |
| `deleteEnrolment(principalId)`                          | Delete enrolment, recovery codes and attempt counts; `void`                                                                                                                                                                           | Remove factor state, including recovery codes                                |
| `claimStep(principalId, step)`                          | Atomically raise the claimed step; `true` only if greater than the previous step, `false` for replay or missing enrolment                                                                                                             | Concurrent uses of one code cannot both claim its step                       |
| `reserveAttempt(principalId, now, { limit, windowMs })` | Atomically expire old attempts, count this attempt before verification and return `{ allowed, count }`. Refused attempts are not stored; memory reports the stored count plus one for a refusal                                       | A burst cannot bypass lockout; refused guesses cannot extend it indefinitely |
| `clearAttempts(principalId)`                            | Clear counted attempts after successful verification; `void`                                                                                                                                                                          | Clear the window without writing back a stale count                          |
| `saveRecoveryCodes(principalId, digests)`               | Replace the whole recovery set with SHA-256 hex digests, never plaintext; `void`                                                                                                                                                      | Regeneration replaces the previous set                                       |
| `consumeRecoveryCode(principalId, digest)`              | Atomically find and consume; `true` once, `false` when absent or already used                                                                                                                                                         | Concurrent uses of one recovery code cannot both succeed                     |

A password-only application sets `providers: []` with `mfa` and records its own principal through
`IAuthSessionService.signIn`, as the `/login` route below does; `signIn` then supplies the
auth-session capability, the pending state and the logout route.

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthSessionService, IRequestContext } from '@setu-ts/common';
import { AuthPlugin, MemoryTotpStore, requireMfa, TotpService } from '@setu-ts/auth-plugin';
import { createRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { createApplication } from '@setu-ts/kernel';

const runtime = createRuntimeServices();
const totp = new TotpService({ store: new MemoryTotpStore(), runtime, issuer: 'MyApp' });

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SessionPlugin({ secret: 'replace-with-at-least-32-characters!!', store: 'memory' }),
    AuthPlugin({
      signIn: {
        providers: [],
        mfa: {
          // Typically: does this principal have a confirmed factor (or a policy
          // that demands one)? Your own lookup decides.
          required: (principal) => principal.id.startsWith('local|'),
          pendingTtlMs: 300_000,
          challengePath: '/mfa',
        },
      },
    }),
  ],
});

// Your own credential check — whatever your user store provides.
declare function checkPassword(username: string, password: string): Promise<{ id: string } | null>;

app.router.post('/login', async (ctx) => {
  const { username, password } = await ctx.request.json<{ username: string; password: string }>();
  const user = await checkPassword(username, password);
  if (user === null) return ctx.response.status(401).json({ error: 'invalid credentials' });
  const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
  const outcome = await auth.signIn(ctx, { id: user.id, roles: [] }, { methods: ['pwd'] });
  // 'second-factor-required': send the browser to the code form.
  return ctx.response.json(outcome);
});

// Who is enrolling: the signed-in principal (a settings page), or — during a
// sign-in held for its first second factor — the pending one. NEVER an id from
// the request body: that would let anyone enrol a factor on another account.
function enrollingPrincipal(ctx: IRequestContext): string | null {
  const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
  return ctx.request.user?.id ?? auth.pending(ctx)?.principal.id ?? null;
}

app.router.post('/mfa/enrol', async (ctx) => {
  const principalId = enrollingPrincipal(ctx);
  if (principalId === null) return ctx.response.status(401).json({ error: 'sign in first' });
  const { secret, uri } = await totp.beginEnrolment(principalId, principalId);
  return ctx.response.json({ secret, uri });
});

// `proof` is required only when REPLACING a confirmed factor: a code from the
// current authenticator, or an unused recovery code.
app.router.post('/mfa/confirm', async (ctx) => {
  const principalId = enrollingPrincipal(ctx);
  if (principalId === null) return ctx.response.status(401).json({ error: 'sign in first' });
  const { code, proof } = await ctx.request.json<{ code: string; proof?: string }>();
  const result = await totp.confirmEnrolment(principalId, code, proof);
  if (result.status !== 'ok') return ctx.response.status(401).json({ error: result.status });
  // Confirmation mints the recovery codes; show them to the user this once.
  return ctx.response.json({ recoveryCodes: result.recoveryCodes });
});

app.router.post('/mfa/complete', async (ctx) => {
  const { code } = await ctx.request.json<{ code: string }>();
  const result = await totp.completeSignIn(ctx, code);
  if (result !== 'signed-in') {
    return ctx.response.status(401).json({ error: result });
  }
  return ctx.response.redirect('/', 302);
});

app.router.post('/mfa/complete-recovery', async (ctx) => {
  const { code } = await ctx.request.json<{ code: string }>();
  const result = await totp.completeSignInWithRecoveryCode(ctx, code);
  if (result !== 'signed-in') {
    return ctx.response.status(401).json({ error: result });
  }
  return ctx.response.redirect('/', 302);
});

// Settings: regenerating codes or disabling the factor takes the factor.
app.router.post('/account/mfa/recovery-codes', {
  middleware: [requireMfa()],
  handler: async (ctx) => {
    const { proof } = await ctx.request.json<{ proof: string }>();
    const result = await totp.generateRecoveryCodes(ctx.request.user?.id ?? '', proof);
    if (result.status !== 'ok') return ctx.response.status(401).json({ error: result.status });
    return ctx.response.json({ recoveryCodes: result.recoveryCodes });
  },
});

app.router.post('/account/mfa/disable', {
  middleware: [requireMfa()],
  handler: async (ctx) => {
    const { proof } = await ctx.request.json<{ proof: string }>();
    const result = await totp.disable(ctx.request.user?.id ?? '', proof);
    return ctx.response.status(result === 'ok' ? 200 : 401).json({ result });
  },
});

app.router.get('/account/bank', {
  middleware: [requireMfa()],
  handler: async (ctx) => ctx.response.json({ ok: true }),
});
```

- **Who may change a factor.** Enrolment, confirmation, regeneration and disabling all take a
  principal id, and the routes that call them must take it from the session — the signed-in
  principal, or the pending one during a sign-in — never from the request. The service then enforces
  the rest: confirming a REPLACEMENT for a confirmed factor, regenerating recovery codes, and
  disabling a confirmed factor each require `proof` of the current factor (a code from it or an
  unused recovery code), answering `proof-required` without it. So a caller who can name a principal
  still cannot take over or remove its second factor. A FIRST enrolment needs no proof, because
  there is nothing to prove: an account with no factor is trust-on-first-use, and whoever holds its
  password during the pending state can enrol one. If that matters, enrol factors only from a
  signed-in session, or have `mfa.required` answer `true` only for principals that already have one.
  An administrator reset that cannot obtain proof calls `ITotpStore.deleteEnrolment` directly,
  behind its own authorization. A PASSKEY is a second factor too: with `signIn.mfa` configured, a
  one-factor session cannot register one — not even the first — unless `PasskeyOptions.mayRegister`
  admits it, so a stolen password cannot add a passkey beside a TOTP factor (see Passkeys).
- **Pending sign-in.** When `mfa.required` returns `true`, `signIn` does NOT sign the session in. It
  stores a `PendingSignIn` record under a private session key and returns `second-factor-required`.
  The session is anonymous until `completeSignIn` (or `completeSignInWithRecoveryCode`) succeeds, at
  which point the principal is recorded with `methods: ['pwd', 'otp']` (or `['fed', 'otp']`) and the
  session id is rotated. A pending record expires after `signIn.mfa.pendingTtlMs` (default 300 000
  ms; a positive integer, anything else is refused when `AuthPlugin(...)` is called). An expired
  record is not reported by `pending(ctx)`, so `completeSignIn` answers `no-pending` without
  checking — or spending — the code; that option is the only place the TTL is configured, because
  `TotpService` has no TTL option of its own. The internal promotion (`promotePending`) is not
  exported, and `TotpService` is the framework's only path that completes a pending sign-in — after
  checking a factor for the pending principal. That is a guarantee about the framework's surface,
  not a sandbox: application code holding the request can always call `signIn` with
  `methods: ['pwd', 'otp']` itself, and is trusted to record only methods it verified.
- **Federated sign-ins.** A provider callback whose sign-in is held pending redirects to
  `signIn.mfa.challengePath` (a same-origin absolute path) — the code form — instead of `returnTo`;
  without it, it falls back to `returnTo`, where the page must read `pending(ctx)` to tell the
  pending state from an anonymous one. The provider-session facts the callback records survive the
  promotion, so RP-initiated logout still ends the provider session afterwards.
- **Lockout.** Five failed attempts within 15 minutes lock the principal out of verification until
  15 minutes after the oldest counted attempt. A refused attempt is not counted, so continued
  guessing cannot extend the lock. `MemoryTotpStore` keeps an entry only for a principal with an
  attempt inside the window — expired entries are swept as the map grows — so its size is bounded by
  the attempt rate, not by every principal id ever presented. The attempt is reserved BEFORE the
  code is checked, so the fifth failure is what trips the lock and the sixth answers `locked`
  without computing or comparing anything. Recovery codes share that counter: five wrong recovery
  codes lock out TOTP verification too. A successful verification clears the count.
- **Re-enrolment is non-destructive.** A confirmed factor stays confirmed and stays usable while a
  new secret awaits confirmation; confirming swaps the pending secret in and keeps the step counter
  monotonic, so a code valid before the swap is still refused afterwards. Confirmation succeeds only
  if the secret its code was checked against is STILL the one awaiting confirmation
  (`ITotpStore.confirmSecret`), so a secret staged concurrently by someone else is never confirmed
  on the strength of the user's code — the user's confirmation answers `invalid` instead. A wrong
  new code is checked before any recovery code offered as proof, so it does not spend one.
- **Replay protection.** The store's `claimStep` is monotonic: a code whose step is ≤ the last
  claimed step is refused, so a captured code cannot be replayed within its ±1 window.
- **Recovery codes.** Confirming a factor mints the first set (`confirmEnrolment` returns it), so
  codes never exist without a proven factor; `generateRecoveryCodes(principalId, proof)` replaces
  the set later. Each set is 10 codes of 16 base32 characters (80 bits each). They are stored as
  SHA-256 digests and consumed atomically on use — a code works exactly once. The plaintext list is
  returned to the caller exactly once and is not recoverable.
- **`requireMfa()` guard.** Answers `401` for an anonymous request and `403`
  `second-factor-required` for a principal whose `claims.amr` lacks `otp` or `pop`. A session that
  completed a second factor carries `amr: [..., 'otp']` and passes. A non-array `amr` — a bare
  `'otp'`, a number, an object — is treated as ABSENT rather than coerced, so a string merely
  containing a factor name cannot satisfy the guard. The guard is branded `AUTHENTICATED`, so it
  composes with `requireRole`/`requirePermission` on the same route.
- **Both completion paths append `otp`.** `completeSignIn` and `completeSignInWithRecoveryCode` each
  append `otp` to the pending record's methods, so a password sign-in that finished with either ends
  up with `methods: ['pwd', 'otp']` and `amr: ['pwd', 'otp']`. `requireMfa()` accepts `otp` or
  `pop`.

## Passkeys (WebAuthn)

`signIn.passkeys` registers the four ceremony routes — `POST <basePath>/passkeys/register/options`,
`POST <basePath>/passkeys/register/verify`, `POST <basePath>/passkeys/login/options` and
`POST <basePath>/passkeys/login/verify` (`basePath` defaults to `/auth`) — and lets a passkey
assertion with user verification count as the second factor for `signIn.mfa`'s step-up model.
Registration and authentication ceremonies are WebAuthn Level 2 with attestation conveyance `none`;
ES256, RS256 and EdDSA credentials are accepted.

The verifier is **zero-dependency**: a bounded CBOR/COSE decoder over `runtime.subtle`. It does not
use `@simplewebauthn/server`, because importing that library installs a global `Reflect.getMetadata`
polyfill in every application that enables passkeys (its `reflect-metadata` dependency) and
advertises ML-DSA-44 on some runtimes only — the framework requires no reflection library, and the
plugin keeps that true. The library appears only in the package's own differential test, as a test
oracle.

Verification checks `clientDataJSON` (ceremony type, the session-held challenge, the origin against
an exact allowlist, `crossOrigin` refused), `authenticatorData` (RP ID hash, user-present and
user-verified flags), and the signature over `authenticatorData ‖ SHA-256(clientDataJSON)`.
Challenges are held in the session with a 5-minute expiry AND claimed once in the credential store:
on the default encrypted-cookie session strategy an older cookie still carries a consumed challenge,
and a synced passkey's counter is always `0`, so the session alone cannot stop a replayed assertion.

```typescript
import type { IPrincipal } from '@setu-ts/common';
import { AuthPlugin, MemoryPasskeyStore } from '@setu-ts/auth-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';

/** The application's own principal lookup; `null` refuses the sign-in. */
function loadPrincipal(principalId: string): Promise<IPrincipal | null> {
  return Promise.resolve(null);
}

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    SessionPlugin({ secret: 'replace-with-at-least-32-characters!!' }),
    AuthPlugin({
      signIn: {
        providers: [],
        mfa: { required: (principal) => principal.roles?.includes('admin') === true },
        passkeys: {
          rpId: 'example.com',
          rpName: 'My App',
          origins: ['https://example.com'],
          store: new MemoryPasskeyStore(),
          resolvePrincipal: loadPrincipal,
        },
      },
    }),
  ],
});
```

The browser calls the routes with `navigator.credentials` and the CSRF header token the session
plugin's form CSRF check requires:

```js
const options = await fetch('/auth/passkeys/login/options', {
  method: 'POST',
  headers: { 'x-csrf-token': csrfToken },
}).then((r) => r.json());

// The options are JSON (base64url strings); WebAuthn needs ArrayBuffers. Registration
// does the same with `parseCreationOptionsFromJSON` before `navigator.credentials.create`.
const assertion = await navigator.credentials.get({
  publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
});

const result = await fetch('/auth/passkeys/login/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
  body: JSON.stringify(assertion),
}).then((r) => r.json());
// { status: 'signed-in' } — or { status: 'second-factor-required' }
```

Credentials are the application's data: `PasskeyOptions.store` is a required `IPasskeyStore`, and
the shipped `MemoryPasskeyStore` is single-process. A multi-instance application supplies a shared
implementation and **must implement `updateCounter` as an atomic compare-and-advance** — it stores
the observed counter only when it is greater than the stored one (or both are zero) and reports
whether it did. A read-then-write lets two concurrent assertions both validate against the same
stored value and lets the lower one overwrite the higher, which is exactly how a cloned
authenticator's stale counter slips through. **`save` must be an atomic compare-and-set** — it
stores a NEW credential only when its id is absent AND the principal holds fewer than
`options.maxPerPrincipal` credentials, both checked in the same atomic step as the insert, and
answers `'saved'`, `'duplicate'` or `'limit'`. A blind write lets two concurrent registrations of
the same credential id both succeed and lets the later record silently replace the earlier one,
`principalId` included; a count read before a separate write lets a burst of concurrent
registrations overshoot the cap. `claimChallenge` must be atomic too.

Under the default `userVerification: 'required'` a UV-unset assertion is refused everywhere — the
options told the browser user verification is required, so the server enforces it. Under
`'preferred'` or `'discouraged'` a UV-unset assertion is refused for a username-less sign-in and
accepted only as the second factor after a first one: without user verification it proves possession
alone, and recording `pop` for it would satisfy `requireMfa()` with one factor.

A passkey-only application needs no provider and no `mfa`: `signIn: { providers: [], passkeys }` is
accepted, and the `passkeys` option is validated when `AuthPlugin(...)` is called, so a malformed
origin or `rpId` refuses before an application exists. The recorded method is always `pop` (proof of
possession) — never `hwk`/`swk`, which the plugin cannot know with attestation unverified.

**Registration is gated.** Registering a passkey requires a signed-in principal (401 otherwise), and
a principal who ALREADY holds a passkey must have proved a second factor (`otp` or `pop`) in the
current session — otherwise a stolen password alone could enrol the attacker's own authenticator,
whose later assertions are recorded as `pop` and pass `requireMfa()`. That is refused with
`403 second-factor-required`, at both `register/options` and `register/verify`.

The FIRST passkey depends on whether `signIn.mfa` is configured. Without it (a passkey-only
application) the first passkey is trusted on first use. **With it, and no `mayRegister`, the first
passkey needs a proven second factor too** — the principal may hold a TOTP factor this plugin cannot
see, and a stolen password must not enrol an authenticator that then satisfies `requireMfa()`. A
user with no factor yet therefore cannot add a first passkey until the application says so:
`PasskeyOptions.mayRegister` receives the principal, the session's recorded `methods` and the
principal's `credentialCount`, is consulted after the built-in rules, and decides the first passkey
when it is set — admit a password-only first enrolment only for a principal that holds no other
factor. `false` or a throw answers `403 registration-refused`. One principal holds at most 16
credentials (`409 credential-limit`, enforced atomically by the store's `save`), and only the six
defined WebAuthn `transports` values are stored, each once. An EC2 key is checked to be a point on
P-256 at registration, because the runtimes disagree on whether Web Crypto does.

Attestation statements are NOT verified: `attestation: 'none'` is requested, any `fmt` the client
sends is accepted with its statement unread, and the stored credential records
`attestation: 'unverified'`. Verifying attestations against trust roots is out of scope.

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
`MemoryRefreshTokenStore` does both with lazy expiry on `get()` and amortised expiry sweeps on
`save()` and `rotate()`. Sweeps remove only expired records; unexpired revoked records remain
available for rotation reuse detection. No background timer is required.

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
(`Retry-After` always set; the draft-11 `RateLimit` and `RateLimit-Policy` fields set unless
`standardHeaders: false`). Both fields are Structured Field Lists (RFC 9651), and each limiter
appends one member:

```
RateLimit-Policy: "default";q=100;w=60
RateLimit: "default";r=99;t=60
```

`q` is the quota (0 to 999999999999999), `w` the window in whole seconds (rounded up), `r` the
remaining budget, and `t` the non-negative delta-seconds until reset. `t` and `Retry-After` are
capped at 999999999999999 (the RFC 9651 sf-integer maximum). Give two stacked limiters distinct
`policyName`s — both append to the same two lists, so a shared name makes their budgets
indistinguishable (`RateLimit-Policy: "a";q=10;w=60, "b";q=5;w=60`).

The factory validates its options once and throws before any request: `max` must be an integer from
0 to 999999999999999 (`RangeError`), `windowMs` a positive integer number of milliseconds
(`RangeError`), and `policyName` a non-empty printable-ASCII string (`TypeError`).

A store result whose `count` is not a non-negative whole number, or whose `resetTime` is not finite,
answers 429 for a full window (fail closed): the limiter refuses rather than serves when it cannot
read its own counter.

The default store is in-memory (single-process); use `RedisRateLimitStore` for multi-instance
deployments (pass an ioredis-compatible `client`, or `ioredis` is lazily imported on first use).
`RedisRateLimitStore` re-arms a key it finds without an expiry, so a lost `PEXPIRE` cannot leave a
counter that answers 429 for ever.

The 429 body uses `@setu-ts/common`'s error-responder seam, so it follows the application's
configured error format. Under the Problem Details formats (`rfc9457`, `rfc7807`) it identifies
itself as the registered `quota-exceeded` problem:

```json
{
  "type": "https://iana.org/assignments/http-problem-types#quota-exceeded",
  "title": "Quota Exceeded",
  "status": 429,
  "detail": "Rate limit exceeded",
  "instance": "/orders",
  "violated-policies": ["default"]
}
```

The default `'default'` format is unchanged. The operational paths `/live`, `/ready`, `/health`,
`/metrics`, `/openapi.json`, and `/docs` are exempt by default through
`DEFAULT_RATE_LIMIT_EXCLUDED_PATHS`; an `exclude` list replaces the defaults, so spread the constant
to extend them. `RedisRateLimitStore` prefixes its keys with `'setu:ratelimit:'` by default; set
`keyPrefix` per application when several share Redis, or `''` to keep pre-M90a keys.

`RedisRateLimitStore` is constructed by the application, so no plugin wires its connection errors.
Pass `connectionErrorReporter` (built with `createConnectionErrorReporter` from `@setu-ts/common`
over your logger) and the `'error'` events of the client it builds are logged — first error at
`warn`, repeats at `debug`, recovery at `info` — rather than printed by `ioredis` to `console.error`
on every reconnect attempt. An injected `client` never gets a listener.

To back the store with node-redis, pass
`new RedisRateLimitStore({ client: fromNodeRedis(createClient({ url })) })` (`fromNodeRedis` from
`@setu-ts/common`, `createClient` from `redis`). See
[Using node-redis](https://github.com/setu-ts/setu-ts/blob/main/packages/common/README.md#using-node-redis-0110).

The default key resolves in this order: the authenticated principal, the client IP published by
`ipSecurityMiddleware` (see `http-security-plugin`), `IRequest.ip`, and only then one global
`'anonymous'` bucket — shared by every caller for whom none of the three resolved.

<!-- assert:js -->

| Expression                                                                                                          | Value              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `(await import('@setu-ts/auth-plugin')).defaultRateLimitKey({ request: { user: { id: 'u1' } }, state: new Map() })` | `"user:u1"`        |
| `(await import('@setu-ts/auth-plugin')).defaultRateLimitKey({ request: { ip: '203.0.113.7' }, state: new Map() })`  | `"ip:203.0.113.7"` |
| `(await import('@setu-ts/auth-plugin')).defaultRateLimitKey({ request: {}, state: new Map() })`                     | `"anonymous"`      |

Node, Deno and Bun populate `IRequest.ip` with the socket peer, so an unauthenticated caller uses
`ip:<peer>` even without IP security middleware. Workers and plain fetch calls have no peer and
still use the shared bucket unless a trusted header or custom key resolves a client.

To make it per client behind a proxy, register `ipSecurityMiddleware` with `trustProxy` **and** the
constraint that matches your deployment — or pass your own `keyGenerator`. `trustProxy` on its own
takes the forwarded header's **leftmost** entry, which is safe only behind a proxy that OVERWRITES
that header. The standard nginx idiom **appends**, and there the leftmost entry is supplied by the
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
app.middleware.add(
  rateLimitMiddleware({
    windowMs: 60_000,
    max: 100,
    exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
  }),
);

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

| Option            | Type                     | Default                                               | Description                                                              |
| ----------------- | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `windowMs`        | `number`                 | -                                                     | Window length in ms; a positive integer.                                 |
| `max`             | `number`                 | -                                                     | Max requests per window per key; 0 to 999999999999999.                   |
| `store`           | `RateLimitStore`         | `MemoryRateLimitStore`                                | Counter backend.                                                         |
| `keyGenerator`    | `(ctx) => string`        | principal → client IP → `IRequest.ip` → `'anonymous'` | Caller identity for the counter.                                         |
| `message`         | `string`                 | `'Rate limit exceeded'`                               | 429 body message.                                                        |
| `standardHeaders` | `boolean`                | `true`                                                | Emit the draft-11 `RateLimit` and `RateLimit-Policy` fields.             |
| `policyName`      | `string`                 | `'default'`                                           | Policy name in both fields and `violated-policies`; use distinct names.  |
| `exclude`         | `readonly PathPattern[]` | six operational paths                                 | Paths skipped entirely; strings match exactly and regexps test the path. |

`MemoryRateLimitStore` reclaims expired windows on `increment()` with a doubling-threshold sweep
starting at 1,024 entries. Each key retains its own window duration; live windows are never evicted
for a hard cap, so active rate limits survive cleanup.

## Diagnostics

`AuthPlugin({ authorizationDiagnostics })` opts into minimized authorization-decision explanations
for the local diagnostics connector's `GET /v1/authorization` (`@setu-ts/diagnostics-plugin`). It is
explicit: the option is absent by default, and when supplied `enabled` must be `true`.

| Field            | Type                     | Meaning                                                        |
| ---------------- | ------------------------ | -------------------------------------------------------------- |
| `enabled`        | `boolean`                | Explicit opt-in; must be `true` (`false` throws).              |
| `roles`          | `Record<string, string>` | Exact role name → approved display alias. At most 128 entries. |
| `permissions`    | `Record<string, string>` | Exact permission name → approved display alias. At most 128.   |
| `policyRevision` | `string`                 | Approved alias for the policy revision; only when configured.  |

Only the exact role and permission names in the allowlists are observed, each under its approved
alias; a decision whose requested rules are not all approved is dropped before buffering and counted
as `droppedUnapproved`. A recorded decision names its rules only by their approved aliases; raw role
and permission names, request bodies, headers and claim values are never captured.
`setu devtool enable` writes this option for you; this section is for the reader who configures it
by hand. Enable only on an approved development dataset.

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';

AuthPlugin({
  authorizationDiagnostics: {
    enabled: true,
    roles: { admin: 'Administrator' },
    permissions: { 'users:write': 'Modify users' },
    policyRevision: 'rev-2026-01',
  },
});
```

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
| `definePolicy`                      | function  |
| `publicRoute`                       | function  |
| `rateLimitMiddleware`               | function  |
| `requireAllPermissions`             | function  |
| `requireAnyRole`                    | function  |
| `requireAuth`                       | function  |
| `requireMfa`                        | function  |
| `requirePermission`                 | function  |
| `requirePolicy`                     | function  |
| `requireRole`                       | function  |
| `requireScopedPermission`           | function  |
| `requireScopedRole`                 | function  |
| `safeReturnTo`                      | function  |
| `AuthorizationDeniedError`          | class     |
| `AuthPluginConfigurationError`      | class     |
| `GrantResolutionError`              | class     |
| `MalformedPasswordHashError`        | class     |
| `MemoryAccessTokenRevocationStore`  | class     |
| `MemoryPasskeyStore`                | class     |
| `MemoryRateLimitStore`              | class     |
| `MemoryRefreshTokenStore`           | class     |
| `MemorySamlRequestStore`            | class     |
| `MemoryTotpStore`                   | class     |
| `PasswordHasher`                    | class     |
| `RateLimitStoreUnavailableError`    | class     |
| `RedisRateLimitStore`               | class     |
| `RefreshTokenService`               | class     |
| `SamlRuntimeLoadError`              | class     |
| `TotpService`                       | class     |
| `UnknownPolicyError`                | class     |
| `DEFAULT_MAX_PENDING_SAML_REQUESTS` | const     |
| `DEFAULT_RATE_LIMIT_EXCLUDED_PATHS` | const     |
| `DEFAULT_RATE_LIMIT_KEY_PREFIX`     | const     |
| `ApiKeyOptions`                     | interface |
| `AuthMiddlewareOption`              | interface |
| `AuthorizationDiagnosticsOptions`   | interface |
| `AuthPluginOptions`                 | interface |
| `IAccessTokenRevocationStore`       | interface |
| `IAuthHttp`                         | interface |
| `IAuthorizationDiagnosticsSource`   | interface |
| `IAuthorizationPolicyService`       | interface |
| `IAuthorizationService`             | interface |
| `IAuthService`                      | interface |
| `IAuthStrategy`                     | interface |
| `IJwtService`                       | interface |
| `IPasskeyStore`                     | interface |
| `IPrincipal`                        | interface |
| `ISamlRequestStore`                 | interface |
| `ITotpStore`                        | interface |
| `JwtOptions`                        | interface |
| `JwtSignOptions`                    | interface |
| `LocalOptions`                      | interface |
| `MemorySamlRequestStoreOptions`     | interface |
| `MfaOptions`                        | interface |
| `OAuth2Provider`                    | interface |
| `OidcProvider`                      | interface |
| `PasskeyOptions`                    | interface |
| `PasskeyRegistrationContext`        | interface |
| `PasskeySaveOptions`                | interface |
| `PasswordHasherOptions`             | interface |
| `ProviderTokens`                    | interface |
| `RateLimitOptions`                  | interface |
| `RateLimitResult`                   | interface |
| `RateLimitStore`                    | interface |
| `RbacConfig`                        | interface |
| `RefreshTokenOptions`               | interface |
| `RefreshTokenRecord`                | interface |
| `RefreshTokenStore`                 | interface |
| `RequireAuthOptions`                | interface |
| `ReserveAttemptResult`              | interface |
| `RoleDefinition`                    | interface |
| `SamlModule`                        | interface |
| `SamlPendingRequest`                | interface |
| `SamlProfile`                       | interface |
| `SamlProvider`                      | interface |
| `ScopedGuardOptions`                | interface |
| `ScopedRbacOptions`                 | interface |
| `ScopedRoleLimit`                   | interface |
| `SessionAuthOptions`                | interface |
| `SignInConfig`                      | interface |
| `SignInProviderBase`                | interface |
| `StaticGrant`                       | interface |
| `StoredPasskey`                     | interface |
| `TokenPair`                         | interface |
| `TotpEnrolment`                     | interface |
| `TotpServiceOptions`                | interface |
| `TrustedIssuer`                     | interface |
| `ClaimsGrantMapper`                 | type      |
| `ConfirmEnrolmentResult`            | type      |
| `DisableResult`                     | type      |
| `GrantResolutionReason`             | type      |
| `GrantSourceConfig`                 | type      |
| `IRefreshTokenRotation`             | type      |
| `IssuerAlgorithm`                   | type      |
| `IssuerKeySource`                   | type      |
| `PasskeySaveResult`                 | type      |
| `PolicyDenial`                      | type      |
| `RecoveryCodesResult`               | type      |
| `RecoveryVerifyResult`              | type      |
| `RefreshPrincipal`                  | type      |
| `ScopedRbacTiming`                  | type      |
| `SessionStamp`                      | type      |
| `SignInProvider`                    | type      |
| `TokenEndpointAuth`                 | type      |
| `TotpCompleteSignInResult`          | type      |
| `TotpProofResult`                   | type      |
| `TotpVerifyResult`                  | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#authplugin-setu-tsauth-plugin).

## Readiness and dependency outages (M113b)

`RedisRateLimitStore.increment/reset` wrap recognised connection faults in
`RateLimitStoreUnavailableError`, preserving `cause`. With `errorHandler`, clients receive 503 and
`Rate limiting is temporarily unavailable.` Other errors propagate unchanged. The constructor's
`commandTimeoutMs` defaults to 15000, accepts 0–2147483647, and throws `RangeError` for invalid
values including NaN. Zero omits ioredis's bound; an injected client keeps its own settings.
Configure a larger bound when necessary.
