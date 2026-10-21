# @setu-ts/session-plugin — cookie-backed sessions and form CSRF

The full-stack scaffold registers `SessionPlugin`; elsewhere `setu add session` adds the dependency
and prints the `SessionPlugin(...)` line for `setu.config.ts`. Provides `CAPABILITIES.SESSION`.

```ts
import { getSession, SessionPlugin } from '@setu-ts/session-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createSessionApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), SessionPlugin({ secret: 'replace-with-a-32-plus-character-secret' })],
  });
  app.router.post('/login', (ctx) => {
    const session = getSession(ctx);
    session.set('userId', 'u-1');
    session.regenerate();
    return ctx.response.json({ ok: true });
  });
  return app;
}
```

- The default cookie strategy encrypts the payload (AES-256-GCM through `runtime.subtle`).
  `mode: 'sign'` only signs a readable payload, so pair it with a store. `store: 'memory'`,
  `store: 'cache'` or an `ISessionStore` keeps the payload server-side and makes immediate
  revocation possible.
- `secret` accepts a list for rotation: index 0 seals new cookies and every entry can open. Omitted,
  it resolves `secretName` (default SESSION_SECRET) from `CAPABILITIES.SECRETS`, then the
  environment; a secret under 32 characters throws `SessionSecretMissingError` at registration.
- Read and write through `getSession(ctx)`, an `ISession` with `get`, `set`, `has`, `delete`,
  `clear` and `destroy`. Never write `Set-Cookie` yourself: the middleware commits only when the
  session changed. Call `regenerate` after any privilege change, above all login.
- `maxAge` defaults to `7200` seconds, enforced from a stamp inside the payload. `rolling: true`
  re-issues on every response, and `idleTimeoutMs` expires a session with no requests.
- `cookie` defaults to `name: 'setu_session'`, `httpOnly: true`, `secure: true`, `sameSite: 'lax'`.
  `secure: 'auto'` follows the trusted request protocol and conflicts with `sameSite: 'none'`.
- `csrf: {}` enables synchronizer-token form CSRF (field `_csrf`, header `x-csrf-token`, safe
  methods skipped). Read the token with `getCsrfToken` or render the field with `csrfTokenField`. It
  complements, not replaces, `http-security-plugin`'s Origin check.
- `tenantBinding` defaults to `true`: the first resolved tenant is sealed, and a later mismatch is
  `403`. `store: 'cache'` shares `CAPABILITIES.CACHE`, so a `cache.clear()` logs everyone out.
