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

Configure `local.verify(identifier, secret, request)`.

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

## Behaviour

- Passive auth: priority 300; add route guards.
- Missing principal: 401; denied role/permission: 403; no `rbac`: those guards return 501.
- `requireAuth({ signInPage })` redirects anonymous browser navigations with `returnTo`, except that
  page; APIs keep 401.
- JWT_SECRET resolves option → secrets manager → config → environment. HS256 needs ≥32 UTF-8/raw
  bytes; missing/short keys throw `AuthPluginConfigurationError`. RS256 skips lookup.
- Sign-in/MFA clear form CSRF; fetch a new token before posting.
- JWTs need a string `sub` and expire at `exp`; `local` needs a passive strategy. Scoped tokens fail
  role/permission guards (`confineScopedTokens`).
- `requireAuth({ credentials: 'header' })` restricts credential kind; `tenantClaim` refuses other
  tenants.

## Options

- Passive auth: `apiKey`, `session`, `issuers`, `strategies`.
- Token APIs: `requireScopes` (ALL-of), `resourceServer` (RFC 9728).
- Policies: `definePolicy`, `requirePolicy`; scoped guards use `scopedRbac`.
- Factors: `signIn.mfa`/`signIn.passkeys`; budgets: `createQuota`, `quota.usage(key)`.
- `signIn` with `providers: []` is password-only; advance `signIn.sessionStamp` to revoke sessions.
