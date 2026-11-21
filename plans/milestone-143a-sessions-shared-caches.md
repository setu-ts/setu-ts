# Milestone 143a — Sessions and Shared Caches (`@setu-ts/session-plugin`, `http-security-plugin`, `openapi-plugin`)

> **Status:** Planning — design awaiting maintainer approval; nothing is implemented. Branch:
> `feat/m143a-sessions-shared-caches`. `develop` and `main` are protected; all work and fixes stay
> on this one branch until it merges through a single PR. Lane: Web (first letter). Security-audited
> before it merges. Revised 2026-11-22 after an independent plan review (§11).

**Dependencies on other lanes, stated first.**

- **No change to an existing contract in `common` and no change to `kernel`.** `ISessionStore` keeps
  its methods; the cache decision reads the response through `IResponse.snapshot()` and writes it
  through `IResponse.header()`, both committed. Nothing waits on M143i.
- **Two in-process response caches outside the Web lane must honour the marking** (§0.2 X5, X6):
  `cache-plugin`'s `cacheMiddleware` (a package **no lane lists**, so the lanes table must be
  corrected before its code is written — Q7) and `cloudflare-plugin`'s `cacheApiMiddleware` (M143o).
  Until both ship, the outcome "cannot be stored by a shared cache" holds for caches outside the
  process (CDN, reverse proxy) and not for those two middlewares.
- Template halves for M143j (V13-111, V13-20), one CLI source comment, two repository docs and the
  Cloudflare session-store README are listed in §0.2.

## 0. Objective & scope

A signed-in page, and a page carrying a visitor's CSRF token, must never be stored by a shared
cache; a `destroy()` or `regenerate()` on the store strategy must stay in force whatever request on
that session was already in flight; concurrent requests on one store session must stop overwriting
each other's untouched keys (per-key last writer wins; loss between keys narrowed from a whole
request to one store round trip); a request for a missing asset must not start a session; the
request-size refusals must carry the same security and CORS headers as every other response; and
Swagger UI's "Try it out" must work against a header-authenticated route in an application that has
sessions. The boundary: the cookie strategy keeps its documented limits (a copied cookie cannot be
revoked, and a cookie snapshot is whole); the revocation guarantee holds on stores that are
linearizable and do not evict live keys (§3.1, the store table); no new capability, store or public
contract is added beyond one `SessionPlugin` option.

- **In scope:** V13-111, V13-112, V13-135, V13-136 (revocation and caching, the trust-boundary
  rows); V13-137 (store commits); V13-20 (session half); V13-34; V13-60. Design 1 (§3.1–§3.4): how a
  store write refuses a revoked or superseded session. Design 2 (§3.5–§3.7): which responses are
  marked private. The design security review (§10).
- **NOT this milestone:** the template halves of V13-111 and V13-20 (M143j, §0.2); the in-process
  cache halves (§0.2 X5, X6); the `HEAD`-on-`GET` gap and React Router public-file validators
  (V13-113 in M143i, V13-114 in M143l); CORS headers on tenant and locale refusals (§9);
  cookie-strategy revocation (documented; `signIn.sessionStamp` is its answer); the nginx/CDN re-run
  on published `0.14.0` (milestone-wide gate after the release).

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

