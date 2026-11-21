# Milestone 143a — Sessions and Shared Caches (`@setu-ts/session-plugin`, `http-security-plugin`, `openapi-plugin`)

> **Status:** Planning — design awaiting maintainer approval; nothing is implemented. Branch:
> `feat/m143a-sessions-shared-caches`. `develop` and `main` are protected; all work and fixes stay
> on this one branch until it merges through a single PR. Lane: Web (first letter). Security-audited
> before it merges.

**Dependencies on other lanes, stated first.** This design needs **no change to an existing contract
in `common` and no change to `kernel`**: `ISessionStore` keeps its three methods, and the
cache-control decision reads the response through `IResponse.snapshot()` and writes it through
`IResponse.header()`, both committed. Nothing waits on M143i. What this letter cannot do inside its
lane is listed in §0.2: two template halves for M143j (V13-111, V13-20), one CLI source comment, and
two priority tables in repository docs outside the Web lane.

## 0. Objective & scope

A signed-in page, and a page carrying a visitor's CSRF token, must never be stored by a shared
cache; a `destroy()` or `regenerate()` on the store strategy must stay in force whatever request on
that session was already in flight; concurrent requests on one store session must stop losing each
other's writes; a request for a missing asset must not start a session; the request-size refusals
must carry the same security and CORS headers as every other response; and Swagger UI's "Try it out"
must work against a header-authenticated route in an application that has sessions. The boundary:
the cookie strategy keeps its documented limits (a copied cookie cannot be revoked, and a cookie
snapshot is whole), and no new capability, store or public contract is added beyond one
`SessionPlugin` option.

- **In scope:** V13-111, V13-112, V13-135, V13-136 (revocation and caching, the trust-boundary
  rows); V13-137 (store commits); V13-20 (session half); V13-34; V13-60. Design 1 (§3.1–§3.4): how a
  store write refuses a revoked or superseded session. Design 2 (§3.5–§3.7): which responses are
  marked private. The design security review (§10).
- **NOT this milestone:** the template halves of V13-111 and V13-20 (M143j, specified in §0.2); the
  `HEAD`-on-`GET` gap and React Router public-file validators (V13-113 in M143i, V13-114 in M143l);
  tenant and locale refusals (priority 40 and 45) without CORS headers (§9); cookie-strategy
  revocation (documented, `signIn.sessionStamp` is its answer); the nginx/CDN re-run on published
  `0.14.0` (milestone-wide gate after the release).

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

