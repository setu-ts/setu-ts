# Milestone 134 — AI features with Setu: weighted quotas in `@setu-ts/auth-plugin`, the AI SDK documented and tested

> **Status:** Planning. Branch: `feat/m134-ai-layer`. `main` and `develop` are protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A SaaS application calling a model needs a tool loop, structured output, streaming to its UI,
provider fallback, traces, a test double, per-tenant spend limits and usage records it can bill
from. The Vercel AI SDK and its ecosystem already provide all but the last two, so Setu does not
re-implement them (maintainer rule, 2026-11-03: when a standard library exists, document and test it
instead of building it). M134 builds only the gap, a **weighted quota with reserve and settle**, as
an extension of auth-plugin's rate limiting, plus one telemetry-plugin option (§3.7) without which
the AI SDK's spans cannot reach Setu's exporter. The rest of the AI layer ships as a website guide
and a runnable example whose smoke test proves each recipe works against Setu.

**Compared with** (the decisions below cite these; survey files `ai-survey/01-providers.md`,
`05-ops-security.md` and the 2026-11-03 research):

| Need                                   | What exists                                                                                                                                                                     | M134 decision                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Providers                              | AI SDK `LanguageModelV4` (`@ai-sdk/provider` 4.x)                                                                                                                               | use; documented                                                                                    |
| Tool loop, step cap, abort             | AI SDK `generateText`/`streamText` (`stopWhen`, `isStepCount`, `prepareStep`, `abortSignal`)                                                                                    | document + test                                                                                    |
| Structured output                      | AI SDK `output` option, `NoObjectGeneratedError`                                                                                                                                | document + test                                                                                    |
| UI message stream                      | AI SDK `toUIMessageStreamResponse()` returns a web `Response`                                                                                                                   | document + test that a Setu route returns it and the AI SDK's own parser reads it                  |
| Fallback                               | `ai-fallback` 3.x (Mastra, LangChain, Genkit, Laravel each ship one; the AI SDK has none, #2636)                                                                                | document + test                                                                                    |
| GenAI telemetry                        | `@ai-sdk/otel` emits `gen_ai.*` (semconv v1.41.1 shape)                                                                                                                         | document + test, content capture off; telemetry-plugin `registerGlobal` so its spans export (§3.7) |
| Test double                            | `ai/test` `MockLanguageModelV4`, `simulateReadableStream`                                                                                                                       | document + test; nothing added to `@setu-ts/testing`                                               |
| Identity-aware tools                   | AI SDK v7 `toolsContext` (Spring AI `ToolContext`, Genkit `context.auth`, Mastra `requestContext`: identity in a side channel the model cannot set; OWASP LLM06 mitigation 5/7) | document + test; no route-calling tools (mcp-plugin, M133, covers pipeline re-entry)               |
| Per-tenant spend cap under concurrency | nothing in any AI library; gateways are eventually consistent (Cloudflare AI Gateway docs). `rate-limiter-flexible` has weighted `consume`/`reward`                             | **build**: weighted quota in auth-plugin (maintainer choice over the library)                      |
| Usage record per call                  | AI SDK `onEnd` usage; vendors dedup on a producer id (Stripe `identifier`, Metronome/Lago `transaction_id`, Orb `idempotency_key`); no framework uses an outbox                 | document + test a middleware recipe with a per-call id, delivered through the existing outbox      |

- **In scope:** auth-plugin `createQuota`, `MemoryQuotaStore`, `RedisQuotaStore`,
  `QuotaExceededError`, `respondQuotaExceeded`; the rate limiter's 429 routed through the same
  helper; the guide `docs/ai.md` (website); `apps/ai-chat` with its smoke test; the ROADMAP M134
  section rewritten to this scope; agent card and README for auth-plugin; CHANGELOG.
- **NOT this milestone:**
  - A `@setu-ts/ai-plugin` package, Setu GenAI spans, a Setu fake model, route-calling tools — each
    replaced by the library row above (maintainer decisions, 2026-11-03).
  - Redaction of captured prompt content: capture stays off and the guide says the AI SDK records
    content unredacted when turned on. A redacting span processor is a follow-on if asked.
  - `setu add ai`: `setu add` installs Setu packages; the guide lists the `npm install` line.
  - Vector retrieval (M135), durable runs (M136).

## 1. Contracts verified from SOURCE (not names)

All line numbers on `develop` at `14c4255d2`; AI SDK facts from an install of `ai` 7.0.162,
`@ai-sdk/provider` 4.0.35 in the session scratchpad.

| Reference                  | Source (file:line)                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RateLimitStore`           | `packages/auth-plugin/src/stores/rate-limit-store.ts:23-31`                                         | `increment(key, windowMs): Promise<RateLimitResult>`, `reset(key)`; counts requests one at a time.                                                                                                                                                                           |
| Redis limiter client       | `packages/auth-plugin/src/stores/redis-rate-limit-store.ts:46-69`                                   | `IRateLimitRedisClient { incr, pexpire, pttl, del, quit }` and `validateClient`; INCR then PEXPIRE, no `eval`. A weighted check-and-add needs Lua.                                                                                                                           |
| Lua precedent              | `packages/idempotency-plugin/src/interfaces/index.ts:19`, `stores/redis-store.ts:115-147`           | `IRedisIdempotencyClient { eval(script, numkeys, ...args), ping, quit, call }`; the store runs atomic Lua.                                                                                                                                                                   |
| `fromNodeRedis`            | `packages/common/src/redis/node-redis-adapter.ts:92, 389`                                           | node-redis clients get an ioredis-style `eval`.                                                                                                                                                                                                                              |
| 429 shape                  | `packages/auth-plugin/src/middleware/rate-limit-middleware.ts:107, 240-255`                         | `Retry-After` written first, then `respondWithError(ctx, { status: 429, title: 'Too Many Requests', detail, problem: { type: QUOTA_EXCEEDED_TYPE, title: 'Quota Exceeded', extensions: { 'violated-policies': [policyName] } } })`. `QUOTA_EXCEEDED_TYPE` is module-private. |
| Error contract             | `packages/common/src/errors/error-responder.ts:149-170, 245`                                        | `ErrorResponseInit { status, title, detail?, details?, problem? }`: **no headers field**.                                                                                                                                                                                    |
| Status hint                | `packages/common/src/errors/status-hint.ts:30, 141`                                                 | `withHttpStatusHint(error, hint)` brands an error so `errorHandler` answers with the hint's `ErrorResponseInit`.                                                                                                                                                             |
| Clock                      | `IRuntimeServices.now()` (common)                                                                   | Wall clock for window ids; never `Date.now()`.                                                                                                                                                                                                                               |
| Tenant / principal         | `packages/common/src/http.ts:60, 69`                                                                | `ctx.request.tenant?.id`, `ctx.request.user?.id`.                                                                                                                                                                                                                            |
| Outbox write               | `packages/messaging-plugin/src/interfaces/index.ts:1188, 1245`; `common/src/services/outbox.ts:184` | `IOutbox.write(scope, definition, payload, { options: { deduplicationId } })`; `scope` is a unit of work.                                                                                                                                                                    |
| Inbox                      | `packages/messaging-plugin/src/integration/subscribe.ts:149`                                        | `onIntegrationEvent(definition, handler, { inbox: { consumer } })`; dedup on (consumer, topic, envelope id).                                                                                                                                                                 |
| Transaction                | `packages/database-plugin/src/interfaces/index.ts:236`                                              | `transaction<T>(work: (uow) => Promise<T>)`.                                                                                                                                                                                                                                 |
| Streaming a web `Response` | `packages/common/src/http.ts:209, 217, 312`                                                         | `ctx.response.status()`, `.header()`, `.stream(body)`: three calls return an AI SDK `Response`.                                                                                                                                                                              |
| AI SDK middleware          | `ai/dist/index.d.ts:10208`                                                                          | `wrapLanguageModel({ model, middleware })`; `LanguageModelV4Middleware` wraps `doGenerate`/`doStream`.                                                                                                                                                                       |
| AI SDK usage               | `@ai-sdk/provider` `index.d.ts:695`                                                                 | `usage: { inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }`, each `number \| undefined`; no total.                                                                                                                         |
| UI stream                  | `ai/dist/index.js:6125, 6139`; client `parseJsonEventStream` + `uiMessageChunkSchema`               | SSE `data: <json>\n\n`, `data: [DONE]`; header `x-vercel-ai-ui-message-stream: v1`. The parser rejects a malformed chunk (probe in scratchpad `m134-aisdk/scripts/parse.mjs`).                                                                                               |
| Mock model                 | `ai/dist/test/index.d.ts:135`                                                                       | `MockLanguageModelV4({ doGenerate?, doStream? })`, records `doGenerateCalls`/`doStreamCalls`.                                                                                                                                                                                |
| Example apps               | `apps/multi-tenant/{package.json, smoke.ts}`; `scripts/check-apps.ts`                               | Each app: `check` (tsc) and a `node:test` `smoke` run by `check:apps`.                                                                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                             | Resolution (picked side)                      | Doc deliverable (same PR)                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M134 names a new `ai-plugin`, a Setu tool loop, Setu GenAI telemetry, a testing fake and fallback through resilience-plugin. | This plan (maintainer decisions 2026-11-03).  | ROADMAP `## Milestone 134` rewritten to this scope; the Progress Tracking row text updated. |
| C2  | ROADMAP M135 and M136 say they build on "M134's ai-plugin".                                                                          | They build on the AI SDK plus the M134 quota. | One sentence in each section corrected.                                                     |

## 3. Design decisions

### 3.1 The quota API

- **Decision:** auth-plugin exports `createQuota(options: QuotaOptions): IQuota`, with
  `QuotaOptions { name: string; store: IQuotaStore; limit: number | ((key: string) => number | undefined | Promise<number | undefined>); window: number | 'utc-day' | 'utc-month'; runtime: IRuntimeServices }`
  and
  `IQuota { reserve(key: string, amount: number): Promise<QuotaReservation>; settle(reservation, actual: number): Promise<void>; release(reservation): Promise<void> }`.
  - `amount` and `actual` must be finite integers ≥ 0; anything else (NaN, ±Infinity, negative,
    fractional) throws `TypeError` before the store is touched. `limit` likewise; `undefined` from
    the callback means unlimited (the reservation is still recorded so settle has a target).
  - `reserve` admits only when `used + amount ≤ limit` in the key's current window, atomically, and
    returns `{ key, windowId, amount }` (frozen). Otherwise it throws `QuotaExceededError`.
  - `settle` adds `actual − amount` to that reservation's window (a refund when negative, an extra
    charge when positive; the stored value never goes below 0). It is idempotent per reservation: a
    second `settle` or `release` is a no-op (tracked in the quota's `WeakSet`, below; the
    reservation object stays frozen).
  - `release(r)` is `settle(r, 0)`.
  - `settle`/`release` accept only a reservation this quota issued and has not settled (a `WeakSet`
    of issued reservations); a fabricated or foreign object throws `TypeError`, so a caller cannot
    mint a refund.
  - `key` must be a non-empty string of at most 512 UTF-8 bytes, else `TypeError`. A `limit`
    callback that throws or rejects makes `reserve` reject with that error and reserve nothing (fail
    closed).
