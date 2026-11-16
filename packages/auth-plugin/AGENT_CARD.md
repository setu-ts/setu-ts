# @setu-ts/auth-plugin — request authentication

**Add it:** `setu add auth`; register `AuthPlugin({ jwt: {}, rbac: { roles: {} } })`. Provides
`CAPABILITIES.AUTH`, `CAPABILITIES.JWT` with `jwt`, and `CAPABILITIES.AUTHORIZATION` with `rbac`.

## Protect orders

```ts
import type { IRouterApi } from '@setu-ts/common';
import { requireAuth, requirePermission } from '@setu-ts/auth-plugin';

export function registerOrderRoutes(router: IRouterApi): void {
  router.get('/orders', {
    middleware: [requireAuth(), requirePermission('orders:read')],
    handler: (ctx) => ctx.response.json({ userId: ctx.request.user?.id }),
  });
}
```

## Sign a token

Needs `local: { verify }`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthService, IJwtService } from '@setu-ts/common';

const auth = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);
const body = await ctx.request.json<{ identifier: string; secret: string }>();
const principal = await auth.verifyCredentials(body, ctx.request);
if (principal === null) {
  ctx.response.status(401).json({ error: 'Invalid credentials' });
} else {
  const jwt = ctx.services.get<IJwtService>(CAPABILITIES.JWT);
  const token = await jwt.sign({ sub: principal.id, roles: principal.roles }, { expiresIn: '1h' });
  ctx.response.json({ token });
}
```

## Behaviour and options

- Passive auth runs at 300; add guards. Missing principal: 401; denied permission: 403; no
  RBAC: 501.
- API-key `validate`: return null for invalid keys; throws become `AuthenticationUnavailableError`
  (503 with `errorHandler`; log names the cause's class only), even on public key-bearing routes.
  Validate format first.
- API-key, JWT and issuer headers refuse Cookie in any case. Use session authentication for cookies.
- JWT_SECRET: option → secrets → config → environment. HS256 needs ≥32 UTF-8/raw bytes.
  Missing/short keys throw `AuthPluginConfigurationError`; RS256 skips lookup.
- Sign-in/MFA clear CSRF. Fetch a fresh token. `signIn.sessionStamp` revokes sessions.
- JWTs need non-empty `sub`; scoped tokens fail RBAC guards. `tenantClaim` binds tokens to tenants.
- `requireAuth({ credentials: 'header' })` restricts credential kind; `signInPage` redirects browser
  navigations with `returnTo`. APIs keep 401.
- `requireScopes` is ALL-of; `definePolicy`/`requirePolicy` cover policies; `scopedRbac` scopes
  roles.
- `createQuota({ message })` sets the shared 429 detail; empty/non-string messages are refused.
  `quota.usage(key)` reads budgets. See README for factors and exchanges.
