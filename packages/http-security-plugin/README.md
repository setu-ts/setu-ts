# @hono-enterprise/http-security-plugin

HTTP transport security plugin for Hono Enterprise. Provides five independent, composable middleware
concerns: **CORS**, **security response headers**, **CSRF**, **request-size limiting**, and **IP
security**.

**Zero npm dependencies** — depends only on `@hono-enterprise/common` and `@hono-enterprise/kernel`.

## Features

- **Security Headers** — ON by default with a secure baseline (X-Content-Type-Options,
  X-Frame-Options, Referrer-Policy, Strict-Transport-Security). Optional CSP and Permissions-Policy.
- **CORS** — Full origin matching (string, allowlist, boolean, function), preflight short-circuit
  (204), credentials support, and Vary header management.
- **CSRF** — Stateless Origin/Referer validation for unsafe HTTP methods. The request's own origin
  is always implicitly trusted. Optional custom-header requirement for defense-in-depth.
- **Request Size** — Enforces `Content-Length` against a configurable limit (default 1 MiB) with 413
  short-circuit before body reading.
- **IP Security** — Resolves client IP from proxy headers (when behind a trusted reverse proxy) or
  socket IP, publishing to `ctx.state.get('clientIp')`.

## Installation

```bash
deno add jsr:@hono-enterprise/http-security-plugin
```

## Usage

### Plugin Registration

```typescript
import { HttpSecurityPlugin } from '@hono-enterprise/http-security-plugin';
import { createApplication } from '@hono-enterprise/kernel';

const app = createApplication();

app.register(HttpSecurityPlugin({
  // CORS — opt-in via presence of `cors` block
  cors: {
    origin: 'https://example.com',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    maxAge: 86400,
  },
  // Security headers — ON by default; customize here
  headers: {
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true,
    },
  },
  // CSRF — opt-in
  csrf: {
    trustedOrigins: ['https://example.com'],
    customHeader: 'X-CSRF-Token',
  },
  // Request size — opt-in
  requestSize: {
    maxBodySize: 2_097_152, // 2 MiB
  },
  // IP security — opt-in
  ipSecurity: {
    trustProxy: true,
    ipHeader: 'X-Forwarded-For',
  },
}));
```

### Per-Route Middleware

Each middleware is also exported as a standalone factory for per-route use:

```typescript
import {
  corsMiddleware,
  csrfMiddleware,
  ipSecurityMiddleware,
  requestSizeMiddleware,
  securityHeadersMiddleware,
} from '@hono-enterprise/http-security-plugin';

app.router.post('/api/data', {
  middleware: [
    corsMiddleware({ origin: 'https://other.com' }),
    requestSizeMiddleware({ maxBodySize: 512_000 }),
  ],
  handler: (ctx) => ctx.response.json({ received: true }),
});
```

## Middleware Priorities

| Concern          | Priority | Description                                      |
| ---------------- | -------- | ------------------------------------------------ |
| IP Security      | 120      | Resolves client IP early for downstream stages   |
| Request Size     | 180      | Rejects oversized bodies before other processing |
| CORS             | 200      | Standard CORS handling + preflight short-circuit |
| Security Headers | 250      | Sets response headers before handler execution   |
| CSRF             | 270      | Validates CSRF after headers, before auth (300)  |

## Defaults

- **Security headers:** ON by default (even when `headers` option is omitted)
- **CORS / CSRF / Request-size / IP-security:** Opt-in (register only when the option block is
  present)
- Each opt-in concern defaults to `enabled: true` (so `{}` enables it, `{ enabled: false }`
  disables)
- CORS `origin` defaults to empty allowlist (deny all cross-origin) when enabled

## Options Reference

### HttpSecurityPluginOptions

| Option         | Type                     | Default | Description                    |
| -------------- | ------------------------ | ------- | ------------------------------ |
| `cors?`        | `CorsOptions`            | —       | Presence enables CORS          |
| `headers?`     | `SecurityHeadersOptions` | default | Omitted → defaults ON          |
| `csrf?`        | `CsrfOptions`            | —       | Presence enables CSRF          |
| `requestSize?` | `RequestSizeOptions`     | —       | Presence enables size limiting |
| `ipSecurity?`  | `IpSecurityOptions`      | —       | Presence enables IP resolution |

