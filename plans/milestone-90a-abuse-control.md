# Milestone 90a — Abuse control that actually protects

> **Status:** Planning. Branch: `feat/m90a-abuse-control`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Make the framework's three abuse-control mechanisms — the rate limiter, the request-size limit and
the GraphQL query-cost limit — bound what their documentation says they bound. All six findings come
from `smoke/X32-FINDINGS.md` and every one of them was **re-verified against this working tree**
before planning (§1), not taken from the published `0.4.0` snapshot they were found on.

The unifying defect is that each limiter is correct on the path its tests exercise and unbounded on
a path nothing composes: the rate limiter refuses the liveness probe it was never composed with, the
size limit is disabled by a request header no test sends, and the depth limit measures a dimension
no attack uses.

- **In scope:** X32-1 (limiter answers `429` from `/live` and `/ready`), X32-2 (the `429` bypasses
  the configured error format), X32-3 (leftmost `X-Forwarded-For` is client-controlled), X32-4
  (`requestSizeMiddleware` bypassed by chunked encoding), X32-5 (unnamespaced Redis keys), X32-6
  (GraphQL breadth unbounded). Unifying the framework's four path-exclusion implementations behind
  one `common` helper, which X32-1's fix would otherwise make a fifth.
- **NOT this milestone:** X32-7 (`BulkheadFullError` masked as `500`) — owned by **M90f**, which
  sweeps every unbranded caller-facing error class. `ipSecurityMiddleware`'s absent allow/deny lists
  — recorded in X32 as an observation, not a finding, and owned by no milestone yet. Database
  connection-pool exhaustion — **M90b** (health) and **M90f** (status). GraphQL depth limiting
  itself, which X32 measured as **working**.

## 1. Contracts verified from SOURCE (not names)

