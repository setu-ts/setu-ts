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

## 8b. Corrections found during implementation

Each item below is a claim in this plan that did not survive the code, recorded here rather than
quietly dropped (CLAUDE.md: a plan at `plans/` root belongs to a milestone under construction and is
corrected normally).

- **§3.4's "named error" is under-specified, and the fix is stronger.** `RequestBodyTooLargeError`
  is branded with a `413` **HTTP status hint** (M89b's `withHttpStatusHint`), so an application
  running `errorHandler` answers `413` in its configured format. Without the brand the refusal
  reaches `errorHandler` as a plain `Error` from deep inside the adapter, is normalised to `500`,
  and is masked — the exact defect class M89b exists to close, and it would have made the
  milestone's own headline fix arrive as an opaque server error. Its `title` is
  `'Payload Too Large'` rather than RFC 9110's newer `'Content Too Large'`, because that is what
  `@setu-ts/exceptions` maps `413` to and what `requestSizeMiddleware` already reports for the same
  condition; a Problem Details formatter derives `title` from the status anyway, so a different
  string would only make the two `413` sites disagree under `'default'`.
- **§4's "no new export in `auth-plugin`, `graphql-plugin` or `runtime`" is not kept,
  deliberately.** Five symbols are added, each with a real reader:
  `DEFAULT_RATE_LIMIT_EXCLUDED_PATHS` (without it "the defaults plus mine" means retyping six
  strings, which is the drift §3.1 exists to remove — `metrics-plugin`'s own
  `DEFAULT_EXCLUDED_PATHS` is the precedent), `DEFAULT_RATE_LIMIT_KEY_PREFIX`,
  `RequestBodyTooLargeError` (a caller wanting `instanceof`), and `HttpAdapterOptions`
  (**mandatory** — it appears in the exported `HttpAdapterFactories` signature, and
  `deno doc --lint` rejects a private type in a public one, the M82 lesson). All four are documented
  in `PUBLIC_API.md` and the package READMEs in the same change.
- **`createMaxNodesRule` and `countResolvedFields` were exported and then CUT, and the ratchet is
  what settled it.** Exporting them beside the already-exported `createDepthLimitRule` looked
  symmetric, and it added **5** `private-type-ref` diagnostics — the rule's signature names three
  package-private types — pushing M38's JSDoc ratchet from `497` to `502`. That is the M82 situation
  exactly: neither symbol has a consumer outside its own test (the rule is configured through
  `maxNodes`; the counter's "budget from real traffic" use was speculative, which is the
  dead-surface rule), so both are internal now. With the two cut and two pre-existing
  missing-description diagnostics paid down on files this milestone touches, the total is back to
  `497` and `DOC_LINT_BASELINE` needs no change.
- **§3.6's file is `src/security/max-nodes.ts`, not `src/validation/max-nodes.ts`.** No
  `validation/` directory exists in `graphql-plugin`; the depth rule this one pairs with lives in
  `src/security/`, and splitting two rules of one kind across two directories would be the drift the
  plan objects to elsewhere.
- **§3.6's rule is a `Document` visitor, not a per-`Field` one.** A field count needs fragment
  expansion, which a per-field visitor cannot do without re-walking the document for every field it
  sees. The count is taken once at the document root, which also means exactly one error per
  document.
- **A fragment spread costs its definition at EVERY spread site.** §3.6 said "counts selection-set
  nodes across the whole document (aliases included)", which read literally counts a fragment's
  fields once per DEFINITION and leaves the obvious evasion open: a hundred fields defined once and
  spread a thousand times is eleven hundred nodes driving a hundred thousand resolutions. Expansion
  is memoized so the count stays computable in linear time, and a fragment re-entered while being
  expanded counts zero (graphql's own `NoFragmentCycles` reports the real error).
- **§3.3's `trustedProxies` semantics needed stating, and writing the test is what exposed it.** The
  option lists the addresses that appear IN the header because a proxy further out contributed them.
  Under one appending nginx the header contains no proxy address at all — nginx appends its PEER,
  the real client — so nothing in that chain is trusted and the rightmost entry is the answer. The
  first draft of `ip-security-proxy.test.ts` declared the client's own address as a trusted proxy
  and then expected it to be returned; the two expectations are contradictory, and the code was
  right.
- **§3.7 changes the `429` body shape, which §3.7 did not say.** Routing through `respondWithError`
  means the body is whatever the configured formatter writes: `{ error, detail }` with no handler,
  Problem Details under `'rfc9457'`, and `{ statusCode, message, details }` under `'default'` —
  never the `{ error, message }` it wrote before. That is a breaking change and is in the CHANGELOG;
  two existing unit assertions were updated with the reason recorded at the call site.
- **§6's `request-size-chunked.test.ts` is a `describe` block inside
  `request-size-middleware.test.ts`.** The middleware layer is unchanged, and an
  absent-`Content-Length` pass-through was already covered there, so a separate file would have been
  a near-duplicate. The new block asserts the CHUNKED case by name and points at the runtime test
  that carries the bound.
- **§6's rate-limit fixture is extracted rather than duplicated.** `rate-limit-exclude.test.ts`
  needs the same recording `IRequestContext` the existing unit file builds, so it moved to
  `test/fixtures/rate-limit-context.ts` (widened with a `path` option) and both files read it.
- **One test the plan did not name was added, and it is the one that proves the option is wired.**
  `packages/runtime/test/integration/max-body-bytes.test.ts` boots a real kernel application and
  posts a real chunked body through `app.fetch`, so the whole thread — plugin option → adapter
  factory → adapter → handle → mapping — is exercised. The unit tests drive the mapping directly and
  would pass with `RuntimePlugin` dropping the option on the floor.
- **A measured web-streams fact, recorded because a test asserted the opposite first.** `cancel()`
  on an already-closed `ReadableStream` is a no-op and does NOT invoke the underlying source's
  `cancel`: a stream read to `done` has released its source itself. So `readBounded`'s `finally`
  cancel is load-bearing only on the early-exit path — which is precisely the path where an
  abandoned stream would keep a connection draining.

## 8c. Findings from the milestone verification pass

Run after the implementation commit, against the committed tree, through real kernel applications
(`.verify-90a/driver*.ts`, deleted afterwards). Two were code defects and are fixed on this branch;
the rest are recorded.

- **`maxBodyBytes: NaN` silently DISABLED the bound — fail-open in a size limit.** `total + n > NaN`
  is `false` for every chunk, so the cap never fired and a 4 KiB body sailed through a configured
  64-byte limit. `Number(env.MAX_BODY_BYTES)` yields exactly `NaN` for an unset or misspelled
  variable, which is the likeliest way this option's value is supplied in a deployment — so the
  input is plausible, not hypothetical. `RuntimePlugin(...)` now refuses any `maxBodyBytes` that is
  not a non-negative integer, at FACTORY time, before an application exists (the M52c/M52d/M59
  binding-guard family). `Infinity` is refused too: omitting the option already means unbounded, so
  there is one way to say it. Reverting the guard fails 4 steps.
- **`proxyHops` accepted a negative, a fraction and `NaN`, each resolving `undefined` for every
  caller.** Fail-SAFE rather than fail-open — the limiter degrades to one shared `'anonymous'`
  bucket, which is more restrictive — but silent, while the mutual-exclusion refusal eight lines
  above it throws at construction for a less consequential mistake. Same guard, same reasoning, same
  file.
- **`maxBodyBytes: 0` refuses every request carrying a body, which is the OPPOSITE of this
  framework's own `0` convention** (`maxDepth`, `maxNodes`, `maxBatchSize`, `documentCacheSize` all
  disable at `0` — and `maxNodes` is an option this very milestone added). It was documented
  nowhere. Kept as-is rather than remapped, because `undefined` already means unbounded and
  remapping `0` would give two spellings of one thing while removing an expressible configuration —
  but now stated in the JSDoc, `PUBLIC_API.md` and the runtime README, and pinned by a test.
- **No committed test drove a high-bit IPv4 CIDR**, the one input class where
  `compileTrustedProxy`'s arithmetic could break: a network at or above `128.0.0.0` exceeds int31,
  so `&` operates on a negative int32 and correctness depends on the `>>> 0` on both sides. Every
  committed CIDR case used `10.x`, which never reaches that path. Probed correct, then pinned with
  three cases (`200.0.0.0/8`, `255.255.255.255/32`, `128.0.0.0/1`); reverting one `>>> 0` fails
  them.
- **Two stale rows in this plan's own tables, both contradicting its C6.** §4.1 says
  `RequestSizeOptions.maxBodySize` "now feeds both layers: the `Content-Length` refusal and
  `maxBodyBytes` on the mapping", and §5 says `request-size-middleware.ts` "feeds `maxBodyBytes` to
  the runtime". Neither is true and neither could be: C6 records that no channel exists between the
  plugin and the mapping, which is why there are two independent options. The implementation follows
  C6; `request-size-middleware.ts` is unchanged by this milestone, and its absence from the diff is
  correct rather than a missing deliverable. Verified by probe: with `maxBodySize: 64` and no
  `maxBodyBytes`, a 4 KiB chunked body is served (200) while a 4 KiB DECLARED length is refused
  (413).
- **§6's planned `graphql-max-nodes.test.ts` shipped as `max-nodes.test.ts`**, matching the src file
  it covers. §8b recorded the sibling `request-size-chunked.test.ts` rename and missed this one.
- **§6's "logger / metrics existing exclusion tests must pass unchanged" held for logger and needed
  a one-line type edit for metrics**, which is §8's own predicted risk materialising exactly as
  written: `http-collector-exclusions.test.ts` extracts the option type into a local helper
  (`readonly string[]`), so widening the option broke the EXTRACTOR and not the callers. No
  assertion moved; the logger tests are byte-identical.
- **A verification-harness fact worth keeping.** An in-process `new Request(url, { body: '...' })`
  carries **no** `Content-Length` header — Deno computes it at wire time — so
  `requestSizeMiddleware`, which reads that header, is UNREACHABLE through `app.fetch` unless the
  probe sets it explicitly. A first probe read the resulting `200` as a missing refusal; measuring
  the header list is what distinguished the artifact from a defect.
- **Checked and clear, recorded so a reviewer need not re-derive it.** `readBounded`'s single-chunk
  fast path returns the stream's own `Uint8Array` rather than a fresh copy, so a capped read can
  hand back a view with a non-zero `byteOffset` where the uncapped `arrayBuffer()` path never does.
  No in-repo consumer touches `.buffer` or `byteOffset` (`grep` over the four `.bytes()` readers),
  and the multipart parser uses `Uint8Array.slice`, which is offset-relative. No divergence reaches
  a caller.

## 8d. Findings from the code-review pass

Run after verification, at high effort, over `main..HEAD`. Two correctness findings and two missed
doc deliverables; all four fixed on this branch.

- **A body-carrying upgrade refused by the new cap LEAKED a WebSocket connection slot.** The
  kernel's RFC 6455 body guard reads `ctx.request.bytes()` _after_ `IWebSocketService.routeUpgrade`
  has accepted — and the router claims a pending slot at accept time (M46). While that read could
  only RETURN, the guard settled the slot with `sink.onClose({ code: 1006 })` before answering
  `400`, and `websocket-service.ts:595` states in as many words that "a refused or malformed upgrade
  can never leak a slot and starve `maxConnections`". `maxBodyBytes` makes the read able to REJECT,
  so the rejection escaped to the fallback `500` with `onClose` never called. Upgrade detection is
  **header-only** — no method check — so a POST carrying `Upgrade: websocket` and an oversized body
  is detected as an upgrade, which makes this reachable by an unauthenticated client with no socket
  and no handshake. Measured with `maxConnections: 2`: two such requests, then a conformant upgrade
  answered **`503`** for the life of the process, where the same sequence without a cap answered
  `400`. The read is now wrapped in a `try` whose `catch` settles the slot and rethrows — rethrown
  rather than answered, so the refusal's own `413` hint still reaches `errorHandler`. This adds
  **`packages/kernel`** to the milestone's package set (the M70b/M70g/M70h/M70k list-correction
  precedent): the defect is one this milestone introduces, and CLAUDE.md puts such a fix on the
  milestone's own branch. Regression test in `websocket-plugin/test/integration/`, with a no-cap
  control; reverting the fix fails exactly the capacity assertion while both siblings still pass.
