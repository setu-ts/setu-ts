# Milestone 113n — Security Behind a Reverse Proxy (`@setu-ts/http-security-plugin`, `@setu-ts/runtime`)

> **Status:** Planning. Branch: `feat/m113n-proxy-security`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two findings from the `v0.9.0` smoke run (X41) share one cause: the framework does not know where a
request came from. Behind a TLS-terminating proxy, `csrfMiddleware` compares the browser's
`Origin: https://…` with an own origin derived from `ctx.request.url`, which reads `http://…`, so
`csrf: {}` refuses every same-origin browser mutation (V9-65, High). And `trustedProxies` walks the
forwarded chain without ever checking the socket peer, because no first-party adapter sets
`IRequest.ip` — so a client that reaches the origin directly writes its own `X-Forwarded-For` and
chooses its own identity (V9-66, the half of X32-3 that M90a left). This milestone makes each of the
three socket-serving adapters report the peer address, makes `trustedProxies` require that peer to
be a trusted proxy before any forwarded entry is believed, and makes the CSRF own-origin include the
origin the proxy forwarded.

- **In scope:** `IRequest.ip` populated by the Node, Deno and Bun adapters from the socket peer,
  IPv4-mapped IPv6 normalized; the peer appended to the `trustedProxies` walk; `InjectRequest.ip` so
  the behaviour is drivable through `app.inject()`; the CSRF own-origin derived additionally from
  `X-Forwarded-Proto` / `X-Forwarded-Host`; README, `PUBLIC_API.md`, `docs/deployment.md`, CHANGELOG
  and upgrading-guide text.
