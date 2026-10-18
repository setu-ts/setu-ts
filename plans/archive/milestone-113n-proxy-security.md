# Milestone 113n — Security Behind a Reverse Proxy (`@setu-ts/http-security-plugin`, `@setu-ts/runtime`, `@setu-ts/common`, `@setu-ts/kernel`, `@setu-ts/session-plugin`, `@setu-ts/react-router-plugin`)

> **Status:** Planning. Branch: `feat/m113n-proxy-security`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two findings from the `v0.9.0` smoke run (X41) share one cause: the framework does not know where a
request came from. Behind a TLS-terminating proxy, `csrfMiddleware` compares the browser's
`Origin: https://…` with an own origin derived from `ctx.request.url`, which reads `http://…`, so
`csrf: {}` refuses every same-origin browser mutation (V9-65, High). And `trustedProxies` walks the
forwarded chain without ever checking the socket peer, because no first-party adapter sets
`IRequest.ip` — so a client that reaches the origin directly writes its own `X-Forwarded-For` and
chooses its own identity (V9-66, the half of X32-3 that M90a left).

This milestone makes the three socket-serving adapters report the peer address, makes
`trustedProxies` require that peer to be a trusted proxy before any forwarded entry is believed, and
resolves ONE trusted public origin per request (protocol and host) from `X-Forwarded-*` or RFC 7239
`Forwarded`. Four consumers read that one decision: the CSRF own-origin, a session cookie
`secure: 'auto'` mode, the React Router request bridge, and a public accessor applications use to
build absolute URLs. The forwarded-header and cookie/redirect work was originally deferred as
unowned; the maintainer placed it in this milestone (2026-10-19).

- **In scope:** `IRequest.ip` from the socket peer on Node, Deno and Bun, IPv4-mapped IPv6
  normalized; the peer appended to the `trustedProxies` walk; RFC 7239 `Forwarded` parsing as an
  alternative to `X-Forwarded-*`; a trusted request origin published by `ipSecurityMiddleware` and
  read through one `common` accessor; the CSRF own-origin (trusted origin plus the zero-config
  `X-Forwarded-Proto` candidate); `SessionPlugin` `cookie.secure: 'auto'`; the React Router bridge
  building its web `Request` from the public URL; `InjectRequest.ip`; README, `PUBLIC_API.md`,
  `docs/deployment.md`, CHANGELOG and upgrading-guide text.