- **Why:** reserve-then-settle is the only form that holds a hard cap under concurrency (survey §05:
  gateway limits that record after completion overshoot). Integer units keep Lua arithmetic exact;
  callers choose the unit (tokens, micro-dollars).
- **Test home:** `test/unit/quota.test.ts`.

### 3.2 Windows

- **Decision:** `window` accepts two forms: a positive integer of milliseconds, epoch-aligned
  (`windowId = floor(runtime.now() / window)`), or `'utc-day'` / `'utc-month'` computed from
  `runtime.now()` in UTC (`YYYY-MM-DD`, `YYYY-MM`). The window id is part of the store key, so a
  settle always lands in the window it reserved, even after the boundary passes. Stored windows
  expire after one window length plus one day (Redis `PEXPIREAT`; memory sweeps on access).
  `QuotaExceededError.retryAfterSeconds` is the whole seconds until the current window ends,
  minimum 1.
- **Why:** billing periods are calendar months; the existing limiter's first-request window cannot
  express them.
- **Test home:** `quota.test.ts` (fake runtime clock across a day and a month boundary, a settle
  after the boundary).

### 3.3 Stores

- **Decision:**
  `IQuotaStore { reserve(key, windowId, amount, limit | undefined, expireAt): Promise<{ admitted: boolean; used: number }>; adjust(key, windowId, delta, expireAt): Promise<void>; close?(): Promise<void> }`.
  - `MemoryQuotaStore(runtime)`: a `Map`, single-process, synchronous critical section.
  - `RedisQuotaStore({ client, namespace })`: `client` structurally
    `IQuotaRedisClient { eval(script, numkeys, ...args): Promise<unknown>; quit(): Promise<unknown> }`,
    validated at construction (missing `eval` → `TypeError` naming it, the `validateClient`
    pattern). One Lua script each for reserve (GET, compare, INCRBY, PEXPIREAT) and adjust (INCRBY
    floored at 0, PEXPIREAT). Keys `${namespace}:${name}:${key}:${windowId}`. A Redis failure throws
    `QuotaStoreUnavailableError` (named like `RateLimitStoreUnavailableError`) — fail closed: the
    call is not admitted.