- **NOT this milestone:** RFC 7239 `Forwarded` header parsing (unowned — named in §9); a peer
  address on Cloudflare Workers (the platform has no socket peer, §3.2); changing `proxyHops` or the
  leftmost mode (§3.4); `secure`-cookie decisions behind a proxy (unowned, §9).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                                                                        | Verified surface / fact                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRequest.ip`                     | `packages/common/src/http.ts:46`                                                                                          | `readonly ip?: string` — "Client IP address, when derivable." Already declared; no `common` change needed.                                                                                                                |
| `mapWebRequestToFrameworkRequest` | `packages/runtime/src/adapters/shared/fetch-mapping.ts:385`                                                               | `(request: Request, maxBodyBytes?: number) => IRequest`; builds a `FrameworkRequest` with NO `ip`.                                                                                                                        |
| `FrameworkRequest`                | `packages/runtime/src/adapters/shared/fetch-mapping.ts:78-96`                                                             | Class with one shared prototype (M87 hidden-class rule in its JSDoc); constructor `(raw, method, url, path, maxBodyBytes?)`; no `ip` member.                                                                              |
| Node fetch env                    | `@hono/node-server@2.1.4` `dist/index.mjs:1045-1047`; `packages/runtime/src/adapters/node/node-http-adapter.ts:70-73,378` | node-server calls `fetchCallback(req, { incoming, outgoing })`. The adapter's `NodeFetchEnv` declares only `outgoing`. `incoming.socket.remoteAddress` is the peer (node-server's own `conninfo.mjs` reads exactly that). |
| Node upgrade path                 | `node-http-adapter.ts:300-308`                                                                                            | `#handleUpgrade(incoming, socket, head)` maps through the same function; `incoming.socket.remoteAddress` available there too.                                                                                             |
| Deno serve                        | `deno-http-adapter.ts:93-104,182-184,291`                                                                                 | `Deno.serve(options, options.fetch)`; the fetch handler is typed `(request: Request) => …` and drops Deno's second `info` argument.                                                                                       |
| Bun serve                         | `bun-http-adapter.ts:53-60,205`                                                                                           | Serve callback receives `(request, server: BunServer)`; `BunServer` declares `stop`, `upgrade?` — no `requestIP`.                                                                                                         |
| Workers                           | `cf-http-adapter.ts:84`                                                                                                   | Maps from `fetch(request)` only — no socket and no peer.                                                                                                                                                                  |
| Peer formats (measured)           | probe, Deno 2.9.6 / Bun 1.4.2 / Node 24 + node-server 2.1.4                                                               | IPv4 listener: `127.0.0.1` on all three. Dual-stack `::` listener: `::ffff:127.0.0.1` on ALL three (Deno `info.remoteAddr.hostname`, Bun `server.requestIP(r).address`, Node `socket.remoteAddress`).                     |
| `ipSecurityMiddleware`            | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:224-246,268-304`                                  | Header read only when `trustProxy`; `resolveForwardedIp` walks the header alone; falls back to `ctx.request.ip`; `compileTrustedProxy` expands IPv4 CIDR only, compares everything else literally.                        |
| `csrfMiddleware`                  | `packages/http-security-plugin/src/middleware/csrf-middleware.ts:95-122,164-171`                                          | Own origin = `getRequestOrigin(ctx.request.url)` only; then `trustedOrigins`; absent Origin AND Referer passes.                                                                                                           |
| `defaultRateLimitKey`             | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:202-216`                                                    | Order: principal → `CLIENT_IP_STATE_KEY` → `ctx.request.ip` → `'anonymous'`. Reads `request.ip` already, so populating it changes the key with no auth-plugin code change.                                                |
| `InjectRequest`                   | `packages/kernel/src/application/application.ts:125-158,921`                                                              | `{ method, url, headers?, body? }` — no `ip`; `inject()` builds its `IRequest` literal with no `ip`.                                                                                                                      |
| `MockRequest` (testing)           | `packages/testing/src/mock-context.ts:145,187-188`                                                                        | Already accepts `ip`. No change.                                                                                                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                      | Resolution (picked side)                                   | Doc deliverable (same PR)                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| C1  | `ip-security-middleware.ts:4-12` module doc: "`trustProxy` is the only working source since M23 … the `request.ip` fallback below is vestigial" — false once adapters populate `IRequest.ip`. | Code wins: the fallback becomes the peer on Node/Deno/Bun. | Rewrite the module note and the `trustProxy` JSDoc "with `false`, `clientIp` is `undefined`" sentence.  |
| C2  | `CsrfOptions.trustedOrigins` JSDoc: "The request's own origin (derived from `request.url`) is always implicitly trusted" — incomplete after §3.5.                                             | Code wins.                                                 | JSDoc, http-security README CSRF section, `PUBLIC_API.md` CSRF row.                                     |
| C3  | `packages/auth-plugin/README.md` rate-limit paragraph implies an unauthenticated caller usually lands in `'anonymous'`; on a socket adapter it now lands in `ip:<peer>`.                      | Code wins.                                                 | One sentence naming which adapters populate `IRequest.ip`; the `assert:js` table is unchanged (pure).   |
| C4  | `docs/deployment.md` has no reverse-proxy section; X41 found the CSRF behaviour undocumented.                                                                                                 | Add one.                                                   | `## Behind a reverse proxy` section: peer check, `trustedProxies`, CSRF forwarded origin, Workers note. |

## 3. Design decisions

### 3.1 Where the peer address comes from

- **Decision:** `mapWebRequestToFrameworkRequest` gains an optional third parameter
  `peerAddress?: string`, stored on `FrameworkRequest` and exposed as `ip` through a prototype
  getter backed by a private field, so every request keeps ONE shape (the M87 rule in the class
  JSDoc) whether or not a peer is known. Each adapter passes it from its own runtime:
  - Node: widen the internal `NodeFetchEnv` with
    `incoming?: { socket?: { remoteAddress?: string } }` and read
    `env?.incoming?.socket?.remoteAddress` in `createFetchHandler`; the upgrade path reads
    `incoming.socket.remoteAddress`. The published `NodeServeHost.serve` `fetch` env type gains the
    same optional member (additive).
  - Deno: the fetch handler takes Deno's second argument
    `info?: { remoteAddr?: { hostname?: string } }` and reads `info?.remoteAddr?.hostname`.
  - Bun: `BunServer` gains optional `requestIP?(request: Request): { address: string } | null`; the
    serve callback reads `server.requestIP?.(request)?.address`. The plain `fetch()` entry
    (`createFetchHandler`, no server) passes none.
  - Workers and the local diagnostics listener pass none.