- **NOT this milestone:** a peer address on Cloudflare Workers (the platform has no socket peer,
  §3.2); changing `proxyHops` or leftmost semantics for the client IP (§3.4); expanding IPv6 CIDR in
  `trustedProxies` (released floor, §8).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRequest.ip`                     | `packages/common/src/http.ts:46`                                                                                          | `readonly ip?: string` — "Client IP address, when derivable." Already declared.                                                                                                                                                                          |
| `mapWebRequestToFrameworkRequest` | `packages/runtime/src/adapters/shared/fetch-mapping.ts:385`                                                               | `(request: Request, maxBodyBytes?: number) => IRequest`; builds a `FrameworkRequest` with NO `ip`.                                                                                                                                                       |
| `FrameworkRequest`                | `packages/runtime/src/adapters/shared/fetch-mapping.ts:78-96`                                                             | Class with one shared prototype (M87 hidden-class rule in its JSDoc); constructor `(raw, method, url, path, maxBodyBytes?)`; no `ip` member.                                                                                                             |
| `sealRequestIdentity`             | `packages/common/src/request-identity.ts:147-169`; `packages/kernel/src/context/request-context.ts:161`                   | Defines `user`/`tenant`/`locale` accessors ON the same request object; it does not copy or rewrap it, so an `ip` field on `FrameworkRequest` survives to `ctx.request`.                                                                                  |
| Node fetch env                    | `@hono/node-server@2.1.4` `dist/index.mjs:1045-1047`; `packages/runtime/src/adapters/node/node-http-adapter.ts:70-73,378` | node-server calls `fetchCallback(req, { incoming, outgoing })`. The adapter's `NodeFetchEnv` declares only `outgoing`. `incoming.socket.remoteAddress` is the peer (node-server's own `conninfo.mjs` reads exactly that).                                |
| Node upgrade path                 | `node-http-adapter.ts:300-308`                                                                                            | `#handleUpgrade(incoming, socket, head)` maps through the same function; `incoming.socket.remoteAddress` is available there too.                                                                                                                         |
| Deno serve                        | `deno-http-adapter.ts:48-60,93-104,182-184,291`                                                                           | Published `DenoServeHost.serve` types `fetch` as `(request: Request) => …`; `Deno.serve(options, options.fetch)` drops Deno's second `info` argument.                                                                                                    |
| Bun serve                         | `bun-http-adapter.ts:53-60,205,316`                                                                                       | Serve callback receives `(request, server: BunServer)`; `BunServer` declares `stop`, `upgrade?` — no `requestIP`. All three host types are barrel-exported (`runtime/src/index.ts:113,116,119`).                                                         |
| Workers                           | `cf-http-adapter.ts:84`                                                                                                   | Maps from `fetch(request)` only — no socket and no peer.                                                                                                                                                                                                 |
| Peer formats (measured)           | probe, Deno 2.9.6 / Bun 1.4.2 / Node 24 + node-server 2.1.4                                                               | IPv4 listener: `127.0.0.1` on all three. Dual-stack `::` listener: `::ffff:127.0.0.1` on ALL three (Deno `info.remoteAddr.hostname`, Bun `server.requestIP(r).address`, Node `socket.remoteAddress`).                                                    |
| `exactOptionalPropertyTypes`      | probe against `tsconfig.base.json` settings                                                                               | A getter or field typed `string \| undefined` does NOT implement `readonly ip?: string` (TS2420/TS2375). A field declared `readonly ip?: string` and assigned only when defined does, and with `target: es2024` it is an own property on every instance. |
| `ipSecurityMiddleware`            | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:224-246,268-304`                                  | Header read only when `trustProxy`; `resolveForwardedIp` walks the header alone; falls back to `ctx.request.ip`; `compileTrustedProxy` expands IPv4 CIDR only. Registered at priority 120 (`http-security-plugin.ts:26`).                                |
| `csrfMiddleware`                  | `packages/http-security-plugin/src/middleware/csrf-middleware.ts:95-122,164-171`                                          | Own origin = `getRequestOrigin(ctx.request.url)` only; then `trustedOrigins`; absent Origin AND Referer passes. Priority 270.                                                                                                                            |
| Session cookie                    | `packages/session-plugin/src/options.ts:49,235`; `services/session-service.ts:198,207,265,381-389`                        | `cookie.secure?: boolean`, default `true`; `#cookie(value, maxAge)` has no context, but both callers sit inside `commit(ctx)`. Session middleware priority 260 (`session-plugin.ts:31`).                                                                 |
| `serializeCookie`                 | `packages/common/src/cookie.ts:130-133`                                                                                   | Emits `Secure` when `secure === true`, and also when `sameSite === 'none'`.                                                                                                                                                                              |
| React Router bridge               | `packages/react-router-plugin/src/handler/request-bridge.ts:48`                                                           | `new Request(ctx.request.url, …)` — loaders see the internal `http://` URL behind a proxy.                                                                                                                                                               |
| Absolute URLs elsewhere           | `auth-plugin/src/interfaces/index.ts:414,667`; `saml/engine.ts:101`                                                       | Sign-in `redirectUri`, SAML `acsUrl` and passkey `origins` are configured explicitly; nothing in auth builds an absolute URL from the request. No change there.                                                                                          |
| `defaultRateLimitKey`             | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:202-216`                                                    | principal → `CLIENT_IP_STATE_KEY` → `ctx.request.ip` → `'anonymous'`. Populating `ip` changes the key with no auth-plugin code change.                                                                                                                   |
| State-key grammar                 | `packages/common/src/state-keys.ts:50`                                                                                    | `CLIENT_IP_STATE_KEY = 'http-security-plugin:client-ip'` — the `<owner-package>:<kebab-key>` precedent the new key follows (M71 gate).                                                                                                                   |
| `InjectRequest`                   | `packages/kernel/src/application/application.ts:125-158,921`                                                              | `{ method, url, headers?, body? }` — no `ip`.                                                                                                                                                                                                            |
| Real-runtime test lanes           | `packages/runtime/test/integration/read-stream-real.test.ts:120`                                                          | Real-Deno cases are gated `skip: typeof Deno === 'undefined'` and run in the Deno lane; there is NO Bun lane in CI.                                                                                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                      | Resolution (picked side)                                   | Doc deliverable (same PR)                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `ip-security-middleware.ts:4-12` module doc: "`trustProxy` is the only working source since M23 … the `request.ip` fallback below is vestigial" — false once adapters populate `IRequest.ip`. | Code wins: the fallback becomes the peer on Node/Deno/Bun. | Rewrite the module note and the `trustProxy` JSDoc "with `false`, `clientIp` is `undefined`" sentence.                                          |
| C2  | `CsrfOptions.trustedOrigins` JSDoc: "The request's own origin (derived from `request.url`) is always implicitly trusted" — incomplete after §3.7.                                             | Code wins.                                                 | JSDoc, http-security README CSRF section, `PUBLIC_API.md` CSRF row.                                                                             |
| C3  | `packages/auth-plugin/README.md` rate-limit paragraph implies an unauthenticated caller usually lands in `'anonymous'`; on a socket adapter it now lands in `ip:<peer>`.                      | Code wins.                                                 | One sentence naming which adapters populate `IRequest.ip`; the `assert:js` table is unchanged (pure).                                           |
| C4  | `docs/deployment.md` has no reverse-proxy section; X41 found the CSRF behaviour undocumented.                                                                                                 | Add one.                                                   | `## Behind a reverse proxy`: peer check, `trustedProxies`, `forwardedHeader`, CSRF, `secure: 'auto'`, the bridge, Workers note.                 |
| C5  | `IRequest.ip` JSDoc says "Client IP address"; on first-party adapters it is now the socket peer, which behind a proxy is the proxy.                                                           | Code wins.                                                 | JSDoc in `common/src/http.ts` and the `PUBLIC_API.md` `IRequest` row say "the socket peer; the client behind a proxy is `CLIENT_IP_STATE_KEY`". |

