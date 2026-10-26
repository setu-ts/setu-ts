# @setu-ts/http-security-plugin — browser and transport protections

**Add it:** `setu add http-security` adds it; register `HttpSecurityPlugin()` in `setu.config.ts`
for the default security headers. It provides middleware, with no capability token.

## Admit a browser frontend and check unsafe requests

Use this registration in `setu.config.ts`:

```ts
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';

export const security = HttpSecurityPlugin({
  cors: { origin: ['https://app.example.com'], credentials: true },
  csrf: { trustedOrigins: ['https://app.example.com'], customHeader: 'x-csrf-token' },
  headers: { contentSecurityPolicy: { defaultSrc: "'self'" } },
});
```

## Limit a route's declared request size

```ts
import type { IRouterApi } from '@setu-ts/common';
import { requestSizeMiddleware } from '@setu-ts/http-security-plugin';

export function registerImportRoutes(router: IRouterApi): void {
  router.post('/imports', {
    middleware: [requestSizeMiddleware({ maxBodySize: 1_048_576 })],
    handler: (ctx) => ctx.response.json({ accepted: true }),
  });
}
```

## Behaviour the types do not show

- Security headers are enabled by default: nosniff, frame denial, no-referrer and one year of strict
  transport security including subdomains. Content security policy is absent by default.
- Cross-origin handling is opt-in. With `credentials: true`, an unrestricted origin matcher admits
  every browser origin; use an explicit list.
- When `allowedHeaders` is omitted, preflight echoes the requested headers.
- CSRF checks unsafe methods against the request's own origin and `trustedOrigins`; `customHeader`
  additionally requires that header to be present with a non-empty value.
- The size limit is in bytes and defaults to 1048576. It checks the declared content length only:
  absent, negative and non-numeric lengths pass through; oversized declarations return 413.

## Other options

- `ipSecurity` configures proxy trust; `trustedProxies` and `proxyHops` are mutually exclusive.
- `headers: { enabled: false }` disables all headers; individual header options accept `false`.
- `corsMiddleware`, `csrfMiddleware`, `securityHeadersMiddleware` and `ipSecurityMiddleware` also
  support route-level wiring.
