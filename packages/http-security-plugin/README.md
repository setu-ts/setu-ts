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
npm install @setu-ts/http-security-plugin
# Deno: deno add npm:@setu-ts/http-security-plugin
```

## Usage

### Plugin Registration

```typescript
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { createApplication } from '@setu-ts/kernel';

const app = createApplication();

app.register(
  HttpSecurityPlugin({
    // CORS — opt-in via presence of `cors` block
    cors: {
      origin: 'https://example.com',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      // Omit `allowedHeaders` and an allowed origin's preflight echoes whatever
      // the browser asked for. List them here to allow only those.
      allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-csrf-token'],
      exposedHeaders: ['idempotent-replayed'],
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
  }),
);
```

A keyed SDK request carries a non-safelisted header, so the preflight must allow `idempotency-key`.
The page can read `Idempotent-Replayed` only when it is exposed through `exposedHeaders`.

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

The implicitly trusted own origins are the request URL origin, the public origin from
`requestOriginOf(ctx)`, and, only when the browser sends `Sec-Fetch-Site: same-origin`, the
validated leftmost `X-Forwarded-Proto`/`X-Forwarded-Host` candidate (falling back to the URL host).
Thus `csrf: {}` accepts same-origin browser mutations behind a standard TLS-terminating proxy
without extra configuration. The `Sec-Fetch-Site` gate is load-bearing: `X-Forwarded-*` are not
forbidden request headers, and the CORS middleware echoes requested headers by default, so without
it a script on any credentialed CORS origin could name its own host and pass. Browsers that do not
send `Sec-Fetch-Site` fall back to the URL and published origins. A request whose `Sec-Fetch-Site`
is present and anything but `same-origin` is checked against the URL origin and `trustedOrigins`
only: a browser cannot send the target's real public origin cross-site, and a trusted proxy that
passes a client's `X-Forwarded-Host` through would otherwise publish a host the attacker then
matches. This comparison grants no proxy trust to IP resolution, cookies or public URLs.

**`Origin: null` is accepted only with `Sec-Fetch-Site: same-origin`** (M119c, V10-1). Under this
plugin's default `Referrer-Policy: no-referrer`, a browser sends `Origin: null` on a same-origin
HTML form POST, so before 0.11.0 every such form answered 403 unless `referrerPolicy` was changed.
The browser also sends `Sec-Fetch-Site: same-origin`, which page script cannot set, so that pair is
accepted — the Fetch Metadata rule Go's `CrossOriginProtection` and Hono's `secFetchSite` use. A
`null` origin with any other `Sec-Fetch-Site` value, or without the header (older browsers), is
still refused: a sandboxed frame, a `data:` or `file:` page and a cross-site redirect all report
`cross-site`. `trustedOrigins: ['null']` is never implied. To refuse every `null` origin as before
0.11.0, set `csrf: { acceptNullOriginSameOrigin: false }` (and send a real origin with
`headers: { referrerPolicy: 'same-origin' }`).

| Option                        | Type            | Default | Description                                                                           |
| ----------------------------- | --------------- | ------- | ------------------------------------------------------------------------------------- |
| `enabled?`                    | `boolean`       | `true`  | Toggle CSRF                                                                           |
| `trustedOrigins?`             | `string[]`      | `[]`    | Additional trusted origins beyond self-origin                                         |
| `customHeader?`               | `string`        | —       | Required custom header for unsafe methods                                             |
| `exclude?`                    | `PathPattern[]` | `[]`    | Paths exempt from the CSRF check, checked before the method test                      |
| `acceptNullOriginSameOrigin?` | `boolean`       | `true`  | Accept `Origin: null` with `Sec-Fetch-Site: same-origin`; `false` refuses it (0.11.0) |

**`exclude` is for a protocol endpoint, not an application route.** An excluded path is checked
FIRST — before the method test — and is never inspected. Use it only where the endpoint's own
defences make the CSRF check redundant: the SAML ACS, whose signed assertion, single-use request and
browser-binding cookie are the check this middleware would otherwise add. Do not use it to bypass
CSRF for a form route.

`exclude` exists because an origin allowlist cannot admit an IdP that serves
`Referrer-Policy: no-referrer` (Keycloak does): the browser posts the ACS with `Origin: null`, and
`trustedOrigins: ['null']` admits every opaque-origin `POST` on every route. The documented SAML
recipe is `exclude: ['/auth/<provider>/acs']` here AND in the session plugin's form CSRF
(`CsrfFormOptions.exclude`); keep `trustedOrigins` for an IdP that sends a real origin.

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

| Option             | Type                           | Default           | Description                                                             |
| ------------------ | ------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| `enabled?`         | `boolean`                      | `true`            | Toggle IP resolution                                                    |
| `trustProxy?`      | `boolean`                      | `false`           | Read IP from proxy header                                               |
| `ipHeader?`        | `string`                       | `X-Forwarded-For` | Proxy header name                                                       |
| `forwardedHeader?` | `'x-forwarded' \| 'forwarded'` | `'x-forwarded'`   | Read exactly one header family; `'forwarded'` conflicts with `ipHeader` |
| `trustedProxies?`  | `readonly string[]`            | —                 | Proxy addresses or IPv4 CIDR blocks; resolves rightmost-untrusted       |
| `proxyHops?`       | `number`                       | —                 | The nth entry from the right, when proxies have no fixed address        |

`trustedProxies` and `proxyHops` are **mutually exclusive** — supplying both throws at middleware
construction. So does a `proxyHops` that is not a non-negative integer (`0` is the rightmost entry):
without that guard a negative, a fraction, or the `NaN` that `Number()` yields for an unset
environment variable resolves `undefined` for every caller, which silently degrades a rate limiter
keyed on the client IP to one shared bucket. A `trustedProxies` entry whose CIDR width is not plain
digits is refused the same way: `Number('')` is `0`, so `'10.0.0.1/'` would otherwise compile to a
`/0` matcher that trusts every IPv4 address. Omit the slash to compare an entry literally, which is
already how a bare address and an IPv6 CIDR are handled.

Node, Deno and Bun populate `IRequest.ip` with the **socket peer**, which behind a proxy is the
proxy. Without `trustProxy`, that peer is published as `CLIENT_IP_STATE_KEY`. With `trustedProxies`,
the peer is appended to the chain before walking right to left: a direct client cannot choose its
identity by forging `X-Forwarded-For`. Every published address is normalized: an IPv4-mapped peer or
hop such as `::ffff:10.1.2.3` (or its hexadecimal spelling `::ffff:a01:203`) becomes `10.1.2.3`, and
an IPv6 address is published in canonical lowercase compressed form (`2001:DB8:0::1` becomes
`2001:db8::1`). Native IPv6 proxies must be listed literally; a literal is normalized the same way
before comparison. IPv6 CIDR expansion is not supported. `proxyHops` and the leftmost default keep
their header-only selection and do not check the peer; prefer `trustedProxies` for stable proxy
addresses.

Every examined `X-Forwarded-For` or custom `ipHeader` entry must be an IP address. Numeric ports are
stripped from IPv4 and bracketed IPv6 entries; an unbracketed IPv6 entry never carries a port. An
invalid entry is a boundary: resolution stops with `CLIENT_IP_STATE_KEY` set to `undefined`, without
falling back to the socket peer, and the origin stays the URL origin.

`forwardedHeader: 'forwarded'` reads only RFC 7239 `Forwarded`, including quoted IPv6 addresses and
ports, and ignores every `X-Forwarded-*` header. The default reads `X-Forwarded-*` only. A malformed
`Forwarded` element is a **boundary**, not a void: the elements to its right were written by later
hops and are still read, while the trust walk stops at the boundary and never continues left of it,
so it cannot cross into client-written text. Everything left of the boundary is one unreadable
entry. An oversized field (over 8 KiB or 64 elements) is read from the right within those bounds
instead of voiding the field, so a trusted proxy that appends its element still resolves the client
behind a padded or malformed prefix. A trusted proxy that writes a comma inside a quoted value to
the right of malformed input loses that element to the boundary and resolves no client (fail
closed). A direct client stays identified by its own address, and a boundary with only trusted
entries to its right yields no client rather than the proxy's own address. Likewise in the default
family a `proxyHops` header too short for the declared chain, or a chain of only trusted proxies,
yields no client rather than the proxy's own address, and in `trustedProxies` mode so does a request
from a trusted proxy carrying no forwarding header (or an empty one) in either family. This
describes `CLIENT_IP_STATE_KEY` only: `defaultRateLimitKey` in `@setu-ts/auth-plugin` then falls
back to `IRequest.ip`, the socket peer, so such requests share the proxy's rate-limit bucket.
`unknown` and obfuscated `for` values stop the trust walk without a client.

IP security also publishes the public origin for `requestOriginOf(ctx)` and `publicRequestUrl(ctx)`
from `@setu-ts/common`. Forwarded origin components are believed only in `trustedProxies` mode, when
the request has a socket peer, that peer is trusted, and the selected client came from the forwarded
chain. Leftmost, `proxyHops` and custom-`ipHeader` modes without `trustedProxies`, and any request
with no peer (Workers, plain fetch), never publish a forwarded origin: nothing checked who wrote the
headers. In the default family the leftmost `X-Forwarded-Proto` and `X-Forwarded-Host` are used, so
the trusted proxy must overwrite both rather than pass a client's copy through (nginx forwards a
client's `X-Forwarded-Host` unless told otherwise); with `Forwarded`, `proto` and `host` come from
the selected client element. Only `http`/`https` protocols, and hosts that are DNS names (letters,
digits, inner hyphens, no trailing dot) or bracketed IPv6 literals with an optional numeric port
(the scheme default port is dropped), are accepted; rejected or absent components fall back to the
request URL. Session `secure: 'auto'` and React Router loaders share this decision.

Workers and plain `adapter.fetch()` calls have no socket peer. On Cloudflare Workers use
`ipSecurity: { trustProxy: true, ipHeader: 'CF-Connecting-IP' }`; Cloudflare overwrites that header.
It vouches for the client address only: the public origin there comes from the request URL, which
Workers already receives as the public one. Build security-sensitive links, such as password resets,
from a configured base URL.

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

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#httpsecurityplugin-setu-tshttp-security-plugin).