## 3. Design decisions

### 3.1 Where the peer address comes from

- **Decision:** `mapWebRequestToFrameworkRequest` gains an optional third parameter
  `peerAddress?: string`. `FrameworkRequest` declares `readonly ip?: string` and assigns it in the
  constructor only when the normalized value is defined. Each adapter passes its runtime's peer:
  - Node: widen the internal `NodeFetchEnv` with
    `incoming?: { socket?: { remoteAddress?: string | undefined } }` (Node declares
    `remoteAddress: string | undefined`, so the facade must admit `undefined` under
    `exactOptionalPropertyTypes`) and read `env?.incoming?.socket?.remoteAddress` in
    `createFetchHandler`; the upgrade path reads `incoming.socket.remoteAddress`. The published
    `NodeServeHost.serve` `fetch` env type gains the same optional member (additive).
  - Deno: the published `DenoServeHost.serve` `fetch` type widens to
    `(request: Request, info?: { remoteAddr?: { hostname?: string } }) => …`; the adapter reads
    `info?.remoteAddr?.hostname`. A host calling `fetch(request)` alone still compiles.
  - Bun: `BunServer` gains optional `requestIP?(request: Request): { address: string } | null`; the
    serve callback reads `server.requestIP?.(request)?.address`. The plain `fetch()` entry
    (`createFetchHandler`, no server) passes none.
  - Workers and the local diagnostics listener pass none.
- **Why:** `IRequest.ip` is already declared, and each read is a property the runtime already holds.
  A getter typed `string | undefined` was the first design and fails `exactOptionalPropertyTypes`
  (measured, §1). The declared optional field is an own property on every instance under `es2024`
  class-field semantics, so requests keep one shape (the M87 rule) whether or not a peer is known.
- **Test home:** `fetch-mapping.test.ts` (`ip` present/absent, `Object.getPrototypeOf` equal across
  both, `'ip' in request` true for both), each adapter's unit test with a fake host passing a peer,
  and `peer-address-real.test.ts` (§6).

### 3.2 Peer normalization and Workers

- **Decision:** one internal `normalizePeerAddress(address)` in `fetch-mapping.ts` strips an
  `::ffff:` prefix (case-insensitive) when the remainder is a dotted-quad IPv4 address, returns
  every other value unchanged, and maps `''` to `undefined`. Workers sets no `ip`: the only peer
  there is Cloudflare's edge, so the documented answer is
  `ipSecurity: { trustProxy: true, ipHeader: 'CF-Connecting-IP' }`, which Cloudflare overwrites.
- **Why:** all three runtimes report `::ffff:127.0.0.1` on a dual-stack listener (measured, §1), and
  `compileTrustedProxy` expands only dotted IPv4 CIDR — without normalization `10.0.0.0/8` never
  matches a mapped peer and every request would be treated as direct.
- **Test home:** `fetch-mapping.test.ts` table: `::ffff:10.1.2.3` → `10.1.2.3`, `::FFFF:10.1.2.3` →
  `10.1.2.3`, `::ffff:abcd` unchanged, `2001:db8::1` unchanged, `''` → `undefined`.

### 3.3 The peer joins the `trustedProxies` walk

