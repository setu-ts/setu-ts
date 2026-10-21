# @setu-ts/auth-plugin — JWT authentication, RBAC and route guards

`setu add auth` is not zero-configuration: it prints the `AuthPlugin(...)` line for
`setu.config.ts`. Provides `CAPABILITIES.AUTH` and `CAPABILITIES.JWT`, plus
`CAPABILITIES.AUTHORIZATION` only with `rbac`.

```ts
import { AuthPlugin, requireAuth, requireRole } from '@setu-ts/auth-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createSecuredApp() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        jwt: { secret: 'a-secret-at-least-32-characters-long' },
        rbac: { roles: { user: { permissions: ['orders:read'] } } },
      }),
    ],
  });
  app.router.get('/orders', {
    middleware: [requireAuth(), requireRole('user')],
    handler: (ctx) => ctx.response.json({ userId: ctx.request.user?.id ?? null }),
  });
  return app;
}
```

- `jwt` takes `secret` (HS256) or `privateKey`/`publicKey` (RS256), plus `algorithm`, `audience`,
  `issuer`, `header`, `scheme`. Verification has no clock tolerance: an `exp` at or past now is
  rejected.
- `apiKey` needs a `validate` callback, `local` a `verify` callback, and `session` a `toPrincipal`
  mapper and `SessionPlugin` from `@setu-ts/session-plugin`. One of `jwt`, `issuers`, `apiKey`,
  `session` or `strategies` is required; `local` alone cannot authenticate a later request.
- `rbac.roles` maps a name to `{ permissions, inherits }`. Without `rbac`, `requireRole`,
  `requirePermission`, `requireAnyRole` and `requireAllPermissions` answer `501`; a denial is `403`.
- Guards go on routes or handlers, never globally: `requireAuth()`, `publicRoute()`, `requireMfa()`
  and the RBAC four. `authMiddleware()` is already global at priority 300, so a handler reads
  `ctx.request.user`, an `IPrincipal` with `id`, `roles`, `permissions` and `claims`. A second write
  throws; use `replacePrincipal` for step-up.
- Login: `IAuthService.verifyCredentials` resolves an `IPrincipal`, then `IJwtService.sign` mints a
  token; resolve them with `CAPABILITIES.AUTH` and `CAPABILITIES.JWT`.
- `setu g guard orders` writes `src/guards/orders.guard.ts` wrapping `requirePermission`.
- Also shipped (see the README): refresh-token rotation, rate limiting, `definePolicy` policies,
  scoped RBAC, `issuers`, sign-in, passkeys, TOTP and SAML.
