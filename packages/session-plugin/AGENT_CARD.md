# @setu-ts/session-plugin — cookie sessions and form CSRF

**Add it:** `setu add session` prints the registration for `setu.config.ts`; use
`SessionPlugin({ csrf: {} })`. It provides `CAPABILITIES.SESSION` (`ISessionService`).

## Save and read a shopping cart

```ts
import type { IRouterApi } from '@setu-ts/common';
import { getSession } from '@setu-ts/session-plugin';

export function registerCartRoutes(router: IRouterApi): void {
  router.post('/cart', {
    handler: (ctx) => {
      getSession(ctx).set('cartId', 'cart-1');
      return ctx.response.json({ ok: true });
    },
  });
  router.get('/cart', {
    handler: (ctx) => ctx.response.json({ cartId: getSession(ctx).get<string>('cartId') ?? null }),
  });
}
```

## Render a form that passes CSRF verification

```ts
import type { IRouterApi } from '@setu-ts/common';
import { csrfTokenField } from '@setu-ts/session-plugin';

export function registerCartFormRoutes(router: IRouterApi): void {
  router.get('/cart/form', {
    handler: (ctx) => ctx.response.html(
      `<form method="post" action="/cart">${csrfTokenField(ctx)}<button>Save</button></form>`,
    ),
  });
}
```

## Behaviour the types do not show

- Cookies encrypt by default; `mode: 'sign'` exposes payloads. `maxAge`: 7200 seconds; optional
  `idleTimeoutMs`: milliseconds. Defaults: secure, httpOnly, sameSite lax; local HTTP needs
  `cookie: { secure: false }`.
- Missing keys return `undefined`. Nested mutations need another `set`.
- `csrf: {}` checks unsafe methods: `_csrf` field or `x-csrf-token` header. The helper follows
  config.
- `csrf.exemptBearer` defaults true: authenticated header credentials with a new session skip CSRF
  and commit no cookie, even on excluded paths. Restored sessions/non-Bearer Authorization prevent
  exemption. Bearer/API-key-to-cookie exchanges need false; see README.
- Secrets: option → secrets manager → config → environment; ≥32 characters. Arrays rotate keys
  (index 0 seals).

## Other options

- `store: 'memory'`, `'cache'` or an `ISessionStore` enables server-side payload storage.
- `regenerate` rotates the session id and clears the form-CSRF token; fetch a fresh token after
  sign-in or MFA promotion. Other data, including the tenant binding, stays. `destroy` logs out.
- `rolling` renews expiry; `tenantBinding` defaults to true and refuses a tenant mismatch with 403.
- Signed-in, cookie-setting and token-reading responses are marked private, no-store unless the
  handler sets public (cookie-setting: always); then a form fails CSRF.