- **`maxNodes: NaN` silently disabled the GraphQL breadth limit** — the same fail-open mechanism as
  the `maxBodyBytes: NaN` case §8c records, in the other numeric option this milestone introduces.
  `maxNodes <= 0` is `false` for `NaN`, so the rule IS built; then `count > NaN` is `false` for
  every document, so it never reports while reading as configured. Guarded in `GraphqlService`'s
  constructor rather than the plugin factory, because the service is barrel-exported and both
  documented entry points must agree — the plugin constructs it during `register()`, so a bad value
  is a startup failure either way. `0` still disables deliberately and is accepted. `maxDepth` has
  the identical laxity and is **pre-existing**, so it is recorded as a residual risk rather than
  changed.
- **C2's `docs/deployment.md` deliverable never shipped.** The row names three sites; the JSDoc
  `@example` and the `auth-plugin` README moved and `docs/deployment.md` was untouched. It now
  carries a "Nothing in the request pipeline may refuse a probe" section stating the asymmetry (a
  refused liveness probe is a restart, not a dropped request), the two first-party middlewares that
  exempt the six operational paths by default, that a caller list REPLACES those defaults, and that
  moving the probes means updating every exclusion list _and_ the manifest together.
- **C3's `defaultRateLimitKey` JSDoc deliverable never shipped.** The row names three sites; the
  `http-security-plugin` README and the `PUBLIC_API.md` IP-security section moved, and the
  function's own JSDoc still listed "Register `ipSecurityMiddleware` (with `trustProxy`)" as remedy
  #1 — the configuration X32-3 shows is attacker-controlled under an appending proxy, with no
  mention of the `trustedProxies`/`proxyHops` this milestone added. Both are exactly the class the
  review procedure warns has shipped before: a doc deliverable named in the plan, passed over with
  every gate green, leaving the package recommending behaviour the same milestone had just shown to
  be unsafe.