| #   | Where (owner)                                                                          | Exactly what must change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Full-stack template (M143j, V13-111 half)                                              | `populateLoadContext` stops minting eagerly: it stores a getter, `context.set(csrfContext, () => getCsrfToken(ctx))`, and the generated `getCsrfToken(context)` in `app/server/session.server.ts` calls it. A page that renders no form then mints nothing, so an anonymous visitor's first page carries no `Set-Cookie` and stays shared-cacheable. The `csrfContext` key's type changes from `string` to `() => string` in `context-keys.server.ts`. Scaffold-and-boot gate row: a signed-in page and its `.data` answer `private, no-store`; an anonymous `/` answers with no `Set-Cookie`.                                                                                                                                              |
| X2  | Full-stack template (M143j, V13-20 half)                                               | Ship a favicon: `public/favicon.svg` plus `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` in `app/root.tsx`'s `<head>`, so the browser's first request is a 200 public file. Gate row: `/favicon.svg` answers 200 with no `Set-Cookie`, and `GET /missing.png` (no `Sec-Fetch-Dest: document`) answers 404 with no `Set-Cookie`.                                                                                                                                                                                                                                                                                                                                                                                               |
| X3  | `packages/cli/src/templates/rest.ts:79` comment (CLI lane)                             | The source comment lists "cors (200), security-headers (250)"; after §3.8 it is "security-headers (10) … cors (125)". Not generated output; the comment becomes false. No row owns it today: add it to M143j's "Half of a row owned elsewhere" as a V13-34 half.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| X4  | `docs/plugin-architecture.md:146-163` and `ARCHITECTURE.md:1934` (Docs lane)           | The priority tables list CORS at 200 and security headers at 250. **Question Q4:** these must change in the same PR as the code (docs-must-match-behaviour), so this plan asks to edit them here; otherwise M143n owns them and the tree is wrong between the two merges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| X5  | `packages/cache-plugin/src/middleware/cache-middleware.ts:125-139` (**no lane**; Q7)   | `captureOrigin` refuses only a streaming response, a non-cacheable status and `Set-Cookie`. It must also refuse a response whose `Cache-Control` holds `private` or `no-store`, and one whose `Vary` names `Cookie` (its key is the URL, so it cannot keep variants). Registered at the default 500 it runs inside the session middleware (260); §3.6 sets signal 1's headers **before** `next()` so it sees them, and the other signals' headers are set after the handler, which a cache registered inside 260 cannot see: the cache-plugin README must say to register it outside the session middleware, or the cache must refuse any request carrying the session cookie. Test: a signed-in read is never replayed to another visitor. |
| X6  | `packages/cloudflare-plugin/src/cache-api/cacheability.ts:72-84` (Workers lane, M143o) | `assessCacheability` refuses method, status, 206, `Vary: *` and `Set-Cookie`. It must also refuse `private`/`no-store` and a `Vary` naming `Cookie` (the Cache API key is the URL; the module's JSDoc at lines 55-66 already says `Vary` cannot separate entries). Add to M143o's "Half of a row owned elsewhere" as a V13-111 half.                                                                                                                                                                                                                                                                                                                                                                                                        |
| X7  | `packages/cloudflare-plugin` README for `KvSessionStore` and `KvCacheStore` (M143o)    | Workers KV is eventually consistent (`kv-session-store.ts:39` "propagates within seconds"), so a revocation marker may not be visible to a commit or restore in another location for seconds. The README states that the §3.1 guarantee does not hold on KV and names a Durable Object store as the strong option. A V13-135 half for M143o.                                                                                                                                                                                                                                                                                                                                                                                                |

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                                                                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ISessionStore`                  | `packages/common/src/services/session.ts:234-276`                                                                                                                                                 | `read(id)`, `write(id, data, ttlMs)` ("replacing any existing one"), `destroy(id): Promise<boolean>`, optional `isHealthy`, `close`. **No conditional write, no version, no compare-and-set**, and nothing about id format or empty payloads. The design uses only these three methods.                 |
| `ICacheStore`                    | `packages/common/src/services/cache.ts:19-54`                                                                                                                                                     | `get`, `set(key, value, ttlSeconds?)`, `delete`, `has`, `clear`. No set-if-exists and no CAS, so `CacheSessionStore` cannot do an atomic conditional write without a contract change.                                                                                                                   |
| `CacheSessionStore`              | `packages/session-plugin/src/stores/cache-session-store.ts:42-85`                                                                                                                                 | Keys `${keyPrefix}${id}` (default `session:`); TTL rounded up to whole seconds, minimum 1.                                                                                                                                                                                                              |
| `MemorySessionStore`             | `packages/session-plugin/src/stores/memory-session-store.ts:51-115`                                                                                                                               | `Map`; read drops expired entries; `write` replaces; periodic sweep; no eviction.                                                                                                                                                                                                                       |
| cache-plugin `MemoryStore`       | `packages/cache-plugin/src/stores/memory-store.ts:20,59`                                                                                                                                          | LRU with `maxSize` default 1000: `store: 'cache'` over it can evict a marker (never read again, so coldest) and a live session.                                                                                                                                                                         |
| `KvSessionStore`                 | `packages/cloudflare-plugin/src/stores/kv-session-store.ts:39`                                                                                                                                    | A first-party `ISessionStore` on eventually consistent KV; "a `destroy()` propagates within seconds".                                                                                                                                                                                                   |
| `cacheMiddleware` capture        | `packages/cache-plugin/src/middleware/cache-middleware.ts:125-139`                                                                                                                                | Stores unless streaming, a non-cacheable status, or `Set-Cookie`; reads no `Cache-Control` and no `Vary`.                                                                                                                                                                                               |
| Cache API cacheability           | `packages/cloudflare-plugin/src/cache-api/cacheability.ts:72-84`                                                                                                                                  | Refuses method, status, 206, `Vary: *`, `Set-Cookie`; nothing else.                                                                                                                                                                                                                                     |
| Unconditional commit write       | `packages/session-plugin/src/services/session-service.ts:298`                                                                                                                                     | `await this.#store.write(snapshot.id, snapshot.data, ttlMs)` with no check. The row's line citation holds on `develop`.                                                                                                                                                                                 |
| Store deletes                    | `session-service.ts:223` (destroy: `session.id` and `previousId`), `:247` (superseded id), `:296` (demotion to cookie-held: `snapshot.id` when store-held)                                        | Plain `store.destroy`; nothing records that the id was revoked. `:223` passes ids that may never have had a row (new, cookie-held, the never-written id after `regenerate()`).                                                                                                                          |
| Commit trigger                   | `session-service.ts:235-240`                                                                                                                                                                      | Commits when dirty, regenerated, or (`rolling` or `idleTimeoutMs`) and not new.                                                                                                                                                                                                                         |
| Anonymous traffic does not grow  | `session-service.ts:264-268`                                                                                                                                                                      | M113e rule: a session of reserved keys only writes no row. The design keeps it (§3.1 writes markers only for ids that had a row).                                                                                                                                                                       |
| Cookie-held reserved keys        | `session-service.ts:44-52`                                                                                                                                                                        | `CSRF_SESSION_KEY` and `SESSION_TENANT_BINDING_KEY`.                                                                                                                                                                                                                                                    |
| Session ids                      | `packages/runtime/src/services/cross-runtime.ts:16-18`                                                                                                                                            | `crypto.randomUUID()`: no `:` in an id, so a `revoked:`/`superseded:` prefix cannot collide with a real id.                                                                                                                                                                                             |
| `Session` reads                  | `packages/session-plugin/src/services/session.ts:137` (`get`), `:163` (`has`), `:202` (`toJSON`), `:221` (`snapshot()`)                                                                           | No tracking today. The service itself calls `toJSON()` (`session-service.ts:254`) and `snapshot()`, so tracking must exclude its own calls.                                                                                                                                                             |
| Framework reads                  | `common/src/services/session.ts:46-50` (`tenantBindingMismatch`, called at `session-middleware.ts:74`); auth-plugin `auth-session-service.ts:483,554`, `pending-state.ts:66`, `ceremonies.ts:422` | The tenant compare reads a reserved key on every request. auth-plugin reads its own (non-reserved) keys through `from(ctx)` when the application asks who is signed in.                                                                                                                                 |
| auth strategies read via headers | `packages/auth-plugin/src/strategies/session-strategy.ts:63`; `auth-session-strategy.ts:89`                                                                                                       | Authenticate through `fromHeaders`, which runs the store restore again on a separate view (`session-service.ts:180`).                                                                                                                                                                                   |
| `getCsrfToken`                   | `packages/session-plugin/src/csrf/token.ts:59-74`; `csrfTokenField` calls it at `:172`                                                                                                            | Mints only when absent (marks dirty); a returning visitor's read sets nothing.                                                                                                                                                                                                                          |
| Session middleware               | `packages/session-plugin/src/middleware/session-middleware.ts:60-141`                                                                                                                             | Priority 260; tenant-mismatch 403 before the session is parked (`:74-80`); commit after `next()`; on throw only `revokeSuperseded`, whose fault is logged and swallowed (`:98-109`); early return for `NO_COMMIT_STATE_KEY`/`CSRF_EXEMPT_STATE_KEY`.                                                    |
| Tenant seal marks dirty          | `session-middleware.ts:133-137`                                                                                                                                                                   | Every cookie-less request under a tenant gets a dirty new session (the X97 widening).                                                                                                                                                                                                                   |
| Headers after the handler        | `session-middleware.ts:28-32`; `packages/kernel/src/context/response.ts:98-106`                                                                                                                   | The kernel appends headers after a terminal response method; `header()` sets (replaces), `appendHeader()` appends.                                                                                                                                                                                      |
| `IResponse.snapshot()`           | `packages/common/src/http.ts:352`, `ResponseSnapshot` at `:1191-1215`                                                                                                                             | Live `headers` view plus `status`.                                                                                                                                                                                                                                                                      |
| `respondWithError`               | `packages/common/src/errors/error-responder.ts:245-258`                                                                                                                                           | Sets status and body; does not clear headers.                                                                                                                                                                                                                                                           |
| React Router response bridge     | `packages/react-router-plugin/src/handler/request-bridge.ts:77-102`                                                                                                                               | Copies React Router's status and every header (a route's `headers` export included) into `ctx.response` before the handler returns.                                                                                                                                                                     |
| React Router asset headers       | `packages/react-router-plugin/src/assets/static-assets.ts:29,38,144,196`                                                                                                                          | `public, max-age=31536000, immutable` (hashed) and `public, max-age=0, must-revalidate` (root files).                                                                                                                                                                                                   |
| `auth-plugin` sign-out           | `packages/auth-plugin/src/sign-in/auth-session-service.ts:642-656`                                                                                                                                | `signOut` calls `destroy()`; its JSDoc promises immediate revocation on the store strategy. True after this letter; no auth-plugin code change.                                                                                                                                                         |
| Template logout                  | `packages/cli/src/templates/full-stack-app-files.ts:701-705`                                                                                                                                      | `clear()` then `regenerate()`: the V13-136 path.                                                                                                                                                                                                                                                        |
| http-security priorities         | `packages/http-security-plugin/src/plugin/http-security-plugin.ts:25-31`                                                                                                                          | IP 120, size 180, CORS 200, security headers 250, CSRF 270. Security headers and CORS set their headers before `next()` (`security-headers-middleware.ts:109-111`, `cors-middleware.ts:97-174`).                                                                                                        |
| Security headers are static      | `security-headers-middleware.ts:106-111`                                                                                                                                                          | One frozen record computed at registration; no per-request input.                                                                                                                                                                                                                                       |
| CORS origin matcher gets `ctx`   | `packages/http-security-plugin/src/middleware/cors-middleware.ts:13-15`                                                                                                                           | A matcher may read `requestOriginOf(ctx)` or the client address IP security publishes (`ip-security-middleware.ts:359-360`), so CORS must stay after IP resolution.                                                                                                                                     |
| IP-security refuses nothing      | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:279-363`                                                                                                                  | Resolves the client address and forwarded origin, then `next()`; no refusal branch (§2 C2).                                                                                                                                                                                                             |
| Request-size refusals            | `request-size-middleware.ts:73-90`                                                                                                                                                                | 400 for a malformed `Content-Length`, 413 over the bound.                                                                                                                                                                                                                                               |
| Configuration refusals           | `packages/session-plugin/src/options.ts:215,236-308`                                                                                                                                              | Invalid options throw `TypeError` naming the option; `storeCommit` follows suit.                                                                                                                                                                                                                        |
| Swagger UI request credentials   | `swagger-ui-dist@5.33.3` bundle (`node_modules/.pnpm/swagger-ui-dist@5.33.3/…/swagger-ui-bundle.js`); peer range `^5` (`openapi-plugin/package.json:43`)                                          | Try-it-out request object is built as `{ url, credentials: withCredentials ? 'include' : 'same-origin', headers, … }` and passed through `requestInterceptor`. `specSelectors.specJson()` returns an Immutable.js `Map`. Proved on 5.33.3 (the CDN pin, `swagger-ui.ts:198`) and the range floor in §7. |
| Swagger UI page                  | `packages/openapi-plugin/src/ui/swagger-ui.ts:103-145`; assets `openapi-plugin.ts:226-234` (`public, max-age=3600`)                                                                               | `SwaggerUIBundle({ url, dom_id, deepLinking, presets, layout })` with no interceptor.                                                                                                                                                                                                                   |
| Bearer exemption                 | `packages/session-plugin/src/middleware/csrf-form-middleware.ts:35-40`, `csrf/exclude.ts:69-95`                                                                                                   | Exempt only when a header-credential strategy authenticated the request **and the session is new**. Kept.                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                         | Doc deliverable (same PR)                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1  | `session-plugin/README.md:50` "Immediate revocation: **Yes** — delete the entry" and `auth-session-service.ts:645-648` against the 50/50 measurement                                    | The code changes to match the claim (§3.1–§3.3). The README gains the exact guarantee and its preconditions (linearizable, no eviction of live keys) and names KV as outside it. | README table row and a "Revocation under concurrency" paragraph; the auth JSDoc stays.             |
| C2  | V13-34's text names an "IP-security refusal (120)"; the middleware has no refusal branch                                                                                                | Source wins: the fix covers the request-size 400 and 413. The row's re-run drives the 400 and the 413.                                                                           | Plan note only; the DEFECTS row is reworded by the maintainer at re-run (smoke/ is not committed). |
| C3  | `session-plugin/README.md:65-69` "can lose one change" against the measured K−1 of K                                                                                                    | Replaced by an accurate statement of each `storeCommit` mode (§3.4).                                                                                                             | README "Concurrent requests" section rewritten.                                                    |
| C4  | Priority tables: `docs/plugin-architecture.md:159`, `ARCHITECTURE.md:1934`, `PUBLIC_API.md:4371` ("priority 200"), `http-security-plugin/README.md:110`, `session-plugin/README.md:406` | New priorities (§3.8) everywhere.                                                                                                                                                | `PUBLIC_API.md`, both READMEs here; the two repository docs per Q4 (§0.2 X4).                      |
| C5  | JSDoc "after security headers (250)" at `session-middleware.ts:24` and `session-plugin.ts:30`                                                                                           | New priority.                                                                                                                                                                    | Both comments corrected in this PR.                                                                |

## 3. Design decisions

### Design 1 — how a store write refuses a revoked or superseded session

**Options compared.**

| Option                                                            | Memory store                    | Cache store                                                                                                             | Application `ISessionStore`                            | Verdict                                                                     |
| ----------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| A. Atomic conditional write (`writeIfPresent`) on `ISessionStore` | trivial                         | impossible over `ICacheStore` without a second contract change (set-if-exists) plus `cache-plugin`, which no lane lists | must implement it; a store without it needs a fallback | Rejected: waits on M143i and a lane change, and still needs a fallback path |
| B. Row version + compare-and-set                                  | possible                        | no CAS primitive in `ICacheStore`                                                                                       | must implement CAS                                     | Rejected: same blockers as A                                                |
| C. Check-then-write alone                                         | non-atomic                      | non-atomic                                                                                                              | works                                                  | Rejected alone: the race shrinks to one round trip but stays                |
| D. Tombstone in the row itself                                    | overwritten by the racing write | overwritten                                                                                                             | overwritten                                            | Rejected: the in-flight write replaces the tombstone                        |
| **E. Markers under their own ids + write-then-verify fence**      | works                           | works where the store keeps the marker (table below)                                                                    | works with no new method                               | **Chosen**                                                                  |

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
  - `commit(ctx, session, policy)` returns `Promise<'written' | 'refused' | 'skipped'>` (was
    `Promise<void>`, additive for callers). `policy` is computed by the middleware from the response
    (§3.6): whether a refresh-only commit and a reserved-keys-only new session may commit on this
    response. The middleware decides `'skipped'`; the service applies it.
- **Why:** closes V13-135 and V13-136 including the `rolling` read-only case and the in-flight
  regenerate, and stops a racing response from re-planting the pre-login cookie.
- **Test home:** `revocation-race.test.ts` (50 runs each for destroy-vs-write, destroy-vs-rolling
  read, regenerate-vs-write, **destroy-vs-regenerate**: 0 resurrections, no signed-in new id, no
  `Set-Cookie` on the racing response); `session-revoke.test.ts` (fence read throws → own write
  deleted, error rethrown; debug line carries no id).

### 3.3 Restore check

- **Decision:** a store-held restore reads the row and both markers of its id in parallel
  (`Promise.all`) and treats a present marker as no session, the same path as a missing row
  (`session-service.ts:365-370`); `fromHeaders` runs the same restore. A snapshot whose id starts
  `revoked:` or `superseded:` is refused before any store read. A marker read that throws propagates
  exactly as a row-read fault does today (the request fails; `fromHeaders` rejects), never as "no
  marker".
- **Why:** without it, a request that **starts** after `destroy()` returned can still restore the
  row during the one round trip between a racing commit's write and its fence delete. With it: once
  `destroy()` or a `regenerate()` commit returns, no request restores the old id. Cost: two extra
  keys read in parallel with the row read on every store-held restore; a request authenticated by
  auth-plugin's session strategy restores twice (`from(ctx)` and `fromHeaders`), so it pays this
  twice. **Question Q1** asks the maintainer to accept it; dropping §3.3 keeps §3.1–§3.2 correct for
  the measured cases and leaves the one-round-trip window documented.
- **Test home:** `revocation-race.test.ts` (a request started between a racing write and its fence,
  driven with a store double that pauses after the write, restores nothing);
  `test/unit/session-from-headers.test.ts` (marker → `null`; marker read throws → rejects);
  `session-revoke.test.ts` (marker-prefixed id refused before any read).

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
  together. **Question Q2:** default `'changes'` (recommended; Spring Session's default) against
  `'snapshot'`.
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

- **Decision:** two steps in the session middleware.
  - **Before `next()`:** when S1 holds, set `Cache-Control: private, no-store` and append
    `Vary: Cookie`, and remember the value written. An in-process cache running inside the session
    middleware sees it (and must honour it, §0.2 X5); the handler may still replace it.
  - **After the handler** (also on the exempt and no-commit paths), read `Cache-Control` from
    `ctx.response.snapshot().headers`. A value equal to the one written before `next()` is the
    plugin's own; anything else present is the application's. A directive is **shared-storable**
    when present and containing neither `private` nor `no-store`. Then:

  | Situation                                                                                  | Action                                                                                 |
  | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
  | No application directive, S2 or S3 holds                                                   | `Cache-Control: private, no-store`, `Vary: Cookie` (appended, never duplicated)        |
  | No application directive, session-dependent only                                           | `Vary: Cookie` only                                                                    |
  | Shared-storable directive, commit would be a refresh only (`rolling`/`idleTimeoutMs`)      | refresh skipped (`'skipped'`): no `Set-Cookie`; the next non-public response refreshes |
  | Shared-storable directive, new session holding only reserved keys (CSRF mint, tenant seal) | not committed (`'skipped'`): a public asset stays public on a first tenant visit       |
  | Shared-storable directive, commit is dirty with application data, regenerated or a destroy | directive replaced by `private, no-store`, `Vary: Cookie`                              |
  | Any other present directive                                                                | left as written                                                                        |
  | The request throws                                                                         | S1's headers already stand; `respondWithError` keeps them (a test proves it)           |

- **Why:** `no-store` as well as `private` so a signed-in page is not kept in the browser's cache
  after sign-out on a shared computer. Respecting an explicit directive is how an application that
  deliberately caches a page says so (§3.7); the overrides and skips exist because no explicit
  directive can make a session `Set-Cookie` safe to share.
- **Test home:** `cache-marking.test.ts` (each row above); `session-middleware.test.ts` (S1 set
  before `next()` and visible to an inner middleware; marking on exempt and no-commit paths; throw
  path); `test/e2e/private-responses.test.ts` (real kernel app, both strategies: the §0.1 probes
  inverted; an asset route with `public, max-age=31536000, immutable` under `rolling` and under a
  tenant seal keeps its directive and gets no `Set-Cookie`; an error thrown on a signed-in route
  answers `private, no-store`).

### 3.7 An application that deliberately caches a page

- **Decision:** no new option. The application sets its own `Cache-Control` (a React Router route's
  `headers` export, or `ctx.response.header(...)` in a handler or an application middleware). The
  plugin leaves an application directive alone except in the `Set-Cookie` cases of §3.6. The README
  gives the recipe: cache the anonymous variant with `public, s-maxage=…` only when no session was
  restored, read the CSRF token in a loader rather than in deferred data, and register
  `cacheMiddleware` outside the session middleware. **Question Q5:** the maintainer may prefer
  overriding an explicit public directive on any per-visitor response; recommended against, because
  a developer who writes `public` on a signed-in page has made a decision the framework can document
  but not guess.
- **Why:** one rule, no switch to forget, and every page an application did not mark is safe.
- **Test home:** `private-responses.test.ts` (explicit `public, s-maxage=60` set for an anonymous
  visitor is kept; the same page with a dirty commit becomes `private, no-store`).

### 3.8 Security headers and CORS run before every refusal (V13-34)

- **Decision:** security headers move from priority 250 to **10**, CORS from 200 to **125**. IP
  resolution stays 120, request size 180, origin CSRF 270. Both set their headers before `next()`,
  so every response produced downstream, the request-size 400 and 413 included, carries them.
  Security headers at 10 also cover refusals at 40 (tenant) and 45 (locale), and an error response
  the error handler (0) builds from a throw anywhere after 10. CORS stays after IP resolution (an
  origin matcher may read the resolved origin or client address) and after request logging (100).
- **Why:** rejected alternative — keep the priorities and have each refusal add the headers itself:
  that covers only this plugin's two refusals and duplicates the CORS decision. **Question Q3** asks
  the maintainer to approve renumbering two documented priorities.
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

### 3.10 Swagger UI Try-it-out with header credentials (V13-60)

- **Decision:** the Swagger UI page gets a `requestInterceptor` that sets `credentials = 'omit'` on
  a Try-it-out request carrying `Authorization` or a header named by an `apiKey` scheme with
  `in: 'header'` in the loaded document (read from `window.ui.specSelectors.specJson()`, an
  Immutable.js `Map`); every other request keeps Swagger UI's default. The interceptor is an
  internal TypeScript function (`src/ui/swagger-interceptor.ts`, not exported from `index.ts`)
  taking the request and the schemes object, embedded into the page through
  `Function.prototype.toString()`, so its branches are unit-tested as a function. The bearer
  exemption is unchanged.
- **Why:** a header-credentialed call has no use for the cookie, and sending it is what defeats the
  exemption; a session-authenticated GET keeps working because it carries no header credential. The
  rejected alternative, exempting bearer requests that also carry a restored session, reopens the
  M113e decision that a restored session must present its token.
- **Test home:** `packages/openapi-plugin/test/unit/swagger-interceptor.test.ts` (with an
  Immutable-shaped spec double: `Authorization` → omit; header API key → omit; `in: cookie` API key
  → keep; no credential → keep; spec not loaded → keep); `swagger-ui.test.ts` (page embeds the
  interceptor); browser proof in §7.

### 3.11 Documentation in the lane

- **Decision:** `session-plugin` README: revocation guarantee, its preconditions and the store
  table; `storeCommit` and what it does not give; the caching rule, the read table and the
  deliberate-caching recipe; the 404 rule; the new neighbour priorities. `http-security-plugin`
  README: priorities and why. `openapi-plugin` README: Try-it-out and cookies. `react-router-plugin`
  README: one paragraph pointing pages to the session plugin's caching rule and the `headers`
  export. The two JSDoc priority comments (C5). `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`
  (priorities, `storeCommit` default, `Cache-Control` now sent, Redis eviction advice).
- **Why:** each claim must match the code it describes.
- **Test home:** `pnpm run check:docs`; docs-claims review before the PR.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `ISessionStore` and every other published interface are
unchanged. Observable behaviour changes (two middleware priorities, new response headers,
`storeCommit` default, a refused racing commit, marker entries in the store, `SessionService.commit`
taking a policy and returning an outcome) are documented in `docs/upgrading.md` and ship in
`0.14.0`.

| Exported symbol                          | Kind                    | Consumer / real code path that READS it                                                              |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `SessionPluginOptions.storeCommit`       | option (existing type)  | `resolveSessionConfig` → `SessionService.commit` branch (§3.4)                                       |
| `SessionService.commit` (policy, return) | method (existing class) | `sessionMiddleware` passes the policy and reads the outcome to decide `Set-Cookie`-dependent caching |

No new export from any `index.ts`. Marker ids and payloads, change and read tracking, the commit
policy type and the Swagger interceptor are internal.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                                | Behavior (per implementation)                                                                                           |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `storeCommit: 'changes'`    | `SessionService.commit`, store strategy | memory, cache and application stores: read current row, apply this request's changes, write, fence; missing row refuses |
| `storeCommit: 'snapshot'`   | `SessionService.commit`, store strategy | every store: write this request's payload, fence                                                                        |
| `storeCommit` with no store | `resolveSessionConfig`                  | `TypeError` naming the option and that it applies only to the store strategy                                            |

## 5. Implementation files

| File                                                                               | Purpose                                                                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/session-plugin/src/services/session-service.ts`                          | `#revoke`, fences, restore check, `storeCommit` modes, commit policy and outcome, refusal debug line |
| `packages/session-plugin/src/services/session.ts`                                  | change tracking, read tracking (application-visible non-reserved reads), CSRF-read flag              |
| `packages/session-plugin/src/services/cache-marking.ts` (new, internal)            | pure functions: S1 headers before `next()`; after-handler decision; commit policy (§3.6, §3.9)       |
| `packages/session-plugin/src/middleware/session-middleware.ts`                     | applies S1 before `next()`, the decision after it on every path, the 403 marking, passes the policy  |
| `packages/session-plugin/src/csrf/token.ts`                                        | `getCsrfToken` records the read on the session                                                       |
| `packages/session-plugin/src/options.ts`                                           | `storeCommit` option, resolution and `TypeError`                                                     |
| `packages/session-plugin/src/plugin/session-plugin.ts`                             | priority comment (C5)                                                                                |
| `packages/http-security-plugin/src/plugin/http-security-plugin.ts`                 | priorities 10 and 125                                                                                |
| `packages/openapi-plugin/src/ui/swagger-interceptor.ts` (new, internal)            | the interceptor function                                                                             |
| `packages/openapi-plugin/src/ui/swagger-ui.ts`                                     | embeds it in the page                                                                                |
| READMEs of the four packages, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` | §3.11                                                                                                |

`src/index.ts` of every package: unchanged. `errors.ts`: unchanged (the refusal is a `TypeError`).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                    | Key assertions                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-plugin/test/integration/revocation-race.test.ts` (from the §0.1 probe) | `session-service.ts`                           | destroy-vs-write, destroy-vs-rolling read, regenerate-vs-write, destroy-vs-regenerate, 50 runs each: **0** resurrections, on `MemorySessionStore` and `CacheSessionStore` over the memory cache; racing response has no `Set-Cookie`; started-after request restores nothing; an evicted marker gives the documented outcome |
| `session-plugin/test/integration/revocation-race-redis-real.test.ts` (guarded)  | `session-service.ts`, `cache-session-store.ts` | the same races against a real Redis cache store (skipped without `REDIS_URL`, like `store-anonymous-redis-real.test.ts`)                                                                                                                                                                                                     |
| `session-plugin/test/unit/services/session-revoke.test.ts` (new)                | `session-service.ts`                           | §3.1–§3.3 order and failure of each step; no marker for new, cookie-held or never-written ids; marker payload check; prefixed id refused; debug line has no id                                                                                                                                                               |
| `session-plugin/test/integration/store-commit-modes.test.ts` (from the probe)   | `session-service.ts`, `session.ts`             | §3.4 with an ordering store double, both modes                                                                                                                                                                                                                                                                               |
| `session-plugin/test/unit/services/session.test.ts` (extended)                  | `session.ts`                                   | change and read tracking; internal accessors and reserved keys not counted; CSRF-read flag                                                                                                                                                                                                                                   |
| `session-plugin/test/unit/services/cache-marking.test.ts` (new)                 | `cache-marking.ts`                             | S1–S3, the read table, every row of the §3.6 table, the §3.9 policy                                                                                                                                                                                                                                                          |
| `session-plugin/test/unit/middleware/session-middleware.test.ts` (extended)     | `session-middleware.ts`                        | S1 before `next()` visible inside; exempt/no-commit paths marked; throw path; 403 marked; policy passed                                                                                                                                                                                                                      |
| `session-plugin/test/e2e/private-responses.test.ts` (from the probe)            | middleware + service through a kernel app      | V13-111/V13-112 inverted on both strategies; anonymous no-cookie page unmarked; explicit `public` kept; asset under `rolling` and tenant seal keeps its directive and no `Set-Cookie`; error on a signed-in route private; §3.9 through the kernel                                                                           |
| `session-plugin/test/unit/session-from-headers.test.ts` (extended)              | `session-service.ts`                           | marker → `null`; marker read throws → rejects                                                                                                                                                                                                                                                                                |
| `session-plugin/test/unit/options.test.ts` (extended)                           | `options.ts`                                   | default `'changes'`; `TypeError` without a store                                                                                                                                                                                                                                                                             |
| `session-plugin/test/unit/csrf/csrf.test.ts` (extended)                         | `csrf/token.ts`                                | read recorded for minted and existing tokens                                                                                                                                                                                                                                                                                 |
| `session-plugin/test/integration/plugin-registration.test.ts` (extended)        | `plugin/session-plugin.ts`                     | registered priorities unchanged (260, 325)                                                                                                                                                                                                                                                                                   |
| `auth-plugin/test/integration/sign-out-race.test.ts`                            | (consumer proof)                               | `signOut` on the store strategy with an overlapping request: the copied cookie is signed out (JSDoc claim)                                                                                                                                                                                                                   |
| `starters/full-stack-starter/test/integration/private-pages.test.ts`            | (composition proof)                            | through the `loadRequestHandler` seam: signed-in document and `.data` answer `private, no-store`; anonymous page without a token read is not marked                                                                                                                                                                          |
| `http-security-plugin/test/integration/refusal-headers.test.ts` (from probe)    | `http-security-plugin.ts`                      | §3.8                                                                                                                                                                                                                                                                                                                         |
| `http-security-plugin/test/unit/http-security-plugin.test.ts` (extended)        | `http-security-plugin.ts`                      | priorities 10 and 125                                                                                                                                                                                                                                                                                                        |
| `openapi-plugin/test/unit/swagger-interceptor.test.ts` (new)                    | `swagger-interceptor.ts`                       | §3.10 cases with an Immutable-shaped spec double                                                                                                                                                                                                                                                                             |
| `openapi-plugin/test/unit/swagger-ui.test.ts` (extended)                        | `swagger-ui.ts`                                | page embeds the interceptor and wires `requestInterceptor`                                                                                                                                                                                                                                                                   |