| Reference               | Source (file:line)                                                                | Verified surface / fact                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RateLimitOptions`      | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:23-44`              | Exactly six members: `windowMs`, `max`, `store?`, `keyGenerator?`, `message?`, `standardHeaders?`. **No exclusion member** — `grep -c exclude` returns `0`.                                                           |
| The `429` short-circuit | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:89-98`              | Writes its own body via `ctx.response.status(429).header('Retry-After', …).json({ error, message })`. `grep -c respondWithError` in that file returns `0`.                                                            |
| `respondWithError`      | `packages/common/src/errors/error-responder.ts:206`                               | `(target: ErrorResponderTarget, init: ErrorResponseInit): void`. Sanitises the status first, then delegates to the responder in `ERROR_RESPONDER_STATE_KEY`, falling back to `.json()`.                               |
| `CLIENT_IP_STATE_KEY`   | `packages/common/src/state-keys.ts:48`                                            | `'http-security-plugin:client-ip'` — the key `defaultRateLimitKey` reads second.                                                                                                                                      |
| XFF parse               | `packages/http-security-plugin/src/middleware/ip-security-middleware.ts:65`       | `headerValue.split(',')[0]?.trim()` — **leftmost**, i.e. the client-supplied entry under an appending proxy.                                                                                                          |
| Size check              | `packages/http-security-plugin/src/middleware/request-size-middleware.ts:45-51`   | Reads `Content-Length`; `if (contentLength === null) { await next(); return; }` — absent header is an unconditional pass-through.                                                                                     |
| **The body read**       | `packages/runtime/src/adapters/shared/fetch-mapping.ts:129-138`                   | `#readBody()` calls `this.#raw.arrayBuffer()` — buffers the **whole** body, unbounded. **This is in `runtime`, not `http-security-plugin`**, which is what makes X32-4's preferred fix a cross-package change (§3.4). |
| Body laziness           | `packages/runtime/src/adapters/shared/fetch-mapping.ts:104-105`                   | `bytes(): return this.#body ??= this.#readBody()` — M87 made the read lazy, so it happens inside the handler, AFTER middleware.                                                                                       |
| `RedisRateLimitStore`   | `packages/auth-plugin/src/stores/redis-rate-limit-store.ts`                       | Constructor takes `{ url?, client?, runtime }`. `grep -c 'prefix\|keyPrefix'` returns `0` — keys are stored exactly as `keyGenerator` produced them.                                                                  |
| Multi-tenancy exclusion | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:53-60, 98-120` | `readonly (string \| RegExp)[]`; six defaults `['/live','/ready','/health','/metrics','/openapi.json','/docs']`; O(n) loop; resets `entry.lastIndex` before `.test` because a `g`/`y` RegExp is stateful.             |
| Logger exclusion        | `packages/logger-plugin/src/middleware/request-logger.ts:26, 51, 55`              | `readonly string[]`, `new Set(...)`, `exclude.has(path)` — O(1), exact-match only, default `[]`.                                                                                                                      |
| Metrics exclusion       | `packages/metrics-plugin/src/collectors/http-collector.ts:40, 48, 83`             | `readonly string[]` → `ReadonlySet<string>`; `DEFAULT_EXCLUDED_PATHS = ['/health','/live','/ready']`; `/metrics` always excluded and `excludePaths` REPLACES the defaults rather than extending them.                 |
| GraphQL cost options    | `packages/graphql-plugin/src/interfaces/options.ts:357`                           | `maxDepth?: number` is the only query-cost control. `grep -rniE "complexity\|maxAliases\|nodeCount\|maxNodes"` over `packages/graphql-plugin/src` returns **nothing**.                                                |
| §2.1 permits the helper | `AI_GUIDELINES.md` §2.1                                                           | `common` may contain "pure zero-dependency type utilities" — a pure path matcher qualifies. Precedents: M55 promoted the content-type map and containment guard; M47 the frame codec.                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                                                                                      |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | ROADMAP M90a names three packages (`auth-plugin`, `http-security-plugin`, `graphql-plugin`); §1 shows the body read lives in `runtime` and the exclusion unification touches `common`, `logger-plugin` and `metrics-plugin`.                                                                                                                                     | **Correct the package list to seven.** The M70b / M70g / M70h / M70k precedent: the ROADMAP list is corrected in the plan when source-checking contradicts it.                                   | ROADMAP M90a "Package(s)" line updated in this PR.                                                                                                                                                                             |
| C2 | `rateLimitMiddleware`'s own `@example` is a bare global `app.middleware.add(rateLimitMiddleware({ windowMs: 60000, max: 100 }))` — precisely the configuration with the X32-1 hazard, presented as the recommended usage.                                                                                                                                        | Change the `@example` to show `exclude` in use, and add the probe interaction to the `auth-plugin` README and `docs/deployment.md`.                                                              | JSDoc `@example`, `auth-plugin/README.md`, `docs/deployment.md`.                                                                                                                                                               |
| C3 | `defaultRateLimitKey`'s remedy list names `trustProxy` as remedy #1 without stating it requires an **overwriting** proxy; X32-3 shows an appending proxy (the standard `$proxy_add_x_forwarded_for` idiom) makes the key attacker-controlled.                                                                                                                    | State the condition at the remedy, and ship the `trustedProxies`/`proxyHops` fix (§3.3) so a correct answer exists.                                                                              | `defaultRateLimitKey` JSDoc, `http-security-plugin/README.md`, `PUBLIC_API.md` IP-security section.                                                                                                                            |
| C4 | `requestSizeMiddleware`'s module doc says the check happens "before any body reading" — a real design property — while no user-facing doc says a chunked body is therefore unbounded.                                                                                                                                                                            | Keep the early check AND add the read bound (§3.4); document both layers and which one is load-bearing.                                                                                          | `http-security-plugin/README.md`, `PUBLIC_API.md`, option JSDoc.                                                                                                                                                               |
| C5 | `graphql-plugin` advertises depth limiting as its query-cost control; X32-6 shows depth bounds nesting only and the body-size limit is what actually carries the defence.                                                                                                                                                                                        | Add a node/complexity budget (§3.6) and document that `maxDepth` bounds nesting alone.                                                                                                           | `graphql-plugin/README.md`, `PUBLIC_API.md` GraphQL section.                                                                                                                                                                   |
| C6 | The body limit is now configured in **two places** — `HttpSecurityPlugin({ requestSize: { maxBodySize } })` for the declaration check and `RuntimePlugin({ maxBodyBytes })` for the read bound — because the mapping runs before any plugin and no channel exists between them (§1, `mapWebRequestToFrameworkRequest(request: Request)` takes only the request). | Ship both and **say so**, rather than inventing a cross-plugin channel for one option. A single knob would need the adapter to read the service registry at map time, which it has no access to. | `http-security-plugin/README.md` and `PUBLIC_API.md` state that `maxBodySize` bounds only declared lengths and that `RuntimePlugin({ maxBodyBytes })` is the unbypassable bound; `runtime/README.md` documents the new option. |

## 3. Design decisions

### 3.1 One path-exclusion matcher in `common`, pre-partitioned

- **Decision:** Add
  `createPathMatcher(patterns: readonly (string | RegExp)[]): (path: string) => boolean` to
  `packages/common/src/path-matcher.ts`, exported from the barrel. It partitions ONCE at
  construction into a `Set<string>` of literals and an array of RegExps, then matches
  `literals.has(path) || regexes.some(r => { r.lastIndex = 0; return r.test(path); })`. All four
  call sites adopt it: `rateLimitMiddleware` (new), `tenantMiddleware`, `requestLogger`,
  `HttpCollector`. `RateLimitOptions.exclude` and `MetricsPluginOptions.excludePaths` /
  `RequestLoggerOptions.excludePaths` widen to `readonly (string | RegExp)[]`.
- **Why:** X32-1's fix would otherwise be the framework's **fifth** copy (§11.1). Pre-partitioning
  means logger and metrics keep O(1) literal matching — measured as `Set.has` today, on the hot path
  — so the unification costs no per-request time, and multi-tenancy gets _faster_ than its current
  O(n) `typeof` loop. The `lastIndex` reset is a real statefulness trap currently handled correctly
  in exactly one of three copies; one home means one place to get it right. Verified by probe that
  widening an option from `readonly string[]` to `readonly (string | RegExp)[]` keeps every caller
  source-compatible and breaks only a consumer **extracting** the type into a narrower one.
- **Test home:** `packages/common/test/unit/path-matcher.test.ts` (matcher semantics, `g`-flag
  statefulness, empty list); each adopting package keeps its existing exclusion tests, which must
  pass unchanged.

### 3.2 Default exclusions, and what `[]` means

- **Decision:** `RateLimitOptions.exclude` defaults to the same six operational paths multi-tenancy
  uses (`/live`, `/ready`, `/health`, `/metrics`, `/openapi.json`, `/docs`). `[]` restores the
  previous behaviour (nothing exempt). The default lists of the other three are **unchanged** —
  unification covers the matcher, never the policy.
- **Why:** X32-1's consequence is that an exhausted global bucket fails the liveness probe and the
  kubelet restarts the container; the CLI generates probes pointing at exactly these paths. Matching
  M70b's list means one number to remember rather than two. Leaving the other defaults alone keeps
  this from being a behaviour change to three released middleware.
- **Test home:** `rate-limit-exclude.test.ts` — an exhausted limiter must still serve `/live`,
  `/ready`, `/health`; and with `exclude: []` must refuse them.

### 3.3 `X-Forwarded-For` resolves rightmost-untrusted, opt-in

- **Decision:** Add `trustedProxies?: readonly string[]` (CIDR or literal address) and
  `proxyHops?: number` to `IpSecurityOptions`. Resolution walks the header **right to left** and
  returns the first entry that is not a trusted proxy; with `proxyHops: n` it returns the nth entry
  from the right. With neither supplied the parse stays **leftmost**, unchanged.
- **Why:** The standard algorithm, and what Express `trust proxy` and Fastify `trustProxy` offer.
  Keeping leftmost as the default means no released deployment changes behaviour silently — X32-3 is
  Medium precisely because it requires the operator to have opted into `trustProxy`, so a silent
  default flip would be a larger change than the defect. The docs (C3) carry the warning until an
  operator opts in.
- **Test home:** `ip-security-proxy.test.ts` — an appending chain (`"7.7.7.7, 198.51.100.9"`) must
  key on `198.51.100.9` with `trustedProxies` set, and on `7.7.7.7` without it.

### 3.4 Two-layer body bound: declaration check in middleware, read bound in `runtime`

- **Decision:** Keep `requestSizeMiddleware`'s `Content-Length` check exactly as it is (a cheap,
  correct `413` before any read). Add the bound that cannot be bypassed where the read actually
  happens: `FrameworkRequest#readBody` streams `this.#raw.body` with a byte cap instead of calling
  `arrayBuffer()`, rejecting with a named error past the cap. The cap is supplied to the mapping by
  a new optional `maxBodyBytes` on **`RuntimeOptions`** (`RuntimePlugin({ maxBodyBytes })`),
  threaded through the adapters it constructs into `mapWebRequestToFrameworkRequest`; absent →
  unbounded, today's exact behaviour.