- **Decision:** when `trustedProxies` is set and `ctx.request.ip` is defined, the chain walked right
  to left is `[...headerEntries, ctx.request.ip]`. An untrusted peer is the client and every header
  entry is ignored; a trusted peer is skipped and the walk continues as today. With `trustProxy` on
  and the header absent, the result is the peer. With `ctx.request.ip` undefined (Workers, a custom
  adapter, `inject()` without `ip`) the walk is header-only, exactly as released.
- **Why:** the standard algorithm (Express `trust proxy` starts from the socket address); appending
  the peer reuses the existing walk, so there is one implementation, and the header-only path
  preserves Workers and every custom adapter.
- **Test home:** `ip-security-proxy.test.ts` (direct client forging `X-Forwarded-For` resolves to
  its own peer; trusted peer resolves from the header; mapped and unmapped peer forms; no-peer path
  unchanged) and the integration test through `app.inject({ ip })`.

### 3.4 `proxyHops` and leftmost resolution of the client IP stay as released

- **Decision:** neither consults the peer when choosing the client IP. Their JSDoc says so and
  recommends `trustedProxies` when the proxies have stable addresses.
- **Why:** `proxyHops` exists for proxies with no stable address, so there is nothing to check the
  peer against; counting the peer as a hop would silently move every existing deployment's resolved
  client by one entry.
- **Test home:** `ip-security-proxy.test.ts` asserts both results are identical with and without a
  peer.

### 3.5 RFC 7239 `Forwarded` as an alternative header family

- **Decision:** `IpSecurityOptions.forwardedHeader?: 'x-forwarded' | 'forwarded'`, default
  `'x-forwarded'` (released behaviour). With `'forwarded'` the middleware reads only the `Forwarded`
  header and ignores every `X-Forwarded-*` header; supplying `ipHeader` beside it throws at
  construction, because the two name different sources. One internal, pure `parseForwarded(value)`
  implements RFC 7239 §4: comma-separated elements, `;`-separated `name=value` pairs, names
  case-insensitive, `token` or `quoted-string` values with `\` escapes, IPv6 `for` values in
  brackets with an optional port (`"[2001:db8::1]:4711"`), IPv4 with an optional port. A `for` value
  of `unknown` or an obfuscated identifier (`_…`) is a hop that can never match `trustedProxies` and
  is never returned as a client IP; a header that fails to parse contributes NO hops and no
  forwarded origin, and the walk then runs over the peer alone — an untrusted peer is the client, a
  trusted one yields `undefined` (corrected in review: "ends the walk with no client" let a direct
  client erase its own identity by sending garbage). The `for` values feed the existing walk (§3.3)
  in place of the `X-Forwarded-For` entries, with ports stripped. Input is bounded: a header over 8
  KiB or with more than 64 elements is treated as malformed.
- **Why:** one header family per deployment, chosen by the operator, keeps the trust surface to the
  header the proxy actually writes; merging both families would let a client supply whichever one
  the proxy does not overwrite.
- **Test home:** `forwarded-header.test.ts` (parser table: quoted strings, escapes, IPv6 with port,
  case-insensitive names, `unknown`, `_obf`, oversized and malformed input) and
  `ip-security-proxy.test.ts` (the walk over `Forwarded`, the `ipHeader` conflict refusal).

### 3.6 One trusted request origin, published once

- **Decision:** `ipSecurityMiddleware` resolves a request origin `{ protocol, host }` and publishes
  it under a new `REQUEST_ORIGIN_STATE_KEY = 'http-security-plugin:request-origin'` in `common`.
  Forwarded values are believed exactly when the resolved client IP came from the forwarded chain
  (`trustProxy` on, and under `trustedProxies` the walk got past the peer); otherwise the origin is
  the one in `ctx.request.url`.
  - With `'x-forwarded'`: protocol from the leftmost `X-Forwarded-Proto` entry, host from the
    leftmost `X-Forwarded-Host` entry, each falling back to `ctx.request.url` when absent.
  - With `'forwarded'`: `proto` and `host` from the element whose `for` was selected as the client,
    the element the client-facing proxy wrote.
  - Protocol is accepted only as `http` or `https` (case-insensitive); host must survive
    `new URL('http://' + host)` with `host` equal to the input lowercased and no path, user info,
    query or fragment. A rejected value falls back to `ctx.request.url`, never to a guess.
  - `common` gains
    `requestOriginOf(ctx): { protocol: 'http' | 'https'; host: string; origin: string }`, returning
    the published value or one derived from `ctx.request.url`, and `publicRequestUrl(ctx): string`,
    the request URL with that origin substituted.
- **Why:** the four consumers below must agree, so the trust decision has one owner and is computed
  once per request at priority 120, before session (260), CSRF (270) and the route handler. The
  accessor lives in `common` because `session-plugin` and `react-router-plugin` may not import
  `http-security-plugin` (§2.2; the `CLIENT_IP_STATE_KEY` precedent). Absent the middleware, every
  consumer behaves exactly as today.
- **Test home:** `request-origin.test.ts` in `common` (fallback derivation, published value wins,
  `publicRequestUrl` keeps path and query) and `ip-security-proxy.test.ts` (each believe/refuse
  case, including an untrusted peer forging `X-Forwarded-Proto` and a host carrying a path).

### 3.7 CSRF own origin behind a proxy

- **Decision:** the implicitly trusted own origins are three: the origin of `ctx.request.url`
  (unchanged), `requestOriginOf(ctx).origin`, and — with no configuration — `<proto>://<host>` from
  the leftmost `X-Forwarded-Proto` and `X-Forwarded-Host` (else the URL host), validated as in §3.6.