- **Why:** atomic check-and-add needs one round trip; the idempotency store is the precedent.
- **Test home:** `test/unit/memory-quota-store.test.ts`, `test/unit/redis-quota-store.test.ts` (fake
  `eval` recording calls) and a guarded real-Redis test (`REDIS_URL`).

### 3.4 The refusal

- **Decision:** `QuotaExceededError` (exported) carries `name`, `retryAfterSeconds`, and a status
  hint
  `{ status: 429, title: 'Too Many Requests', detail: 'The quota for this request is spent.', problem: { type: QUOTA_EXCEEDED_TYPE, title: 'Quota Exceeded', extensions: { 'violated-policies': [name], 'retry-after': retryAfterSeconds } } }`.
  An uncaught one is therefore answered as RFC 9457 by `errorHandler` without a header (the hint
  contract has none, §1). `respondQuotaExceeded(ctx, error)` (exported) writes `Retry-After` and
  then calls `respondWithError` with the same init. The rate limiter's 429 branch is refactored to
  build its init through the same internal function
  `quotaProblemInit(policyName, detail, retryAfterSeconds?)`, so both refusals share one type,
  title, status and extension layout; the limiter keeps its own `detail` and omits the `retry-after`
  extension it never carried.
- **Why:** one implementation of the 429 body; the header needs a context the deep throw site lacks.
- **Test home:** `test/unit/quota-refusal.test.ts` (field-by-field body, forbidden fields absent,
  both entry points under a non-default error format; the rate limiter's 429 body and headers
  byte-identical to the pre-change output, captured from `develop` as a fixture).