| #   | Where (owner)                                                                | Exactly what must change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Full-stack template (M143j, V13-111 half)                                    | `populateLoadContext` stops minting eagerly: it stores a getter, `context.set(csrfContext, () => getCsrfToken(ctx))`, and the generated `getCsrfToken(context)` in `app/server/session.server.ts` calls it. A page that renders no form then mints nothing, so an anonymous visitor's first page carries no `Set-Cookie` and stays shared-cacheable. The `csrfContext` key's type changes from `string` to `() => string` in `context-keys.server.ts`. Scaffold-and-boot gate row: a signed-in page and its `.data` answer `private, no-store`; an anonymous `/` answers with no `Set-Cookie`. |
| X2  | Full-stack template (M143j, V13-20 half)                                     | Ship a favicon: `public/favicon.svg` plus `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` in `app/root.tsx`'s `<head>`, so the browser's first request is a 200 public file. Gate row: `/favicon.svg` answers 200 with no `Set-Cookie`, and `GET /missing.png` (no `Sec-Fetch-Dest: document`) answers 404 with no `Set-Cookie`.                                                                                                                                                                                                                                                  |
| X3  | `packages/cli/src/templates/rest.ts:79` comment (CLI lane, M143j or M143k)   | The source comment lists "cors (200), security-headers (250)"; after §3.8 it is "security-headers (10) … cors (115)". Not generated output; the comment becomes false. No row owns it today: add it to M143j's "Half of a row owned elsewhere" as a V13-34 half.                                                                                                                                                                                                                                                                                                                               |
| X4  | `docs/plugin-architecture.md:146-163` and `ARCHITECTURE.md:1934` (Docs lane) | The priority tables list CORS at 200 and security headers at 250. **Question Q4:** these must change in the same PR as the code (docs-must-match-behaviour), so this plan asks to edit them here; otherwise M143n owns them and the tree is wrong between the two merges.                                                                                                                                                                                                                                                                                                                      |

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ISessionStore`                 | `packages/common/src/services/session.ts:234-276`                                                                            | `read(id)`, `write(id, data, ttlMs)` ("replacing any existing one"), `destroy(id): Promise<boolean>`, optional `isHealthy`, `close`. **No conditional write, no version, no compare-and-set.** The design uses only these three methods.                                                                       |
| `ICacheStore`                   | `packages/common/src/services/cache.ts:19-54`                                                                                | `get`, `set(key, value, ttlSeconds?)`, `delete`, `has`, `clear`. No set-if-exists and no CAS, so `CacheSessionStore` cannot do an atomic conditional write without a contract change.                                                                                                                          |
| `CacheSessionStore`             | `packages/session-plugin/src/stores/cache-session-store.ts:42-85`                                                            | Keys `${keyPrefix}${id}` (default `session:`); TTL rounded up to whole seconds, minimum 1.                                                                                                                                                                                                                     |
| `MemorySessionStore`            | `packages/session-plugin/src/stores/memory-session-store.ts:136-200`                                                         | `Map`; read drops expired entries; `write` replaces; periodic sweep.                                                                                                                                                                                                                                           |
| Unconditional commit write      | `packages/session-plugin/src/services/session-service.ts:298`                                                                | `await this.#store.write(snapshot.id, snapshot.data, ttlMs)` with no check. The row's line citation holds on `develop`.                                                                                                                                                                                        |
| Superseded-row delete           | `session-service.ts:247` (`#destroyStored(session.previousId)`), `:223` (destroy both ids), `:296` (demotion to cookie-held) | Plain `store.destroy`; nothing records that the id was revoked.                                                                                                                                                                                                                                                |
| Commit trigger                  | `session-service.ts:235-240`                                                                                                 | Commits when dirty, regenerated, or (`rolling` or `idleTimeoutMs`) and not new.                                                                                                                                                                                                                                |
| Cookie-held reserved keys       | `session-service.ts:44-52`                                                                                                   | `CSRF_SESSION_KEY` and `SESSION_TENANT_BINDING_KEY`; a store session holding only these lives in the cookie with no row.                                                                                                                                                                                       |
| Session ids                     | `packages/runtime/src/services/cross-runtime.ts:16-18`                                                                       | `crypto.randomUUID()`: no `:` in an id, so a `revoked:` prefix cannot collide with a real id.                                                                                                                                                                                                                  |
| `Session` reads                 | `packages/session-plugin/src/services/session.ts:137` (`get`), `:163` (`has`), `:202` (`toJSON`)                             | Plain reads with no tracking today.                                                                                                                                                                                                                                                                            |
| Framework read on every request | `packages/common/src/services/session.ts:46-50` (`tenantBindingMismatch`), called from `session-middleware.ts:74`            | Reads the reserved tenant-binding key on every request, so "the session was read" must exclude reserved keys.                                                                                                                                                                                                  |
| `getCsrfToken`                  | `packages/session-plugin/src/csrf/token.ts:59-74`; `csrfTokenField` calls it at `:172`                                       | Mints only when absent (marks dirty); a returning visitor's read sets nothing.                                                                                                                                                                                                                                 |
| Session middleware              | `packages/session-plugin/src/middleware/session-middleware.ts:60-141`                                                        | Priority 260; commit after `next()`; on throw only `revokeSuperseded`; returns early without committing for `NO_COMMIT_STATE_KEY`/`CSRF_EXEMPT_STATE_KEY`.                                                                                                                                                     |
| Headers after the handler       | `session-middleware.ts:28-32`; `packages/kernel/src/context/response.ts:98-106`                                              | The kernel appends headers after a terminal response method; `header()` sets (replaces), `appendHeader()` appends.                                                                                                                                                                                             |
| `IResponse.snapshot()`          | `packages/common/src/http.ts:352`, `ResponseSnapshot` at `:1191-1215`                                                        | Live `headers` view plus `status`; the read the cache decision needs.                                                                                                                                                                                                                                          |
| React Router response bridge    | `packages/react-router-plugin/src/handler/request-bridge.ts:81-102`                                                          | Copies React Router's status and every header (a route's `headers` export included) into `ctx.response` before the handler returns, so the session middleware sees the application's `Cache-Control`.                                                                                                          |
| React Router asset headers      | `packages/react-router-plugin/src/assets/static-assets.ts:29,38,144,196`                                                     | `public, max-age=31536000, immutable` (hashed) and `public, max-age=0, must-revalidate` (root files): the only `Cache-Control` writers on the SSR path, as the row says.                                                                                                                                       |
| `auth-plugin` sign-out          | `packages/auth-plugin/src/sign-in/auth-session-service.ts:642-656`                                                           | `signOut` calls `destroy()`; its JSDoc promises immediate revocation on the store strategy. True after this letter; no auth-plugin code change.                                                                                                                                                                |
| Template logout                 | `packages/cli/src/templates/full-stack-app-files.ts:701-705`                                                                 | `clear()` then `regenerate()`: the V13-136 path.                                                                                                                                                                                                                                                               |
| http-security priorities        | `packages/http-security-plugin/src/plugin/http-security-plugin.ts:25-31`                                                     | IP 120, size 180, CORS 200, security headers 250, CSRF 270. Security headers and CORS set their headers before `next()` (`security-headers-middleware.ts:109-111`, `cors-middleware.ts:97-174`), so moving them earlier is all a refusal needs.                                                                |
| Security headers are static     | `security-headers-middleware.ts:106-111`                                                                                     | One frozen record computed at registration; no per-request input, so it may run before IP resolution.                                                                                                                                                                                                          |
| IP-security refuses nothing     | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:279-363`                                             | Resolves the client address and forwarded origin, then `next()`; there is no refusal branch. The row's "IP-security refusal (120)" has no code behind it today (§2 C2).                                                                                                                                        |
| Request-size refusals           | `request-size-middleware.ts:73-90`                                                                                           | 400 for a malformed `Content-Length`, 413 over the bound.                                                                                                                                                                                                                                                      |
| Swagger UI request credentials  | `swagger-ui-dist@5.33.3` bundle (`node_modules/.pnpm/swagger-ui-dist@5.33.3/…/swagger-ui-bundle.js`)                         | Try-it-out request object is built as `{ url, credentials: withCredentials ? 'include' : 'same-origin', headers, … }` and passed through `requestInterceptor`; a same-origin request therefore always carries the session cookie. Setting `credentials = 'omit'` in the interceptor is proved in §6 (browser). |
| Swagger UI page                 | `packages/openapi-plugin/src/ui/swagger-ui.ts:103-145`; assets `openapi-plugin.ts:226-234` (`public, max-age=3600`)          | `SwaggerUIBundle({ url, dom_id, deepLinking, presets, layout })` with no interceptor.                                                                                                                                                                                                                          |
| Bearer exemption                | `packages/session-plugin/src/middleware/csrf-form-middleware.ts:35-40`, `csrf/exclude.ts:69-95`                              | Exempt only when a header-credential strategy authenticated the request **and it restored no session**. Kept: this letter does not loosen it.                                                                                                                                                                  |
| `CSRF_EXEMPT_STATE_KEY` remedy  | `session-middleware.ts:119-124`                                                                                              | What Mohor used for V13-60; stays the application's tool for a route that refuses sessions.                                                                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                | Resolution (picked side)                                                                                                                                      | Doc deliverable (same PR)                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1  | `session-plugin/README.md:50` "Immediate revocation: **Yes** — delete the entry" and `auth-session-service.ts:645-648` against the 50/50 measurement                                    | The code changes to match the claim (§3.1–§3.3). The README gains the exact guarantee and its one precondition (a linearizable store).                        | README table row and a "Revocation under concurrency" paragraph; the auth JSDoc stays.             |
| C2  | V13-34's text names an "IP-security refusal (120)"; the middleware has no refusal branch                                                                                                | Source wins: the fix covers the request-size 400 and 413, and the reorder covers any refusal later added at 120. The row's re-run drives the 400 and the 413. | Plan note only; the DEFECTS row is reworded by the maintainer at re-run (smoke/ is not committed). |
| C3  | `session-plugin/README.md:65-69` "can lose one change" against the measured K−1 of K                                                                                                    | Replaced by the `storeCommit` behaviour (§3.4) and an accurate statement of each mode.                                                                        | README "Concurrent requests" section rewritten.                                                    |
| C4  | Priority tables: `docs/plugin-architecture.md:159`, `ARCHITECTURE.md:1934`, `PUBLIC_API.md:4371` ("priority 200"), `http-security-plugin/README.md:110`, `session-plugin/README.md:406` | New priorities (§3.8) everywhere.                                                                                                                             | `PUBLIC_API.md`, both READMEs here; the two repository docs per Q4 (§0.2 X4).                      |

## 3. Design decisions

### Design 1 — how a store write refuses a revoked or superseded session

**Options compared.**

| Option                                                              | Memory store                    | Cache store (Redis, memory cache, custom `ICacheStore`)                                                                 | Application `ISessionStore`                            | Cost                                                               | Verdict                                                                     |
| ------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| A. Atomic conditional write (`writeIfPresent`) on `ISessionStore`   | trivial                         | impossible over `ICacheStore` without a second contract change (set-if-exists) plus `cache-plugin`, which no lane lists | must implement it; a store without it needs a fallback | Core-lane contract change first, two paths                         | Rejected: waits on M143i and a lane change, and still needs a fallback path |
| B. Row version + compare-and-set                                    | possible                        | no CAS primitive in `ICacheStore`                                                                                       | must implement CAS                                     | same as A                                                          | Rejected: same blockers as A                                                |
| C. Check-then-write (read the row, write only if present)           | non-atomic                      | non-atomic                                                                                                              | works                                                  | +1 read                                                            | Rejected alone: the race moves from request length to one round trip        |
| D. Tombstone in the row itself                                      | overwritten by the racing write | overwritten                                                                                                             | overwritten                                            | —                                                                  | Rejected: the in-flight write replaces the tombstone, so nothing is fenced  |
| **E. Revocation marker under its own id + write-then-verify fence** | works                           | works                                                                                                                   | works with no new method                               | +1 write per revoke, +1 read per commit and per store-held restore | **Chosen**                                                                  |

**Why E is sound.** A revoke writes the marker **before** it deletes the row; a commit writes the
row and **then** reads the marker, deleting its own write when the marker exists. On a linearizable
store every interleaving ends with the row gone: if the commit's write precedes the marker, the
revoke's later delete removes it; if it follows the marker, the commit's own read sees the marker.
It uses only `read`/`write`/`destroy`, so it holds on every shipped store and on an application
store, with one implementation.

### 3.1 Revocation marker

- **Decision:** a private `#revoke(id)` in `SessionService` replaces `#destroyStored` at all four
  sites (`destroy()` both ids, the superseded id after `regenerate()`, `revokeSuperseded` on a
  throw, and the demotion of a stored session to cookie-held). It writes
  `store.write('revoked:' + id, {}, config.maxAgeMs)`, then `store.destroy(id)`. If the marker write
  throws, the row is not deleted and the error propagates (the logout fails visibly, as a store
  fault does today); if the delete throws after the marker, the marker stands and still fences every
  commit. Marker TTL is `maxAgeMs`, the longest a row can be written for, so it outlives any request
  that loaded the row before the revocation except one running longer than `maxAge` (§8).