- **Why:** the third candidate is what makes `csrf: {}` work behind a standard proxy with no
  configuration. Believing it without a peer check is safe for this purpose specifically: a CSRF
  request is sent by the victim's browser, and a cross-site page cannot add `X-Forwarded-*` to it —
  a form cannot set headers and a script-set non-safelisted header forces a preflight. A client that
  CAN set them is not a CSRF attacker; it can set `Origin` too. The second candidate adds the
  `Forwarded` family and trusted-host cases. An explicit `publicOrigin` option was rejected because
  it would duplicate `trustedOrigins`.
- **Test home:** `csrf-middleware.test.ts` (https browser origin + `X-Forwarded-Proto: https`
  passes; `X-Forwarded-Host` used; published origin passes; `ftp`/empty/garbage proto ignored; a
  cross-site origin still refused while forwarded headers are present) and the integration test.

### 3.8 Session cookie `secure: 'auto'`

- **Decision:** `SessionCookieOptions.secure` widens to `boolean | 'auto'`; the default stays
  `true`. With `'auto'`, `Secure` is set when `requestOriginOf(ctx).protocol === 'https'`. `#cookie`
  gains the context argument from `commit(ctx)`. `'auto'` with `sameSite: 'none'` throws at
  construction, because `serializeCookie` forces `Secure` there anyway, making `'auto'` a setting
  that does nothing.
- **Why:** this is express-session's `cookie.secure: 'auto'`, which relies on the same trusted-proxy
  decision. It serves a deployment reachable both over local http and through an https proxy; the
  secure default is unchanged (AI_GUIDELINES §13.4).
- **Test home:** `session-cookie-secure.test.ts` (https published origin → `Secure`; http → absent;
  no ip-security middleware → derived from the URL; the `sameSite: 'none'` refusal).

### 3.9 The React Router bridge uses the public URL

- **Decision:** `request-bridge.ts` builds the web `Request` from `publicRequestUrl(ctx)`.
- **Why:** loaders and actions read `request.url` to build redirects and absolute links; behind a
  proxy they currently see `http://internal…`. With no ip-security middleware the URL is unchanged.
- **Test home:** `request-bridge.test.ts` (extend): a published `https` origin reaches the loader's
  `request.url`; without it the URL is `ctx.request.url` byte for byte.

### 3.10 `inject()` can carry a peer

- **Decision:** `InjectRequest` gains `ip?: string`, copied onto the injected `IRequest` when
  present.
- **Why:** without it the peer check is untestable through the public test entry point, and
  applications testing their own proxy configuration need it.
- **Test home:** `inject-ip.test.ts` in the kernel, and the http-security integration test.

### 3.11 Behaviour change and versioning

- **Decision:** a breaking behaviour change shipping in `0.10.0`: `CLIENT_IP_STATE_KEY` and
  `defaultRateLimitKey` now see a peer on Node, Deno and Bun, so unauthenticated callers move from
  one `'anonymous'` bucket to one bucket per peer address; under `trustedProxies` a direct client's
  forged header is ignored; with ip-security configured and a trusted proxy in front, React Router
  loaders see the public URL. CHANGELOG `Changed` entries and a `docs/upgrading.md` entry under
  `## Unreleased`.
- **Why:** released behaviour changes without a configuration change.
- **Test home:** `peer-rate-limit-key.test.ts` (real Node adapter, ephemeral port, key
  `ip:127.0.0.1`).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none at the type level (every addition is optional or a widening);
the behaviour changes in §3.11 ship in minor `0.10.0`.