### 3.5 The guide `docs/ai.md`

- **Decision:** one page on the website, each section a compiled code fence: install (`ai`,
  `@ai-sdk/openai-compatible`, `ai-fallback`, `@ai-sdk/otel`, exact majors); a route that streams
  `toUIMessageStreamResponse()` through `status`/`header`/`stream`; the tool loop with
  `stopWhen: isStepCount(n)` and `abortSignal` from the request; structured `output` and
  `NoObjectGeneratedError`; tools with `toolsContext` carrying `ctx.request.tenant?.id` and
  `ctx.request.user?.id` (the quota key and tool identity come from server-set request identity,
  never from model input or the request body), authorization in the service; `ai-fallback`;
  `@ai-sdk/otel` registration with Setu's telemetry, content capture off, and the warning that
  capture records content unredacted; testing with `MockLanguageModelV4`; **the budget recipe**: a
  `LanguageModelV4Middleware` that reserves
  `inputBound × inputPrice + maxOutputTokens × outputPrice` per model call, where `inputBound` = the
  UTF-8 byte length of the serialized text parts and tool definitions (a byte-level tokenizer emits
  at most one token per byte) plus a per-message allowance for chat-template tokens plus a
  configured per-file allowance for each image or file part (a URL's bytes bound nothing; the guide
  says the cap is hard for text and only as tight as the allowance for media); `maxOutputTokens` is
  required. It settles from `usage` priced the same way; when any count is `undefined`, or the
  client aborted the stream, it settles the full reservation. It releases when `doGenerate` rejects
  or `doStream` fails before its first part. Each model is wrapped with its own prices and
  `ai-fallback` runs over the wrapped models, so a failed first model releases its reservation
  before the second reserves its own. Abort comes from `ctx.signal` (`IRequestContext.signal`,
  always live); **the usage recipe**: a record
  `{ id, occurredAt, tenantId, principalId?, provider, model, usageKnown, inputTokens?, cacheReadTokens?, cacheWriteTokens?, outputTokens?, reasoningTokens?, settledAmount }`
  with `id = runtime.uuid()` taken before the call, written with
  `db.transaction((uow) => outbox.write(uow, usageRecorded, record, { options: { deduplicationId: record.id } }))`,
  and a billing consumer behind the inbox.