- **Why:** a separate id cannot be overwritten by the racing commit, which is what made option D
  useless.
- **Test home:** `test/integration/revocation-race.test.ts` (V13-135, V13-136 probes inverted);
  `test/unit/services/session-revoke.test.ts` (order, failure of each step).

### 3.2 Commit fence

- **Decision:** a commit that writes a row for an id the request **loaded from the store**
  (`wasStoreHeld`, not regenerated, not rotated) reads `revoked:<id>` after its write; when present
  it deletes the row, sends **no `Set-Cookie`** (and no clearing cookie, which would wipe the new
  cookie a `regenerate()` just gave the browser), and returns a refused outcome. A write to a fresh
  id (new session, regenerated id, promotion's `rotateId`) has no fence: no other request can hold
  it. If the fence read throws, the commit deletes its own write best-effort and rethrows.
  `commit()` returns `Promise<'written' | 'refused' | 'skipped'>` (was `Promise<void>`; additive for
  callers) so the middleware can decide caching (§3.6).
- **Why:** closes V13-135 and V13-136 including the `rolling` read-only case, and stops a racing
  response from re-planting the pre-login cookie.
- **Test home:** `revocation-race.test.ts` (50 runs each; 0 resurrections; the old cookie restores
  nothing; the racing response carries no `Set-Cookie`); `session-revoke.test.ts` (fence read throws
  → own write deleted, error rethrown).

### 3.3 Restore check

- **Decision:** a store-held restore that finds the row also reads `revoked:<id>` and treats a
  present marker as no session (same path as a missing row, `session-service.ts:365-370`, and the
  same for `fromHeaders`). A snapshot whose id starts `revoked:` is refused before any store read.
- **Why:** without it, a request that **starts** after `destroy()` returned can still restore the
  row during the one round trip between a racing commit's write and its fence delete. With it, the
  guarantee is simple: once `destroy()` or a `regenerate()` commit returns, no request restores the
  old id. Cost: one extra store read per request carrying a store-held session (one Redis `GET`);
  cookie-held and cookie-strategy sessions pay nothing. **Question Q1** asks the maintainer to
  accept that cost; dropping §3.3 keeps §3.1–§3.2 correct for the measured 50/50 cases and leaves
  the one-round-trip window documented.
- **Test home:** `revocation-race.test.ts` (a request started between a racing write and its fence,
  driven with a store double that pauses after the write, restores nothing);
  `test/unit/session-from-headers.test.ts` (marker → `null`).

### 3.4 Store commits write the request's changes (V13-137)

- **Decision:** `Session` records its changes (`set`/`delete` per key, and whether `clear()` ran).
  New option `storeCommit: 'changes' | 'snapshot'`, default `'changes'`. In `'changes'` mode a
  commit to a loaded store-held id reads the current row; a missing row (expired, or deleted by
  anything) refuses the commit exactly like the fence; otherwise it writes `current` with this
  request's changes applied (a `clear()` writes this request's payload whole), and the cookie-held
  decision is made on that merged payload. In `'snapshot'` mode it writes the request's whole
  payload (today's behaviour) followed by the fence. New, regenerated and rotated ids always write
  the whole payload. Setting `storeCommit` without a `store` is refused at registration with a named
  error (the option has no consumer on the cookie strategy). A `rolling` refresh in `'changes'` mode
  rewrites the current row, so a read-only request no longer overwrites another request's write.
- **Why:** the merge narrows lost updates from the whole request to one round trip and makes a key
  deleted by a concurrent request (a logout that deletes `userId` without `destroy()`) stay deleted.
  `'snapshot'` stays for an application whose keys must change together (an item list and its total
  written by one request), which a per-key merge could mix. **Question Q2:** default `'changes'`
  (recommended; Spring Session's default) against `'snapshot'` (today's).
- **Test home:** `test/integration/store-commit-modes.test.ts` (10 concurrent increments:
  `'changes'` keeps each request's disjoint key, both modes documented for one key; disjoint keys
  `a`/`b` both survive in `'changes'`; `'snapshot'` reproduces today); `options.test.ts` (refusal
  without a store); `session.test.ts` (change tracking).

### Design 2 — which responses are marked private

**Options compared.**

| Layer                                     | What it can see                                                                                    | Verdict                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| React Router plugin: every page `private` | only that a page rendered, not whether it depends on a visitor                                     | Rejected: makes every anonymous marketing page uncacheable, and misses REST routes, Swagger UI and any non-SSR page that reads the session    |
| Starter or template middleware            | the same as the application                                                                        | Rejected: an application composed without the starter (the REST template with sessions) stays exposed, and the fix becomes a line to remember |
| **Session plugin, after the handler**     | whether a session was restored and what it held, whether it commits, whether a CSRF token was read | **Chosen**: the only layer that knows a response is tied to a cookie-identified visitor, on every route kind, with one implementation         |

### 3.5 What marks a response as per-visitor

- **Decision:** the session middleware decides after `next()`, for every response it handles (the
  exempt and no-commit paths included). A response is **per-visitor** when any of:
  1. the request restored a session holding any key other than the reserved cookie-held keys (a
     signed-in visitor, or one carrying application data); this is decided at load, so a session
     read late (a deferred loader) is still covered;
  2. the response carries the session `Set-Cookie` (a written commit or a destroy);
  3. a CSRF token was read for this request (`getCsrfToken`, `csrfTokenField`), recorded on the
     `Session` object. A response is **session-dependent** when application code read a non-reserved
     key (`get`, `has`) or called `toJSON()`, while none of 1–3 holds: it is the anonymous variant
     of a page. Reads of the reserved keys by the framework (`tenantBindingMismatch`,
     `readCsrfToken` inside `getCsrfToken`) do not count.
- **Why:** 1 covers V13-111 (the leak), 3 covers V13-112 (a returning visitor's `/login` has no
  `Set-Cookie`), 2 covers a cached response replaying one visitor's cookie to everyone. An anonymous
  visitor holding only a cookie-held CSRF session is not per-visitor on a page that does not read
  the token, which keeps anonymous pages cacheable once the template stops minting eagerly (§0.2
  X1).
- **Test home:** `test/unit/services/cache-marking.test.ts` (one case per signal, and the reserved
  reads that must not count); `session.test.ts` (read tracking).

### 3.6 The headers it writes

- **Decision:** read the application's `Cache-Control` from `ctx.response.snapshot().headers`. A
  directive is **shared-storable** when present and containing neither `private` nor `no-store`.
  - No directive, per-visitor → `Cache-Control: private, no-store` and `Vary: Cookie` (appended,
    never duplicated).
  - No directive, session-dependent only → `Vary: Cookie` only (a shared cache keeps the anonymous
    variant for cookie-less visitors and does not serve it to a signed-in one).
  - Shared-storable directive and the commit is a refresh only (`rolling`/`idleTimeoutMs`, not
    dirty, not regenerated) → the refresh is skipped for this response (`'skipped'`): no
    `Set-Cookie` rides a response the application made public (a hashed asset under `rolling`), and
    the next non-public response refreshes the idle window.
  - Shared-storable directive and the commit is dirty, regenerated or a destroy → the directive is
    replaced by `private, no-store`: a session cookie never rides a shared-storable response.
  - Any other present directive is the application's decision and is left as written.
  - On a request that throws, rule 1 is applied before rethrowing. `respondWithError`
    (`common/src/errors/error-responder.ts:245-258`) sets status and body without clearing headers;
    a test proves the marking survives the error handler's response.
- **Why:** `no-store` as well as `private` so a signed-in page is not kept in the browser's cache
  after sign-out on a shared computer (the defensive default other frameworks send). Respecting an
  explicit directive is how an application that deliberately caches a page says so (§3.7); the two
  overrides exist because no explicit directive can make a `Set-Cookie` safe to share.
- **Test home:** `cache-marking.test.ts` (each row of the table above, with the response it starts
  from); `test/e2e/private-responses.test.ts` (real kernel app, store and cookie strategies: the
  §0.1 probes inverted; an asset route with `public, max-age=31536000, immutable` under `rolling`
  keeps its directive and gets no `Set-Cookie`).

### 3.7 An application that deliberately caches a page

- **Decision:** no new option. The application sets its own `Cache-Control` (a React Router route's
  `headers` export, or `ctx.response.header(...)` in a handler or an application middleware, which
  runs inside the session middleware and so sets it first). The plugin leaves a present directive
  alone except in the two `Set-Cookie` cases of §3.6. The README gives the recipe: cache the
  anonymous variant with `public, s-maxage=…` only when no session was restored, and read the CSRF
  token in a loader, not in deferred data (a token read after the response headers are sent cannot
  mark the response). **Question Q5:** the maintainer may prefer overriding an explicit public
  directive on any per-visitor response; recommended against, because a developer who writes
  `public` on a signed-in page has made a decision the framework can document but not guess.
- **Why:** one rule, no switch to forget, and every page an application did not mark is safe.
- **Test home:** `private-responses.test.ts` (explicit `public, s-maxage=60` on a page reading only
  for anonymous visitors is kept; the same page with a dirty commit becomes `private, no-store`).

### 3.8 Security headers and CORS run before every refusal (V13-34)

- **Decision:** security headers move from priority 250 to **10**, CORS from 200 to **115**. IP
  resolution stays 120, request size 180, origin CSRF 270. Both middlewares already set their
  headers before `next()`, so every response produced downstream, the request-size 400 and 413
  included, carries them. Security headers at 10 also cover refusals at 40 (tenant) and 45 (locale),
  and an error response the error handler (0) builds from a throw anywhere after 10. CORS stays
  after request logging (100), so a preflight answered by CORS is still logged.
- **Why:** rejected alternative — keep the priorities and have each refusal add the headers itself:
  that covers only this plugin's two refusals and duplicates the CORS decision (two entry points,
  one capability). CORS earlier than 100 would skip metrics, tracing and logging for preflights.
  **Question Q3** asks the maintainer to approve renumbering two documented priorities.