| Exported symbol                       | Kind                     | Consumer / real code path that READS it                                             |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `REQUEST_ORIGIN_STATE_KEY` (`common`) | const                    | written by `ipSecurityMiddleware`; read by `requestOriginOf`                        |
| `requestOriginOf` (`common`)          | function                 | `csrfMiddleware`, session `commit`, `publicRequestUrl`; applications building links |
| `publicRequestUrl` (`common`)         | function                 | React Router `request-bridge.ts`; applications building absolute URLs               |
| `RequestOrigin` (`common`)            | type                     | return type of `requestOriginOf`                                                    |
| `NodeServeHost` (`fetch` env type)    | interface (widened)      | `NodeHttpAdapter.listen` passes the callback that reads `incoming`                  |
| `DenoServeHost` (`fetch` type)        | interface (widened)      | `DenoHttpAdapter.listen` passes the callback that reads `info`                      |
| `BunServer.requestIP?`                | interface member (added) | `BunHttpAdapter` serve callback                                                     |
| `InjectRequest.ip?`                   | interface member (added) | `Application.inject`; integration and application tests                             |

`normalizePeerAddress`, `parseForwarded` and the origin validator are internal (not
barrel-exported). The `http-security-plugin`, `common` and `runtime` barrels gain or keep exactly
the rows above, asserted by each package's `barrel-exports.test.ts`.

### 4.1 Options — every option names its consumer

| Option                                         | Consumer                          | Behavior (per implementation)                                                                                                    |
| ---------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `IpSecurityOptions.forwardedHeader`            | `ipSecurityMiddleware` (§3.5–3.6) | `'x-forwarded'` (default) reads `X-Forwarded-*`; `'forwarded'` reads only RFC 7239 `Forwarded`; conflict with `ipHeader` throws. |
| `SessionCookieOptions.secure` (`'auto'` added) | `SessionService.#cookie` (§3.8)   | `true` (default) / `false` unchanged; `'auto'` follows `requestOriginOf(ctx).protocol`.                                          |

## 5. Implementation files