- **Recorded, not changed.** `RedisRateLimitStore.increment` issues INCR → PEXPIRE → PTTL against
  one shared key, which is three awaited operations on shared external state; the namespaced key is
  computed ONCE into a local and reused for all three, so no interleave can make them address
  different keys, and the prefix introduces no new ordering. The interleave window between INCR and
  PEXPIRE is pre-existing and unchanged. `createPathMatcher` writes `lastIndex = 0` on the caller's
  own `RegExp` — documented, and a caller sharing one stateful pattern between an exclusion list and
  its own `exec` loop is contrived, but a defensive clone at construction would remove the side
  effect entirely.

## 8e. Findings from the PR review bots (PR #247)

Five inline findings across two bots. Three fixed, two declined with evidence — the convention here
is one reply per thread, verifying before agreeing.

- **FIXED (CodeRabbit, Major) — a `trustedProxies` entry with an empty CIDR width trusted every IPv4
  address.** `Number('')` is `0`, so `'10.0.0.1/'` compiled to a `/0` matcher. Probed: an all-IPv4
  chain then resolved `clientIp: undefined` (the limiter degrades to one shared bucket), and a chain
  whose leftmost entry was IPv6 returned that **caller-supplied** value as the client — X32-3
  reintroduced by a typo in configuration. `Number` also reads `'0x20'` as `32`, silently applying a
  mask the text does not state. The width must now be plain digits, and a non-digit width is refused
  at construction rather than falling through, matching this milestone's other two guards. The range
  is deliberately NOT checked at the refusal: an IPv6 CIDR such as `2001:db8::/64` has a digit width
  above 32 and must keep its documented literal-comparison path (verified — all six legitimate forms
  still construct). **Two details of the report did not survive measurement**: of the four "loose"
  widths it listed, `' 8'`, `'+8'` and `'8e0'` all resolved the client CORRECTLY before the fix,
  because `Number` maps each to `8` and a `/8` mask matches the proxy; only the empty width and the
  hex form were defects.
