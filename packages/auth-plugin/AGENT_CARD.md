# @setu-ts/auth-plugin — authenticate requests and guard routes

**Add it:** `setu add auth` prints the registration for `setu.config.ts`; configure
`AuthPlugin({ jwt: { secret: process.env.JWT_SECRET! }, rbac: { roles: { user: { permissions: ['orders:read'] } } } })`.
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

## Sign a token after verifying credentials

Configure `local.verify` to check your application's credential store first.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuthService, IJwtService } from '@setu-ts/common';

const auth = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);
const principal = await auth.verifyCredentials(await ctx.request.json<{ identifier: string; secret: string }>());
if (principal === null) {
  ctx.response.status(401).json({ error: 'Invalid credentials' });
} else {
  const jwt = ctx.services.get<IJwtService>(CAPABILITIES.JWT);
  const token = await jwt.sign({ sub: principal.id, roles: principal.roles }, { expiresIn: '1h' });
  ctx.response.json({ token });
}
```

## Behaviour the types do not show

- Passive authentication runs globally at priority 300 by default; guards belong on routes.
- An absent principal yields 401. An authenticated caller denied a role or permission gets 403;
  without `rbac` those authorization guards return 501.
- Token verification rejects at or after `exp`, with no clock tolerance.
- `local` alone cannot authenticate subsequent requests; configure a passive strategy too.

## Other options

- `apiKey`, `session`, `issuers` and `strategies` supply other passive authentication paths.
- `definePolicy` and `requirePolicy` evaluate application policies; scoped guards use `scopedRbac`.
- `signIn.mfa` and `signIn.passkeys` add factors; `RefreshTokenService` and `rateLimitMiddleware`
  are standalone helpers.