Every fix's test is run once against `develop` first and shown failing (the §0.1 numbers).

## 7. Verification gates

```bash
git branch --show-current   # feat/m143a-sessions-shared-caches
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage session-plugin http-security-plugin openapi-plugin auth-plugin full-stack-starter
flock /home/dkpaul91/.cache/setu-ts/locks/suite.lock pnpm run ci:local
flock /home/dkpaul91/.cache/setu-ts/locks/suite.lock pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Beyond the gates: a browser proof of §3.10 on swagger-ui-dist 5.33.3 and on 5.0.0 (a signed-in
session cookie, "Authorize" with a bearer token, Execute a `POST` under form CSRF → 2xx; without the
interceptor → 403), driven with the in-app browser on a local app and recorded in the PR; the X86
nginx cache harness re-run locally against the branch (expected 0 leaks of 16); a measurement of the
§3.3 cost on the memory and Redis cache stores; the committed-tree security audit of §10 in a fresh
context, after verification and code review.

## 8. Risks & mitigations

- A non-linearizable or evicting store loses markers → the store table, README preconditions, an
  evicted-marker test asserting the documented outcome, and the Redis `noeviction` advice.
- A request running longer than `maxAge` that loaded the session before a revocation can outlive the
  marker → bounded by `maxAge` (default two hours); documented.
- Added store reads (§3.2–§3.4, doubled for auth-strategy requests) → measured in the PR; Q1 can
  drop §3.3.
- Marker entries appear in an application store's listing → documented; they expire after `maxAge`.
- `private, no-store` on pages that were CDN-cached by accident → intended; upgrade note and the
  §3.7 recipe.
- Moving security headers to 10 and CORS to 125 changes what an application middleware between those
  numbers and the old ones sees → upgrade note; no first-party middleware reads them.
- In-process caches (§0.2 X5, X6) keep storing per-visitor responses until their halves ship → the
  dependency is stated at the top and in Q7; the release cannot close V13-111 without them.
- `Function.prototype.toString()` output of the built interceptor → a test asserts the embedded text
  is the compiled function, and the browser proof runs on the built package.

## 9. Out of scope

- CORS headers on tenant (40) and locale (45) refusals, which still run before CORS → not a row; a
  candidate for M143l if the maintainer wants it (security headers already cover them after §3.8).
- An atomic conditional write on `ISessionStore`/`ICacheStore` → a Core-lane contract change plus a
  lane for `cache-plugin`; not needed where the store table says the guarantee holds.
- Cookie-strategy revocation and merge → documented limits; `signIn.sessionStamp` (auth-plugin).
- The template, in-process cache and Cloudflare README halves → §0.2.
- `HEAD` on `GET` routes (V13-113, M143i) and public-file validators (V13-114, M143l).

## 10. Design security review

**Status:** completed 2026-11-22, BEFORE implementation, from §3, and revised after the independent
plan review (§11). The committed-tree audit checks the code against it.

**Reviewed flows.**

1. Sign-out on the store strategy: `POST /logout` → `destroy()` (or `auth-plugin` `signOut`) →
   commit → `revoked:` marker, row delete → clearing `Set-Cookie`, while other requests on the same
   cookie are in flight (including one that regenerates).
2. Sign-in and step-up: `regenerate()` → commit → `revoked:` pre-check → `superseded:` marker, old
   row delete → new row → `revoked:` post-check → new cookie, while a request on the old cookie is
   in flight.
3. Every store-held restore: cookie open → prefix check → row and markers read in parallel.
4. Every commit: change merge or snapshot → write → fence → `Set-Cookie`.
5. Every response through the session middleware: S1 headers before `next()`; after it, the §3.6
   decision and commit policy; the tenant-mismatch 403.
6. Early refusals: request-size 400/413 after security headers (10) and CORS (125).
7. Swagger UI Try-it-out from a browser holding a session cookie.

**Assets.** A signed-in session (its id, `userId`, auth markers); the form-CSRF token; the page and
`.data` bodies of a signed-in visitor; the integrity of a sign-out and of a regeneration; the
session cookie itself; store capacity (markers and anonymous sessions).

**Attackers.**

- A thief holding a copy of a cookie taken before sign-out or before a step-up, who keeps requests
  in flight to race the revocation, including a request that regenerates.
- Any visitor behind the same shared cache (CDN, reverse proxy) as a signed-in user.
- An anonymous visitor reaching a page cached with someone else's CSRF token (denial of sign-in).
- An anonymous client flooding `POST /logout` or asset URLs to grow the store or evict markers.
- A cross-site page driving a victim's browser against an API on the same host as Swagger UI.
- A client sending a crafted `Content-Length` or oversized body.

**Approved budgets.** Store strategy: two marker keys read in parallel with the row on each
store-held restore (twice for a request authenticated by auth-plugin's session strategy); one marker
read per commit to a loaded id, two for a regenerating commit; one row read more in `'changes'`
mode; one marker write per revocation of an id that had a row; marker storage of one small entry per
such revocation for `maxAge`. No added cost on the cookie strategy, for cookie-held sessions, or for
anonymous traffic.

**Obligations on the committed-tree audit.**

1. Race `destroy()` and `regenerate()` against overlapping requests that write, refresh (`rolling`,
   `idleTimeoutMs`) and regenerate, on the memory store, the cache store over the memory cache and
   over real Redis, 50 runs each: 0 restores of the old id, no signed-in new id derived from a
   logged-out session, no `Set-Cookie` on the racing response, the old CSRF token refused.
2. Drive a request that starts after `destroy()` returned while a racing commit is paused between
   its write and its fence: it restores nothing.
3. Fail each store step in turn (marker write, row delete, fence read, restore marker read) and show
   each fails closed: an errored or refused request, never a restored revoked session, never a
   silent success of a sign-out whose marker was not written, and a marker-write failure still
   deleting the row.
4. Present a sealed cookie whose id is `revoked:<uuid>` or `superseded:<uuid>` (built with the test
   key ring): refused before any store read. A store returning `{}` for the marker id does not count
   as a marker.
5. Flood anonymous `POST /logout` and 404 asset requests: no store entry is written.
6. Evict a marker (bounded memory cache) during a race: the outcome is the one the README documents.
7. For S1, S2 and S3 on both strategies, prove `Cache-Control: private, no-store` and
   `Vary: Cookie`; prove S1's headers are visible to a middleware inside the session middleware;
   prove a shared-storable application directive never leaves with a session `Set-Cookie`; prove an
   anonymous, cookie-less, non-reading page is not marked and a session-dependent one gets
   `Vary: Cookie`; prove the marking on the exempt and no-commit paths, on a thrown error and on the
   tenant 403; drive the nginx harness (16 leak checks) to 0.
8. Prove each "no" row of the read table neither marks a response nor hides a real read.
9. Prove the 404 rule skips only reserved-key-only new sessions on non-navigation requests (both
   navigation signals honoured; an application write still commits).
10. Prove `'changes'` keeps a concurrently deleted key deleted and refuses on a missing row.
11. 400 and 413 carry the security headers and, for an allowed origin only, the CORS headers; a
    preflight is unchanged; an origin matcher sees the resolved client address.
12. Swagger UI: a bearer- or header-API-key call omits the cookie and succeeds; a cookie API key and
    a cookie-authenticated GET keep the cookie; a cross-site form `POST` with the victim's cookie
    and no token is still refused 403.
13. Each control in the table below has its negative control run: remove it and observe its probe
    fail.

**Findings table.**

| #   | Threat                                                        | Resolution (a claim the audit checks)                                                         | Negative control                                                                      |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| T1  | Sign-out undone by an in-flight commit (V13-135)              | `revoked:` marker before the delete; every commit to a loaded id fences on it                 | remove the fence → 50/50 resurrections return                                         |
| T2  | Regeneration undone; old CSRF token accepted again (V13-136)  | the superseded id gets a `superseded:` marker; commits to it fence                            | revert to a plain delete at the `previousId` site → 50/50 old cookie restores         |
| T3  | In-flight regenerate carries a logged-out session to a new id | regenerating commit pre- and post-checks `revoked:<previousId>`                               | remove the post-check → destroy-vs-regenerate race yields a signed-in new id          |
| T4  | Request started after sign-out restores during a racing write | restore reads the markers                                                                     | remove the restore check → paused-write probe restores the session                    |
| T5  | Racing response re-plants the pre-login cookie                | a refused commit sends no `Set-Cookie`                                                        | send the cookie on refusal → probe sees the old id re-planted                         |
| T6  | Store fault turns a sign-out into a silent success            | marker first; failure still deletes the row and propagates; fence failure deletes own write   | swallow the marker-write error → 200 sign-out with the session alive                  |
| T7  | Restore marker read fault read as "no marker"                 | the fault propagates like a row-read fault                                                    | catch it as absent → revoked session restores during a store fault                    |
| T8  | Marker id used as a session id, or empty marker passes        | prefixed ids refused at restore; marker counts only with its `__setu_marker` payload          | remove the prefix check / payload check → probe reaches the store / fence passes      |
| T9  | Anonymous traffic grows the store, evicting markers           | markers only for ids that had a row; reserved-only new sessions skipped on 404 and public     | write markers for every id → anonymous logout flood writes entries                    |
| T10 | Signed-in page served to others by a shared cache (V13-111)   | S1 → `private, no-store`, `Vary: Cookie`, set before `next()`                                 | drop S1 → nginx harness leaks again; set it after `next()` → inner cache sees nothing |
| T11 | Login page cached with one visitor's CSRF token (V13-112)     | S3 → `private, no-store`                                                                      | drop S3 → returning `/login` unmarked                                                 |
| T12 | Shared cache replays a session `Set-Cookie`                   | dirty/destroy commit overrides a shared-storable directive; refresh and reserved-only skipped | remove the override → `public` response carries `Set-Cookie`                          |
| T13 | Anonymous variant served to a signed-in user                  | session-dependent page gets `Vary: Cookie`                                                    | drop `Vary` → probe shows it absent                                                   |
| T14 | Marking missing on exempt, no-commit, thrown or 403 responses | marking runs on every path through the middleware                                             | return early before marking → probe on each path unmarked                             |
| T15 | Framework reads hide or fake a visitor dependence             | the read table; internal accessors do not track                                               | count reserved reads → every response gets `Vary: Cookie`                             |
| T16 | Lost concurrent writes resurrect a deleted key (V13-137)      | `'changes'` merges onto the current row; a missing row refuses                                | force `'snapshot'` → a deleted `userId` returns; drop the missing-row check → rewrite |
| T17 | Cross-origin client cannot read a refusal (V13-34)            | security headers at 10, CORS at 125                                                           | restore 250/200 → 413 loses the headers                                               |
| T18 | Loosened CSRF exemption for Swagger UI (V13-60)               | only the page's own header-credentialed requests omit cookies; exemption rule unchanged       | remove the interceptor → Try-it-out 403; cookie API key case → omitted wrongly        |
| T19 | A missing asset mints sessions (V13-20)                       | reserved-only new session not committed on a non-navigation 404                               | remove the rule → image 404 sets a cookie                                             |

**Open questions for the maintainer (answer before implementation).**

- **Q1** — accept the restore-side marker reads (§3.3). Recommended yes.
- **Q2** — `storeCommit` default `'changes'` (recommended) against `'snapshot'`.
- **Q3** — renumber security headers to 10 and CORS to 125 (recommended) against per-refusal
  headers.
- **Q4** — may this letter edit the priority tables in `docs/plugin-architecture.md` and
  `ARCHITECTURE.md` (recommended), and should M143j's half list gain the `rest.ts:79` comment as a
  V13-34 half.
- **Q5** — leave an explicit application `public` directive on a per-visitor response (recommended)
  against overriding it.
- **Q6** — confirm the V13-60 approach (Swagger UI omits cookies on header-credentialed calls)
  rather than any change to the bearer exemption.
- **Q7** — `cache-plugin` is in no lane, and its `cacheMiddleware` must honour the marking (§0.2
  X5). Recommended: add `cache-plugin` to the Web lane in the lanes table and fix it in this letter;
  the alternative is a later letter, with V13-111 open until it ships. Also add X6 and X7 to M143o's
  half list.

## 11. Plan review (2026-11-22)

An independent agent that did not write the plan reviewed it against the row texts, the ROADMAP
section and lane rules, `CLAUDE.md`'s plan checklist and the source. It found 2 blocking, 10
should-fix and 10 minor items; each was checked against the source and resolved above:

- **Blocking:** in-process caches (`cacheMiddleware`, `cacheApiMiddleware`) ignore the marking →
  §0.2 X5, X6, S1 headers set before `next()`, Q7, the dependency stated at the top. Stores where a
  marker is evicted or not yet visible (bounded memory cache, evicting Redis, KV) → the store table,
  README preconditions, X7, an evicted-marker test.
- **Should-fix:** an in-flight `regenerate()` against a logout (§3.2 pre/post-check, two marker
  kinds, T3); a marker-write failure leaving the row (§3.1 still deletes); restore marker-read
  failure (§3.3, T7); markers for ids with no row (§3.1, T9); CORS before IP resolution (125, not
  115); reserved-only new sessions making public assets private (§3.6 row, T9); framework reads not
  enumerated (§3.5 read table, T15); the read budget (§3.3, §10); the V13-137 overclaim (§0, §3.4);
  an empty marker payload on application stores (§3.1 sentinel, T8).
- **Minor:** `MemorySessionStore` citation; the two priority comments (C5); the undecided error
  class (now `TypeError`); the 404 rule's home and test (§3.9, policy in `cache-marking.ts`); the
  "rule 1" naming (now S1–S3); the Immutable `Map` and peer-range floor (§3.10, §7); Safari without
  `Sec-Fetch-Dest` (§3.9); obligations and negative controls for every control (§10); the tenant 403
  (§3.5); a silent refused commit (§3.2 debug line); parallel restore reads (§3.3).