- **Why:** every capability but the quota is a library's; the guide is where Setu's integration is
  stated, and colleagues read the website, not GitHub.
- **Test home:** the guide's fences compile in `test/guide-fence-compiler.test.ts`; behaviour is
  proven by `apps/ai-chat` (§3.6).

### 3.6 `apps/ai-chat`

- **Decision:** a runnable example (`check`, `smoke`, `start`) with the guide's recipes as source
  files and a `node:test` smoke that proves the ROADMAP gate with `MockLanguageModelV4`:
  1. the tool loop stops at the step cap, and an abort mid-stream ends the response;
  2. the route's stream, read by `parseJsonEventStream({ schema: uiMessageChunkSchema })` and
     `readUIMessageStream`, yields the scripted text;
  3. two concurrent calls over one tenant's last budget: exactly one is admitted (memory store; the
     Redis case is the auth-plugin guarded test);
  4. the usage record is read back once despite a redelivered outbox message (memory database,
     in-memory broker, inbox consumer);
  5. with `@ai-sdk/otel` registered, `registerGlobal: true` and capture off, the spans received by
     an in-process OTLP/HTTP receiver the smoke starts (`exporter: 'otlp'`; the plugin has no
     in-memory exporter kind) carry no prompt text and share the request span's trace id as their
     parent;
  6. a tool reads the tenant from `toolsContext`, never from model input;
  7. `ai-fallback` moves to the second model after a 503 from the first;
  8. a guarded test against a real OpenAI-compatible endpoint (`AI_COMPAT_BASE_URL`, skipped when
     unset).
- **Why:** an example that runs is the test that the documented integration still works when the AI
  SDK moves (the guide pins majors; `check:apps` catches drift).
- **Test home:** `apps/ai-chat/smoke.ts`.

### 3.7 Telemetry interop: `registerGlobal`

- **Decision:** `TelemetryPlugin` gains `registerGlobal?: boolean` (default `false`). When `true`,
  at `register()` the plugin calls the OTel API's `trace.setGlobalTracerProvider(provider)` with the
  provider it already builds (`telemetry-plugin/src/tracing/tracer.ts:280`), so any library that
  traces through `@opentelemetry/api` (here `@ai-sdk/otel`) exports through Setu's processors,
  sampler and diagnostics. A refused second registration is reported once at `warn` and the plugin
  keeps working with its private provider. Shutdown does not unregister (the OTel API offers only
  `trace.disable()`); the guide says one process, one global provider.
- **Why:** verified at plan time: the provider is private and never registered globally, and
  `ITelemetryService` exposes only `withSpan`, so without this the AI SDK's spans go to the no-op
  global provider. Registering the SDK's provider globally is what `NodeSDK` does; this is the one
  place Setu blocks the documented recipe.
- **Test home:** `packages/telemetry-plugin/test/unit/register-global.test.ts` (off: global
  untouched; on: a span started through `@opentelemetry/api`'s global tracer reaches the in-memory
  exporter and parents under an active `withSpan` span; a second registration warns once);
  `apps/ai-chat` item 5.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none; additive exports in auth-plugin and one optional
telemetry-plugin option; ships in minor `0.13.0`.

| Exported symbol                                            | Kind               | Consumer / real code path that READS it                            |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| `createQuota`                                              | function           | `apps/ai-chat` budget middleware; guide recipe                     |
| `IQuota`, `QuotaOptions`, `QuotaReservation`               | types              | `createQuota`'s signature; the example's middleware                |
| `IQuotaStore`                                              | type               | both stores implement it; `QuotaOptions.store`                     |
| `MemoryQuotaStore`, `RedisQuotaStore`, `IQuotaRedisClient` | class, class, type | `apps/ai-chat` (memory); guide (Redis)                             |
| `QuotaExceededError`, `QuotaStoreUnavailableError`         | classes            | thrown by `reserve`; caught in the example's route                 |
| `respondQuotaExceeded`                                     | function           | the example's route; the rate limiter's 429 (shared internal init) |