- **Test home:** `packages/http-security-plugin/test/integration/refusal-headers.test.ts` (413 and
  400 carry `access-control-allow-origin`, `vary: Origin`, `x-content-type-options`, HSTS; a
  disallowed origin gets no CORS header on the 413; a preflight still 204s);
  `test/unit/http-security-plugin.test.ts` (registered priorities).

### 3.9 A missing asset starts no session (V13-20, session half)

- **Decision:** a **new** session whose payload holds only the reserved keys is not committed on a
  `404` response to a request that is not a document navigation (`Sec-Fetch-Dest` absent or not
  `document`). Application data written during the request still commits. The response is still
  marked by §3.6 (a token read on it makes it `private, no-store`).
- **Why:** removes the session a framework mint or tenant seal creates for `/favicon.ico` or a stale
  asset URL, without path heuristics that would break a React Router resource route like
  `/sitemap.xml`, and without dropping application writes. A navigational 404 that renders a form
  keeps its token.
- **Test home:** `cache-marking.test.ts` (404 + image fetch → no `Set-Cookie`; 404 + document
  navigation → `Set-Cookie`; 404 + application write → `Set-Cookie`; 200 + image fetch → unchanged).

### 3.10 Swagger UI Try-it-out with header credentials (V13-60)

- **Decision:** the Swagger UI page gets a `requestInterceptor` that sets `credentials = 'omit'` on
  a Try-it-out request carrying `Authorization` or a header named by an `apiKey` scheme with
  `in: 'header'` in the loaded document (`window.ui.specSelectors.specJson()`); every other request
  keeps Swagger UI's default. The interceptor is an internal TypeScript function
  (`src/ui/swagger-interceptor.ts`, not exported from `index.ts`) embedded into the page through
  `Function.prototype.toString()`, so its branches are unit-tested as a function. The bearer
  exemption is unchanged: the request now restores no session, so the existing rule exempts it and
  nothing commits.