- **Why:** §1 establishes the read is in `packages/runtime`, so X32-4's preferred fix is not
  implementable in `http-security-plugin` at all — the middleware has no access to the read, and
  because M87 made the body lazy the read happens _after_ middleware has already returned. The
  `411 Length Required` alternative was **rejected**: it refuses every legitimate streaming upload
  as the price of closing the bypass, which trades one broken case for another. Two layers rather
  than one because the middleware check is O(1) on a header and refuses before a socket is drained,
  while the read bound is the backstop that no header can disable.
- **Test home:** `request-size-chunked.test.ts` (middleware layer, absent header) and
  `packages/runtime/test/unit/read-body-bound.test.ts` (the cap itself, driven with a real
  `ReadableStream` body).

### 3.5 `RedisRateLimitStore` namespaces its keys

- **Decision:** Add `keyPrefix?: string` defaulting to `'setu:ratelimit:'`. Keys become
  `setu:ratelimit:<generated>`.
- **Why:** Two sibling Redis stores in this framework already namespace and both explain why in
  their own source — `cache-plugin`'s takes `prefix` as a **required** parameter, `session-plugin`'s
  `CacheSessionStore` has `keyPrefix` with a default "because a `clear()` from elsewhere logs
  everybody out". The rate limiter's keys are the most generic of the three (the literal string
  `anonymous`) and it has none. The realistic consequence is two applications sharing one managed
  Redis, where service A's traffic exhausts service B's limit — and combined with X32-1, restarts
  service B's pods.