### 4.1 Options — every option names its consumer

| Option                           | Consumer                               | Behavior (per implementation)                     |
| -------------------------------- | -------------------------------------- | ------------------------------------------------- |
| `name`                           | store key, `violated-policies`         | non-empty, `[a-z0-9-]+`, else `TypeError`         |
| `store`                          | `reserve`/`adjust`                     | both stores                                       |
| `limit`                          | `reserve`                              | number or per-key callback; `undefined` unlimited |
| `window`                         | window id, expiry, `retryAfterSeconds` | §3.2                                              |
| `runtime`                        | clock                                  | `now()` only                                      |
| `RedisQuotaStore.namespace`      | key prefix                             | required, non-empty                               |
| `TelemetryPlugin.registerGlobal` | `register()`                           | §3.7; read once at registration                   |

## 5. Implementation files

| File                                                                                  | Purpose                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth-plugin/src/index.ts`                                                   | barrel exports (§4)                                                                                                                |
| `packages/auth-plugin/src/quota/quota.ts`                                             | `createQuota`, windows, validation, settle idempotency                                                                             |
| `packages/auth-plugin/src/quota/memory-quota-store.ts`                                | memory store                                                                                                                       |
| `packages/auth-plugin/src/quota/redis-quota-store.ts`                                 | Redis store, Lua scripts, client validation                                                                                        |
| `packages/auth-plugin/src/quota/refusal.ts`                                           | `QuotaExceededError`, `respondQuotaExceeded`, the shared 429 init                                                                  |
| `packages/auth-plugin/src/middleware/rate-limit-middleware.ts`                        | 429 branch built through `refusal.ts`                                                                                              |
| `packages/auth-plugin/src/errors.ts`                                                  | `QuotaStoreUnavailableError`                                                                                                       |
| `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts`, `src/interfaces/index.ts` | the `registerGlobal` option (§3.7)                                                                                                 |
| `apps/ai-chat/*`                                                                      | example: `setu.config.ts`, `src/budget-middleware.ts`, `src/usage.ts`, `src/chat.routes.ts`, `smoke.ts`, README                    |
| root `package.json` devDependencies                                                   | `ai`, `@ai-sdk/openai-compatible`, `ai-fallback`, `@ai-sdk/otel` so the guide's fences compile in the tooling member               |
| `scripts/check-apps.ts` and repo lists                                                | the new app joins `check:apps` (grep how `apps/multi-tenant` is listed)                                                            |
| Docs                                                                                  | `docs/ai.md` (+ website nav), `packages/auth-plugin/README.md`, `AGENT_CARD.md`, `PUBLIC_API.md`, `CHANGELOG.md`, ROADMAP §2 edits |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                      | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth-plugin/test/unit/quota.test.ts`                         | `quota/quota.ts`                 | admit/refuse at the boundary; NaN/±Infinity/negative/fractional refused before the store; settle refund, extra charge, idempotent second settle; a forged or foreign reservation refused; key empty or over 512 bytes refused; a throwing limit callback reserves nothing; release; window ids across UTC day/month and epoch windows; a settle after the boundary hits the reserved window; `retryAfterSeconds` ≥ 1 |
| `packages/auth-plugin/test/unit/memory-quota-store.test.ts`            | `memory-quota-store.ts`          | 50 concurrent `reserve` of 1 over limit 10 → exactly 10 admitted; floor at 0; expiry sweep                                                                                                                                                                                                                                                                                                                           |
| `packages/auth-plugin/test/unit/redis-quota-store.test.ts`             | `redis-quota-store.ts`           | Lua arguments and keys; validation refuses a client without `eval`; Redis error → `QuotaStoreUnavailableError`                                                                                                                                                                                                                                                                                                       |
| `packages/auth-plugin/test/integration/redis-quota-store.real.test.ts` | real Redis (guarded `REDIS_URL`) | two concurrent reservations over the last budget → exactly one admitted; refund visible to the next reserve; key expires                                                                                                                                                                                                                                                                                             |
| `packages/auth-plugin/test/unit/quota-refusal.test.ts`                 | `refusal.ts`, limiter 429        | body field by field (type, title, status, detail, `violated-policies`, `retry-after`; no `message`); `Retry-After` header via the helper; hinted throw through `errorHandler`; limiter and quota bodies share type, title and extension layout under a non-default format (one init function, both entry points driven)                                                                                              |
| existing `rate-limit*.test.ts`                                         | limiter                          | unchanged and passing                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/telemetry-plugin/test/unit/register-global.test.ts`          | the `registerGlobal` branch      | §3.7                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/ai-chat/smoke.ts`                                                | the recipes                      | §3.6 items 1–8                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/guide-fence-compiler.test.ts`                                    | `docs/ai.md` fences              | compile, counts pinned                                                                                                                                                                                                                                                                                                                                                                                               |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m134-ai-layer
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run check:apps
pnpm run ci:local
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Per-file coverage for every changed auth-plugin and telemetry-plugin `src` file ≥ 90%
branch/function/line. **Security audit** by a fresh Claude agent before merge (the quota is an abuse
control; the guide's capture and egress advice is reviewed with it), per
`.roo/skills/security-audit/SKILL.md`, with a §8a design review written first.

## 8. Risks & mitigations

- **The AI SDK churns between majors** (60+ breaking headings in v7) → the guide pins majors and the
  example's smoke fails on drift; no Setu package depends on the AI SDK.
- **`ai` pins exact `@ai-sdk/*` versions** (7.0.162 pins `@ai-sdk/provider` 4.0.35) → the example
  pins one `ai` release and lets it choose its provider packages; the guide names majors only.
- **The byte-length input bound over-reserves** (roughly 3–4× for English) → documented; a caller
  can pass a tighter estimator; the settle refunds the difference.
- **Workers and Deno for the AI SDK are unverified** → the example runs on Node in `check:apps`; the
  guide states the runtimes proven.
- **Content capture is unredacted when enabled** → off by default in the recipe, stated in the guide
  and reviewed in the audit.
- **The usage record is durable only from the outbox write onward.** A process that dies between the
  provider's answer and the local transaction loses that record (and the settled reservation was
  already applied) → stated in the guide; the window is one in-process step.
- **Runtime coverage:** the quota code uses only `IRuntimeServices` and web APIs; its tests run on
  Node, and the ROADMAP rewrite states the example is proven on Node only.

## 8a. Security design review (input to the committed-tree audit)

- **Assets:** a tenant's spend; usage records (billing input); prompt content in traces.
- **Threats and resolutions:**
  - T1 bypass by choosing the key → the key is built from `ctx.request.tenant?.id` set by the
    tenancy plugin, never from body or model output (guide, smoke item 6). Obligation O1: the recipe
    reads no client-supplied value into the key.
  - T2 over-admission under concurrency → atomic Lua / single-threaded memory section (O2: the
    50-way memory test and the real-Redis two-way test).
  - T3 hostile amounts (NaN, ±Infinity, negative, fractional, > 2^53) → `TypeError` before the store
    (O3: unit table).
  - T4 minted refunds via a forged or replayed reservation → issued-reservation `WeakSet`, single
    settle (O4).
  - T5 store failure → fail closed with `QuotaStoreUnavailableError` (O5: fake `eval` rejecting).
  - T6 Lua injection → keys and values only as `KEYS`/`ARGV`, never concatenated into the script
    (O6: the script text is a constant).
  - T7 memory growth from many keys → 512-byte key bound, window expiry, sweep on access (O7).
  - T8 prompt content in spans → capture off in the recipe; `registerGlobal` exports only what the
    AI SDK records (O8: smoke item 5 negative check, then a positive control with capture on).
  - T9 a refusal leaking another tenant's state → the 429 carries only the policy name and seconds
    to reset (O9: field-by-field body test).
- **Accepted:** the byte bound over-reserves; media allowances are configuration, not proof; the
  window between the provider answer and the outbox write.

## 9. Out of scope

- A Setu AI package, Setu GenAI spans, a Setu fake model, route-calling tools (§0 table).
- A redacting span processor for captured content; `setu add ai`.
- Billing-vendor adapters (Stripe, Metronome, Lago, Orb); the usage recipe ends at the inbox
  consumer.