- **Why:** a header-credentialed call has no use for the cookie, and sending it is what defeats the
  exemption; a session-authenticated GET keeps working because its request carries no header
  credential. The rejected alternative, exempting bearer requests that also carry a restored
  session, reopens the M113e decision that a restored session must present its token.
- **Test home:** `packages/openapi-plugin/test/unit/swagger-interceptor.test.ts` (each header shape,
  `in: cookie` keeps credentials, a missing spec keeps credentials); `swagger-ui.test.ts` (page
  embeds the interceptor); browser proof in §7.

### 3.11 Documentation in the lane

- **Decision:** `session-plugin` README: revocation guarantee and its precondition (§3.1–§3.3),
  `storeCommit`, the caching rule and the deliberate-caching recipe, the 404 rule, the new priority
  of the neighbours it names; `http-security-plugin` README: priorities and why; `openapi-plugin`
  README: Try-it-out and cookies; `react-router-plugin` README: one paragraph pointing pages to the
  session plugin's caching rule and the `headers` export; `PUBLIC_API.md`, `CHANGELOG.md`,
  `docs/upgrading.md` (priorities, `storeCommit` default, `Cache-Control` now sent).
- **Why:** each claim must match the code it describes.
- **Test home:** `pnpm run check:docs`; docs-claims review before the PR.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `ISessionStore` and every other published interface are
unchanged. Observable behaviour changes (two middleware priorities, new response headers,
`storeCommit` default, a refused racing commit, `SessionService.commit` returning an outcome instead
of `void`) are documented in `docs/upgrading.md` and ship in `0.14.0`.