- **Test home:** `redis-rate-limit-prefix.test.ts` — the key written carries the prefix; a supplied
  prefix replaces the default.

### 3.6 A node budget bounds GraphQL breadth

- **Decision:** Add `maxNodes?: number` beside `maxDepth` on `GraphqlPluginOptions`' intersection
  arm (`options.ts:357`), implemented as a validation rule that counts selection-set nodes across
  the whole document (aliases included) and refuses past the budget with the same error shape
  `maxDepth` uses. Default: **absent** (unbounded), so no released application changes behaviour.
- **Why:** X32-6 measured 100,000 aliases at depth 2 producing a 4,988 KB response and **+822 MB
  RSS** from one request, with `maxDepth: 5` configured and unable to see it — a depth limiter
  counts the path, and breadth is a different dimension. A node count is the standard companion and
  bounds cost by _work_ rather than by shape. Default-off because turning it on by default would
  refuse large legitimate documents in existing applications; the docs (C5) say it is load-bearing.
- **Test home:** `graphql-max-nodes.test.ts` — an alias bomb at depth 2 is refused with `maxNodes`
  set and accepted without it; a deep-but-narrow query is unaffected.

### 3.7 The 429 routes through the responder

- **Decision:** Replace the raw `.json({ error, message })` with
  `respondWithError(ctx, { status:
  429, title: 'Too Many Requests', detail: message })`, keeping
  the `Retry-After` and `RateLimit-*` headers written exactly as they are today.
- **Why:** M70f routed every first-party short-circuit through this seam — "upload ×6, tenant,
  session ×2, auth ×9, http-security ×3, the flag guard" — and the limiter sits in the same package
  as the `auth ×9` and was missed, presumably because it is middleware rather than a guard. A client
  parsing Problem Details, which the framework's own generated SDK does, currently gets an
  unreadable body under `application/json` for the one status it most needs to handle.
- **Test home:** `rate-limit-error-format.test.ts` — under `errorHandler({ format: 'rfc9457' })` the
  `429` body and its `content-type` must match the `401` a guard produces in the same application.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                | Kind                          | Consumer / real code path that READS it                                                                    |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `createPathMatcher` (`common`) | function                      | `rateLimitMiddleware`, `tenantMiddleware`, `requestLogger`, `HttpCollector` — four in-repo readers (§3.1). |