| File                                                                                                                              | Purpose                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`                                                                           | `peerAddress` parameter, `ip` field, `normalizePeerAddress`                        |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`                                                                         | read `incoming.socket.remoteAddress` on fetch and upgrade paths                    |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`                                                                         | accept Deno's `info` argument                                                      |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`                                                                           | `requestIP` on `BunServer`; read it in the serve callback                          |
| `packages/common/src/request-origin.ts` (new)                                                                                     | `RequestOrigin`, `requestOriginOf`, `publicRequestUrl`                             |
| `packages/common/src/state-keys.ts`                                                                                               | `REQUEST_ORIGIN_STATE_KEY`                                                         |
| `packages/common/src/http.ts`                                                                                                     | `IRequest.ip` JSDoc (C5)                                                           |
| `packages/http-security-plugin/src/middleware/forwarded-header.ts` (new)                                                          | `parseForwarded` (internal)                                                        |
| `packages/http-security-plugin/src/middleware/ip-security-middleware.ts`                                                          | peer in the walk, `forwardedHeader`, origin resolution and publication; JSDoc (C1) |
| `packages/http-security-plugin/src/middleware/csrf-middleware.ts`                                                                 | the three own-origin candidates; JSDoc (C2)                                        |
| `packages/session-plugin/src/options.ts`, `services/session-service.ts`                                                           | `secure: 'auto'`, the `sameSite: 'none'` refusal, context into `#cookie`           |
| `packages/react-router-plugin/src/handler/request-bridge.ts`                                                                      | `publicRequestUrl(ctx)`                                                            |
| `packages/kernel/src/application/application.ts`                                                                                  | `InjectRequest.ip`                                                                 |
| READMEs of http-security, session, react-router, auth; `PUBLIC_API.md`; `docs/deployment.md`; `CHANGELOG.md`; `docs/upgrading.md` | C1–C5, §3.11                                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                     | src covered                        | Key assertions                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/test/unit/fetch-mapping.test.ts` (extend)                   | `fetch-mapping.ts`                 | §3.1 shape assertions; §3.2 normalization table.                                                                                                                                                                                       |
| `packages/runtime/test/unit/node-http-adapter.test.ts` (extend)               | `node-http-adapter.ts`             | fetch env with `incoming.socket.remoteAddress` yields `ip`; env without `incoming` yields none; upgrade path carries the peer.                                                                                                         |
| `packages/runtime/test/unit/deno-http-adapter.test.ts` (extend)               | `deno-http-adapter.ts`             | handler with `info.remoteAddr.hostname` yields `ip`; no `info` yields none.                                                                                                                                                            |
| `packages/runtime/test/unit/bun-http-adapter.test.ts` (extend)                | `bun-http-adapter.ts`              | `requestIP` returning an address, returning `null`, and absent.                                                                                                                                                                        |
| `packages/runtime/test/integration/peer-address-real.test.ts` (new)           | Node and Deno adapters, real hosts | DEFAULT host bound to `::` and to `0.0.0.0`, `fetch` from 127.0.0.1, handler sees `ip === '127.0.0.1'` in both. Node runs in Vitest; Deno cases skip unless `typeof Deno !== 'undefined'` and run in the Deno lane.                    |
| `packages/common/test/unit/request-origin.test.ts` (new)                      | `request-origin.ts`                | §3.6 accessor cases.                                                                                                                                                                                                                   |
| `packages/http-security-plugin/test/unit/forwarded-header.test.ts` (new)      | `forwarded-header.ts`              | §3.5 parser table and bounds.                                                                                                                                                                                                          |
| `packages/http-security-plugin/test/unit/ip-security-proxy.test.ts` (extend)  | `ip-security-middleware.ts`        | §3.3–3.6 cases.                                                                                                                                                                                                                        |
| `packages/http-security-plugin/test/unit/csrf-middleware.test.ts` (extend)    | `csrf-middleware.ts`               | §3.7 cases.                                                                                                                                                                                                                            |
| `packages/http-security-plugin/test/integration/proxy-security.test.ts` (new) | both middlewares via a kernel app  | `app.inject({ ip })`: untrusted peer forging XFF and XFP → client IP is the peer and origin is the URL's; trusted peer → header client and https origin; https form POST with `X-Forwarded-Proto` → not 403; same through `Forwarded`. |
| `packages/session-plugin/test/unit/session-cookie-secure.test.ts` (new)       | `options.ts`, `session-service.ts` | §3.8 cases, driven through a real kernel app with ip-security registered.                                                                                                                                                              |
| `packages/react-router-plugin/test/unit/request-bridge.test.ts` (extend)      | `request-bridge.ts`                | §3.9 cases.                                                                                                                                                                                                                            |
| `packages/kernel/test/unit/inject-ip.test.ts` (new)                           | `application.ts`                   | `inject({ ip })` reaches `ctx.request.ip`; omitted stays absent.                                                                                                                                                                       |
| `packages/auth-plugin/test/integration/peer-rate-limit-key.test.ts` (new)     | (behaviour, §3.11)                 | real Node adapter on an ephemeral port: default key is `ip:127.0.0.1`.                                                                                                                                                                 |

Bun has no CI lane, so the Bun adapter's real-socket behaviour is proved by a recorded manual probe
during verification (default host, `::` and `0.0.0.0`), alongside its unit tests.

Negative controls (each observed failing, then reverted): drop the peer append in §3.3 (the direct-
forge case returns the forged address); drop normalization (the `::` real-socket case fails); trust
forwarded proto/host when the walk stopped at the peer (the untrusted-forge origin case passes
`https`); drop the CSRF zero-config candidate (the https POST is 403); accept any proto value (the
`ftp` case passes); merge `Forwarded` with `X-Forwarded-*` (the single-family case fails).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113n-proxy-security
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line
pnpm run test:deno-lane     # the Deno adapter proofs
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

Performance: one paired A/B on `/json` with the benchmark harness (Node adapter), new build vs
`develop`; a drop beyond 2% is a finding to fix before hand-off.

Security: the diff crosses a trust boundary (client identity, origin, cookie flags), so a
committed-tree security audit by a fresh agent runs after code review, before the PR merges.

## 8. Risks & mitigations

- **A deployment that relied on the header-only walk with a direct path** (a sidecar posting from a
  non-listed address) starts resolving that sidecar's address → CHANGELOG/upgrade text names it and
  the remedy (list the sidecar in `trustedProxies`).
- **Host header poisoning through the public URL** → a trusted forwarded host is no less trustworthy
  than the `Host` header `ctx.request.url` already carries; the docs say to build security-sensitive
  links (password reset, email) from configured base URLs, not from the request.
- **Per-request cost on the hot path** (M87) → the peer is a property read and requests keep one
  shape; origin resolution runs only where ip-security is registered; the harness A/B in §7 is the
  guard.
- **IPv6 proxies** are still compared literally (released floor) → a mapped IPv4 peer is normalized;
  a real IPv6 proxy must be listed exactly; README says so.
- **Bun `requestIP` absent on an old Bun** → optional member; the request has no peer.

## 9. Out of scope

- A peer address on Cloudflare Workers — not available on the platform (§3.2).
- Changing `proxyHops` or leftmost client-IP semantics — §3.4.
- Expanding IPv6 CIDR in `trustedProxies` — released floor, unchanged.

## 10. Design security review (recorded after implementation)

The committed-tree security audit of `bd23aff8` failed because this plan had no design review while
the diff crosses a trust boundary (F0 below). This section is recorded after implementation — the
M101a / M113a precedent — and is not presented as having guided the design.

**Flows reviewed.** (a) The socket peer each Node, Deno and Bun adapter reads into `IRequest.ip`,
and its IPv4-mapped normalization. (b) The client-IP walk over `X-Forwarded-For`, a custom
`ipHeader`, or RFC 7239 `Forwarded`, in leftmost, `proxyHops` and `trustedProxies` modes, with the
peer appended in the last. (c) The public origin published under `REQUEST_ORIGIN_STATE_KEY` from
`X-Forwarded-Proto`/`X-Forwarded-Host` or a `Forwarded` element, consumed by `publicRequestUrl` (the
React Router bridge) and session `secure: 'auto'`. (d) The CSRF own-origin set, including the
zero-configuration `X-Forwarded-*` candidate. (e) The `Forwarded` parser on client input.

**Assets.** The client identity that rate limits and IP allowlists key on; the public host and
protocol that loaders build redirects and markup from; the `Secure` attribute of the session cookie;
the CSRF decision for state-changing requests; event-loop availability.

**Attackers.** A client connecting directly to the application (bypassing or in front of the proxy).
A cross-site page in a victim's browser. A script on an origin the application admits for
credentialed CORS (a partner origin, or one with an XSS hole). A misconfigured trusted proxy that
appends or passes through client-supplied forwarding headers.

**Obligations.**

1. A direct client in `trustedProxies` mode cannot choose its client IP or the public origin: the
   peer is walked first, and an untrusted peer is the client.
2. A forwarded origin is believed only when a walk passed a trusted socket peer. Leftmost,
   `proxyHops`, custom-`ipHeader` modes without `trustedProxies`, and requests with no peer never
   checked who wrote the headers and so publish the URL origin.
3. A forwarded host reaching `publicRequestUrl` is a DNS name or bracketed IPv6 literal with an
   optional numeric port, bounded in length; a protocol is `http` or `https`.
4. The CSRF zero-config candidate is believed only for a request the browser itself marks
   `Sec-Fetch-Site: same-origin`, a header scripts cannot set; `X-Forwarded-*` are not forbidden
   headers and the CORS middleware echoes requested headers by default.
5. The `Forwarded` parser is linear, bounded (8 KiB, 64 elements), never throws out of the
   middleware, and stores parameters in a `Map`.
6. A header that resolves no client yields `undefined` in both families, never the proxy's address.
7. No header value is logged or echoed in an error.

**Residual, accepted.** A trusted proxy that passes a client's `X-Forwarded-Host` through untouched
lets that client choose the published host; the docs require the proxy to overwrite both headers
(Express makes the same trade). Browsers that send no `Sec-Fetch-Site` fall back to the URL and
published origins for CSRF.

**Findings.**

| #   | Finding                                                                                                                                                    | Severity | Disposition                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| R1  | Review: a malformed `Forwarded` header from a direct, untrusted client erased its client IP                                                                | Medium   | Fixed before the audit: a malformed header contributes no hops and the walk still checks the peer  |
| F0  | Audit: no design security review                                                                                                                           | Blocking | Fixed: this section                                                                                |
| F1  | Audit: a script on a credentialed CORS origin sent `X-Forwarded-Host: <its host>` and passed CSRF (403 → 200)                                              | High     | Fixed: the candidate requires `Sec-Fetch-Site: same-origin`; regression test reproduces the attack |
| F2  | Audit: leftmost, `proxyHops`, custom-`ipHeader` and peerless modes published a client-chosen origin (host injection; `secure: 'auto'` dropped `Secure`)    | Medium   | Fixed: only `trustedProxies` with a trusted socket peer publishes a forwarded origin               |
| F3  | Audit: the host check admitted URL-legal punctuation (`"`, `` ` ``, `{}`, a trailing dot)                                                                  | Low      | Fixed: DNS-name or bracketed-IPv6 grammar, 259-character bound                                     |
| F4  | Audit: in the `X-Forwarded-*` family a short `proxyHops` header or an all-trusted chain resolved the proxy's own address, unlike `Forwarded` and the JSDoc | Low      | Fixed: both families resolve `undefined`                                                           |
