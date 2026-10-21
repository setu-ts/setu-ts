# @setu-ts/http-security-plugin — CORS, headers, CSRF, request size and client IP

`setu add http-security` adds the dependency; REST scaffolds register `HttpSecurityPlugin()` with
the default header set. It adds middleware only — no capability token.

```ts
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createSecuredApp() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      HttpSecurityPlugin({
        cors: { origin: ['https://app.example.com'], credentials: true },
        headers: { contentSecurityPolicy: { defaultSrc: "'self'", scriptSrc: "'self'" } },
        csrf: { trustedOrigins: ['https://app.example.com'], customHeader: 'x-csrf-token' },
        requestSize: { maxBodySize: 1_048_576 },
        ipSecurity: { trustProxy: true, trustedProxies: ['10.0.0.0/8'] },
      }),
    ],
  });
  return app;
}
```

- Security headers are ON by default: nosniff, X-Frame-Options DENY, no-referrer, and HSTS for one
  year with subdomains. `headers: { enabled: false }` turns them off; each sub-field overrides one
  header, and `false` omits that header. CSP is absent by default.
- CORS is opt-in through `cors`. `origin` accepts true, false, a string, a list or a matcher; the
  default denies cross-origin. With `credentials: true` never reflect `origin: true`, which would
  admit every site. Omitted `allowedHeaders` echoes the preflight request headers.
- CSRF is opt-in through `csrf`. Unsafe methods are checked against the request origin plus
  `trustedOrigins`; `customHeader` requires a non-simple header, and `exclude` takes a `PathPattern`
  for protocol endpoints. Do not allow the literal null origin.
- `requestSize` is opt-in. `maxBodySize` defaults to 1 MiB and refuses a declared Content-Length
  with 413 before reading. Chunked bodies have no length, so pair it with `RuntimePlugin`'s
  `maxBodyBytes`.
- `ipSecurity` is opt-in. `trustProxy` reads `ipHeader` (default X-Forwarded-For). Behind an
  appending proxy set `trustedProxies` or `proxyHops`; they are mutually exclusive, and supplying
  both throws at construction.
- The standalone factories `corsMiddleware`, `securityHeadersMiddleware`, `csrfMiddleware`,
  `requestSizeMiddleware` and `ipSecurityMiddleware` apply one concern per route.