| `PathPattern` (`common`)       | type alias `string \| RegExp` | The three widened option members, and `createPathMatcher`'s parameter.                                     |

No new export in `auth-plugin`, `http-security-plugin`, `graphql-plugin`, `logger-plugin`,
`metrics-plugin` or `runtime` — every change there is to an existing option type or an internal
path. A `barrel-exports.test.ts` in `common` pins the two additions (the M56 defect class, where a
dropped barrel export left 18 tests green).

### 4.1 Options — every option names its consumer

| Option                                             | Consumer                                               | Behavior (per implementation)                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `RateLimitOptions.exclude`                         | `rateLimitMiddleware` via `createPathMatcher`          | Omitted → six operational defaults; `[]` → nothing exempt; a match skips the limiter body entirely and calls `next()`. |
| `IpSecurityOptions.trustedProxies`                 | `ipSecurityMiddleware` XFF resolution                  | Rightmost entry that is not in the list. Absent → leftmost, unchanged.                                                 |
| `IpSecurityOptions.proxyHops`                      | `ipSecurityMiddleware` XFF resolution                  | nth entry from the right. Mutually exclusive with `trustedProxies`; supplying both throws at middleware construction.  |
| `RequestSizeOptions.maxBodySize` (existing)        | `requestSizeMiddleware` **and** the runtime read bound | Now feeds both layers: the `Content-Length` refusal and `maxBodyBytes` on the mapping.                                 |
| `keyPrefix` on `RedisRateLimitStore`'s ctor object | `RedisRateLimitStore` key construction                 | Omitted → `'setu:ratelimit:'`; supplied → replaces it.                                                                 |
| `GraphqlPluginOptions.maxNodes`                    | The new node-count validation rule                     | Omitted → unbounded (today's behaviour); set → refuse past the budget.                                                 |
| `RequestLoggerOptions.excludePaths` (widened)      | `requestLogger` via `createPathMatcher`                | Behaviour unchanged for string input; RegExp now accepted.                                                             |
| `MetricsPluginOptions.excludePaths` (widened)      | `HttpCollector` via `createPathMatcher`                | Behaviour unchanged for string input; RegExp now accepted; still REPLACES the defaults.                                |

## 5. Implementation files

| File                                                                      | Purpose                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/common/src/path-matcher.ts`                                     | `createPathMatcher`, `PathPattern` — the one matcher (§3.1).             |
| `packages/common/src/index.ts`                                            | Barrel: the two new exports.                                             |
| `packages/auth-plugin/src/middleware/rate-limit-middleware.ts`            | `exclude` option + matcher; `respondWithError` for the 429 (§3.2, §3.7). |
| `packages/auth-plugin/src/stores/redis-rate-limit-store.ts`               | `keyPrefix` (§3.5).                                                      |
| `packages/http-security-plugin/src/middleware/ip-security-middleware.ts`  | `trustedProxies` / `proxyHops` (§3.3).                                   |
| `packages/http-security-plugin/src/middleware/request-size-middleware.ts` | Unchanged logic; feeds `maxBodyBytes` to the runtime (§3.4).             |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`                   | Bounded streaming read replacing `arrayBuffer()` (§3.4).                 |
| `packages/graphql-plugin/src/validation/max-nodes.ts`                     | The node-count rule (§3.6).                                              |
| `packages/logger-plugin/src/middleware/request-logger.ts`                 | Adopt the shared matcher (§3.1).                                         |
| `packages/metrics-plugin/src/collectors/http-collector.ts`                | Adopt the shared matcher (§3.1).                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                      | src covered                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/test/unit/path-matcher.test.ts`                        | `path-matcher.ts`            | Literal exact-match; RegExp match; a `g`-flagged RegExp matches on the **second** call (the `lastIndex` trap); empty list matches nothing. Calls `createPathMatcher(readonly (string \| RegExp)[])`.                                                                                       |
| `common/test/unit/barrel-exports.test.ts`                      | `index.ts`                   | Compile-time assertion that both symbols are exported from the barrel, declared against the barrel not the module (M56).                                                                                                                                                                   |
| `auth-plugin/test/unit/rate-limit-exclude.test.ts`             | `rate-limit-middleware.ts`   | Exhausted limiter still serves `/live`/`/ready`/`/health`; `exclude: []` refuses them; a RegExp entry matches.                                                                                                                                                                             |
| `auth-plugin/test/integration/rate-limit-error-format.test.ts` | `rate-limit-middleware.ts`   | Through a **real kernel app** with `errorHandler({ format: 'rfc9457' })`: the `429` body and `content-type` match the `401` a guard produces. Drives `app.fetch`, not `inject()` — `inject()` exposes no response headers (the M70i lesson).                                               |
| `auth-plugin/test/unit/redis-rate-limit-prefix.test.ts`        | `redis-rate-limit-store.ts`  | Default prefix applied; supplied prefix replaces it. Injected fake client records the key.                                                                                                                                                                                                 |
| `http-security-plugin/test/unit/ip-security-proxy.test.ts`     | `ip-security-middleware.ts`  | Appending chain keys rightmost-untrusted with `trustedProxies`; leftmost without; both options together throws at construction.                                                                                                                                                            |
| `http-security-plugin/test/unit/request-size-chunked.test.ts`  | `request-size-middleware.ts` | Absent `Content-Length` still reaches `next()` (the middleware layer is unchanged) — the bound is asserted in the runtime test below.                                                                                                                                                      |
| `runtime/test/unit/read-body-bound.test.ts`                    | `fetch-mapping.ts`           | A `ReadableStream` body over the cap rejects with the named error; under the cap resolves whole; **absent cap reads unbounded** (today's behaviour preserved). Uses a real `Request` with a stream body.                                                                                   |
| `graphql-plugin/test/unit/graphql-max-nodes.test.ts`           | `max-nodes.ts`               | A depth-2 alias bomb is refused with `maxNodes` set; accepted without; a deep-but-narrow query unaffected. Fixtures are **real parsed documents**, never hand-built `{ kind: 'SelectionSet' }` objects — the M51b defect where six tests fed the depth rule fixtures it could never match. |
| `logger-plugin` / `metrics-plugin` existing exclusion tests    | both                         | Must pass **unchanged**, which is the evidence the unification is behaviour-preserving for string input.                                                                                                                                                                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90a-abuse-control, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree
deno task release:verify 0.4.0
```

Plus the functional bar this milestone's own findings demand: a **real kernel application** with the
limiter, `HealthPlugin` and `errorHandler` composed, driven with an exhausted bucket, asserting the
probes still answer `200`. X32-1 exists because no test ever composed those two plugins.

## 8. Risks & mitigations

- **The exclusion widening breaks a consumer extracting the option type** → probed: callers are
  source-compatible, extractors break. Mitigation: CHANGELOG entry with migration text (§9
  prerelease rules require the entry, not a deprecation cycle).
- **The runtime read bound is on the hottest path in the framework** → M87/M88 measured this path
  deliberately. Mitigation: the cap is `undefined` unless configured, and the absent-cap branch
  keeps `arrayBuffer()` verbatim, so an application that configures no limit runs today's code
  exactly.
- **`maxNodes` refusing a legitimate large document** → default absent; documented as opt-in.
- **The Redis key move orphans in-flight counters** → counters are TTL-bounded, so the blast radius
  is one window. Stated in the CHANGELOG.
- **Two knobs for one concern (C6) invites setting only one** → the `http-security-plugin` docs name
  both and say which is load-bearing; a reader who sets only `maxBodySize` gets today's behaviour
  (declared lengths bounded, chunked unbounded) rather than a silent regression.
- **Scope: seven packages** → the six findings genuinely span them (§2 C1). Mitigation: each finding
  is independently revertable, and the shared matcher lands first so the other changes build on it.

## 9. Out of scope

- **X32-7** (`BulkheadFullError` → masked `500`) — **M90f**, which sweeps every unbranded
  caller-facing error class across packages rather than fixing this one instance.
- **`ipSecurityMiddleware` allow/deny lists** — the module resolves an IP and always calls `next()`;
  it blocks nothing, and X32 recorded that as an observation rather than a finding. No milestone
  owns it yet.
- **A rate-limit `skip` predicate** (as opposed to path exclusion) — a richer surface than the
  findings justify; `exclude` covers every case X32 measured.
- **Changing the `defaultRateLimitKey` fallback chain** — the `'anonymous'` global-counter behaviour
  is already documented in detail, and X32's own correction records that this was not the defect.