- **Why:** `IRequest.ip` is already declared (`common` unchanged), and the read is a property access
  the runtime already holds; nothing is guessed from headers.
- **Test home:** `fetch-mapping.test.ts` (getter present/absent, same prototype), each adapter's
  unit test with a fake host passing a peer, and `test/integration/peer-address-real.test.ts`
  driving the DEFAULT host on Node, Deno and Bun against a real socket.

### 3.2 Peer normalization and Workers

- **Decision:** one internal `normalizePeerAddress(address)` in `fetch-mapping.ts` strips an
  `::ffff:` prefix when the remainder is a dotted-quad IPv4 address (case-insensitive prefix), and
  returns every other value unchanged; empty strings become `undefined`. Workers sets no `ip`: the
  only peer there is Cloudflare's edge, so the documented answer is
  `ipSecurity: { trustProxy: true, ipHeader: 'CF-Connecting-IP' }`, which Cloudflare overwrites.
- **Why:** all three runtimes report `::ffff:127.0.0.1` on a dual-stack listener (measured, §1), and
  `compileTrustedProxy` expands only dotted IPv4 CIDR — so without normalization `10.0.0.0/8` never
  matches a mapped peer and every request would be treated as direct.
- **Test home:** `fetch-mapping.test.ts` table: `::ffff:10.1.2.3` → `10.1.2.3`, `::FFFF:10.1.2.3` →
  `10.1.2.3`, `::ffff:abcd` unchanged, `2001:db8::1` unchanged, `''` → `undefined`.

### 3.3 The peer joins the `trustedProxies` walk

- **Decision:** when `trustedProxies` is set and `ctx.request.ip` is defined, the chain walked right
  to left is `[...headerEntries, ctx.request.ip]`. A peer that is not trusted is therefore the
  client and every header entry is ignored; a trusted peer is skipped and the walk continues as
  today. When `trustProxy` is on and the header is absent, the result is the peer (unchanged
  fallback). When `ctx.request.ip` is undefined (Workers, a custom adapter, `inject()` without `ip`)
  the walk is header-only, exactly as released.
- **Why:** this is the standard algorithm (Express `trust proxy` starts from the socket address);
  appending the peer reuses the existing walk instead of adding a second check, so there is one
  implementation. Keeping the header-only path when no peer is known preserves Workers and every
  custom adapter.
- **Test home:** `ip-security-proxy.test.ts` (direct client forging `X-Forwarded-For` resolves to
  its own peer; trusted peer resolves from the header; mapped and unmapped peer forms; no-peer path
  unchanged) and the integration test through `app.inject({ ip })`.

### 3.4 `proxyHops` and the leftmost mode stay as released

- **Decision:** neither consults the peer. Their JSDoc says so and recommends `trustedProxies` when
  the proxies have stable addresses.
- **Why:** `proxyHops` exists for proxies with no stable address, so there is nothing to check the
  peer against; counting the peer as a hop would silently move every existing deployment's resolved
  client by one entry. The leftmost mode is already documented as safe only behind an overwriting
  proxy.
- **Test home:** `ip-security-proxy.test.ts` asserts `proxyHops` and leftmost results are identical
  with and without a peer.

### 3.5 CSRF own origin behind a proxy

- **Decision:** the implicitly trusted own origins become two: the origin of `ctx.request.url`
  (unchanged) and, when `X-Forwarded-Proto` is present, `<proto>://<host>` where `proto` is the
  first comma entry, trimmed and lowercased, accepted only if `http` or `https`, and `host` is the
  first comma entry of `X-Forwarded-Host` when present, else the host of `ctx.request.url`. The
  derived origin is built with `new URL(...)` so a malformed host yields no candidate rather than a
  string compare against garbage. No new option.