| Exported symbol                       | Kind                    | Consumer / real code path that READS it                                               |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `SessionPluginOptions.storeCommit`    | option (existing type)  | `resolveSessionConfig` → `SessionService.commit` branch (§3.4)                        |
| `SessionService.commit` (return type) | method (existing class) | `sessionMiddleware` reads the outcome to decide `Set-Cookie`-dependent caching (§3.6) |

No new export from any `index.ts`. The marker id format, change tracking, read tracking and the
Swagger interceptor are internal.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                                 | Behavior (per implementation)                                                                                           |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `storeCommit: 'changes'`    | `SessionService.commit`, store strategy  | memory, cache and application stores: read current row, apply this request's changes, write, fence; missing row refuses |
| `storeCommit: 'snapshot'`   | `SessionService.commit`, store strategy  | every store: write this request's payload, fence                                                                        |
| `storeCommit` with no store | `resolveSessionConfig` / plugin register | refused with a named configuration error naming the option and that it applies only to the store strategy               |

## 5. Implementation files

| File                                                                               | Purpose                                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/session-plugin/src/services/session-service.ts`                          | `#revoke`, fence, restore check, `storeCommit` modes, commit outcome, 404 rule            |
| `packages/session-plugin/src/services/session.ts`                                  | change tracking, read tracking (non-reserved keys), CSRF-read flag                        |
| `packages/session-plugin/src/services/cache-marking.ts` (new, internal)            | the §3.5/§3.6 decision as a pure function over (session facts, outcome, response headers) |
| `packages/session-plugin/src/middleware/session-middleware.ts`                     | applies marking on every non-throw path and rule 1 on throw; refresh skip                 |
| `packages/session-plugin/src/csrf/token.ts`                                        | `getCsrfToken` records the read on the session                                            |
| `packages/session-plugin/src/options.ts`                                           | `storeCommit` option, resolution and refusal                                              |
| `packages/session-plugin/src/errors.ts`                                            | reuse an existing configuration error if one fits, otherwise one named class (internal)   |
| `packages/http-security-plugin/src/plugin/http-security-plugin.ts`                 | priorities 10 and 115                                                                     |
| `packages/openapi-plugin/src/ui/swagger-interceptor.ts` (new, internal)            | the interceptor function                                                                  |
| `packages/openapi-plugin/src/ui/swagger-ui.ts`                                     | embeds it in the page                                                                     |
| READMEs of the four packages, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` | §3.11                                                                                     |

`src/index.ts` of every package: unchanged.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                    | Key assertions                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-plugin/test/integration/revocation-race.test.ts` (from the §0.1 probe) | `session-service.ts`                           | V13-135 50 runs, `rolling` 50 runs, V13-136 50 runs: **0** resurrections each, on `MemorySessionStore` and `CacheSessionStore` over the memory cache; racing response has no `Set-Cookie`; started-after request restores nothing (§3.3) |
| `session-plugin/test/integration/revocation-race-redis-real.test.ts` (guarded)  | `session-service.ts`, `cache-session-store.ts` | same three races against a real Redis cache store (skipped without `REDIS_URL`, like `store-anonymous-redis-real.test.ts`)                                                                                                               |
| `session-plugin/test/unit/services/session-revoke.test.ts` (new)                | `session-service.ts`                           | marker before delete; marker write throws → row kept, error out; delete throws → marker kept; fence read throws → own write deleted, rethrown; `revoked:` id refused at restore                                                          |
| `session-plugin/test/integration/store-commit-modes.test.ts` (from the probe)   | `session-service.ts`, `session.ts`             | `'changes'`: disjoint keys survive, a concurrent delete stays deleted, `clear()` writes whole, missing row refuses, rolling refresh rewrites current row; `'snapshot'`: today's loss reproduced                                          |
| `session-plugin/test/unit/services/session.test.ts` (extended)                  | `session.ts`                                   | change and read tracking; reserved-key reads not counted; CSRF-read flag                                                                                                                                                                 |
| `session-plugin/test/unit/services/cache-marking.test.ts` (new)                 | `cache-marking.ts`                             | every row of §3.6; per-visitor signals 1–3; session-dependent only; 404 rule of §3.9                                                                                                                                                     |
| `session-plugin/test/unit/middleware/session-middleware.test.ts` (extended)     | `session-middleware.ts`                        | marking on exempt/no-commit paths, on throw (rule 1), refresh skip, outcome wiring                                                                                                                                                       |
| `session-plugin/test/e2e/private-responses.test.ts` (from the probe)            | middleware + service through a kernel app      | V13-111/V13-112 inverted on both strategies; anonymous no-cookie page has no `Cache-Control`; explicit `public` kept; asset under `rolling` keeps its directive and no `Set-Cookie`                                                      |
| `session-plugin/test/unit/options.test.ts` (extended)                           | `options.ts`                                   | default `'changes'`; refusal without a store                                                                                                                                                                                             |
| `session-plugin/test/unit/csrf/csrf.test.ts` (extended)                         | `csrf/token.ts`                                | read recorded for minted and existing tokens                                                                                                                                                                                             |
| `auth-plugin/test/integration/sign-out-race.test.ts`                            | (consumer proof)                               | `signOut` on the store strategy with an overlapping request: the copied cookie is signed out (JSDoc claim)                                                                                                                               |
| `starters/full-stack-starter/test/integration/private-pages.test.ts`            | (composition proof)                            | through the `loadRequestHandler` seam: signed-in document and `.data` answer `private, no-store`; anonymous page without a token read is not marked                                                                                      |
| `http-security-plugin/test/integration/refusal-headers.test.ts` (from probe)    | `http-security-plugin.ts`                      | 413 and 400 carry CORS and security headers; disallowed origin none; preflight 204                                                                                                                                                       |
| `http-security-plugin/test/unit/http-security-plugin.test.ts` (extended)        | `http-security-plugin.ts`                      | priorities 10 and 115                                                                                                                                                                                                                    |
| `openapi-plugin/test/unit/swagger-interceptor.test.ts`                          | `swagger-interceptor.ts`                       | `Authorization` → omit; header API key → omit; cookie API key → keep; none → keep; spec not loaded → keep                                                                                                                                |
| `openapi-plugin/test/unit/swagger-ui.test.ts` (extended)                        | `swagger-ui.ts`                                | page embeds the interceptor and wires `requestInterceptor`                                                                                                                                                                               |

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

