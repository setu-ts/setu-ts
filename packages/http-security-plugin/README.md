# @setu-ts/http-security-plugin

HTTP transport security plugin for Setu-TS. Provides five independent, composable middleware
concerns: **CORS**, **security response headers**, **CSRF**, **request-size limiting**, and **IP
security**.

**Zero npm dependencies** — depends only on `@setu-ts/common` and `@setu-ts/kernel`.

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
  socket IP, publishing to `ctx.state.get(CLIENT_IP_STATE_KEY)`.

## Installation

```bash
deno add jsr:@setu-ts/http-security-plugin
```

## Usage

### Plugin Registration

```typescript
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { createApplication } from '@setu-ts/kernel';

const app = createApplication();

app.register(HttpSecurityPlugin({
  // CORS — opt-in via presence of `cors` block
  cors: {
    origin: 'https://example.com',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    // Omit `allowedHeaders` and an allowed origin's preflight echoes whatever
    // the browser asked for. List them here to allow only those.
    allowedHeaders: ['content-type', 'authorization'],
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
} from '@setu-ts/http-security-plugin';

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
| `allowedHeaders?` | `string[]`                            | echo the request     | Allowed headers for preflight     |
| `exposedHeaders?` | `string[]`                            | `[]`                 | Exposed response headers          |
| `maxAge?`         | `number`                              | —                    | Preflight cache max age (seconds) |

**`allowedHeaders` omitted vs `[]`.** Omitting it echoes the preflight's own
`Access-Control-Request-Headers` back and adds `Vary: Access-Control-Request-Headers`; an explicit
list allows only those headers, and an explicit `[]` allows none.

Echoing is the default because the alternative was incoherent: `methods` defaults to every standard
verb, so the preflight advertised `POST`/`PUT`/`PATCH`/`DELETE` and then refused `content-type` —
the one header a JSON body needs — and every browser blocked every JSON request. It does not widen
the security boundary: the ORIGIN allowlist is what decides, it is unchanged, and a caller reaching
this branch has already been admitted while asking for a header it is already sending. A denied
origin echoes nothing.

### CsrfOptions

| Option            | Type       | Default | Description                                   |
| ----------------- | ---------- | ------- | --------------------------------------------- |
| `enabled?`        | `boolean`  | `true`  | Toggle CSRF                                   |
| `trustedOrigins?` | `string[]` | `[]`    | Additional trusted origins beyond self-origin |
| `customHeader?`   | `string`   | —       | Required custom header for unsafe methods     |

### RequestSizeOptions

| Option         | Type      | Default     | Description                                     |
| -------------- | --------- | ----------- | ----------------------------------------------- |
| `enabled?`     | `boolean` | `true`      | Toggle size limiting                            |
| `maxBodySize?` | `number`  | `1_048_576` | Maximum **declared** body size in bytes (1 MiB) |

`maxBodySize` bounds a declared `Content-Length` and nothing else — a chunked request declares none,
and the body read happens inside the handler, after this middleware has returned. The bound no
client can disable lives where the body is consumed: `RuntimePlugin({ maxBodyBytes })`. Set both,
and set `maxBodyBytes` to the same value or higher. See "Bounding the request body" in
`PUBLIC_API.md`.

### IpSecurityOptions

| Option            | Type                | Default           | Description                                                       |
| ----------------- | ------------------- | ----------------- | ----------------------------------------------------------------- |
| `enabled?`        | `boolean`           | `true`            | Toggle IP resolution                                              |
| `trustProxy?`     | `boolean`           | `false`           | Read IP from proxy header                                         |
| `ipHeader?`       | `string`            | `X-Forwarded-For` | Proxy header name                                                 |
| `trustedProxies?` | `readonly string[]` | —                 | Proxy addresses or IPv4 CIDR blocks; resolves rightmost-untrusted |
| `proxyHops?`      | `number`            | —                 | The nth entry from the right, when proxies have no fixed address  |

`trustedProxies` and `proxyHops` are **mutually exclusive** — supplying both throws at middleware
construction. So does a `proxyHops` that is not a non-negative integer (`0` is the rightmost entry):
without that guard a negative, a fraction, or the `NaN` that `Number()` yields for an unset
environment variable resolves `undefined` for every caller, which silently degrades a rate limiter
keyed on the client IP to one shared bucket. A `trustedProxies` entry whose CIDR width is not plain
digits is refused the same way: `Number('')` is `0`, so `'10.0.0.1/'` would otherwise compile to a
`/0` matcher that trusts every IPv4 address. Omit the slash to compare an entry literally, which is
already how a bare address and an IPv6 CIDR are handled.

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

- **IP Security:** `trustProxy: true` on its own trusts the header's **leftmost** entry, which is
  safe only behind a proxy that OVERWRITES it. The standard nginx idiom
  (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) **appends**, so a request arriving
  with a forged `X-Forwarded-For: 7.7.7.7` reaches the application as `7.7.7.7, 198.51.100.9` and
  the leftmost entry is the value the caller chose — which is then what `defaultRateLimitKey` counts
  against. Behind an appending proxy, set `trustedProxies` (or `proxyHops`) so the client is
  resolved from the right.
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

## Exports

| Export                           | Kind      |
| -------------------------------- | --------- |
| `corsMiddleware`                 | function  |
| `csrfMiddleware`                 | function  |
| `HttpSecurityPlugin`             | function  |
| `ipSecurityMiddleware`           | function  |
| `requestSizeMiddleware`          | function  |
| `securityHeadersMiddleware`      | function  |
| `ContentSecurityPolicyOptions`   | interface |
| `CorsOptions`                    | interface |
| `CsrfOptions`                    | interface |
| `HttpSecurityPluginOptions`      | interface |
| `IpSecurityOptions`              | interface |
| `RequestSizeOptions`             | interface |
| `SecurityHeadersOptions`         | interface |
| `StrictTransportSecurityOptions` | interface |
| `CorsOriginMatcher`              | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#httpsecurityplugin-setu-tshttp-security-plugin).