- **Why:** this makes `csrf: {}` work behind a standard proxy with no configuration. Trusting these
  headers WITHOUT a peer check is safe for this purpose specifically: a CSRF request is sent by the
  victim's browser, and a cross-site page cannot add `X-Forwarded-*` to it — a form cannot set
  headers and a script-set custom header forces a preflight. A client that CAN set them is not a
  CSRF attacker; it can set `Origin` too. An explicit `publicOrigin` option was rejected because it
  would duplicate `trustedOrigins`, which already admits an extra origin.
- **Test home:** `csrf-middleware.test.ts` (https browser origin + `X-Forwarded-Proto: https`
  passes; `X-Forwarded-Host` used when present; `ftp`/empty/garbage proto ignored; a cross-site
  origin still refused while the forwarded headers are present) and the integration test.

### 3.6 `inject()` can carry a peer

- **Decision:** `InjectRequest` gains `ip?: string`, copied onto the injected `IRequest` when
  present.
- **Why:** without it, the peer check is untestable through the public test entry point, and
  applications testing their proxy configuration need it as much as this milestone does.
- **Test home:** a kernel unit test asserting `ctx.request.ip` inside a handler, and the
  http-security integration test that uses it.

### 3.7 Behaviour change and versioning

- **Decision:** treated as a breaking behaviour change shipping in `0.10.0`: `CLIENT_IP_STATE_KEY`
  and `defaultRateLimitKey` now see a peer on Node, Deno and Bun, so unauthenticated callers move
  from the global `'anonymous'` bucket to one bucket per peer address; with `trustedProxies`, a
  direct client's forged header is ignored. CHANGELOG `Changed` entry plus a `docs/upgrading.md`
  entry under `## Unreleased`.
- **Why:** a released rate limit's keying changes without a configuration change.
- **Test home:** `packages/auth-plugin/test/integration/peer-rate-limit-key.test.ts` boots a real
  Node adapter on an ephemeral port and asserts the key is `ip:127.0.0.1`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none at the type level (every addition is optional). Behaviour change
(§3.7) ships in minor `0.10.0`.

| Exported symbol                    | Kind                     | Consumer / real code path that READS it                                   |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `NodeServeHost` (`fetch` env type) | interface (widened)      | `NodeHttpAdapter.listen` passes the callback that reads `incoming` (§3.1) |
| `BunServer.requestIP?`             | interface member (added) | `BunHttpAdapter` serve callback (§3.1)                                    |
| `InjectRequest.ip?`                | interface member (added) | `Application.inject` copies it; integration tests and application tests   |

`mapWebRequestToFrameworkRequest` and `normalizePeerAddress` are internal (not barrel-exported); the
barrels of `http-security-plugin` and `common` are unchanged, asserted by their
`barrel-exports.test.ts`.

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation)                                              |
| ------ | -------- | -------------------------------------------------------------------------- |
| none   | —        | No option is added; §3.3 and §3.5 change existing options' behaviour only. |

## 5. Implementation files