Beyond the gates: a browser proof of §3.10 (a signed-in session cookie, Swagger UI "Authorize" with
a bearer token, Execute a `POST` under form CSRF → 2xx; without the interceptor → 403), driven with
the in-app browser on a local app and recorded in the PR; the X86 nginx cache harness re-run locally
against the branch (expected 0 leaks of 16); the committed-tree security audit of §10 in a fresh
context, after verification and code review.

## 8. Risks & mitigations

- A non-linearizable store (reads from a replica) can miss a marker just written → the README states
  the precondition; the shipped cache store over one Redis primary meets it.
- A request running longer than `maxAge` that loaded the session before a revocation can outlive the
  marker → bounded by `maxAge` (default two hours); documented.
- One extra store read per store-held request (§3.3) and per commit (§3.2), two in `'changes'` mode
  → measured in the PR on the memory and Redis cache stores; Q1 can drop §3.3.
- Marker rows appear in an application store's listing → documented; they expire after `maxAge`.
- `private, no-store` on pages that were CDN-cached by accident → intended; upgrade note and the
  §3.7 recipe.
- Moving security headers to 10 changes when an application middleware between 10 and 250 sees them
  → upgrade note; no first-party middleware reads them.
- `Function.prototype.toString()` output of the built interceptor → a test asserts the embedded text
  is the compiled function and the browser proof runs on the built package.

## 9. Out of scope

- CORS headers on tenant (40) and locale (45) refusals, which still run before CORS → not a row; a
  candidate for M143l if the maintainer wants it (security headers already cover them after §3.8).
- An atomic conditional write on `ISessionStore`/`ICacheStore` → would be a Core-lane contract
  change plus a lane for `cache-plugin`; not needed for the guarantee.
- Cookie-strategy revocation and merge → documented limits; `signIn.sessionStamp` (auth-plugin).
- The template halves → M143j (§0.2).
- `HEAD` on `GET` routes (V13-113, M143i) and public-file validators (V13-114, M143l).

## 10. Design security review

**Status:** completed 2026-11-22, BEFORE implementation, from §3. The committed-tree audit checks
the code against it.

**Reviewed flows.**

1. Sign-out on the store strategy: `POST /logout` → `destroy()` (or `auth-plugin` `signOut`) →
   commit → `#revoke` both ids → clearing `Set-Cookie`, while other requests on the same cookie are
   in flight.
2. Sign-in and step-up: `regenerate()` → commit → `#revoke(previousId)` → write new id → new cookie,
   while a request on the old cookie is in flight.
3. Every request's restore: cookie open → store read → marker read (§3.3).
4. Every commit: change merge or snapshot → write → fence → `Set-Cookie`.
5. Every response leaving the session middleware: per-visitor and session-dependent decision →
   `Cache-Control`/`Vary` → refresh skip.
6. Early refusals: request-size 400/413 after security headers (10) and CORS (115).
7. Swagger UI Try-it-out from a browser holding a session cookie.

**Assets.** A signed-in session (its id, `userId`, auth markers); the form-CSRF token; the page and
`.data` bodies of a signed-in visitor; the integrity of a sign-out and of a regeneration; the
session cookie itself.

**Attackers.**

- A thief holding a copy of a cookie taken before sign-out or before a step-up, who keeps requests
  in flight to race the revocation.
- Any visitor behind the same shared cache (CDN, reverse proxy) as a signed-in user.
- An anonymous visitor reaching a page cached with someone else's CSRF token (denial of sign-in).
- A cross-site page driving a victim's browser against an API on the same host as Swagger UI.
- A client sending a crafted `Content-Length` or oversized body.

**Approved budgets.** Store strategy: one extra store read per request carrying a store-held session
(§3.3), one extra read per commit (§3.2), one more in `'changes'` mode (§3.4), one extra write per
revocation; marker storage of one empty entry per revocation for `maxAge`. No added cost on the
cookie strategy or for cookie-held sessions.

