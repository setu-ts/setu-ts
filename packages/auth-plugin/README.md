# Auth Plugin

Authentication and authorization plugin for Hono Enterprise: JWT and API-key authentication, local
credential verification, RBAC authorization with role hierarchy, and short-circuiting route guards.

All cryptography (HS256/RS256 JWT signing/verification and PBKDF2-SHA256 password hashing) runs
through Web Crypto via `IRuntimeServices` (`runtime.subtle` / `runtime.randomBytes`), so the package
has **zero npm dependencies** and is cross-runtime (Deno / Node 20+ / Bun).

The plugin registers three services under existing capability tokens:

| Service                | Token              | Interface               |
| ---------------------- | ------------------ | ----------------------- |
| JWT sign/verify/decode | `'jwt'`            | `IJwtService`           |
| Authentication         | `'authentication'` | `IAuthService`          |
| Authorization (RBAC)   | `'authorization'`  | `IAuthorizationService` |

> **Phasing (M16b):** the **refresh-token strategy** and **rate limiting** are deferred to M16b.
> `IJwtService` exposes only `sign` / `verify` / `decode` — a refresh token is simply
> `sign({ expiresIn: '7d' })`.

## Installation

```bash
deno add @hono-enterprise/auth-plugin
```

## Usage

```typescript
import { authMiddleware, AuthPlugin } from '@hono-enterprise/auth-plugin';

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
app.middleware.add(authMiddleware());
```

## Login (Issue Token)

`IAuthService.verifyCredentials({ identifier, secret })` resolves to an `IPrincipal | null`; mint a
JWT with the separate `IJwtService` resolved from `'jwt'`.

```typescript
import type { IAuthService, IJwtService } from '@hono-enterprise/common';

app.router.post('/auth/login', async (ctx) => {
  const auth = ctx.services.get<IAuthService>('authentication');
  const jwt = ctx.services.get<IJwtService>('jwt');
  const { username, password } = await ctx.request.json();

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
- **LocalStrategy** — explicit credentials verification. Not passive; reached only via
  `IAuthService.verifyCredentials` from a login handler.

Passive strategies run in the configured order during `IAuthService.authenticate`; the first
non-null principal wins, and `null` is returned when none match.

## RBAC

`IAuthorizationService` (the `'authorization'` service) resolves a transitive role hierarchy before
checking. A principal with `admin` satisfies `requireRole('user')` when `admin` inherits `user`
(directly or transitively). Hierarchy resolution is cycle-safe (a self/cyclic `inherits` is
ignored). The wildcard permission `'*'` — held directly by the principal or granted by any of its
(direct or inherited) roles — satisfies every `hasPermission`/`hasAllPermissions` check.

```typescript
import type { IAuthorizationService } from '@hono-enterprise/common';

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
} from '@hono-enterprise/auth-plugin';

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

## Password Hashing

`PasswordHasher` is an exported utility for provisioning passwords and verifying them inside a
`local.verify` callback. It draws a random 16-byte salt and derives a 32-byte key with PBKDF2-SHA256
(100 000 iterations) via `runtime.subtle` / `runtime.randomBytes`, comparing with a fixed-time
check.

```typescript
import { PasswordHasher } from '@hono-enterprise/auth-plugin';

const hasher = new PasswordHasher(runtime); // IRuntimeServices resolved from the 'runtime' token
const stored = await hasher.hash('correct horse battery staple');
const ok = await hasher.verify(stored, 'correct horse battery staple'); // true
```

## Options

| Option            | Type                                                  | Default           | Description                                   |
| ----------------- | ----------------------------------------------------- | ----------------- | --------------------------------------------- |
| `jwt.secret`      | `string \| Uint8Array`                                | -                 | HS256 key. Required for HS256.                |
| `jwt.privateKey`  | `string` (PEM)                                        | -                 | RS256 private key. Required for RS256.        |
| `jwt.publicKey`   | `string` (PEM)                                        | -                 | RS256 public key. Required for RS256.         |
| `jwt.algorithm`   | `'HS256' \| 'RS256'`                                  | inferred          | Inferred from which key material is provided. |
| `jwt.audience`    | `string`                                              | -                 | Expected `aud`; enforced on verify.           |
| `jwt.issuer`      | `string`                                              | -                 | Expected `iss`; enforced on verify.           |
| `jwt.header`      | `string`                                              | `'authorization'` | Header name for bearer extraction.            |
| `jwt.scheme`      | `string`                                              | `'bearer'`        | Token scheme prefix.                          |
| `apiKey.header`   | `string`                                              | `'X-API-Key'`     | Header holding the API key.                   |
| `apiKey.validate` | `(key) => Promise<IPrincipal \| null>`                | -                 | App-supplied API-key lookup.                  |
| `local.verify`    | `(identifier, secret) => Promise<IPrincipal \| null>` | -                 | App-supplied credential check.                |
| `rbac.roles`      | `Record<string, RoleDefinition>`                      | -                 | Role → permissions + `inherits` hierarchy.    |

Supplying neither `jwt.secret` (HS256) nor `jwt.privateKey` + `jwt.publicKey` (RS256) throws at
registration.

## License

MIT