| File                                                                                                                                                    | Purpose                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`                                                                                                 | `peerAddress` parameter, `ip` getter, `normalizePeerAddress`    |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`                                                                                               | read `incoming.socket.remoteAddress` on fetch and upgrade paths |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`                                                                                               | accept Deno's `info` argument                                   |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`                                                                                                 | `requestIP` on `BunServer`; read it in the serve callback       |
| `packages/http-security-plugin/src/middleware/ip-security-middleware.ts`                                                                                | peer appended to the `trustedProxies` walk; JSDoc (C1)          |
| `packages/http-security-plugin/src/middleware/csrf-middleware.ts`                                                                                       | forwarded own origin; JSDoc (C2)                                |
| `packages/kernel/src/application/application.ts`                                                                                                        | `InjectRequest.ip`                                              |
| `packages/http-security-plugin/README.md`, `packages/auth-plugin/README.md`, `PUBLIC_API.md`, `docs/deployment.md`, `CHANGELOG.md`, `docs/upgrading.md` | C1–C4 and §3.7                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                     | src covered                       | Key assertions                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/test/unit/fetch-mapping.test.ts` (extend)                   | `fetch-mapping.ts`                | `ip` from the third argument; absent without it; normalization table (§3.2); two requests with and without a peer share a prototype.                                                      |
| `packages/runtime/test/unit/node-http-adapter.test.ts` (extend)               | `node-http-adapter.ts`            | fetch callback with `{ incoming: { socket: { remoteAddress } } }` yields `ip`; env without `incoming` yields none; upgrade path carries the peer.                                         |
| `packages/runtime/test/unit/deno-http-adapter.test.ts` (extend)               | `deno-http-adapter.ts`            | handler with `info.remoteAddr.hostname` yields `ip`; no `info` yields none.                                                                                                               |
| `packages/runtime/test/unit/bun-http-adapter.test.ts` (extend)                | `bun-http-adapter.ts`             | `requestIP` returning an address, returning `null`, and absent.                                                                                                                           |
| `packages/runtime/test/integration/peer-address-real.test.ts` (new)           | all three adapters, real hosts    | DEFAULT host on each runtime (guarded per runtime) bound to `::` and to `0.0.0.0`, `fetch` from 127.0.0.1, handler sees `ip === '127.0.0.1'` in both — the case only a real socket shows. |
| `packages/http-security-plugin/test/unit/ip-security-proxy.test.ts` (extend)  | `ip-security-middleware.ts`       | §3.3 and §3.4 cases.                                                                                                                                                                      |
| `packages/http-security-plugin/test/unit/csrf-middleware.test.ts` (extend)    | `csrf-middleware.ts`              | §3.5 cases, including the cross-site refusal with forwarded headers present.                                                                                                              |
| `packages/http-security-plugin/test/integration/proxy-security.test.ts` (new) | both middlewares via a kernel app | `app.inject({ ip })`: direct untrusted peer forging XFF → `CLIENT_IP_STATE_KEY` is the peer; trusted peer → header client; https form POST with `X-Forwarded-Proto` → not 403.            |
| `packages/kernel/test/unit/inject-ip.test.ts` (new)                           | `application.ts`                  | `inject({ ip })` reaches `ctx.request.ip`; omitted stays absent.                                                                                                                          |
| `packages/auth-plugin/test/integration/peer-rate-limit-key.test.ts` (new)     | (behaviour, §3.7)                 | real Node adapter on an ephemeral port: default key is `ip:127.0.0.1`.                                                                                                                    |

Negative controls (each observed failing, then reverted): drop the peer append in §3.3 (the direct-
forge case passes the forged address); drop normalization (the `::` real-socket case fails); drop
the forwarded candidate (the https POST is 403); accept any `X-Forwarded-Proto` value (the `ftp`
case passes).

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

## 8. Risks & mitigations

- **A deployment that relied on the header-only walk with a direct path** (a sidecar posting from a
  non-listed address) starts resolving that sidecar's address → CHANGELOG/upgrade text names it and
  the remedy (list the sidecar in `trustedProxies`).
- **Per-request cost on the hot path** (M87) → the peer is a property read; the getter keeps one
  shape; the harness A/B in §7 is the guard.
- **IPv6 proxies** are still compared literally (released floor) → a mapped IPv4 peer is normalized,
  a real IPv6 proxy must be listed exactly; README says so.
- **Bun `requestIP` absent on an old Bun** → optional member; the request simply has no peer.

## 9. Out of scope

- RFC 7239 `Forwarded` header parsing — unowned; recorded in the ROADMAP section.
- Deriving `secure` cookie flags or redirect URLs from forwarded proto — unowned.
- A peer address on Cloudflare Workers — not available on the platform (§3.2).
- Changing `proxyHops` semantics — §3.4.
