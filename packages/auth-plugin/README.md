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
import { authMiddleware, AuthPlugin } from '@setu-ts/auth-plugin';

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

// Global middleware: authenticates every request and populates ctx.request.user.
// The priority is explicit and deliberate: ARCHITECTURE.md §10 reserves 300 for
// authentication, but a bare add() takes the kernel's default of 500 — AFTER
// every band in that table, including the row named for it.
app.middleware.add(authMiddleware(), { priority: 300 });
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

Passive strategies run in a fixed order during `IAuthService.authenticate` — **jwt → api-key →
session → caller-supplied, in declaration order** — and the first non-null principal wins, with
`null` returned when none match. A request carrying both a bearer header and a session cookie is
therefore authenticated by the JWT, because the explicit credential runs first. Caller-supplied
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

| Option                           | Type                                                  | Default           | Description                                                                                     |
| -------------------------------- | ----------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `jwt.secret`                     | `string \| Uint8Array`                                | -                 | HS256 key. Required for HS256.                                                                  |
| `jwt.privateKey`                 | `string` (PEM)                                        | -                 | RS256 private key. Required for RS256.                                                          |
| `jwt.publicKey`                  | `string` (PEM)                                        | -                 | RS256 public key. Required for RS256.                                                           |
| `jwt.algorithm`                  | `'HS256' \| 'RS256'`                                  | inferred          | Inferred from which key material is provided.                                                   |
| `jwt.audience`                   | `string`                                              | -                 | Expected `aud`; enforced on verify.                                                             |
| `jwt.issuer`                     | `string`                                              | -                 | Expected `iss`; enforced on verify.                                                             |
| `jwt.header`                     | `string`                                              | `'authorization'` | Header name for bearer extraction.                                                              |
| `jwt.scheme`                     | `string`                                              | `'bearer'`        | Token scheme prefix.                                                                            |
| `jwt.accessTokenRevocationStore` | `IAccessTokenRevocationStore`                         | -                 | Shared store that rejects revoked typed access tokens.                                          |
| `apiKey.header`                  | `string`                                              | `'X-API-Key'`     | Header holding the API key.                                                                     |
| `apiKey.validate`                | `(key) => Promise<IPrincipal \| null>`                | -                 | App-supplied API-key lookup.                                                                    |
| `local.verify`                   | `(identifier, secret) => Promise<IPrincipal \| null>` | -                 | App-supplied credential check.                                                                  |
| `rbac.roles`                     | `Record<string, RoleDefinition>`                      | -                 | Role → permissions + `inherits` hierarchy.                                                      |
| `session.toPrincipal`            | `(view: SessionView) => IPrincipal \| null`           | -                 | Maps the opened session to its principal; `null` continues the chain. Requires `SessionPlugin`. |
| `strategies`                     | `readonly IAuthStrategy[]`                            | -                 | Caller-supplied strategies, appended after every built-in in declaration order.                 |

Supplying neither `jwt.secret` (HS256) nor `jwt.privateKey` + `jwt.publicKey` (RS256) throws at
registration.

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

The default key resolves in this order: the authenticated principal, the client IP published by
`ipSecurityMiddleware` (which needs `trustProxy` — see `http-security-plugin` — to resolve one from
the proxy headers), `IRequest.ip`, and only then one global `'anonymous'` bucket shared by every
unauthenticated caller. Without that middleware the limiter is a single counter across all callers,
so the example below is **not** per IP; register `ipSecurityMiddleware` with `trustProxy` (or pass
your own `keyGenerator`) to make it one.

```typescript
import {
  DEFAULT_RATE_LIMIT_EXCLUDED_PATHS,
  rateLimitMiddleware,
  RedisRateLimitStore,
} from '@setu-ts/auth-plugin';

app.middleware.add(rateLimitMiddleware({
  windowMs: 60_000,
  max: 100,
  exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
})); // keyed by user; anonymous callers share ONE bucket without ipSecurityMiddleware

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
| `AuthPluginOptions`                 | interface |
| `IAccessTokenRevocationStore`       | interface |
| `IAuthorizationService`             | interface |
| `IAuthService`                      | interface |
| `IAuthStrategy`                     | interface |
| `IJwtService`                       | interface |
| `IPrincipal`                        | interface |
| `JwtOptions`                        | interface |
| `JwtSignOptions`                    | interface |
| `LocalOptions`                      | interface |
| `RateLimitOptions`                  | interface |
| `RateLimitResult`                   | interface |
| `RateLimitStore`                    | interface |
| `RbacConfig`                        | interface |
| `RefreshTokenOptions`               | interface |
| `RefreshTokenRecord`                | interface |
| `RefreshTokenStore`                 | interface |
| `RoleDefinition`                    | interface |
| `SessionAuthOptions`                | interface |
| `TokenPair`                         | interface |
| `IRefreshTokenRotation`             | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#authplugin-setu-tsauth-plugin).