### CorsOptions

| Option            | Type                                  | Default              | Description                       |
| ----------------- | ------------------------------------- | -------------------- | --------------------------------- |
| `enabled?`        | `boolean`                             | `true`               | Toggle CORS                       |
| `origin?`         | `boolean \| string \| string[] \| fn` | `[]` (deny all)      | Origin matching configuration     |
| `credentials?`    | `boolean`                             | `false`              | Allow credentials                 |
| `methods?`        | `string[]`                            | all standard methods | Allowed methods for preflight     |
| `allowedHeaders?` | `string[]`                            | `[]`                 | Allowed headers for preflight     |
| `exposedHeaders?` | `string[]`                            | `[]`                 | Exposed response headers          |
| `maxAge?`         | `number`                              | —                    | Preflight cache max age (seconds) |

### CsrfOptions

| Option            | Type       | Default | Description                                   |
| ----------------- | ---------- | ------- | --------------------------------------------- |
| `enabled?`        | `boolean`  | `true`  | Toggle CSRF                                   |
| `trustedOrigins?` | `string[]` | `[]`    | Additional trusted origins beyond self-origin |
| `customHeader?`   | `string`   | —       | Required custom header for unsafe methods     |

### RequestSizeOptions

| Option         | Type      | Default     | Description                        |
| -------------- | --------- | ----------- | ---------------------------------- |
| `enabled?`     | `boolean` | `true`      | Toggle size limiting               |
| `maxBodySize?` | `number`  | `1_048_576` | Maximum body size in bytes (1 MiB) |

### IpSecurityOptions

| Option        | Type      | Default           | Description                                    |
| ------------- | --------- | ----------------- | ---------------------------------------------- |
| `enabled?`    | `boolean` | `true`            | Toggle IP resolution                           |
| `trustProxy?` | `boolean` | `false`           | Read IP from proxy header (trusted proxy only) |
| `ipHeader?`   | `string`  | `X-Forwarded-For` | Proxy header name                              |

### SecurityHeadersOptions

| Option                     | Type                                      | Default                               | Description                    |
| -------------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------ |
| `enabled?`                 | `boolean`                                 | `true`                                | Toggle all security headers    |
| `contentSecurityPolicy?`   | `ContentSecurityPolicyOptions \| false`   | — (none)                              | CSP configuration (no default) |
| `strictTransportSecurity?` | `StrictTransportSecurityOptions \| false` | `max-age=31536000; includeSubDomains` | HSTS configuration             |
| `xFrameOptions?`           | `string \| false`                         | `DENY`                                | X-Frame-Options value          |
| `xContentTypeOptions?`     | `string \| false`                         | `nosniff`                             | X-Content-Type-Options value   |
| `referrerPolicy?`          | `string \| false`                         | `no-referrer`                         | Referrer-Policy value          |
| `permissionsPolicy?`       | `string \| false`                         | — (none)                              | Permissions-Policy value       |

## Security Considerations

- **IP Security:** `trustProxy: true` should only be enabled behind a trusted reverse proxy that
  validates the proxy header. An untrusted client can forge `X-Forwarded-For`.
- **CSRF:** The stateless Origin/Referer check is the OWASP-recommended stateless CSRF defense.
  Non-browser clients (which send neither header) pass through by design. Use `customHeader` for
  defense-in-depth on API-style clients.
- **Security Headers:** Use `headers: { enabled: false }` to disable the entire set, or per-header
  `false` to omit individual headers that conflict with your existing configuration.

## No Capability Token

This plugin is middleware-only — it registers no service and no capability token. Each middleware is
added to the global pipeline via `ctx.middleware.add(...)` and is also available as a standalone
factory for per-route use. This follows the same pattern as `rateLimitMiddleware` from the
auth-plugin.
