# @setu-ts/auth-plugin — authenticate requests and guard routes

**Add it:** `setu add auth` prints config; register `AuthPlugin` with `jwt.secret` and `rbac.roles`.
It provides `CAPABILITIES.AUTH` (`IAuthService`), `CAPABILITIES.JWT` (`IJwtService`) with `jwt`, and
`CAPABILITIES.AUTHORIZATION` (`IAuthorizationService`) with `rbac`.

## Protect an order route

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

## Verify credentials and sign

Configure `local.verify(identifier, secret, request)` first.

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

## Behaviour the types do not show

- Passive authentication defaults to priority 300; put guards on routes.
- Missing principal: 401; denied role/permission: 403; no `rbac`: those guards return 501.
- `requireAuth({ signInPage })` redirects anonymous browser navigations with `returnTo`, except that
  page itself; APIs keep 401.
- Tokens expire at `exp`. `local` needs a passive strategy for later requests.
- A JWT needs a string `sub`. Scoped tokens fail role/permission guards (`confineScopedTokens`).
- `requireAuth({ credentials: 'header' })` restricts the credential kind; `tenantClaim` refuses
  another tenant's token.

## Other options

- `apiKey`, `session`, `issuers` and `strategies` supply passive auth.
- `requireScopes` (ALL-of) and `resourceServer` (RFC 9728) serve token APIs.
- `definePolicy` and `requirePolicy` evaluate policies; scoped guards use `scopedRbac`.
- `signIn.mfa`/`signIn.passkeys` add factors; `createQuota` budgets (read with `quota.usage(key)`).
- `signIn` with `providers: []` is password-only; advancing `signIn.sessionStamp` revokes sessions.