**Obligations on the committed-tree audit.**

1. Race `destroy()` and `regenerate()` against overlapping committing requests (writes, `rolling`
   read-only, `idleTimeoutMs`) on the memory store, the cache store over the memory cache and over
   real Redis, 50 runs each: 0 restores of the old id afterwards; the racing response carries no
   `Set-Cookie`; the old CSRF token is refused.
2. Drive a request that starts after `destroy()` returned while a racing commit is paused between
   its write and its fence: it restores nothing (§3.3).
3. Fail each store step in turn (marker write, row delete, fence read, restore marker read) and show
   each fails closed: a refused or errored request, never a restored revoked session and never a
   silent success of a sign-out whose marker was not written.
4. Present a sealed cookie whose id is `revoked:<uuid>` (built with the test key ring): refused
   before any store read; a crafted unsealed cookie is refused as today.
5. For every per-visitor signal (restored data session, `Set-Cookie`, CSRF read) and both
   strategies, prove `Cache-Control: private, no-store` and `Vary: Cookie`; prove a shared-storable
   application directive never leaves with a session `Set-Cookie`; prove an anonymous, cookie-less,
   non-reading page is not marked; drive the nginx harness (16 leak checks) to 0.
6. Prove reserved-key reads (tenant binding, CSRF lookup) neither mark a response nor hide a real
   read of a non-reserved key.
7. Prove the 404 rule drops only reserved-key-only new sessions on non-navigation requests: an
   application write on a 404 still commits; a document navigation still commits.
8. 400 and 413 carry the security headers and, for an allowed origin only, the CORS headers; a
   disallowed origin gets none; preflight unchanged.
9. Swagger UI: a bearer- or header-API-key call omits the cookie and succeeds; a
   cookie-authenticated GET still carries the cookie; a cross-site form `POST` with the victim's
   cookie and no token is still refused 403 (the exemption was not loosened).
10. Each control above has a negative control: remove it and observe its probe fail (§10 table).

**Findings table.**

| #   | Threat                                                        | Resolution (a claim the audit checks)                                                       | Negative control                                                                         |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| T1  | Sign-out undone by an in-flight commit (V13-135)              | `#revoke` writes `revoked:<id>` before the delete; every commit to a loaded id fences on it | remove the fence → 50/50 resurrections return                                            |
| T2  | Regeneration undone; old CSRF token accepted again (V13-136)  | the superseded id is revoked through the same marker                                        | revert `#revoke` to a plain delete at the `previousId` site → 50/50 old cookie restores  |
| T3  | Request started after sign-out restores during a racing write | restore reads the marker (§3.3)                                                             | remove the restore check → the paused-write probe restores the session                   |
| T4  | Racing response re-plants the pre-login cookie                | a refused commit sends no `Set-Cookie`                                                      | send the cookie on refusal → probe sees the old id re-planted                            |
| T5  | Store fault turns a sign-out into a silent success            | marker written first; failure propagates; fence failure deletes own write and rethrows      | swallow the marker-write error → probe sees a 200 sign-out with the session alive        |
| T6  | Marker id used as a session id                                | `revoked:` ids refused at restore; real ids are `randomUUID()`                              | remove the prefix check → sealed `revoked:` cookie reaches the store read                |
| T7  | Signed-in page served to others by a shared cache (V13-111)   | restored data session → `private, no-store`, `Vary: Cookie`                                 | drop signal 1 → nginx harness leaks again                                                |
| T8  | Login page cached with one visitor's CSRF token (V13-112)     | CSRF read → `private, no-store`                                                             | drop signal 3 → returning `/login` unmarked                                              |
| T9  | Shared cache replays a session `Set-Cookie`                   | dirty/destroy commit overrides a shared-storable directive; a refresh is skipped            | remove the override → `public` response carries `Set-Cookie`                             |
| T10 | Anonymous variant served to a signed-in user, or vice versa   | session-dependent anonymous page gets `Vary: Cookie`                                        | drop `Vary` → probe shows it absent                                                      |
| T11 | Lost concurrent writes resurrect a deleted key (V13-137)      | `'changes'` merges onto the current row; a missing row refuses                              | force `'snapshot'` → a deleted `userId` returns                                          |
| T12 | Cross-origin client cannot read a refusal (V13-34)            | security headers at 10, CORS at 115                                                         | restore 250/200 → 413 loses the headers                                                  |
| T13 | Loosened CSRF exemption for Swagger UI (V13-60)               | only the page's own requests omit cookies; the exemption rule is unchanged                  | remove the interceptor → Try-it-out answers 403; cross-site POST stays 403 in both cases |
| T14 | A missing asset mints sessions (store growth, cache bypass)   | reserved-only new session not committed on a non-navigation 404                             | remove the rule → image 404 sets a cookie                                                |

**Open questions for the maintainer (answer before implementation).**

- **Q1** — accept the restore-side marker read (§3.3): one extra store read per request carrying a
  store-held session. Recommended yes.
- **Q2** — `storeCommit` default `'changes'` (recommended) against `'snapshot'`.
- **Q3** — renumber security headers to 10 and CORS to 115 (recommended) against per-refusal
  headers.
- **Q4** — may this letter edit `docs/plugin-architecture.md` and `ARCHITECTURE.md`'s priority
  tables (recommended, so docs match the code at merge), and should M143j's half list gain the
  `rest.ts:79` comment as a V13-34 half.
- **Q5** — leave an explicit application `public` directive on a per-visitor response (recommended)
  against overriding it.
- **Q6** — confirm the V13-60 approach (Swagger UI omits cookies on header-credentialed calls)
  rather than any change to the bearer exemption.