- **FIXED (Qodo, Bug) — `countResolvedFields` summed EVERY operation instead of the one that
  executes.** Probed with two 3-field operations against `maxNodes: 4`: both `operationName=A` and
  `operationName=B` were refused at a counted 6, though each is individually within budget. The
  sibling `maxDepth` served the identical document, so the two limiters in one package disagreed
  about what a "query" is. Now the **maximum** over operations, which needs no `operationName`
  plumbing (a validation rule receives the document, and the cache is keyed on query text) and
  states the policy the limit actually wants: no operation in the document may exceed the budget.
  The error message says "its largest operation resolves N fields" so a developer debugging a
  bundled document is not misled.
- **FIXED (Qodo, Medium) — the `exhausted` test double sampled `Date.now()` while the middleware
  samples `runtime.now()`.** Benign as written, and the reply says why: the app runs the real
  `RuntimePlugin`, so both are the wall clock, and `Math.ceil` absorbs the sub-millisecond gap. But
  it is the "never mix clocks" pattern the repo names as a recurring pitfall, and it produced a real
  flake in the v0.4.0 cycle (`queue-plugin`: 20 failing offsets in a 6000-offset sweep). The double
  now reads the injected clock, so nobody copies the pattern into a fake-clock test.
- **DECLINED (Qodo, Medium) — `IXxx` interface naming.** Refuted with the same evidence that
  withdrew it in M86: the convention marks PORTS, not data shapes, and `packages/common` exports 114
  non-prefixed interfaces. `HttpAdapterOptions` is an options bag beside `RuntimeOptions` and
  `CloudflareRuntimeOptions`; `ValidationRuleContext`/`MaxNodesVisitor` are module-private
  structural shapes matching `DepthLimitVisitor` beside them; `CapturedResponse` is a test fixture.
  Renaming any of them would make each inconsistent with its own immediate neighbours.
- **DECLINED (Qodo, Medium) — the unused `_context` parameter in the disabled-rule branch.**
  Technically removable, but `createDepthLimitRule` in the same directory has the byte-identical
  `(_context: ValidationRuleContext) => ({})`, so removing it here would make the two sibling rules
  differ for no behavioural gain. Consistency with the neighbour is worth more than one underscore.

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
