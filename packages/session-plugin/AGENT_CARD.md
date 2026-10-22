# @setu-ts/session-plugin — cookie sessions and form CSRF

**Add it:** `setu add session` prints the registration for `setu.config.ts`; use
`SessionPlugin({ secret: process.env.SESSION_SECRET!, csrf: {} })`. It provides
`CAPABILITIES.SESSION` (`ISessionService`).

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

- The default cookie encrypts the payload. `mode: 'sign'` leaves it readable.
- `maxAge` defaults to 7200 seconds; `idleTimeoutMs` uses milliseconds and is omitted by default.
- Cookies default to `secure: true`, `httpOnly: true`, `sameSite: 'lax'`; plain HTTP development
  needs `cookie: { secure: false }`.
- Missing session keys return `undefined`. Nested mutations need another `set` to mark a change.
- `csrf: {}` enables verification: the default field is `_csrf`, the header is `x-csrf-token`, and
  safe methods are skipped. The helper follows the configured field name.
- Secrets need at least 32 characters; an array rotates secrets, with index 0 sealing new cookies.

## Other options

- `store: 'memory'`, `'cache'` or an `ISessionStore` enables server-side payload storage.
- `regenerate` rotates the session id after a privilege change; `destroy` logs the session out.
- `rolling` renews expiry; `tenantBinding` defaults to true and refuses a tenant mismatch with 403.
