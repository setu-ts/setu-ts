# Milestone 143a — Sessions and Shared Caches (`@setu-ts/session-plugin`, `http-security-plugin`, `openapi-plugin`, `cache-plugin`)

> **Status:** Complete — implemented on `feat/m143a-sessions-shared-caches` (built inline at the
> maintainer's direction), independently reviewed and security-audited before it merges; the PR
> description carries the verification and audit records. Lane: Web (first letter). Revised after
> three independent plan reviews (§11).

**Dependencies on other lanes, stated first.**

- **No change to an existing contract in `common` and no change to `kernel`.** `ISessionStore`,
  `ICacheStore` and `IResponse` are used as committed. The one `common` change is **additive**: a
  new file `packages/common/src/services/csrf-token-access.ts` and its export line (§3.10), which
  the lane rules allow outside the Core lane. Nothing waits on M143i.
- **`cache-plugin` joins the Web lane** (maintainer, Q7). The Web lane's row in the ROADMAP lanes
  table is corrected in the same commit as this plan, before any code.
- **Halves owned elsewhere, reported and not edited:** template halves for M143j (V13-111, V13-20)
  and the `rest.ts:79` comment as a V13-34 half for M143j; the Cache API and Workers KV halves for
  M143o (§0.2).

## 0. Objective & scope

A signed-in page, and a page carrying a visitor's CSRF token, must never be stored by a shared
cache, inside the process (`cacheMiddleware`) or outside it (CDN, reverse proxy); a `destroy()` or
`regenerate()` on the store strategy must stay in force whatever request on that session was already
in flight, with one store round trip as the measured, documented window for a request that starts
during a racing commit; concurrent requests on one store session must stop overwriting each other's
untouched keys (per-key last writer wins; loss between keys narrowed from a whole request to one
store round trip); a request for a missing asset must not start a session; the request-size refusals
must carry the same security and CORS headers as every other response; and Swagger UI's "Try it out"
must work for authenticated and session calls in an application that has sessions, by sending the
CSRF token (an anonymous visitor's unsafe call to a route under form CSRF, such as `POST /login`,
still needs a session first, and the README says so). The boundary: the cookie strategy keeps its
documented limits; the revocation guarantee holds on stores that are linearizable and do not evict
live keys (§3.1, the store table); no new capability or store is added.

- **In scope:** V13-111, V13-112, V13-135, V13-136 (revocation and caching, the trust-boundary
  rows); V13-137 (store commits); V13-20 (session half); V13-34; V13-60. Design 1 (§3.1–§3.4): how a
  store write refuses a revoked or superseded session. Design 2 (§3.5–§3.7, §3.12): which responses
  are marked private, and how `cacheMiddleware` treats them. The design security review (§10).
- **NOT this milestone:** the template halves (M143j) and the Cloudflare halves (M143o), §0.2; the
  `HEAD`-on-`GET` gap and React Router public-file validators (V13-113 in M143i, V13-114 in M143l);
  CORS headers on tenant and locale refusals (§9); cookie-strategy revocation (documented;
  `signIn.sessionStamp` is its answer); the nginx/CDN re-run on published `0.14.0` (milestone-wide
  gate after the release).

### 0.1 Measured on current `develop` (2026-11-22, source at `d2ec1aef1`)

Reproduced in-process against the workspace source with small Vitest probes. The probes are kept in
the session notes folder (`m143a-probes/`, outside the repository) and become the failing-first
tests named in §6; each asserts the defect today and is inverted when the fix lands.

| Row     | Probe                                                                                                    | Measured                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| V13-135 | `MemorySessionStore`; request A loads a signed-in session, B `destroy()`s and commits, A writes a key    | **50 / 50** later loads of the old cookie read `userId=u1`                                                                        |
| V13-135 | Same with `rolling: true` and A only reading                                                             | **50 / 50** resurrected (a read-only GET is enough)                                                                               |
| V13-136 | B `regenerate()`s (step-up) and commits, A then writes                                                   | **50 / 50** old cookie still reads `userId=u1`                                                                                    |
| V13-137 | 10 requests load one store session, each increments `n`, all commit                                      | `n = 1` (9 of 10 changes lost; the README says "one change"); disjoint keys `a`/`b`: `a` lost                                     |
| V13-111 | Store and cookie strategies; signed-in `GET /products` reading `userId`                                  | no `Cache-Control`, no `Vary`, no `Set-Cookie` — heuristically storable by a shared cache                                         |
| V13-112 | Returning anonymous visitor's `GET /login` rendering `getCsrfToken`                                      | no `Cache-Control`, no `Vary`, no `Set-Cookie` (first visit: `Set-Cookie` only)                                                   |
| V13-20  | 404 handler that mints a CSRF token (what the template's eager `populateLoadContext` does on every page) | `Set-Cookie` on the 404                                                                                                           |
| V13-34  | `HttpSecurityPlugin({ cors, requestSize: { maxBodySize: 10 } })`, allowed origin, 100-byte POST          | 200: `access-control-allow-origin`, `nosniff`, HSTS present; **413: all three absent**                                            |
| V13-60  | (read from source) Swagger UI's request object is built with `credentials: 'same-origin'`                | a signed-in browser sends its session cookie on every Try-it-out call, so the bearer exemption declines and form CSRF answers 403 |

The template's eager mint is `populateLoadContext` calling `getCsrfToken(ctx)` on every SSR request
(`packages/cli/src/templates/full-stack.ts:160`): that is why `/favicon.ico` sets a cookie.

### 0.2 Needs outside the Web lane (reported, not edited here)

| #   | Where (owner)                                                                                     | Exactly what must change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Full-stack template (M143j, V13-111 half)                                                         | `populateLoadContext` stops minting eagerly: it stores a getter, `context.set(csrfContext, () => getCsrfToken(ctx))`, and the generated `getCsrfToken(context)` in `app/server/session.server.ts` calls it. A page that renders no form then mints nothing, so an anonymous visitor's first page carries no `Set-Cookie` and stays shared-cacheable. The `csrfContext` key's type changes from `string` to `() => string` in `context-keys.server.ts`. Scaffold-and-boot gate row: a signed-in page and its `.data` answer `private, no-store`; an anonymous `/` answers with no `Set-Cookie`. |
| X2  | Full-stack template (M143j, V13-20 half)                                                          | Ship a favicon: `public/favicon.svg` plus `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` in `app/root.tsx`'s `<head>`, so the browser's first request is a 200 public file. Gate row: `/favicon.svg` answers 200 with no `Set-Cookie`, and `GET /missing.png` (no `Sec-Fetch-Dest: document`) answers 404 with no `Set-Cookie`.                                                                                                                                                                                                                                                  |
| X3  | `packages/cli/src/templates/rest.ts:79` comment (M143j, V13-34 half; maintainer, Q4)              | The source comment lists "cors (200), security-headers (250)"; after §3.8 it reads "security-headers (10) … cors (125)". Not generated output, but the comment becomes false. Add it to M143j's "Half of a row owned elsewhere".                                                                                                                                                                                                                                                                                                                                                               |
| X6  | `packages/cloudflare-plugin/src/cache-api/cacheability.ts:72-84` (M143o, V13-111 half)            | `assessCacheability` refuses method, status, 206, `Vary: *` and `Set-Cookie`. It must also refuse `private`/`no-store`, a `Vary` naming `Cookie` or `Authorization` (the Cache API key is the URL; the module's JSDoc at lines 55-66 says `Vary` cannot separate entries), and, as §3.12 does for `cacheMiddleware`, a request carrying a cookie or `Authorization` unless the response says `public`. Add to M143o's half list.                                                                                                                                                               |
| X7  | `packages/cloudflare-plugin` README for `KvSessionStore` and `KvCacheStore` (M143o, V13-135 half) | Workers KV is eventually consistent (`kv-session-store.ts:39` "propagates within seconds"), so a revocation marker may not be visible to a commit in another location for seconds. The README states that the §3.1 guarantee does not hold on KV and names a Durable Object store as the strong option.                                                                                                                                                                                                                                                                                        |

The two repository docs priority tables (`docs/plugin-architecture.md:146-163`,
`ARCHITECTURE.md:1934`) are edited **in this letter**, in the same change as the code (maintainer,
Q4).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                                                                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ISessionStore`                   | `packages/common/src/services/session.ts:234-276`                                                                                                                                                 | `read(id)`, `write(id, data, ttlMs)` ("replacing any existing one"), `destroy(id): Promise<boolean>`, optional `isHealthy`, `close`. **No conditional write, no version, no compare-and-set**, and nothing about id format or empty payloads. The design uses only these three methods.                                                                |
| `ICacheStore`                     | `packages/common/src/services/cache.ts:19-54`                                                                                                                                                     | `get`, `set(key, value, ttlSeconds?)`, `delete`, `has`, `clear`. No set-if-exists and no CAS, so `CacheSessionStore` cannot do an atomic conditional write without a contract change.                                                                                                                                                                  |
| `CacheSessionStore`               | `packages/session-plugin/src/stores/cache-session-store.ts:42-85`                                                                                                                                 | Keys `${keyPrefix}${id}` (default `session:`); TTL rounded up to whole seconds, minimum 1.                                                                                                                                                                                                                                                             |
| `MemorySessionStore`              | `packages/session-plugin/src/stores/memory-session-store.ts:51-115`                                                                                                                               | `Map`; read drops expired entries; `write` replaces; periodic sweep; no eviction.                                                                                                                                                                                                                                                                      |
| cache-plugin `MemoryStore`        | `packages/cache-plugin/src/stores/memory-store.ts:20,59`                                                                                                                                          | LRU with `maxSize` default 1000: `store: 'cache'` over it can evict a marker (never read again, so coldest) and a live session.                                                                                                                                                                                                                        |
| `KvSessionStore`                  | `packages/cloudflare-plugin/src/stores/kv-session-store.ts:39`                                                                                                                                    | A first-party `ISessionStore` on eventually consistent KV; "a `destroy()` propagates within seconds".                                                                                                                                                                                                                                                  |
| `cacheMiddleware` capture         | `packages/cache-plugin/src/middleware/cache-middleware.ts:125-139`                                                                                                                                | Stores unless streaming, a non-cacheable status, or `Set-Cookie`; reads no `Cache-Control` and no `Vary`.                                                                                                                                                                                                                                              |
| Cache API cacheability            | `packages/cloudflare-plugin/src/cache-api/cacheability.ts:72-84`                                                                                                                                  | Refuses method, status, 206, `Vary: *`, `Set-Cookie`; nothing else.                                                                                                                                                                                                                                                                                    |
| Unconditional commit write        | `packages/session-plugin/src/services/session-service.ts:298`                                                                                                                                     | `await this.#store.write(snapshot.id, snapshot.data, ttlMs)` with no check. The row's line citation holds on `develop`.                                                                                                                                                                                                                                |
| Store deletes                     | `session-service.ts:223` (destroy: `session.id` and `previousId`), `:247` (superseded id), `:296` (demotion to cookie-held: `snapshot.id` when store-held)                                        | Plain `store.destroy`; nothing records that the id was revoked. `:223` passes ids that may never have had a row (new, cookie-held, the never-written id after `regenerate()`).                                                                                                                                                                         |
| Commit trigger                    | `session-service.ts:235-240`                                                                                                                                                                      | Commits when dirty, regenerated, or (`rolling` or `idleTimeoutMs`) and not new.                                                                                                                                                                                                                                                                        |
| Anonymous traffic does not grow   | `session-service.ts:264-268`                                                                                                                                                                      | M113e rule: a session of reserved keys only writes no row. The design keeps it (§3.1 writes markers only for ids that had a row).                                                                                                                                                                                                                      |
| Cookie-held reserved keys         | `session-service.ts:44-52`                                                                                                                                                                        | `CSRF_SESSION_KEY` and `SESSION_TENANT_BINDING_KEY`.                                                                                                                                                                                                                                                                                                   |
| Session ids                       | `packages/runtime/src/services/cross-runtime.ts:16-18`                                                                                                                                            | `crypto.randomUUID()`: no `:` in an id, so a `revoked:`/`superseded:` prefix cannot collide with a real id.                                                                                                                                                                                                                                            |
| `Session` reads                   | `packages/session-plugin/src/services/session.ts:137` (`get`), `:163` (`has`), `:202` (`toJSON`), `:221` (`snapshot()`)                                                                           | No tracking today. The service itself calls `toJSON()` (`session-service.ts:254`) and `snapshot()`, so tracking must exclude its own calls.                                                                                                                                                                                                            |
| Framework reads                   | `common/src/services/session.ts:46-50` (`tenantBindingMismatch`, called at `session-middleware.ts:74`); auth-plugin `auth-session-service.ts:483,554`, `pending-state.ts:66`, `ceremonies.ts:422` | The tenant compare reads a reserved key on every request. auth-plugin reads its own (non-reserved) keys through `from(ctx)` when the application asks who is signed in.                                                                                                                                                                                |
| auth strategies read via headers  | `packages/auth-plugin/src/strategies/session-strategy.ts:63`; `auth-session-strategy.ts:89`                                                                                                       | Authenticate through `fromHeaders`, which runs the store restore again on a separate view (`session-service.ts:180`).                                                                                                                                                                                                                                  |
| `getCsrfToken`                    | `packages/session-plugin/src/csrf/token.ts:59-74`; `csrfTokenField` calls it at `:172`                                                                                                            | Mints only when absent (marks dirty); a returning visitor's read sets nothing.                                                                                                                                                                                                                                                                         |
| Session middleware                | `packages/session-plugin/src/middleware/session-middleware.ts:60-141`                                                                                                                             | Priority 260; tenant-mismatch 403 before the session is parked (`:74-80`); commit after `next()`; on throw only `revokeSuperseded`, whose fault is logged and swallowed (`:98-109`); early return for `NO_COMMIT_STATE_KEY`/`CSRF_EXEMPT_STATE_KEY`.                                                                                                   |
| Tenant seal marks dirty           | `session-middleware.ts:133-137`                                                                                                                                                                   | Every cookie-less request under a tenant gets a dirty new session (the X97 widening).                                                                                                                                                                                                                                                                  |
| Headers after the handler         | `session-middleware.ts:28-32`; `packages/kernel/src/context/response.ts:98-106`                                                                                                                   | The kernel appends headers after a terminal response method; `header()` sets (replaces), `appendHeader()` appends.                                                                                                                                                                                                                                     |
| `IResponse.snapshot()`            | `packages/common/src/http.ts:352`, `ResponseSnapshot` at `:1191-1215`                                                                                                                             | Live `headers` view plus `status`.                                                                                                                                                                                                                                                                                                                     |
| `respondWithError`                | `packages/common/src/errors/error-responder.ts:245-258`                                                                                                                                           | Sets status and body; does not clear headers.                                                                                                                                                                                                                                                                                                          |
| React Router response bridge      | `packages/react-router-plugin/src/handler/request-bridge.ts:83-98`                                                                                                                                | Copies React Router's status and every header with `appendHeader` (`response.ts:102-106` appends), so a route's `Cache-Control` would be **merged** with a value already set; §3.6 changes `Cache-Control` to `header()`.                                                                                                                              |
| React Router asset headers        | `packages/react-router-plugin/src/assets/static-assets.ts:29,38,144,196`                                                                                                                          | `public, max-age=31536000, immutable` (hashed) and `public, max-age=0, must-revalidate` (root files).                                                                                                                                                                                                                                                  |
| `auth-plugin` sign-out            | `packages/auth-plugin/src/sign-in/auth-session-service.ts:642-656`                                                                                                                                | `signOut` calls `destroy()`; its JSDoc promises immediate revocation on the store strategy. True after this letter; no auth-plugin code change.                                                                                                                                                                                                        |
| Template logout                   | `packages/cli/src/templates/full-stack-app-files.ts:701-705`                                                                                                                                      | `clear()` then `regenerate()`: the V13-136 path.                                                                                                                                                                                                                                                                                                       |
| http-security priorities          | `packages/http-security-plugin/src/plugin/http-security-plugin.ts:25-31`                                                                                                                          | IP 120, size 180, CORS 200, security headers 250, CSRF 270. Security headers and CORS set their headers before `next()` (`security-headers-middleware.ts:109-111`, `cors-middleware.ts:97-174`).                                                                                                                                                       |
| Security headers are static       | `security-headers-middleware.ts:106-111`                                                                                                                                                          | One frozen record computed at registration; no per-request input.                                                                                                                                                                                                                                                                                      |
| CORS origin matcher gets `ctx`    | `packages/http-security-plugin/src/middleware/cors-middleware.ts:13-15`                                                                                                                           | A matcher may read `requestOriginOf(ctx)` or the client address IP security publishes (`ip-security-middleware.ts:359-360`), so CORS must stay after IP resolution.                                                                                                                                                                                    |
| IP-security refuses nothing       | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:279-363`                                                                                                                  | Resolves the client address and forwarded origin, then `next()`; no refusal branch (§2 C2).                                                                                                                                                                                                                                                            |
| Request-size refusals             | `request-size-middleware.ts:73-90`                                                                                                                                                                | 400 for a malformed `Content-Length`, 413 over the bound.                                                                                                                                                                                                                                                                                              |
| Configuration refusals            | `packages/session-plugin/src/options.ts:215,236-308`                                                                                                                                              | Invalid options throw `TypeError` naming the option; `storeCommit` follows suit.                                                                                                                                                                                                                                                                       |
| Swagger UI request shapes         | `swagger-ui-dist@5.33.3` bundle; peer range `^5` (`openapi-plugin/package.json:43`); CDN pin `swagger-ui.ts:198`                                                                                  | The spec and `$ref` fetches build `{ url, credentials: withCredentials ? 'include' : 'same-origin', … }`; Try-it-out builds its request with `credentials: withCredentials ? 'include' : 'same-origin'` and `method` taken from the spec's lowercase path key. A same-origin request carries the session cookie.                                       |
| Swagger UI page                   | `packages/openapi-plugin/src/ui/swagger-ui.ts:103-145`; assets `openapi-plugin.ts:226-234` (`public, max-age=3600`)                                                                               | `SwaggerUIBundle({ url, dom_id, deepLinking, presets, layout })` with no interceptor.                                                                                                                                                                                                                                                                  |
| Bearer exemption                  | `packages/session-plugin/src/middleware/csrf-form-middleware.ts:35-40`, `csrf/exclude.ts:69-95`                                                                                                   | Exempt only when a header-credential strategy authenticated the request **and the session is new**. Kept.                                                                                                                                                                                                                                              |
| Swagger UI interceptor callers    | `swagger-ui-dist@5.33.3` bundle, the one `requestInterceptor` call in `http_http`                                                                                                                 | `o.requestInterceptor && (o = await o.requestInterceptor(o) \|\| o)`, then the fetch uses `o`, so an async interceptor may fetch a token and set a header. Four request kinds reach it: the spec load, `$ref` resolution, Try-it-out, and the OAuth2 token request (`authorizeRequest`) — so the interceptor must filter by origin and method (§3.10). |
| CSRF header token                 | `packages/session-plugin/src/options.ts:62-71`; `csrf/verify.ts:108-113`                                                                                                                          | `headerName` default `'x-csrf-token'`, read before the body and cannot be disabled.                                                                                                                                                                                                                                                                    |
| `CSRF_EXEMPT_STATE_KEY`           | `packages/common/src/state-keys.ts:124-129`; honoured as no-commit at `session-middleware.ts:119-124`                                                                                             | Boolean `true` exempts verification **and suppresses session commit**; "set only for endpoints with their own protection". The docs routes are safe-method reads (§3.10).                                                                                                                                                                              |
| `CSRF_SESSION_KEY`                | `packages/session-plugin/src/csrf/token.ts:31`                                                                                                                                                    | `'__csrf'`, session-plugin only; openapi-plugin never reads it (it uses the accessor of §3.10).                                                                                                                                                                                                                                                        |
| `cacheMiddleware` key and options | `packages/cache-plugin/src/middleware/cache-middleware.ts:52-110`; options `src/interfaces/index.ts:150-175`                                                                                      | Key `${method}:${url}` plus tenant and `vary` segments; options `ttlSeconds`, `key`, `vary`, `bypass`, `store`, `cacheableStatuses`. A HIT is replayed before the origin runs, whatever the request carries.                                                                                                                                           |
| No route pattern on the context   | `packages/common/src/http.ts` (no route-pattern member); `telemetry-middleware.ts:62` uses `request.path`                                                                                         | "Once per route" (§3.7) keys on method and path, bounded.                                                                                                                                                                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                         | Doc deliverable (same PR)                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1  | `session-plugin/README.md:50` "Immediate revocation: **Yes** — delete the entry" and `auth-session-service.ts:645-648` against the 50/50 measurement                                    | The code changes to match the claim (§3.1–§3.3). The README gains the exact guarantee and its preconditions (linearizable, no eviction of live keys) and names KV as outside it. | README table row and a "Revocation under concurrency" paragraph; the auth JSDoc stays.                    |
| C2  | V13-34's text names an "IP-security refusal (120)"; the middleware has no refusal branch                                                                                                | Source wins: the fix covers the request-size 400 and 413. The row's re-run drives the 400 and the 413.                                                                           | Plan note only; the DEFECTS row is reworded by the maintainer at re-run (smoke/ is not committed).        |
| C3  | `session-plugin/README.md:65-69` "can lose one change" against the measured K−1 of K                                                                                                    | Replaced by an accurate statement of each `storeCommit` mode (§3.4).                                                                                                             | README "Concurrent requests" section rewritten.                                                           |
| C4  | Priority tables: `docs/plugin-architecture.md:159`, `ARCHITECTURE.md:1934`, `PUBLIC_API.md:4371` ("priority 200"), `http-security-plugin/README.md:110`, `session-plugin/README.md:406` | New priorities (§3.8) everywhere.                                                                                                                                                | `PUBLIC_API.md`, both READMEs here; `docs/plugin-architecture.md` and `ARCHITECTURE.md` (maintainer, Q4). |
| C5  | JSDoc "after security headers (250)" at `session-middleware.ts:24` and `session-plugin.ts:30`                                                                                           | New priority.                                                                                                                                                                    | Both comments corrected in this PR.                                                                       |

## 3. Design decisions

### Design 1 — how a store write refuses a revoked or superseded session

**Options compared.**

| Option                                                            | Memory store                    | Cache store                                                                    | Application `ISessionStore`                            | Verdict                                                                         |
| ----------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| A. Atomic conditional write (`writeIfPresent`) on `ISessionStore` | trivial                         | impossible over `ICacheStore` without a second contract change (set-if-exists) | must implement it; a store without it needs a fallback | Rejected: waits on a Core-lane contract change, and still needs a fallback path |
| B. Row version + compare-and-set                                  | possible                        | no CAS primitive in `ICacheStore`                                              | must implement CAS                                     | Rejected: the same Core-lane contract change as A                               |
| C. Check-then-write alone                                         | non-atomic                      | non-atomic                                                                     | works                                                  | Rejected alone: the race shrinks to one round trip but stays                    |
| D. Tombstone in the row itself                                    | overwritten by the racing write | overwritten                                                                    | overwritten                                            | Rejected: the in-flight write replaces the tombstone                            |
| **E. Markers under their own ids + write-then-verify fence**      | works                           | works where the store keeps the marker (table below)                           | works with no new method                               | **Chosen**                                                                      |

**Why E is sound.** A revoke writes the marker **before** it deletes the row; a commit writes the
row and **then** reads the marker, deleting its own write when the marker exists. On a linearizable
store that keeps the marker every interleaving ends with the row gone: if the commit's write
precedes the marker, the revoke's later delete removes it; if it follows the marker, the commit's
own read sees the marker. It uses only `read`/`write`/`destroy`, with one implementation.

**Where it holds, per store.**

| Store                                                         | Holds?                           | Why, and what the plan does                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store: 'memory'` (`MemorySessionStore`)                      | yes                              | one process, no eviction; single-replica only (already documented)                                                                                                                                                                                                                     |
| `store: 'cache'` over cache-plugin Redis, `noeviction` policy | yes                              | one primary is linearizable                                                                                                                                                                                                                                                            |
| `store: 'cache'` over Redis with an evicting policy           | no                               | `volatile-*` evicts keys with a TTL (every marker has one), `allkeys-*` evicts anything; a lost marker reverts that revocation to today's behaviour. README: use `noeviction` (or a dedicated instance) for sessions; test drives an evicted marker and asserts the documented outcome |
| `store: 'cache'` over cache-plugin `MemoryStore`              | no                               | LRU at `maxSize` (default 1000) evicts the coldest entry — a marker — and live sessions too. README names it development-only for sessions (the plugin cannot see the cache's bound through `ICacheStore`, so the README carries it)                                                   |
| `KvSessionStore` / `KvCacheStore` (Workers KV)                | no                               | eventually consistent; §0.2 X7 documents it in the Cloudflare README                                                                                                                                                                                                                   |
| Application `ISessionStore`                                   | if linearizable and non-evicting | the README states both preconditions, and that ids are arbitrary strings (markers use `revoked:<uuid>`/`superseded:<uuid>`) and a marker's payload is `{ "__setu_marker": "revoked" }`                                                                                                 |
| Cookie strategy, cookie-held sessions                         | n/a                              | no row exists; documented as before                                                                                                                                                                                                                                                    |

### 3.1 Markers

- **Decision:** a private `#revoke(id, kind)` in `SessionService` replaces `#destroyStored`. `kind`
  is `'revoked'` (from `destroy()` and from a demotion to cookie-held, which is a logout) or
  `'superseded'` (the old id of a `regenerate()`, including `revokeSuperseded` on a throw). It
  writes `store.write(kind + ':' + id, { __setu_marker: kind }, config.maxAgeMs)`, then
  `store.destroy(id)`. A marker counts only when its payload carries the matching `__setu_marker`
  value, so a store that drops empty payloads cannot make the fence pass silently. **Markers are
  written only for an id that had a row**: the loaded id when the session was restored store-held,
  and `previousId` only when the request's source session was store-held. A new session, a
  cookie-held session and the never-written id after `regenerate()` get no marker and no delete
  call, so anonymous `POST /logout` traffic writes nothing (the M113e rule at
  `session-service.ts:264-268` holds). If the marker write throws, the row delete is still attempted
  and then the error propagates (no weaker than today's plain delete); if the delete throws after
  the marker, the marker stands and still fences every commit and restore. Marker TTL is `maxAgeMs`.
- **Why:** a separate id cannot be overwritten by the racing commit, which is what made option D
  useless; two kinds let a regenerating commit tell "my source was logged out" from "my source was
  superseded by me" (§3.2).
- **Test home:** `test/integration/revocation-race.test.ts` (V13-135, V13-136 probes inverted);
  `test/unit/services/session-revoke.test.ts` (order; marker-write failure still deletes the row and
  rethrows; delete failure keeps the marker; no marker for a new, cookie-held or never-written id; a
  payload without `__setu_marker` does not count).

### 3.2 Commit fence

- **Decision:**
  - A commit that writes a row for the id the request **loaded from the store** reads both markers
    of that id after its write; when one is present it deletes the row, sends **no `Set-Cookie`**
    (and no clearing cookie, which would wipe the new cookie a `regenerate()` just gave the
    browser), and returns `'refused'`.
  - A **regenerating** commit whose source was store-held reads `revoked:<previousId>` before doing
    anything; if present it refuses (no supersede, no new row, no `Set-Cookie`). Otherwise it writes
    `superseded:<previousId>`, deletes the old row, writes the new id, and then reads
    `revoked:<previousId>` again; if a logout landed meanwhile it deletes the new row and refuses.
    This stops an in-flight `regenerate()` (a step-up or sign-in) carrying a logged-out session's
    data to a fresh id.
  - Writes to a fresh id with no store-held source (new session, promotion's `rotateId`) have no
    fence: no other request can hold it.
  - If a fence read throws, the commit deletes its own write best-effort and rethrows.
  - A refused commit logs one `debug` line ("session commit refused: the session was revoked or
    superseded during this request"), carrying no id.
  - `commit(ctx, session, policy?)` returns `Promise<SessionCommitOutcome>`
    (`'written' | 'refused' | 'skipped'`; was `Promise<void>`). `policy?: SessionCommitPolicy` is
    optional and defaults to today's behaviour (both commits allowed), so an existing caller is
    unaffected; it is computed by the middleware from the response (§3.6): whether a refresh-only
    commit and a reserved-keys-only new session may commit on this response. The middleware decides
    `'skipped'`; the service applies it.
- **Why:** closes V13-135 and V13-136 including the `rolling` read-only case and the in-flight
  regenerate, and stops a racing response from re-planting the pre-login cookie.
- **Test home:** `revocation-race.test.ts` (50 runs each for destroy-vs-write, destroy-vs-rolling
  read, regenerate-vs-write, **destroy-vs-regenerate**: 0 resurrections, no signed-in new id, no
  `Set-Cookie` on the racing response); `session-revoke.test.ts` (fence read throws → own write
  deleted, error rethrown; debug line carries no id).

### 3.3 The remaining window, and an opt-in restore check

- **Decision (maintainer, Q1):** by default a restore does **not** read the markers; the cost of the
  design falls only on requests that commit, as in the frameworks that close this race. The one
  window this leaves is documented in the README and measured by a test: a request that **starts**
  after `destroy()` returned can restore the row during the one store round trip between a racing
  commit's write and its fence delete. New option `restoreRevocationCheck: boolean`, default
  `false`: when `true`, a store-held restore reads both markers of its id in parallel with the row
  (`Promise.all`) and treats a present marker as no session, the same path as a missing row
  (`session-service.ts:365-370`); `fromHeaders` runs the same restore. A marker read that throws
  propagates as a row-read fault does today. Consumer: an application that must guarantee no request
  starting after a sign-out is served signed in (a bank, an admin console), at two extra keys read
  per store-held restore (twice for a request authenticated by auth-plugin's session strategy, which
  restores through `fromHeaders` as well). Setting it without a `store` throws a `TypeError`, like
  `storeCommit`. Always, whatever the option: a snapshot whose id starts `revoked:` or `superseded:`
  is refused before any store read (no cost).
- **Why:** the window is one round trip and only reachable while a request from before the sign-out
  is committing; an application that needs it closed can pay for it.
- **Test home:** `revocation-race.test.ts` ("window" case, store double paused after a racing write:
  with the default a request started after `destroy()` returned restores the session — the measured
  window; with `restoreRevocationCheck: true` it restores nothing);
  `test/unit/session-from-headers.test.ts` (with the option: marker → `null`, marker read throws →
  rejects); `options.test.ts` (default `false`; `TypeError` without a store).

### 3.4 Store commits write the request's changes (V13-137)

- **Decision:** `Session` records its changes (`set`/`delete` per key, and whether `clear()` ran).
  New option `storeCommit: 'changes' | 'snapshot'`, default `'changes'`. In `'changes'` mode a
  commit to a loaded store-held id reads the current row; a missing row refuses the commit exactly
  like the fence; otherwise it writes `current` with this request's changes applied (a `clear()`
  writes this request's payload whole), the cookie-held decision is made on that merged payload, and
  the fence follows. In `'snapshot'` mode it writes the request's whole payload (today's behaviour)
  followed by the fence. Regenerated and new ids always write the whole payload. `storeCommit`
  without a `store` throws a `TypeError` at registration naming the option (as the other option
  checks do, `options.ts:236-308`). A `rolling` refresh in `'changes'` mode rewrites the current
  row.
- **What it does not give:** per-key last writer wins, so K concurrent read-modify-writes of one key
  still keep 1 in both modes; disjoint keys can still be lost when two commits interleave between
  one's read and its write (one round trip, against a whole request today). The README says exactly
  this.
- **Why:** the merge stops a request overwriting keys it never touched and makes a key deleted by a
  concurrent request stay deleted. `'snapshot'` stays for an application whose keys must change
  together. Default `'changes'` (maintainer, Q2; Spring Session's default).
- **Test home:** `test/integration/store-commit-modes.test.ts`, driven with a store double that
  orders the reads and writes explicitly (not scheduling): `'changes'` keeps disjoint keys when the
  commits do not interleave, loses one when they do (asserted, documented), keeps a concurrent
  delete, writes `clear()` whole, refuses on a missing row, rewrites the current row on a rolling
  refresh; `'snapshot'` reproduces today. `options.test.ts` (default; `TypeError` without a store);
  `session.test.ts` (change tracking).

### Design 2 — which responses are marked private

**Options compared.**

| Layer                                     | What it can see                                                                                    | Verdict                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| React Router plugin: every page `private` | only that a page rendered, not whether it depends on a visitor                                     | Rejected: makes every anonymous marketing page uncacheable, and misses REST routes, Swagger UI and any non-SSR page that reads the session    |
| Starter or template middleware            | the same as the application                                                                        | Rejected: an application composed without the starter (the REST template with sessions) stays exposed, and the fix becomes a line to remember |
| **Session plugin, around the handler**    | whether a session was restored and what it held, whether it commits, whether a CSRF token was read | **Chosen**: the only layer that knows a response is tied to a cookie-identified visitor, on every route kind, with one implementation         |

### 3.5 What marks a response as per-visitor

- **Decision:** a response is **per-visitor** when any of these signals holds:
  - **S1** — the request restored a session holding any key other than the reserved cookie-held keys
    (a signed-in visitor, or one carrying application data). Known at load, so it is applied
    **before** `next()` (§3.6) and covers a session read late (a deferred loader) and in-process
    caches registered inside the session middleware.
  - **S2** — the response carries the session `Set-Cookie` (a written commit or a destroy).
  - **S3** — a CSRF token was read for this request (`getCsrfToken`, `csrfTokenField`), recorded on
    the `Session` object.

  A response is **session-dependent** when an application-visible read of a non-reserved key
  happened (`get`, `has`, or `toJSON()` through the `ISession` the request sees) while no signal
  holds: it is the anonymous variant of a page. What counts:

  | Read                                                                                                                  | Counts as a read                                                                                                                       |
  | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
  | Application `get`/`has`/`toJSON` of a non-reserved key                                                                | yes                                                                                                                                    |
  | auth-plugin reads through `from(ctx)` (`auth-session-service.ts:483,554`, `pending-state.ts:66`, `ceremonies.ts:422`) | yes: the response depends on who is signed in                                                                                          |
  | `tenantBindingMismatch`, `readTenantBinding`, `readCsrfToken` (reserved keys)                                         | no                                                                                                                                     |
  | The service's own `toJSON()`/`snapshot()` during commit (`session-service.ts:254`)                                    | no (internal accessors that do not track)                                                                                              |
  | `fromHeaders` (auth strategies)                                                                                       | no: it opens a separate view with no request to mark; a signed-in request is already S1, and an anonymous one is the anonymous variant |

  The tenant-mismatch 403 (`session-middleware.ts:74-80`) is answered with `private, no-store`.

- **Why:** S1 covers V13-111 (the leak), S3 covers V13-112 (a returning visitor's `/login` has no
  `Set-Cookie`), S2 covers a cached response replaying one visitor's cookie to everyone. An
  anonymous visitor holding only a cookie-held CSRF session is not per-visitor on a page that does
  not read the token, which keeps anonymous pages cacheable once the template stops minting eagerly
  (§0.2 X1).
- **Test home:** `test/unit/services/cache-marking.test.ts` (each signal, and each row of the read
  table); `session.test.ts` (read tracking excludes internal accessors).

### 3.6 The headers it writes

- **Decision:** marking happens as early as each signal is known, so a cache inside the session
  middleware (`cacheMiddleware` registered on a route) sees it when it captures the response:
  - **Before `next()`:** when S1 holds, set `Cache-Control: private, no-store`, whatever directive
    an outer middleware set, and remember the value written; `Vary: Cookie` follows at the first
    application read or after the handler.
  - **At the moment of the read:** `getCsrfToken` sets `Cache-Control: private, no-store` and
    appends `Vary: Cookie` on `ctx.response` when it returns a token (S3).
  - **At the first write:** the middleware gives the request's `Session` a first-write hook; the
    first `set`/`delete`/`clear` of a non-reserved key, a `regenerate()` or a `destroy()` sets the
    same headers at once (the response will carry the session cookie, S2). Writes of reserved keys
    (the CSRF mint, the tenant seal after the handler) do not fire it.
  - **React Router:** `request-bridge.ts` copies `Cache-Control` with `header()` (replace) instead
    of `appendHeader()`, so a route's `headers` export replaces the plugin's value instead of
    merging into it; every other header keeps `appendHeader()`.
  - **After the handler** (also on the exempt and no-commit paths), read `Cache-Control` from
    `ctx.response.snapshot().headers`. A value equal to one the plugin wrote is the plugin's own;
    anything else present is the application's. A directive is **shared-storable** when present and
    containing neither `private` nor `no-store`. "Read" below means an application-visible read
    (§3.5). Then:

  | Situation                                                                                           | Action                                                                                 |
  | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | No application directive, S2 or S3 holds                                                            | `Cache-Control: private, no-store`, `Vary: Cookie` (appended, never duplicated)        |
  | No application directive, session-dependent only                                                    | `Vary: Cookie` only                                                                    |
  | Shared-storable directive, commit would be a refresh only (`rolling`/`idleTimeoutMs`)               | refresh skipped (`'skipped'`): no `Set-Cookie`; the next non-public response refreshes |
  | Shared-storable directive, new session holding only reserved keys (CSRF mint, tenant seal)          | not committed (`'skipped'`): a public asset stays public on a first tenant visit       |
  | Shared-storable directive, commit is dirty with application data, regenerated or a destroy          | directive replaced by `private, no-store`, `Vary: Cookie`                              |
  | Shared-storable directive, S1 only (no S2, no S3, no read) — a public asset for a signed-in visitor | directive kept; the `Vary: Cookie` S1 added is removed; no warning                     |
  | Shared-storable directive, S3, or S1 with a read                                                    | directive kept; `Vary: Cookie` kept; the §3.7 warning                                  |
  | Shared-storable directive, session-dependent only                                                   | directive kept; `Vary: Cookie` appended                                                |
  | Any other present directive                                                                         | left as written                                                                        |
  | The request throws                                                                                  | headers already set stand; `respondWithError` keeps them (a test proves it)            |

- **Why:** `no-store` as well as `private` so a signed-in page is not kept in the browser's cache
  after sign-out on a shared computer. Respecting an explicit directive is how an application that
  deliberately caches a page says so (§3.7); the overrides and skips exist because no explicit
  directive can make a session `Set-Cookie` safe to share. Removing S1's `Vary` from a public asset
  keeps assets cacheable for signed-in visitors.
- **Test home:** `cache-marking.test.ts` (each row above); `session-middleware.test.ts` (S1 before
  `next()`, the first-write hook and the CSRF read each visible to an inner middleware at capture
  time; reserved writes do not fire the hook; marking on exempt and no-commit paths; throw path);
  `react-router-plugin/test/unit/request-bridge.test.ts` (extended: `Cache-Control` replaces, other
  headers and `Set-Cookie` still append); `test/e2e/private-responses.test.ts` (real kernel app,
  both strategies: the §0.1 probes inverted; an asset route with
  `public, max-age=31536000, immutable` under `rolling` and under a tenant seal keeps its directive,
  gets no `Set-Cookie`, no `Vary: Cookie` and logs nothing; an error thrown on a signed-in route
  answers `private, no-store`).

### 3.7 An application that deliberately caches a page

- **Decision (maintainer, Q5):** no new option. The application sets its own `Cache-Control` (a
  React Router route's `headers` export, which now replaces the plugin's value, §3.6; or
  `ctx.response.header(...)` in a handler or an application middleware). The plugin leaves an
  application directive alone except in the `Set-Cookie` cases of §3.6. When it keeps a
  shared-storable directive on a response that S3 marks, or that S1 marks and the handler read the
  session for (the table rows of §3.6 that say "the §3.7 warning"), it logs **one `warn` per
  route**:
  - message
    `session-plugin: a per-visitor response carries a shared-cacheable Cache-Control set by the application`,
    fields `{ method, route, signal: 'session' | 'csrf-token' }`;
  - `route` is the request path with each value of `ctx.request.params` replaced by `:<name>`
    (`/orders/123` → `/orders/:id`), so no identifier from the path reaches the log, and is cut to
    200 characters; it never carries the query, the directive's values, the session id or a cookie;
  - the set of `method route` keys already warned about holds at most 1,000 entries of at most 210
    characters each (about 210 KB); when it is full one more `warn`
    (`session-plugin: further shared-cacheable-directive warnings suppressed`) is logged and no
    others, so an attacker varying paths cannot grow it;
  - no logger registered → nothing logged.

  The README gives the recipe: cache the anonymous variant with `public, s-maxage=…` only when no
  session was restored (it still carries `Vary: Cookie`, so a CDN keys it apart and
  `cacheMiddleware` does not store it, §3.12), read the CSRF token in a loader rather than in
  deferred data, and register `cacheMiddleware` outside the session middleware where possible.

- **Why:** a developer who writes `public` on a signed-in page has made a decision the framework can
  document and point out, but not guess.
- **Test home:** `private-responses.test.ts` (explicit `public, s-maxage=60` set for an anonymous
  visitor is kept with no warning and with `Vary: Cookie` when the session was read; the same page
  for a signed-in visitor that reads the session is kept and warns once across three requests; the
  same page with a dirty commit becomes `private, no-store`);
  `full-stack-starter/test/integration/private-pages.test.ts` (a React Router route's `headers`
  export `public, s-maxage=60` replaces the plugin's value and warns once); `cache-marking.test.ts`
  (route templating from params, the 200-character cut, the 1,001st distinct route logs the
  suppression line once and the 1,002nd logs nothing, fields carry no id, path value or query).

### 3.8 Security headers and CORS run before every refusal (V13-34)

- **Decision:** security headers move from priority 250 to **10**, CORS from 200 to **125**. IP
  resolution stays 120, request size 180, origin CSRF 270. Both set their headers before `next()`,
  so every response produced downstream, the request-size 400 and 413 included, carries them.
  Security headers at 10 also cover refusals at 40 (tenant) and 45 (locale), and an error response
  the error handler (0) builds from a throw anywhere after 10. CORS stays after IP resolution (an
  origin matcher may read the resolved origin or client address) and after request logging (100).
- **Why:** rejected alternative — keep the priorities and have each refusal add the headers itself:
  that covers only this plugin's two refusals and duplicates the CORS decision. Renumbering approved
  by the maintainer (Q3), with an upgrade note.
- **Test home:** `packages/http-security-plugin/test/integration/refusal-headers.test.ts` (413 and
  400 carry `access-control-allow-origin`, `vary: Origin`, `x-content-type-options`, HSTS; a
  disallowed origin gets no CORS header; a preflight still 204s; an origin matcher sees the resolved
  client address); `test/unit/http-security-plugin.test.ts` (registered priorities).

### 3.9 A missing asset starts no session (V13-20, session half)

- **Decision:** a **new** session holding only reserved keys is not committed on a `404` to a
  request that is not a document navigation. A navigation is `Sec-Fetch-Dest: document`, or, when
  `Sec-Fetch-Dest` is absent (Safari before 16.4), an `Accept` that includes `text/html`.
  Application data written during the request still commits. This is applied through the same commit
  `policy` as §3.6, and the response is still marked (a token read makes it `private, no-store`).
- **Why:** removes the session a framework mint or tenant seal creates for `/favicon.ico` or a stale
  asset URL, without path heuristics that would break a resource route like `/sitemap.xml`, and
  without dropping application writes.
- **Test home:** `cache-marking.test.ts` (the policy: 404 + image fetch → skip; 404 + document
  navigation → commit; 404 without `Sec-Fetch-Dest` and `Accept: text/html` → commit; 404 +
  application write → commit) and `private-responses.test.ts` (the same four through a kernel app,
  asserting `Set-Cookie`).

### 3.10 Swagger UI Try-it-out sends the CSRF token (V13-60)

- **Decision (maintainer, Q6):** the bundled Swagger UI sends the CSRF token on its unsafe
  Try-it-out requests; cookies are left as Swagger UI sends them and the bearer exemption is
  unchanged.
  - **Accessor (new `common` file, additive).** `packages/common/src/services/csrf-token-access.ts`
    exports `CSRF_TOKEN_ACCESS_STATE_KEY = 'session-plugin:csrf-token-access'` and
    `interface ICsrfTokenAccess { readonly headerName: string; tokenForExistingSession(): string | undefined }`.
    `csrfFormMiddleware` publishes a frozen per-request accessor under that key, beside the
    `CSRF_CONFIG_STATE_KEY` it already writes before its short-circuits. `tokenForExistingSession()`
    returns `getCsrfToken(ctx)` (minting if absent) **only when the request restored a session**
    (`isNew === false`); for a new session it returns `undefined` and mints nothing.
  - **Token route.** openapi-plugin, when the UI is on, registers `GET <ui path>/csrf-token`
    (`schema.excludeFromDocument: true`). With an accessor and a token it answers
    `200 {"headerName": …, "token": …}` (S3 then makes it `private, no-store`). With no accessor (no
    form CSRF), or no existing session, it answers `204` with `Cache-Control: no-store` and sets
    `CSRF_EXEMPT_STATE_KEY`, so it commits no session.
  - **No session from the docs pages.** The Swagger UI page, the spec JSON and the self-hosted asset
    routes set `CSRF_EXEMPT_STATE_KEY` (safe-method reads that never need a session), so none of
    them commits a session: an anonymous visitor gets no `Set-Cookie` from the docs (V13-60's first
    half), and a signed-in visitor's rolling refresh waits for the next ordinary request.
  - **Interceptor.** An internal TypeScript function (`src/ui/swagger-interceptor.ts`, not exported
    from `index.ts`) embedded through `Function.prototype.toString()`. It acts only when
    `new URL(req.url, location.href).origin === location.origin` **and** the uppercased method is
    outside `GET`/`HEAD`/`OPTIONS` (Try-it-out's method is lowercase); then it awaits
    `fetch(tokenUrl, { credentials: 'same-origin' })`, and on `200` sets the named header. On `204`,
    a fetch failure, a cross-origin URL (an OAuth2 `tokenUrl` at an outside provider, a `servers`
    entry on another origin) or a safe method it leaves the request unchanged and fetches nothing.
    The token URL is written into the page from the plugin's own route (normalised when the UI
    endpoint ends in `/`), never from the query string.
  - **Assets served elsewhere.** With `assets: { baseUrl }` the Swagger assets are served by the
    application, not openapi-plugin, so the exemption does not reach them; the README says so.
- **Why:** other frameworks' bundled UIs send the token; a same-origin request carries the session
  cookie whatever `withCredentials` says, so the token is what makes it pass. A visitor with no
  session sends no cookie, so a header-authenticated call is exempt as today; a visitor with a
  session presents its token; a cookie-authenticated `POST` now works from Swagger UI too. The token
  route never starts a session, so V13-20 is not reopened.
- **Test home:** `packages/openapi-plugin/test/unit/swagger-interceptor.test.ts` (same-origin
  lowercase `post` + `200` → header set with the served name; `GET` → no fetch; cross-origin `post`
  → no fetch, unchanged; `204` → unchanged; fetch rejects → unchanged); `swagger-ui.test.ts` (page
  embeds the interceptor and the token URL); `test/integration/csrf-token-route.test.ts` (with
  `SessionPlugin` as a dev dependency: no cookie → `204`, `no-store`, no `Set-Cookie`; restored
  session without a token → `200`, token minted, `Set-Cookie`, `private, no-store`; restored session
  with a token, with `rolling` and `idleTimeoutMs` unset → same token, no `Set-Cookie`; no form CSRF
  → `204` with `Cache-Control: no-store`; docs page, spec and assets commit no session for an
  anonymous and a tenant-sealed request); `session-plugin/test/unit/csrf/csrf.test.ts` (accessor
  published, frozen, returns `undefined` and mints nothing for a new session);
  `test/e2e/swagger-try-it-out.browser.test.ts` (real Chromium through Playwright, guarded: §7).

### 3.11 Documentation in the lane

- **Decision:** `session-plugin` README: revocation guarantee, its preconditions, the store table,
  the one-round-trip window and `restoreRevocationCheck`; `storeCommit` and what it does not give;
  the caching rule, the read table, the public-directive warning and the deliberate-caching recipe;
  the 404 rule; the token accessor; the new neighbour priorities. `http-security-plugin` README:
  priorities and why. `openapi-plugin` README: Try-it-out, the token route, docs routes commit no
  session. `cache-plugin` README: what `cacheMiddleware` now refuses and the credentialed-request
  rule, `credentialCookies`, and registering it outside the session middleware.
  `react-router-plugin` README: one paragraph pointing pages to the session plugin's caching rule
  and the `headers` export. The two JSDoc priority comments (C5). `docs/plugin-architecture.md` and
  `ARCHITECTURE.md` priority tables. `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` (an
  upgrade note for each: the two priorities, `storeCommit` default, `Cache-Control` now sent,
  `cacheMiddleware` no longer storing credentialed or private responses, Redis eviction advice, docs
  routes no longer committing).
- **Why:** each claim must match the code it describes.
- **Test home:** `pnpm run check:docs`; docs-claims review before the PR.

### 3.12 `cacheMiddleware` stores nothing per-visitor (V13-111, maintainer Q7)

- **Decision:** in `packages/cache-plugin/src/middleware/cache-middleware.ts`, in this order:
  1. **`bypass`** as today.
  2. **Credentialed check.** A request is credentialed when it carries `Authorization`, or a
     `Cookie` header holding a cookie that counts: by default any cookie; with the new option
     `credentialCookies: readonly string[]`, only the named ones (`[]` means only `Authorization`
     counts). Q8 settled this default after a comparison (§10).
  3. **Credentialed request:** never leads and never joins the coalescer. It is replayed a HIT only
     from an entry whose stored `Cache-Control` contains `public` and whose `Vary` names neither
     `Cookie`, `Authorization` nor `*`; otherwise it runs the origin itself, and its response is
     stored only when that response's `Cache-Control` contains `public`, its `Vary` names none of
     them, **and** it passes step 5.
  4. **Other requests:** lookup and coalescing as today.
  5. **Response refusals,** for every request, before any store: `Cache-Control` containing
     `private` or `no-store`; and, as today, streaming, a non-cacheable status and `Set-Cookie`. A
     refused leader's joiners run their own origin, as today. The `key` and `vary` options are
     unchanged. A response whose `Vary` names `Cookie` or `Authorization` is stored only from a
     request carrying no cookie and no `Authorization` at all, so the entry is the cookie-less
     variant, and it is served only to such a request: a request that `credentialCookies` leaves
     uncredentialed but that carries some cookie skips such entries and the coalescer, without the
     `public` rule. A `Vary: *` response is never stored (RFC 9111 §4.1). A session-dependent
     anonymous page carries `Vary: Cookie` (§3.6), so it is cached in-process for cookie-less
     visitors only; the README says so. (Amended 2026-11-22, decision A below: as first written,
     step 5 refused every `Vary: Cookie` response, which stopped `cacheMiddleware` caching anything
     in a localized application, whose locale middleware adds `Vary: Accept-Language, Cookie` by
     default.)
- **Why:** the page is safe whoever marked it — the session plugin, the application, or nothing —
  which is RFC 9111 §3.5's rule for `Authorization` widened to cookies. The cache-plugin cannot know
  the session plugin's cookie name, so the safe default counts any cookie; `credentialCookies` is
  for an application whose anonymous visitors carry unrelated cookies (analytics, consent). This
  widens Q7's "a session cookie" to "any cookie by default" — Q8.
- **Test home:** `packages/cache-plugin/test/unit/cache-middleware.test.ts` (extended: each refusal;
  credentialed by `Authorization`, by any cookie, by a named cookie with `credentialCookies`, not by
  an unnamed cookie with it, only by `Authorization` with `[]`; credentialed HIT replayed only from
  a `public` entry; a credentialed request never leads or joins a coalesced flight; a credentialed
  `public` response without `Vary: Cookie` (a bearer API, no session plugin) is stored; one with
  `Vary: Cookie` is not; a `public` response varying on `Cookie` or `Authorization` stored from a
  cookie-less request is replayed to cookie-less requests and never to a credentialed one, with the
  Vary check as its negative control; with `credentialCookies` narrowed, a `Vary: Cookie` entry is
  never stored from or served to a request carrying an unnamed cookie, with the cookie check as its
  negative control; a `Vary: *` response is never stored; anonymous behaviour unchanged;
  `packages/localization-plugin/test/integration/cache-vary.test.ts` passes unchanged);
  `test/integration/cache-per-visitor.test.ts` (kernel app with `SessionPlugin` as a dev dependency,
  cache inside and outside the session middleware: a signed-in read is never replayed to another
  visitor or to an anonymous one; with the cache inside, an anonymous cookie-less token-minting
  `GET` and an anonymous write are not stored; an anonymous page that does not touch the session is
  still cached and replayed).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `ISessionStore`, `ICacheStore` and every other published
interface are unchanged; the `common` addition is a new file. Observable behaviour changes (two
middleware priorities, new response headers, `storeCommit` default, a refused racing commit, marker
entries in the store, `SessionService.commit` taking an optional policy and returning an outcome
instead of `void`, `cacheMiddleware` no longer storing credentialed or private responses, docs
routes no longer committing a session) are documented in `docs/upgrading.md` and ship in `0.14.0`.

| Exported symbol                                                           | Kind                    | Consumer / real code path that READS it                                                              |
| ------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `CSRF_TOKEN_ACCESS_STATE_KEY` (`@setu-ts/common`, new)                    | state key               | written by `csrfFormMiddleware`; read by openapi-plugin's token route (§3.10)                        |
| `ICsrfTokenAccess` (`@setu-ts/common`, new)                               | interface               | implemented by session-plugin's published accessor; called by openapi-plugin's token route           |
| `SessionPluginOptions.storeCommit`                                        | option (existing type)  | `resolveSessionConfig` → `SessionService.commit` branch (§3.4)                                       |
| `SessionPluginOptions.restoreRevocationCheck`                             | option (existing type)  | `resolveSessionConfig` → `SessionService` restore (§3.3)                                             |
| `CacheMiddlewareOptions.credentialCookies`                                | option (existing type)  | `cacheMiddleware`'s credentialed-request check (§3.12)                                               |
| `SessionService.commit` (optional policy, outcome)                        | method (existing class) | `sessionMiddleware` passes the policy and reads the outcome to decide `Set-Cookie`-dependent caching |
| `SessionCommitPolicy`, `SessionCommitOutcome` (session-plugin, new types) | types                   | the parameter and return type of the public `commit`; documented in `PUBLIC_API.md`                  |

No other new export. Marker ids and payloads, change and read tracking, the first-write hook, the
warning bound and the Swagger interceptor are internal.

### 4.1 Options — every option names its consumer

| Option                                    | Consumer                                 | Behavior (per implementation)                                                                                           |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `storeCommit: 'changes'` (default)        | `SessionService.commit`, store strategy  | memory, cache and application stores: read current row, apply this request's changes, write, fence; missing row refuses |
| `storeCommit: 'snapshot'`                 | `SessionService.commit`, store strategy  | every store: write this request's payload, fence                                                                        |
| `restoreRevocationCheck: false` (default) | `SessionService` restore, store strategy | no marker read at restore; the one-round-trip window of §3.3 stays                                                      |
| `restoreRevocationCheck: true`            | `SessionService` restore, store strategy | every store-held restore reads both markers in parallel with the row; a marker → no session; a read fault propagates    |
| a session option above with no store      | `resolveSessionConfig`                   | `TypeError` naming the option and that it applies only to the store strategy                                            |
| `credentialCookies` (default: any cookie) | `cacheMiddleware`                        | only the named cookies make a request credentialed; `Authorization` always does                                         |

## 5. Implementation files

| File                                                                                                                                                | Purpose                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/common/src/services/csrf-token-access.ts` (new) + its export line in `packages/common/src/index.ts`                                       | `CSRF_TOKEN_ACCESS_STATE_KEY`, `ICsrfTokenAccess`                                                      |
| `packages/session-plugin/src/services/session-service.ts`                                                                                           | `#revoke`, fences, opt-in restore check, `storeCommit` modes, commit policy and outcome, debug line    |
| `packages/session-plugin/src/services/session.ts`                                                                                                   | change tracking, read tracking, CSRF-read flag                                                         |
| `packages/session-plugin/src/services/cache-marking.ts` (new, internal)                                                                             | S1 headers; after-handler decision; commit policy; public-directive warning with its 1,000-entry bound |
| `packages/session-plugin/src/middleware/session-middleware.ts`                                                                                      | applies S1 before `next()`, the decision after it on every path, the 403 marking, passes the policy    |
| `packages/session-plugin/src/middleware/csrf-form-middleware.ts`                                                                                    | publishes the token accessor                                                                           |
| `packages/session-plugin/src/csrf/token.ts`                                                                                                         | `getCsrfToken` records the read; the accessor's `tokenForExistingSession`                              |
| `packages/session-plugin/src/options.ts`                                                                                                            | `storeCommit`, `restoreRevocationCheck`, resolution and `TypeError`                                    |
| `packages/session-plugin/src/plugin/session-plugin.ts`                                                                                              | priority comment (C5)                                                                                  |
| `packages/http-security-plugin/src/plugin/http-security-plugin.ts`                                                                                  | priorities 10 and 125                                                                                  |
| `packages/openapi-plugin/src/plugin/openapi-plugin.ts`                                                                                              | token route; `CSRF_EXEMPT_STATE_KEY` on page, spec and asset routes                                    |
| `packages/openapi-plugin/src/ui/swagger-interceptor.ts` (new, internal)                                                                             | the interceptor function                                                                               |
| `packages/openapi-plugin/src/ui/swagger-ui.ts`                                                                                                      | embeds it and the token URL in the page                                                                |
| `packages/cache-plugin/src/middleware/cache-middleware.ts`                                                                                          | credentialed-request rule and the new refusals                                                         |
| `packages/cache-plugin/src/interfaces/index.ts`                                                                                                     | `credentialCookies` option                                                                             |
| `packages/react-router-plugin/src/handler/request-bridge.ts`                                                                                        | `Cache-Control` copied with `header()`                                                                 |
| READMEs of the five packages named in §3.11, `docs/plugin-architecture.md`, `ARCHITECTURE.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` | §3.11                                                                                                  |

`src/index.ts` of every package except `common`: unchanged. `errors.ts`: unchanged.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                    | Key assertions                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-plugin/test/integration/revocation-race.test.ts` (from the §0.1 probe) | `session-service.ts`                           | destroy-vs-write, destroy-vs-rolling read, regenerate-vs-write, destroy-vs-regenerate, 50 runs each: **0** resurrections on `MemorySessionStore` and `CacheSessionStore` over the memory cache; no `Set-Cookie` on the racing response; the window case with and without `restoreRevocationCheck`; an evicted marker gives the documented outcome |
| `session-plugin/test/integration/revocation-race-redis-real.test.ts` (guarded)  | `session-service.ts`, `cache-session-store.ts` | the same races against a real Redis cache store (skipped without `REDIS_URL`, like `store-anonymous-redis-real.test.ts`)                                                                                                                                                                                                                          |
| `session-plugin/test/unit/services/session-revoke.test.ts` (new)                | `session-service.ts`                           | §3.1–§3.3 order and failure of each step; no marker for new, cookie-held or never-written ids; marker payload check; prefixed id refused with no read; debug line has no id                                                                                                                                                                       |
| `session-plugin/test/integration/store-commit-modes.test.ts` (from the probe)   | `session-service.ts`, `session.ts`             | §3.4 with an ordering store double, both modes                                                                                                                                                                                                                                                                                                    |
| `session-plugin/test/unit/services/session.test.ts` (extended)                  | `session.ts`                                   | change and read tracking; internal accessors and reserved keys not counted; CSRF-read flag                                                                                                                                                                                                                                                        |
| `session-plugin/test/unit/services/cache-marking.test.ts` (new)                 | `cache-marking.ts`                             | S1–S3, the read table, every row of the §3.6 table, the §3.9 policy, the §3.7 warning (once per method and path, the 1,000-entry bound and the single suppression line, no id in the fields)                                                                                                                                                      |
| `session-plugin/test/unit/middleware/session-middleware.test.ts` (extended)     | `session-middleware.ts`                        | S1 before `next()` visible inside; exempt/no-commit paths marked; throw path; 403 marked; policy passed                                                                                                                                                                                                                                           |
| `session-plugin/test/unit/middleware/csrf-form-middleware.test.ts` (new)        | `csrf-form-middleware.ts`                      | accessor published before the short-circuits, frozen, carries the configured `headerName`                                                                                                                                                                                                                                                         |
| `session-plugin/test/e2e/private-responses.test.ts` (from the probe)            | middleware + service through a kernel app      | V13-111/V13-112 inverted on both strategies; anonymous no-cookie page unmarked; explicit `public` kept with one warning; asset under `rolling` and tenant seal keeps its directive and no `Set-Cookie`; error on a signed-in route private; §3.9                                                                                                  |
| `session-plugin/test/unit/session-from-headers.test.ts` (extended)              | `session-service.ts`                           | with `restoreRevocationCheck`: marker → `null`; marker read throws → rejects; without it: no marker read                                                                                                                                                                                                                                          |
| `session-plugin/test/unit/options.test.ts` (extended)                           | `options.ts`                                   | defaults `'changes'` and `false`; `TypeError` for each without a store                                                                                                                                                                                                                                                                            |
| `session-plugin/test/unit/csrf/csrf.test.ts` (extended)                         | `csrf/token.ts`                                | read recorded for minted and existing tokens; `tokenForExistingSession` mints for a restored session, returns `undefined` and mints nothing for a new one                                                                                                                                                                                         |
| `session-plugin/test/integration/plugin-registration.test.ts` (extended)        | `plugin/session-plugin.ts`                     | registered priorities unchanged (260, 325)                                                                                                                                                                                                                                                                                                        |
| `common/test/unit/csrf-token-access.test.ts` (new)                              | `services/csrf-token-access.ts`                | the key's value and its export from the barrel (`barrel-exports` table)                                                                                                                                                                                                                                                                           |
| `auth-plugin/test/integration/sign-out-race.test.ts`                            | (consumer proof)                               | `signOut` on the store strategy with an overlapping request: the copied cookie is signed out (JSDoc claim)                                                                                                                                                                                                                                        |
| `starters/full-stack-starter/test/integration/private-pages.test.ts`            | (composition proof)                            | through the `loadRequestHandler` seam: signed-in document and `.data` answer `private, no-store`; anonymous page without a token read is not marked                                                                                                                                                                                               |
| `http-security-plugin/test/integration/refusal-headers.test.ts` (from probe)    | `http-security-plugin.ts`                      | §3.8                                                                                                                                                                                                                                                                                                                                              |
| `http-security-plugin/test/unit/http-security-plugin.test.ts` (extended)        | `http-security-plugin.ts`                      | priorities 10 and 125                                                                                                                                                                                                                                                                                                                             |
| `openapi-plugin/test/unit/swagger-interceptor.test.ts` (new)                    | `swagger-interceptor.ts`                       | §3.10 interceptor cases                                                                                                                                                                                                                                                                                                                           |
| `openapi-plugin/test/unit/swagger-ui.test.ts` (extended)                        | `swagger-ui.ts`                                | page embeds the interceptor and the token URL                                                                                                                                                                                                                                                                                                     |
| `openapi-plugin/test/integration/csrf-token-route.test.ts` (new)                | `openapi-plugin.ts`                            | §3.10 token route and docs routes, through a kernel app with `SessionPlugin` (dev dependency)                                                                                                                                                                                                                                                     |
| `openapi-plugin/test/e2e/swagger-try-it-out.browser.test.ts` (new, guarded)     | (browser proof)                                | §7 browser proof                                                                                                                                                                                                                                                                                                                                  |
| `cache-plugin/test/unit/cache-middleware.test.ts` (extended)                    | `cache-middleware.ts`                          | §3.12 refusals and credentialed rule                                                                                                                                                                                                                                                                                                              |
| `cache-plugin/test/integration/cache-per-visitor.test.ts` (new)                 | `cache-middleware.ts` through a kernel app     | §3.12 with `SessionPlugin` (dev dependency), cache inside and outside the session middleware                                                                                                                                                                                                                                                      |
| `session-plugin/test/integration/concurrent-writes.test.ts` (changed)           | `session-service.ts`                           | the store case at line 71 pinned to `storeCommit: 'snapshot'` (today's behaviour), plus the same scenario under the `'changes'` default keeping both keys                                                                                                                                                                                         |
| `react-router-plugin/test/unit/request-bridge.test.ts` (extended)               | `request-bridge.ts`                            | `Cache-Control` replaces an existing value; other headers and each `Set-Cookie` still append                                                                                                                                                                                                                                                      |

Every fix's test is run once against `develop` first and shown failing (the §0.1 numbers).

## 7. Verification gates

```bash
git branch --show-current   # feat/m143a-sessions-shared-caches
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common session-plugin http-security-plugin openapi-plugin cache-plugin react-router-plugin auth-plugin full-stack-starter
flock /home/dkpaul91/.cache/setu-ts/locks/suite.lock pnpm run ci:local
flock /home/dkpaul91/.cache/setu-ts/locks/suite.lock pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Beyond the gates:

- **Browser proof of §3.10**, in real Chromium, not `inject()`:
  `openapi-plugin/test/e2e/swagger-try-it-out.browser.test.ts` drives a local app (kernel,
  `SessionPlugin` with form CSRF, `OpenApiPlugin`) through Playwright (`playwright` as an
  openapi-plugin dev dependency at the version already in the lockfile; the test skips with a named
  reason when Chromium is not installed, and is run, not skipped, before the PR). It proves: an
  anonymous visit to the docs page, the spec and the assets sets no cookie; a signed-in visitor's
  Try-it-out `POST` under form CSRF answers 2xx and carries `x-csrf-token`; the same with
  "Authorize" and a bearer token answers 2xx; with the interceptor removed it answers 403. Run on
  swagger-ui-dist 5.33.3 (the CDN pin) and on 5.0.0 (the floor of the `^5` peer range); the browser
  run also proves an OAuth2 password-flow authorize against a stub token URL on another origin
  carries no `x-csrf-token`; the run is also repeated by hand in the in-app browser and recorded in
  the PR.
- The X86 nginx cache harness re-run locally against the branch (expected 0 leaks of 16).
- A measurement of the §3.2–§3.4 commit cost, and of `restoreRevocationCheck`, on the memory and
  Redis cache stores.
- The committed-tree security audit of §10 in a fresh context, after verification and code review.

## 8. Risks & mitigations

- A non-linearizable or evicting store loses markers → the store table, README preconditions, an
  evicted-marker test asserting the documented outcome, and the Redis `noeviction` advice.
- A request running longer than `maxAge` that loaded the session before a revocation can outlive the
  marker → bounded by `maxAge` (default two hours); documented.
- Added store reads on committing requests (§3.2, §3.4) → measured in the PR; the restore read is
  opt-in (§3.3).
- Marker entries appear in an application store's listing → documented; they expire after `maxAge`.
- `private, no-store` on pages that were CDN-cached by accident → intended; upgrade note and the
  §3.7 recipe.
- Moving security headers to 10 and CORS to 125 changes what an application middleware between those
  numbers and the old ones sees → upgrade note; no first-party middleware reads them.
- `cacheMiddleware` stops caching any page requested with a cookie, by default → upgrade note and
  `credentialCookies`; the Cache API keeps storing per-visitor responses until M143o's half ships
  (§0.2 X6), so V13-111 closes only when both have shipped.
- The token route returns a CSRF token to any same-origin script → it serves only an existing
  session's own token, the same value its forms already embed; it is `private, no-store` and not
  readable cross-origin without a CORS grant to that origin.
- The React Router bridge now replaces `Cache-Control` instead of appending → a route that relied on
  two `Cache-Control` values merging gets the route's value; upgrade note.
- `Function.prototype.toString()` output of the built interceptor → a test asserts the embedded text
  is the compiled function, and the browser proof runs on the built package.

## 9. Out of scope

- CORS headers on tenant (40) and locale (45) refusals, which still run before CORS → not a row; a
  candidate for M143l if the maintainer wants it (security headers already cover them after §3.8).
- An atomic conditional write on `ISessionStore`/`ICacheStore` → a Core-lane contract change; not
  needed where the store table says the guarantee holds.
- Cookie-strategy revocation and merge → documented limits; `signIn.sessionStamp` (auth-plugin).
- The template and Cloudflare halves → §0.2.
- `HEAD` on `GET` routes (V13-113, M143i) and public-file validators (V13-114, M143l).

## 10. Design security review

**Status:** completed 2026-11-22, BEFORE implementation, from §3; revised after the first plan
review and again after the maintainer's decisions and the second review (§11). The committed-tree
audit checks the code against it.

**Reviewed flows.**

1. Sign-out on the store strategy: `POST /logout` → `destroy()` (or `auth-plugin` `signOut`) →
   commit → `revoked:` marker, row delete → clearing `Set-Cookie`, while other requests on the same
   cookie are in flight (including one that regenerates).
2. Sign-in and step-up: `regenerate()` → commit → `revoked:` pre-check → `superseded:` marker, old
   row delete → new row → `revoked:` post-check → new cookie, while a request on the old cookie is
   in flight.
3. Every store-held restore: cookie open → prefix check → row read (and, with
   `restoreRevocationCheck`, the markers in parallel).
4. Every commit: change merge or snapshot → write → fence → `Set-Cookie`.
5. Every response through the session middleware: S1 headers before `next()`; after it, the §3.6
   decision, the public-directive warning and the commit policy; the tenant-mismatch 403.
6. `cacheMiddleware`: credentialed check → HIT only from a `public` entry → origin → refusals →
   store.
7. Early refusals: request-size 400/413 after security headers (10) and CORS (125).
8. Swagger UI: docs page, spec and assets (no commit) → Try-it-out `POST` → interceptor fetches
   `GET <ui path>/csrf-token` → accessor → token header → form CSRF verifies.

**Assets.** A signed-in session (its id, `userId`, auth markers); the form-CSRF token; the page and
`.data` bodies of a signed-in visitor; responses held in `cacheMiddleware`'s store; the integrity of
a sign-out and of a regeneration; the session cookie itself; store capacity (markers, anonymous
sessions, the warning set).

**Attackers.**

- A thief holding a copy of a cookie taken before sign-out or before a step-up, who keeps requests
  in flight to race the revocation, including a request that regenerates.
- Any visitor behind the same shared cache (CDN, reverse proxy, `cacheMiddleware`) as a signed-in
  user.
- An anonymous visitor reaching a page cached with someone else's CSRF token (denial of sign-in).
- An anonymous client flooding `POST /logout`, asset URLs, the token route or distinct paths to grow
  the store, the warning set or evict markers.
- A cross-site page driving a victim's browser against the API, the token route or Swagger UI.
- A client sending a crafted `Content-Length` or oversized body.

**Approved budgets.** Store strategy: one marker read per commit to a loaded id, two for a
regenerating commit; one row read more in `'changes'` mode; one marker write per revocation of an id
that had a row; marker storage of one small entry per such revocation for `maxAge`; with
`restoreRevocationCheck` only, two marker keys read in parallel with the row on each store-held
restore (twice for a request authenticated by auth-plugin's session strategy). No added store cost
on non-committing requests by default, on the cookie strategy, for cookie-held sessions, or for
anonymous traffic. The warning set holds at most 1,000 method-and-path pairs.

**Obligations on the committed-tree audit.**

1. Race `destroy()` and `regenerate()` against overlapping requests that write, refresh (`rolling`,
   `idleTimeoutMs`) and regenerate, on the memory store, the cache store over the memory cache and
   over real Redis, 50 runs each: 0 restores of the old id once the racing commits finish, no
   signed-in new id derived from a logged-out session, no `Set-Cookie` on the racing response, the
   old CSRF token refused.
2. Drive a request that starts after `destroy()` returned while a racing commit is paused between
   its write and its fence: with the default it restores (the documented one-round-trip window, and
   only during the pause); with `restoreRevocationCheck` it restores nothing; after the fence, both
   restore nothing.
3. Fail each store step in turn (marker write, row delete, fence read, and with the option the
   restore marker read) and show each fails closed: an errored or refused request, never a restored
   revoked session once the fence ran, never a silent success of a sign-out whose marker was not
   written, and a marker-write failure still deleting the row.
4. Present a sealed cookie whose id is `revoked:<uuid>` or `superseded:<uuid>` (built with the test
   key ring): refused before any store read. A store returning `{}` for the marker id does not count
   as a marker.
5. Flood anonymous `POST /logout`, 404 asset requests and the token route: no store entry is written
   and no `Set-Cookie` is sent.
6. Evict a marker (bounded memory cache) during a race: the outcome is the one the README documents.
7. For S1, S2 and S3 on both strategies, prove `Cache-Control: private, no-store` and
   `Vary: Cookie`; prove S1's headers are visible to a middleware inside the session middleware;
   prove a shared-storable application directive never leaves with a session `Set-Cookie`; prove an
   anonymous, cookie-less, non-reading page is not marked and a session-dependent one gets
   `Vary: Cookie`; prove the marking on the exempt and no-commit paths, on a thrown error and on the
   tenant 403; drive the nginx harness (16 leak checks) to 0.
8. An application `public` on a per-visitor response: kept, one warning per route template, with no
   path value, query, id or cookie in it; a signed-in fetch of a public asset logs nothing and keeps
   no `Vary: Cookie`; 1,001 distinct routes log one suppression line and the set does not grow past
   1,000 entries of 210 characters.
9. Prove each "no" row of the read table neither marks a response nor hides a real read.
10. Prove the 404 rule skips only reserved-key-only new sessions on non-navigation requests (both
    navigation signals honoured; an application write still commits).
11. Prove `'changes'` keeps a concurrently deleted key deleted and refuses on a missing row.
12. A cache inside the session middleware sees the marking at capture time for each signal: S1
    (before `next()`), S3 (at the token read) and S2 (at the first write); a reserved-key write does
    not fire the hook. `cacheMiddleware`, inside and outside the session middleware: a signed-in
    read, a bearer read and a cookie-carrying read are never stored and never replayed from a
    non-`public` entry; `private`, `no-store` and `Vary: Cookie`/`Authorization` responses are never
    stored; an anonymous page is still stored and replayed; `credentialCookies` narrows only the
    cookie half (`[]` leaves only `Authorization`); a credentialed request never leads or joins a
    coalesced flight.
13. 400 and 413 carry the security headers and, for an allowed origin only, the CORS headers; a
    preflight is unchanged; an origin matcher sees the resolved client address.
14. Swagger UI interceptor: it fetches the token and sets the header only for a same-origin request
    with an unsafe method in any case; an OAuth2 token request to another origin and a Try-it-out
    call to a `servers` entry on another origin carry no `x-csrf-token` and trigger no token fetch.
15. Swagger UI in real Chromium: the docs page, spec, assets and token route set no cookie for an
    anonymous visitor; the token route never mints for a new session; a signed-in Try-it-out `POST`
    passes form CSRF with the token header, with and without a bearer token; a cross-site page
    cannot read the token route (no CORS grant) and a cross-site form `POST` with the victim's
    cookie and no token is still refused 403; the bearer exemption rule is unchanged.
16. Each control in the table below has its negative control run: remove it and observe its probe
    fail.

**Findings table.**

| #   | Threat                                                              | Resolution (a claim the audit checks)                                                                                                                                                                                                                                                            | Negative control                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Sign-out undone by an in-flight commit (V13-135)                    | `revoked:` marker before the delete; every commit to a loaded id fences on it                                                                                                                                                                                                                    | remove the fence → 50/50 resurrections return                                                                                                                                                                                                                                                                                 |
| T2  | Regeneration undone; old CSRF token accepted again (V13-136)        | the superseded id gets a `superseded:` marker; commits to it fence                                                                                                                                                                                                                               | revert to a plain delete at the `previousId` site → 50/50 old cookie restores                                                                                                                                                                                                                                                 |
| T3  | In-flight regenerate carries a logged-out session to a new id       | regenerating commit pre- and post-checks `revoked:<previousId>`                                                                                                                                                                                                                                  | remove the post-check → destroy-vs-regenerate race yields a signed-in new id                                                                                                                                                                                                                                                  |
| T4  | Request started after sign-out restores during a racing write       | documented window by default; closed by `restoreRevocationCheck`                                                                                                                                                                                                                                 | with the option on, remove its read → the paused-write probe restores the session                                                                                                                                                                                                                                             |
| T5  | Racing response re-plants the pre-login cookie                      | a refused commit sends no `Set-Cookie`                                                                                                                                                                                                                                                           | send the cookie on refusal → probe sees the old id re-planted                                                                                                                                                                                                                                                                 |
| T6  | Store fault turns a sign-out into a silent success                  | marker first; failure still deletes the row and propagates; fence failure deletes own write                                                                                                                                                                                                      | swallow the marker-write error → 200 sign-out with the session alive                                                                                                                                                                                                                                                          |
| T7  | Restore marker read fault read as "no marker" (option on)           | the fault propagates like a row-read fault                                                                                                                                                                                                                                                       | catch it as absent → revoked session restores during a store fault                                                                                                                                                                                                                                                            |
| T8  | Marker id used as a session id, or empty marker passes              | prefixed ids refused at restore; marker counts only with its `__setu_marker` payload                                                                                                                                                                                                             | remove the prefix check / payload check → probe reaches the store / fence passes                                                                                                                                                                                                                                              |
| T9  | Anonymous traffic grows the store, evicting markers                 | markers only for ids that had a row; reserved-only new sessions skipped on 404 and public                                                                                                                                                                                                        | write markers for every id → anonymous logout flood writes entries                                                                                                                                                                                                                                                            |
| T10 | Signed-in page served to others by a shared cache (V13-111)         | S1 → `private, no-store`, `Vary: Cookie`, set before `next()`                                                                                                                                                                                                                                    | drop S1 → nginx harness leaks again; set it after `next()` → inner middleware sees none                                                                                                                                                                                                                                       |
| T11 | Login page cached with one visitor's CSRF token (V13-112)           | S3 → `private, no-store`                                                                                                                                                                                                                                                                         | drop S3 → returning `/login` unmarked                                                                                                                                                                                                                                                                                         |
| T12 | Shared cache replays a session `Set-Cookie`                         | dirty/destroy commit overrides a shared-storable directive; refresh and reserved-only skipped                                                                                                                                                                                                    | remove the override → `public` response carries `Set-Cookie`                                                                                                                                                                                                                                                                  |
| T13 | Anonymous variant served to a signed-in user                        | a session-dependent page always carries `Vary: Cookie` (with or without an application `public`); `cacheMiddleware` stores a `Vary: Cookie` response only for a cookie-less request and replays a credentialed request only from a `public` entry that does not vary on `Cookie`/`Authorization` | drop `Vary` → probe shows it absent; drop the replay check → signed-in user gets the anonymous entry                                                                                                                                                                                                                          |
| T14 | Marking missing on exempt, no-commit, thrown or 403 responses       | marking runs on every path through the middleware                                                                                                                                                                                                                                                | return early before marking → probe on each path unmarked                                                                                                                                                                                                                                                                     |
| T15 | Framework reads hide or fake a visitor dependence                   | the read table; internal accessors do not track                                                                                                                                                                                                                                                  | count reserved reads → every response gets `Vary: Cookie`                                                                                                                                                                                                                                                                     |
| T16 | Explicit `public` on a signed-in page goes unnoticed                | one bounded `warn` per route template; no path value, id or cookie in it; none for a public asset fetched by a signed-in visitor                                                                                                                                                                 | remove the warning → no log; remove the bound → 2,000 routes grow the set; log the raw path → an id reaches the log; drop the S1-only exception → an asset fetch warns                                                                                                                                                        |
| T17 | Lost concurrent writes resurrect a deleted key (V13-137)            | `'changes'` merges onto the current row; a missing row refuses                                                                                                                                                                                                                                   | force `'snapshot'` → a deleted `userId` returns; drop the missing-row check → rewrite                                                                                                                                                                                                                                         |
| T18 | In-process cache serves one visitor's page to another (V13-111)     | `cacheMiddleware` credentialed rule, coalescer exclusion and response refusals; `credentialCookies`                                                                                                                                                                                              | remove the credentialed check → signed-in read replayed to an anonymous visitor; remove the `private` refusal → a marked response is stored; remove the credentialed `Vary` check → a cookie-less entry is replayed to a cookie request; set `credentialCookies` wrongly to include nothing → probe shows the cookie half off |
| T19 | Cross-origin client cannot read a refusal (V13-34)                  | security headers at 10, CORS at 125                                                                                                                                                                                                                                                              | restore 250/200 → 413 loses the headers                                                                                                                                                                                                                                                                                       |
| T20 | Swagger UI cannot pass form CSRF (V13-60)                           | interceptor sends the existing session's token in the configured header                                                                                                                                                                                                                          | remove the interceptor → browser Try-it-out 403                                                                                                                                                                                                                                                                               |
| T21 | Token route starts sessions or leaks a token                        | mints only for a restored session; `204` with `no-store` and the exemption otherwise; `private, no-store`; no CORS grant                                                                                                                                                                         | let it mint for a new session → anonymous call sets a cookie; drop `no-store` on the `204` → probe sees it storable                                                                                                                                                                                                           |
| T22 | Docs pages start a session (V13-60 first half, V13-20)              | page, spec and asset routes set `CSRF_EXEMPT_STATE_KEY`                                                                                                                                                                                                                                          | remove it → anonymous tenant-sealed docs visit sets a cookie                                                                                                                                                                                                                                                                  |
| T23 | A missing asset mints sessions (V13-20)                             | reserved-only new session not committed on a non-navigation 404                                                                                                                                                                                                                                  | remove the rule → image 404 sets a cookie                                                                                                                                                                                                                                                                                     |
| T24 | Swagger UI sends the CSRF token to another origin                   | the interceptor acts only on same-origin unsafe requests                                                                                                                                                                                                                                         | drop the origin check → the stub OAuth2 token URL on another origin receives `x-csrf-token`                                                                                                                                                                                                                                   |
| T25 | A cache inside the session middleware stores before marking         | S3 marks at the token read; the first-write hook marks at the first application write                                                                                                                                                                                                            | move the marking back after the handler → an anonymous token-minting `GET` is stored and replayed                                                                                                                                                                                                                             |
| T26 | A skipped commit still sends the cookie, or a needed one is skipped | the commit policy: refresh-only and reserved-only new sessions skipped only on shared-storable responses; 404 rule                                                                                                                                                                               | ignore the policy → a public asset carries `Set-Cookie`; skip on every response → a dirty session on a public page is lost                                                                                                                                                                                                    |

**Maintainer decisions (2026-11-22, after a comparison with other frameworks).**

- **Q1** — no restore-time marker read by default; the commit fence stays; the read is the opt-in
  `restoreRevocationCheck`, and the one-round-trip window is documented and measured (§3.3).
- **Q2** — `storeCommit` defaults to `'changes'` (§3.4).
- **Q3** — security headers at 10 and CORS at 125, with an upgrade note (§3.8).
- **Q4** — this letter edits the priority tables in `docs/plugin-architecture.md` and
  `ARCHITECTURE.md`; the `rest.ts:79` comment is a V13-34 half for M143j (§0.2 X3).
- **Q5** — an explicit application `public` stays, with one bounded warning per method and path; the
  `Set-Cookie` exceptions stay (§3.7).
- **Q6** — Swagger UI sends the CSRF token through its `requestInterceptor`; cookies are not omitted
  and the bearer exemption is unchanged; the docs routes start no session; proved in a real browser
  (§3.10, §7).
- **Q7** — `cache-plugin` joins the Web lane (ROADMAP lanes table and the M143j and M143o half lists
  corrected in the same commit); `cacheMiddleware` refuses `private` and `no-store`, and treats a
  request with a cookie or `Authorization` as not shared-cacheable unless the response says `public`
  and does not vary on either (§3.12, as amended by decision A below); the Cache API and KV halves
  go to M143o (§0.2 X6, X7).

**Resolved after the third review.**

- **Q8** — `cacheMiddleware` cannot know the session plugin's cookie name, so §3.12 counts **any**
  cookie as a credential by default and adds `credentialCookies` to narrow it. Q7 said "a session
  cookie". Decided (maintainer, 2026-11-22): keep "any cookie" as the default with the option, after
  the comparison below; defaulting to `setu_session` would miss a renamed cookie.

**Q8 compared with established caches (2026-11-22; each row re-read at its source).** Decision: any
cookie counts as a credential by default, `credentialCookies` narrows it; no code change.

| Cache                                   | What a request cookie does by default                                                                                                                                                                     | Source read                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Symfony `HttpCache`                     | A request with any parsed cookie or `Authorization` makes the response private unless it says `public`; option `private_headers`, default `['Authorization', 'Cookie']`                                   | `symfony/symfony` 7.3 `HttpKernel/HttpCache/HttpCache.php:97` (default), `:518` (rule), `:671-686` (cookie test)  |
| `Rack::Cache`                           | The same rule: `private_request?` when any of `['Authorization', 'Cookie']` is present; private unless `public`                                                                                           | `rack/rack-cache` `lib/rack/cache/options.rb:152`, `context.rb:112-113`, `:272`                                   |
| Varnish builtin VCL                     | Any `Cookie` (or `Authorization`) request header passes in `vcl_recv`, before the response, so no `public` override; the guide documents the analytics-cookie cost and stripping or allow-listing cookies | `varnish-cache` `bin/varnishd/builtin.vcl:99-111`; `users-guide/increasing-your-hitrate.rst:124-180`              |
| Django cache middleware                 | Never reads the request cookie; the session framework adds `Vary: Cookie` when the session was accessed (as Design 2 does)                                                                                | `django/middleware/cache.py:101,107,130-135`; `contrib/sessions/middleware.py:49`                                 |
| ASP.NET Core Output Caching             | Never reads request cookies; refuses a request with `Authorization` or an authenticated `HttpContext.User`, and a response with `Set-Cookie`                                                              | `dotnet/aspnetcore` `OutputCaching/src/Policies/DefaultPolicy.cs:50-60,80-89`                                     |
| Nginx `proxy_cache`, Cloudflare, Fastly | Ignore request cookies by default (no cookie in the default key); cookie key fields are opt-in (Cloudflare Enterprise); a `Set-Cookie` response is not cached                                             | nginx `ngx_http_proxy_module`; Cloudflare cache-keys and default-cache-behavior docs; Fastly cache-freshness docs |

No cache found defaults to one named session cookie. The application frameworks that skip the cookie
test (Django, ASP.NET Core) can do so because their own session or identity layer marks the
response; `cacheMiddleware` cannot see the session plugin, so it takes the reverse-proxy rule
(Symfony, Rack::Cache, Varnish) and keeps the `public` override the first two have. The cost Varnish
documents applies: an application whose visitors all carry an analytics or consent cookie gets
nothing shared-cached until it marks responses `public` or sets `credentialCookies`; the
`cache-plugin` README says so, in one place.

**Decision A — `Vary: Cookie` responses (maintainer, 2026-11-22).** `ci:local` showed that Q7's
refusal of every `Vary: Cookie` response leaves `cacheMiddleware` caching nothing in a localized
application (`localization-plugin/test/integration/cache-vary.test.ts`). Decided: store a
`Vary: Cookie` response only for a request that carries no cookie (as Q8 defines one: any cookie,
narrowed by `credentialCookies`; the final review below tightened this to no cookie at all, whatever
`credentialCookies` names), and never serve it to a request that carries one; a request with a
cookie or `Authorization` is served only a `public` entry that varies on neither. Option B (keep the
refusal, so a localized application caches only with `cookieName: false`) was declined. Reason,
looked up by the maintainer on 2026-11-22 (the first three agree with the Q8 table's source reads
above):

| Cache                   | Cookie-less request                             | Request with `Cookie` or `Authorization`                                                                                | Fits |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| `Rack::Cache`           | cached                                          | private; not stored unless the response is explicitly `public`                                                          | A    |
| Varnish built-in rules  | cached                                          | bypassed                                                                                                                | A    |
| Symfony                 | cacheable                                       | the response is made private once the session is started in the request                                                 | A    |
| Django cache middleware | one entry per cookie value under `Vary: Cookie` | one entry per cookie value; its tracker records analytics cookies making the cache nearly useless (tickets 23054, 9249) | none |
| ASP.NET Core            | not checked                                     | not checked                                                                                                             | —    |

None of them refuses a cookie-less request because the response varies on `Cookie` (option B). The
caveat A keeps is Q8's: any cookie, an analytics one included, takes a request out of the cache, and
`credentialCookies` narrows it; the `cache-plugin` README says so. The Workers Cache API and KV
halves stay with M143o (§0.2 X6, X7): X6 must apply the same rule, which on the Cache API, keyed by
URL alone, means refusing to store any response varying on `Cookie` or `Authorization` from a
credentialed request and never serving a credentialed request an entry that varies on either.

**Final review (2026-11-22, after decision A).** Three code findings fixed: S1 again sets
`private, no-store` before `next()` whatever directive an outer middleware set, as §3.6 specifies
(an earlier review fix had kept a preset shared-cacheable directive, which let a cache inside the
session middleware store a signed-in page that renders `ctx.request.user`); a `Vary: Cookie` entry
is stored and served only for a request carrying no cookie at all, also with `credentialCookies`
narrowed; a `Vary: *` response is never stored.

**Audit on `3a4900885` (2026-11-22).** One Medium: with `cacheMiddleware` inside the session
middleware, a new visitor's session write followed by a handler `public` (a React Router `headers`
export does the same) was captured as `public, Vary: Cookie` before the commit added `Set-Cookie`,
and rule A stored it for every cookie-less visitor. Fixed with an additive `common` key,
`PER_VISITOR_RESPONSE_STATE_KEY` (`session-plugin:per-visitor-response`): the first application
write sets it, and `cacheMiddleware` never stores a response captured with it set. The Workers Cache
API half (M143o, §0.2 X6) should read the same key.

**CodeRabbit review on PR #609 (2026-11-22).** Fixed: a sign-out that lands after a regeneration's
fence read now also revokes the regenerated id (the `superseded` marker names its successor; each
side writes before it reads the other's marker); a commit whose request loaded the session longer
ago than a marker lives is refused; a CSRF token read and a read of a restored session holding
application data also set `PER_VISITOR_RESPONSE_STATE_KEY`; `Cache-Control` directive names are
parsed outside quoted arguments through one new `common` helper, `cacheControlDirectives` (an
unclosed quote fails safe per caller); Swagger UI's interceptor shares one in-flight token fetch.

## 11. Plan review (2026-11-22)

An independent agent that did not write the plan reviewed it against the row texts, the ROADMAP
section and lane rules, `CLAUDE.md`'s plan checklist and the source. It found 2 blocking, 10
should-fix and 10 minor items; each was checked against the source and resolved above:

- **Blocking:** in-process caches (`cacheMiddleware`, `cacheApiMiddleware`) ignore the marking →
  §0.2 X6 and §3.12 (after Q7), S1 headers set before `next()`, the dependency stated at the top.
  Stores where a marker is evicted or not yet visible (bounded memory cache, evicting Redis, KV) →
  the store table, README preconditions, X7, an evicted-marker test.
- **Should-fix:** an in-flight `regenerate()` against a logout (§3.2 pre/post-check, two marker
  kinds, T3); a marker-write failure leaving the row (§3.1 still deletes); restore marker-read
  failure (§3.3, T7); markers for ids with no row (§3.1, T9); CORS before IP resolution (125, not
  115); reserved-only new sessions making public assets private (§3.6 row, T9); framework reads not
  enumerated (§3.5 read table, T15); the read budget (§3.3, §10); the V13-137 overclaim (§0, §3.4);
  an empty marker payload on application stores (§3.1 sentinel, T8).
- **Minor:** `MemorySessionStore` citation; the two priority comments (C5); the undecided error
  class (now `TypeError`); the 404 rule's home and test (§3.9, policy in `cache-marking.ts`); the
  "rule 1" naming (now S1–S3); the Swagger spec shape (superseded by Q6) and the peer-range floor
  (§7); Safari without `Sec-Fetch-Dest` (§3.9); obligations and negative controls for every control
  (§10); the tenant 403 (§3.5); a silent refused commit (§3.2 debug line); parallel restore reads
  (§3.3).

**Second review (2026-11-22), after the maintainer's answers.** A fresh agent reviewed the sections
changed for Q1, Q5, Q6 and Q7 and their knock-on edits. It found 2 blocking, 11 should-fix and 9
minor items, each checked against the source and resolved:

- **Blocking:** the interceptor would have sent the token on Swagger UI's OAuth2 token request and
  to other origins, since four request kinds reach it → same-origin and uppercased-method filter,
  T24, a cross-origin browser case. A cache inside the session middleware stored a response before
  S2 and S3 were applied → S3 marks at the token read and a first-write hook marks at the first
  application write (§3.6), T25.
- **Should-fix:** React Router merged a route's `Cache-Control` into the plugin's → the bridge
  replaces it (§3.6). The warning fired on public assets and S1's `Vary` made them uncacheable → no
  warning and no `Vary` for an S1-only public response. The warning keyed on raw paths by count →
  route template from `params`, 200-character cut, byte bound. `commit` gained a required parameter
  on a public class → optional, with exported types. `concurrent-writes.test.ts:71` asserts the old
  behaviour → pinned to `'snapshot'` and mirrored under `'changes'`. The ROADMAP half lists and the
  halves count → corrected in the same commit. "Any cookie" goes beyond Q7 → Q8. `Vary: Cookie`
  missing from an application-`public` anonymous variant → always appended; never cached in-process.
  The `cacheMiddleware` order was unstated → five ordered steps, coalescer exclusion. The coverage
  command → `common`, `cache-plugin`, `react-router-plugin` added. The Try-it-out claim → narrowed
  to authenticated and session calls.
- **Minor:** stale `cache-plugin` wording in Design 1, the stale §11 cross-reference, the Swagger
  request-shape row, the token-route test pinned to no `rolling`/`idleTimeoutMs`, the 5.0.0 floor
  named, the `assets: { baseUrl }` arm and a trailing-slash UI path, the missing negative controls
  (T18, T21, T26, T16), the README count. The new dev-dependency from `cache-plugin` to
  `session-plugin` mirrors the existing reverse one; `tsc -b` and the test order are checked once at
  implementation (only `src`-level cycles are refused).
