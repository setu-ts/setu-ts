# Milestone 70f — Error format and error visibility (`kernel`, `exceptions`, `common`, and the short-circuit sites)

> **Status:** Complete (PR pending). Branch: `feat/m70f-error-visibility`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

An application configures ONE error format and gets several. The framework's own responses — the
kernel's 404 and its fallback 500 — never reach the configured formatter, because the kernel writes
them directly rather than raising them; every middleware that short-circuits answers in a shape it
invented locally; and `createUploadMiddleware` goes further than bypassing the format, destroying
the error outright by wrapping `await next()` in a parameterless `catch` that reports every
downstream failure as a malformed multipart body. Alongside that, the errors that ARE handled are
frequently invisible: the kernel's fallback 500 logs nothing even with `LoggerPlugin` registered, a
gRPC handler's throw is logged nowhere and cannot be, and a raw `Error` placed in log metadata
renders as `{}` because `message` and `stack` are non-enumerable. This milestone makes one
application answer in one shape, and makes every error it swallows visible to an operator.

The unifying constraint is that the packages producing these responses may not import
`@setu-ts/exceptions` (AI_GUIDELINES §2.2), which is where every formatter lives — a constraint M70b
already met and recorded in source, deferring the convergence here by name
(`session-middleware.ts:48-52`). The milestone therefore delivers ONE seam in `common` that carries
the application's resolved formatter to every site that needs it, and converts every site to it.

- **In scope:** register rows **X8-1** (upload middleware destroys downstream errors), **X9-6**
  (kernel 404 bypasses the configured format), **X11-2** (kernel fallback 500 discards the error and
  logs nothing), **X4-8 + C3** (short-circuiting middleware answers in its own shape; templates pair
  two disagreeing formats), **X7-5** (gRPC handler errors logged nowhere), **X2-5** (a raw `Error`
  in log metadata serializes empty), **X8-12** (a notification `AggregateError` names no channel).
  The X4-8 sweep covers **every** first-party short-circuit site, not the three named in the row —
  see §3.5.
- **NOT this milestone:** a `405` for a method mismatch on an existing path (X9-6's third row) — the
  router's `match()` reports `null` without distinguishing a missing path from a missing method, so
  answering `405` is a router change and belongs with **M70g** (routing). Upload buffering limits
  (X8-3) and the parser's leniency are **M70k**. gRPC's `basePath` reachability and the
  repair-versus-withdraw decision (X7-2, X7-4) are **M70i**. Notification's all-or-nothing retry
  amplification beyond the new settled surface is bounded here to what §3.8 specifies.

## 1. Contracts verified from SOURCE (not names)

| Reference                                         | Source (file:line)                                                                                                                                                                                                                                                 | Verified surface / fact                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRequestContext.state`                           | `packages/common/src/http.ts:230`                                                                                                                                                                                                                                  | `readonly state: Map<string, unknown>` — **string keys only**, so the responder seam is a string constant, not a `Symbol.for` brand like M57's `SECURITY_METADATA`                                                                                 |
| Kernel-authored error bodies                      | `packages/kernel/src/application/application.ts:543,609,651,711,720,735,822`                                                                                                                                                                                       | Seven sites writing `.json({ error: … })` directly: 503 drain, 404 unmatched, 500 fallback, 500 upgrade-router failure, upgrade rejection, and two 400 bad-request paths                                                                           |
| Kernel dependency graph                           | `packages/kernel/deno.json:6-8`                                                                                                                                                                                                                                    | `@setu-ts/common` + `@hono/hono` only — the kernel **cannot** import `@setu-ts/exceptions`, so `throw notFound()` is unavailable to it                                                                                                             |
| Kernel logger idiom                               | `packages/kernel/src/application/application.ts` `#reportSuppressedHookError`, `#reportUpgradeRouterFailure`                                                                                                                                                       | The kernel already resolves `CAPABILITIES.LOGGER` through `registry.has(...)` inside a `try {} catch {}`, unwrapping to `{ error: err.message, stack: err.stack }` — X11-2's fix reuses this exact shape, it does not invent one                   |
| `errorHandler` resolution timing                  | `packages/exceptions/src/middleware/error-handler.ts:127-133`                                                                                                                                                                                                      | `selectFormatter(format)` and the `PROBLEM_JSON` / `JSON_CONTENT_TYPE` choice are resolved **once at factory time**, before the returned middleware — so publishing them per request costs one `Map.set`, not a resolution                         |
| `ErrorHandlerFormatter`                           | `packages/exceptions/src/formatters/error-formatter.ts:33-36`                                                                                                                                                                                                      | `(error: Error, ctx?: IRequestContext) => Record<string, unknown>` — takes an `Error`, so a responder built from it must construct one internally; it cannot be fed a bare `(status, title)` pair                                                  |
| `defaultFormatter` shape                          | `packages/exceptions/src/formatters/error-formatter.ts:84-91`                                                                                                                                                                                                      | `{ statusCode, message, details? }` — **not** Problem Details. An app configured `format: 'default'` must keep getting this, which is why §3.1 rejects hardcoding RFC 9457 at the short-circuit sites                                              |
| `buildProblemDetails`                             | `packages/exceptions/src/formatters/problem-details.ts`                                                                                                                                                                                                            | Internal (not barrel-exported), takes `(error, ctx, resolveType)`; `HttpError` is what supplies `statusCode` and the `errors` extension                                                                                                            |
| `HttpError`                                       | `packages/exceptions/src/errors/http-error.ts`                                                                                                                                                                                                                     | One concrete class, `statusCode` + optional `details` + `cause`; factories set the status. `instanceof HttpError` is what `errorHandler` uses to decide masking                                                                                    |
| `maskInternalErrors`                              | `packages/exceptions/src/middleware/error-handler.ts:65-79,124`                                                                                                                                                                                                    | Already shipped by M70b, default `true`; a **non**-`HttpError` at status ≥ 500 is masked. A responder-produced 4xx must therefore be `HttpError`-shaped or it would be masked into `Internal Server Error`                                         |
| Metrics throw path                                | `packages/metrics-plugin/src/collectors/http-collector.ts:126-135`                                                                                                                                                                                                 | On a caught throw the collector **hardcodes** `const status = '500'` and increments both `http_requests_total` and `http_requests_errors_total` before rethrowing. This is the source-verified reason §3.1 rejects "make the kernel throw"         |
| Metrics success path                              | `packages/metrics-plugin/src/collectors/http-collector.ts:139-153`                                                                                                                                                                                                 | The `finally` arm reads `ctx.response.snapshot().status` — so a site that **writes the status and returns** is recorded accurately, which the responder design preserves                                                                           |
| Upload middleware                                 | `packages/storage-plugin/src/middleware/upload-middleware.ts:61-121`                                                                                                                                                                                               | `await next()` is the second-to-last statement **inside** the `try`; the `catch` is parameterless. Six further short-circuits in the same function emit `{ error, detail }`                                                                        |
| Tenant rejection                                  | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:154-159`                                                                                                                                                                                        | `.status(rejectionStatus).json({ error: 'Tenant Required', message: … })`                                                                                                                                                                          |
| Session tenant mismatch                           | `packages/session-plugin/src/middleware/session-middleware.ts:48-61`                                                                                                                                                                                               | The 403, **and a source comment naming this milestone**: "no plugin may import `@setu-ts/exceptions`, so an `HttpError` is unavailable here, and M70f converges the two shapes in one place"                                                       |
| Form CSRF rejection                               | `packages/session-plugin/src/middleware/csrf-form-middleware.ts:67-71`                                                                                                                                                                                             | `.status(403).json({ error: 'Forbidden', message: 'CSRF token validation failed' })`                                                                                                                                                               |
| Remaining short-circuit sites                     | `packages/auth-plugin/src/guards/index.ts:36,62,71,98,107,134,143,173,182`; `packages/http-security-plugin/src/middleware/request-size-middleware.ts:62`, `csrf-middleware.ts:63,97`; `packages/feature-flags-plugin/src/middleware/feature-flag-middleware.ts:80` | Thirteen further first-party sites the X4-8 row did not enumerate — the register's own instruction is to "grep for the remaining sites" and treat it as one audit                                                                                  |
| `LogMetadata`                                     | `packages/common/src/services/logger.ts:14`                                                                                                                                                                                                                        | `Readonly<Record<string, unknown>>` — `ILogger` has **no** `Error`-shaped parameter, which is what makes X2-5's mistake available                                                                                                                  |
| Console logger emit                               | `packages/logger-plugin/src/loggers/console-logger.ts:133-149`                                                                                                                                                                                                     | Merges bindings + metadata, redacts, then `JSON.stringify(entry)` — an `Error` value renders `{}` because `message`/`stack` are non-enumerable                                                                                                     |
| X2-5 call site                                    | `packages/events-plugin/src/plugin/events-plugin.ts:100`                                                                                                                                                                                                           | `logger.error('Event handler failed', { error, eventType: event.type })` — the raw `Error`                                                                                                                                                         |
| **A second X2-5 site the register's scan missed** | `packages/exceptions/src/middleware/error-handler.ts:210-214`                                                                                                                                                                                                      | `logError` writes `...(error.cause !== undefined && { cause: error.cause })` — a raw `Error` in metadata. The register scanned for the `{ error, … }` idiom and this one is keyed `cause`, so the "single outlier" claim is one site short         |
| `ConnectCoreModuleLike`                           | `packages/grpc-plugin/src/transports/connect-loader.ts:59`                                                                                                                                                                                                         | `createConnectRouter(options?: Record<string, unknown>)` — the facade **already** declares the options parameter                                                                                                                                   |
| Connect router construction                       | `packages/grpc-plugin/src/transports/connect-loader.ts:113-115`, `connect-router-builder.ts:76`                                                                                                                                                                    | The default adapter drops its argument (`return connect.createConnectRouter()`) and the builder calls `createConnectRouter()` with none — so an `interceptors` option is dead surface until BOTH are threaded                                      |
| gRPC optional deps                                | `packages/grpc-plugin/src/plugin/grpc-plugin.ts:35`                                                                                                                                                                                                                | `optionalDependencies: ['logger', CAPABILITIES.HEALTH]` — the logger edge already exists; only a reader is missing                                                                                                                                 |
| `INotifier`                                       | `packages/common/src/services/notification.ts:47-55`                                                                                                                                                                                                               | Exactly one member, `send(...): Promise<void>`. A `sendSettled` must be **optional** to stay non-breaking for implementors                                                                                                                         |
| Notification fan-out                              | `packages/notification-plugin/src/services/notification-service.ts:53-71`                                                                                                                                                                                          | `Promise.allSettled` over `notification.channels.map(async (name) => …)`; `errors.push(toError(result.reason))` **discards the channel name it holds two lines earlier**                                                                           |
| `testing` dependency graph                        | `packages/testing/deno.json:6-9`                                                                                                                                                                                                                                   | `@setu-ts/common` + `@setu-ts/kernel` only — so X11-2's "have `createTestApp` install `errorHandler`" fix option is **unavailable** without adding a dependency; §3.7 takes the kernel-side fix instead                                            |
| C3 at the CLI                                     | `packages/cli/src/templates/rest.ts:44,78-83`                                                                                                                                                                                                                      | `{ pkg: 'validation-plugin', symbol: 'ValidationPlugin' }` with no `args`, beside `errorHandler` with `args: "{ format: 'rfc9457' }"`                                                                                                              |
| **C3 at the starters (not in the row)**           | `packages/starters/rest-starter/src/app.ts:43,95`                                                                                                                                                                                                                  | `ValidationPlugin(options.validation)` beside `errorHandler({ format: 'rfc9457' })` — the identical split, inherited by the microservice and full-stack tiers through the `extends` chain. C3 named only `cli` because it was found by scaffolding |
| Plan linter                                       | `scripts/plan-lint.ts:52-74`                                                                                                                                                                                                                                       | Nine required section headings; `<FILL:` is an error; all-caps `OR`, `either`, `TBD`, `TODO`/`FIXME`, `???` are warnings outside inline code                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Resolution (picked side)                                                                                                                                                                                                                                             | Doc deliverable (same PR)                                                                                                                                                               |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | The ROADMAP M70f package list reads `storage-plugin`, `kernel`, `exceptions`, `multi-tenancy-plugin`, `session-plugin`, `grpc-plugin`, `logger-plugin`, `notification-plugin`. Four packages carrying rows the body itself assigns are absent — `events-plugin` (X2-5's actual site), `cli` (C3's fix site), `common` (the seam every other fix depends on, since no plugin may import `exceptions`), `testing` (X11-2's second half) — and the X4-8 sweep reaches `auth-plugin`, `http-security-plugin`, `feature-flags-plugin` and the starters | Correct the list at plan time, as M70b did for `feature-flags-plugin`/`common` and M70h did for `common`/`runtime`. Final list in §5. `logger-plugin` **stays** in the list and gains a real change (§3.6), rather than being the row's stand-in for `events-plugin` | ROADMAP M70f package list + the workstream body, corrected and the correction stated in the row, matching the M70b/M70h precedent                                                       |
| C2 | The register calls X2-5 "a single outlier, not a systemic pattern — which is what makes the fix unambiguous", having scanned 185 files for one idiom. `error-handler.ts:210-214` is a second site, keyed `cause` rather than `error`                                                                                                                                                                                                                                                                                                              | The claim is one site short and the fix is correspondingly wider: normalize in the logger (§3.6) so the class cannot recur through any call site, and correct both known call sites                                                                                  | Register X2-5 row amended with the second site; CHANGELOG entry states both                                                                                                             |
| C3 | `packages/session-plugin/src/middleware/session-middleware.ts:48-52` promises in source that "M70f converges the two shapes in one place"                                                                                                                                                                                                                                                                                                                                                                                                         | Honoured — the comment's forward reference becomes a call to `respondWithError`                                                                                                                                                                                      | The comment is rewritten to describe what the code now does rather than what a future milestone will do (a stale forward reference is a doc-versus-behavior defect the moment it lands) |
| C4 | `PUBLIC_API.md` documents `errorHandler` as the middleware that formats thrown errors, with no statement that the kernel's own responses and short-circuiting middleware participate                                                                                                                                                                                                                                                                                                                                                              | Document the responder seam as the framework's error-body contract, and state plainly that with **no** `errorHandler` registered every site falls back to `{ error, detail? }`                                                                                       | `PUBLIC_API.md` gains the `common` responder-seam entries and an "error format" note; `ARCHITECTURE.md` §13 (errors) gains the seam                                                     |

## 3. Design decisions

### 3.1 The convergence seam — how a package that may not import `exceptions` answers in the configured format

- **Decision:** `common` gains a **request-scoped error responder** published into `ctx.state` under
  a `common`-owned string key, plus ONE pure free function `respondWithError(ctx, init)` that every
  site calls. `errorHandler` publishes the responder before `await next()`, built from the formatter
  and content type it has **already** resolved at factory time. When no responder is present — no
  `errorHandler` registered, or a site running outside it — `respondWithError` writes the
  framework-default `{ error: title, detail? }` body, which is today's shape family. **Corrected
  during review:** that is not byte-identical at every site — §3.11 converges `{ error, message }`
  to `{ error, detail }` at the multi-tenancy and session sites, a released behaviour change
  carrying its own CHANGELOG migration note. It IS byte-identical at every site that already
  answered `{ error }` or `{ error, detail }`.
- **Why:** the alternative the register offers first — have the kernel terminal and each
  short-circuit **throw**, and let `errorHandler` format — was rejected on measured grounds, not
  taste. `metrics-plugin`'s HTTP collector hardcodes `const status = '500'` on its catch path
  (`http-collector.ts:128`) and increments `http_requests_errors_total` before rethrowing, while its
  `finally` arm reads the real status from `snapshot()`. Throwing would therefore move **every**
  unmatched route from `http_requests_total{status="404"}` to `{status="500"}` and count it as a
  server error — a monitoring regression on the most common response an API produces, applied to
  100% of applications. The responder leaves the status write exactly where it is, so metrics,
  telemetry and the access log all keep seeing the status the client sees. It also honours a
  **custom** formatter function and the `'default'` format, which a hardcoded Problem Details body
  at each site would silently contradict — reintroducing X4-8 at every site it claimed to fix.
- **Test home:** `packages/common/test/unit/error-responder.test.ts` (fallback shape, key
  isolation), `packages/exceptions/test/integration/error-format-agreement.test.ts` (one app, one
  shape, across `'default'`, `'rfc9457'` and a custom function).

### 3.2 What the responder carries, and why it is not a formatter reference

- **Decision:** the state value is an object `IErrorResponder` with a single method
  `respond(ctx, init: ErrorResponseInit): void`, where
  `ErrorResponseInit = { status: number; title: string; detail?: string; details?: Readonly<Record<string, unknown>> }`.
  `exceptions` implements it by constructing an `HttpError` from the init and running its resolved
  formatter, then writing status, `content-type` and the serialized body — the same three-step tail
  `errorHandler` already performs. `common` exports the interface, the state key, the init type, and
  `respondWithError`; it exports no formatter and constructs no error.
- **Why:** publishing the raw `ErrorHandlerFormatter` would force every caller to build an `Error`,
  which is precisely the thing a package without `exceptions` cannot do correctly — a plain `Error`
  carries no `statusCode`, so `buildProblemDetails` would answer `500` for a tenant `400`, and
  `maskInternalErrors` would then mask it into `Internal Server Error`. Handing over one `respond`
  call keeps the `HttpError` construction inside the only package that owns it, and keeps the
  content-type decision (`application/problem+json` versus `application/json`) in the one place that
  already computes it.
- **Test home:** `packages/exceptions/test/unit/error-responder-install.test.ts` — asserts a
  responder-produced `400` is **not** masked, and carries `application/problem+json` under
  `'rfc9457'` and `application/json; charset=utf-8` under `'default'`.

### 3.3 Kernel-authored responses

- **Decision:** all seven kernel sites route through `respondWithError`. **Corrected during
  implementation:** this section assumed every one of them can read the responder from `ctx.state`.
  Three cannot — the drain `503`, the malformed-request `400`, and the request-lifecycle hooks run
  BEFORE any middleware, and are reached instead through the `ERROR_RESPONDER_BRAND` channel that
  §10 records. The seven sites are: the 503 drain, the 404 unmatched route, the 500 fallback, the
  500 upgrade-router failure, the upgrade rejection, and both 400 bad-request paths. The status is
  still written by the kernel, so nothing about pipeline semantics, metrics or hooks changes; only
  the body and content type follow the application.
- **Why:** X9-6 is the 404 alone, but leaving the other six writing `{ error: … }` would mean an
  application answers in one shape for a missing route and another for a malformed path — the same
  defect, one site over. The kernel is inside the pipeline for all seven, so the responder is
  reachable at every one.
- **Test home:** `packages/kernel/test/integration/error-format-terminal.test.ts` — one app with
  `errorHandler({ format: 'rfc9457' })` asserting a thrown `notFound()` and an unmatched route
  produce **identical** `type`/`title`/`status`/`content-type`, which is the assertion the register
  says no gate makes.

### 3.4 The kernel's fallback 500 becomes visible (X11-2)

- **Decision:** the kernel's catch arm logs the unhandled error at `error` level through the
  existing guarded-logger idiom (`registry.has(CAPABILITIES.LOGGER)` inside `try {} catch {}`),
  carrying `serializeError(error)` from §3.6 plus the request id, method and path. The response body
  stays opaque — the message is not disclosed, which is M70b's `maskInternalErrors` decision applied
  consistently. Only the generic 500 path logs; a responder-formatted 4xx the kernel itself authored
  does not.
- **Why:** X11-2's preferred fix is exactly this, and it is the only one of the row's three options
  reachable: `testing` depends on `common` + `kernel` alone (`testing/deno.json:6-9`), so installing
  `errorHandler` by default there would add a package dependency to buy a behaviour the kernel can
  provide for every application rather than only for test apps. A 500 with no trace is a production
  defect before it is a testing one. Logging at 4xx would make an unmatched-route scan an error-log
  flood.
- **Test home:** `packages/kernel/test/integration/unhandled-error-logging.test.ts` — a real
  `LoggerPlugin` app whose handler throws asserts one `error` line carrying the message and the
  stack, and that the response body still discloses neither.

### 3.5 The short-circuit sweep — every first-party site, not the three named

- **Decision:** every first-party middleware that writes an error response without throwing is
  converted to `respondWithError`: `storage-plugin`'s six upload rejections,
  `multi-tenancy-plugin`'s tenant `400`, `session-plugin`'s tenant-mismatch `403` and form-CSRF
  `403`, `auth-plugin`'s nine guard rejections, `http-security-plugin`'s request-size `413` and two
  CSRF `403`s, and `feature-flags-plugin`'s flag-guard rejection. Each keeps its status, its title,
  and its (non-)disclosure decision verbatim; only the body assembly moves.
- **Why:** X4-8's own fix text asks for exactly this — "then grep for the remaining sites" — and the
  register's cross-cutting section calls it "one audit across every site that writes a response
  without throwing". Converting three of twenty-two would leave the milestone's claim untrue while
  reading as complete: an application would still get two shapes, just from different plugins. Each
  conversion is a one-line call swap against a single shared function, so the cost is proportional
  to the site count and the risk is not. **This widens the ROADMAP package list (C1) and is flagged
  for the maintainer as a plan-time scope call** — trimming it back to the three named sites is a
  deletion, not a redesign.
- **Test home:** `packages/exceptions/test/integration/short-circuit-format.test.ts` drives one app
  registering every converted middleware and asserts each rejection carries the configured shape;
  plus one per-package unit assertion that the status and disclosure text are unchanged.

### 3.6 Error serialization (X2-5)

- **Decision:** `common` gains a pure `serializeError(value: unknown): SerializedError` returning
  `{ name, message, stack?, cause? }`, with the cause chain serialized recursively to a bounded
  depth so a self-referential cause cannot recurse forever. Two consumers: (a) `logger-plugin`
  normalizes any `Error` value found in merged metadata **before** redaction, in `ConsoleLogger` and
  on the pino path, so the class cannot recur through any call site; (b) the two known raw-`Error`
  call sites — `events-plugin/src/plugin/events-plugin.ts:100` and `exceptions`' `logError` `cause`
  member — call it explicitly, so they stay correct under a third-party `ILogger` that does not
  normalize.
- **Why:** the register's recommendation is the call-site fix, and it is right that it is
  unambiguous — but it leaves the next call site free to make the same mistake, and C2 shows the
  scan that produced "a single outlier" already missed one. Normalizing in the logger is the fix
  that makes the defect unavailable; correcting the call sites is what keeps them portable. One
  implementation in `common` serves both, so the two cannot drift (§11.1). Normalizing before
  redaction is load-bearing: a redact path such as `error.token` must see the normalized object, and
  redacting first would leave the raw `Error` for `JSON.stringify` to flatten to `{}` anyway.
- **Test home:** `packages/common/test/unit/serialize-error.test.ts` (shape, nested cause, cycle
  bound, non-`Error` input),
  `packages/logger-plugin/test/unit/console-logger-error-metadata.test.ts` (a raw `Error` in
  metadata emits `message` and `stack`; a redact path into it still redacts).

### 3.7 gRPC handler errors (X7-5)

- **Decision:** `grpc-plugin` installs a built-in logging interceptor that catches, logs at `error`
  level with the procedure name and `serializeError(...)`, and rethrows so the masked wire response
  is unchanged. The logger is resolved from `CAPABILITIES.LOGGER` — already an `optionalDependency`
  (`grpc-plugin.ts:35`) — and read at **call** time, not captured at `register()` (the M52b lesson).
  Separately `GrpcPluginOptions` gains `interceptors?: readonly unknown[]`, threaded through
  `buildConnectRouter` into `createConnectRouter({ interceptors })`, with the application's
  interceptors composed after the built-in one.
- **Why:** the response is already correct — masking is the gRPC convention — so the defect is
  purely that the operator is blind, and the plugin's own `optionalDependencies` edge says a logger
  was always intended. The `interceptors` option is not decoration: without it an application has no
  way to add its own observability, and with it the built-in interceptor becomes one entry in a list
  rather than a special case. Threading requires fixing `connect-loader.ts:113-115`, which currently
  **drops** the argument its own facade declares (`connect-loader.ts:59`) — without that fix the
  option would be dead surface, which §4 forbids.
- **Test home:** `packages/grpc-plugin/test/integration/handler-error-logging.test.ts` — a throwing
  procedure driven through the plugin asserts the wire response is still `{"code":"internal"}` AND
  that one `error` log line carries the real message; a second case asserts an application-supplied
  interceptor runs.

### 3.8 Notification failure attribution (X8-12)

- **Decision:** each rejection is wrapped with the channel it came from — `new Error(\`channel
  '${name}' failed\`, { cause
  })`— so the`AggregateError`'s members name their
  channel without needing`.errors`to be rendered.`INotifier`gains an **optional**`sendSettled?(notification):
  Promise<readonly
  ChannelSendResult[]>`in`common`, implemented by`NotificationService`, returning one non-throwing result per channel
  (`{
  channel, ok: true } | { channel, ok: false, error: SerializedError }`).
- **Why:** the channel name is held two lines above the site that discards it
  (`notification-service.ts:57,65`), so attribution costs nothing. `sendSettled` is what makes the
  retry amplification fixable by a caller — behind a queue with `maxAttempts: 3` one failing channel
  produced four emails — and it must be reachable through `CAPABILITIES.NOTIFICATION`, which means
  it belongs on `INotifier` rather than on the concrete class alone; a concrete-only method would be
  unreachable through the token and therefore dead surface. Optional, so no implementor breaks (the
  M47 `isEnabledAsync` precedent).
- **Test home:** `packages/notification-plugin/test/unit/send-settled.test.ts` — a two-channel
  fan-out with one failure asserts `send` still throws an `AggregateError` whose members name the
  channel, and that `sendSettled` throws nothing and reports one `ok: false` naming the same
  channel.

### 3.9 Template and starter format agreement (C3)

- **Decision:** `packages/cli/src/templates/rest.ts` emits
  `ValidationPlugin({ errorFormat: 'rfc9457' })`, inherited by the `microservice` and `class-based`
  sets that compose from `REST_PLUGINS`. `packages/starters/rest-starter/src/app.ts` becomes
  `ValidationPlugin({ errorFormat: 'rfc9457', ...options.validation })`, so the starter default
  agrees while an explicit caller option still wins; the microservice and full-stack tiers inherit
  it through the existing `extends` chain with no new gate logic.
- **Why:** C3's row names `cli` only because it was found by scaffolding, but
  `rest-starter/src/app.ts:43,95` pairs the identical bare `ValidationPlugin(...)` with
  `errorHandler({ format: 'rfc9457' })` — so an application built through the starter has the same
  two-shape split, and fixing only the templates would leave the library half live. Spreading
  `options.validation` last rather than defaulting the whole object keeps the option's existing
  precedence exactly.
- **Test home:** `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` gains an assertion that a
  scaffolded project's validation failure and its thrown error answer with the same `content-type`
  and the same body members; `packages/starters/rest-starter/test/unit/validation-format.test.ts`
  asserts the default and the override.

### 3.10 X8-1 — the upload middleware stops destroying errors

- **Decision:** `await next()` moves **out** of the `try`, taking the register's first-preference
  fix. The parse and validation stay guarded; the `catch` gains its parameter, reports the failure
  through
  `respondWithError(ctx, { status: 400, title: 'Bad Request', detail: 'Failed to parse multipart body' })`,
  and logs the caught error at `warn` level so a genuinely malformed body is still diagnosable.
- **Why:** re-throwing anything that is not the parser's own error (the row's option 2) needs the
  parser to throw a **typed** error, which it does not today — adding one is a parser change that
  belongs with M70k's upload work, and moving one statement achieves the same isolation now with no
  new type. The register's observation that the catch rarely catches what it was written for (three
  of four malformed bodies parse to zero parts and answer `200`) is a parser-leniency defect, not
  this one, and is left to M70k rather than folded in silently.
- **Test home:** `packages/storage-plugin/test/integration/upload-error-passthrough.test.ts` — a
  handler that throws behind the upload middleware produces the **same** response as the same
  handler with no upload middleware, which is exactly the control the register's table used.

### 3.11 What happens with no `errorHandler` registered

- **Decision:** `respondWithError` writes `{ error: title }`, plus `detail` when the init carries
  one, as `application/json`. Sites whose current fallback body differs — `multi-tenancy-plugin` and
  `session-plugin` emit `{ error, message }` — converge on `detail`; `message` is dropped.
- **Why:** `message` is not a Problem Details member, which is half of what X4-8 reports, and
  keeping it in the no-handler fallback would leave two spellings of the same field alive in one
  framework. Converging is a **behaviour change to a released response body** for applications with
  no `errorHandler`, so it ships with a CHANGELOG migration note rather than as an implementation
  detail.
- **Test home:** `packages/common/test/unit/error-responder.test.ts` — the no-responder path, keyed
  per site by the integration suite in §3.5.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                           | Kind            | Consumer / real code path that READS it                                                                                                                                                                        |
| --------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERROR_RESPONDER_STATE_KEY` (`common`)                    | `const string`  | Written by `exceptions`' `errorHandler`; read by `respondWithError`. Exported so a third-party error handler can publish a responder too                                                                       |
| `IErrorResponder` (`common`)                              | interface       | Implemented by `exceptions`; the type of the value under the state key                                                                                                                                         |
| `ErrorResponseInit` (`common`)                            | interface       | Parameter type of `respondWithError` and `IErrorResponder.respond`; constructed at all twenty-two short-circuit sites and the seven kernel sites                                                               |
| `respondWithError` (`common`)                             | function        | Called by `kernel` (7 sites), `storage-plugin` (7), `multi-tenancy-plugin` (1), `session-plugin` (2), `auth-plugin` (9), `http-security-plugin` (3), `feature-flags-plugin` (1)                                |
| `serializeError` (`common`)                               | function        | Called by `logger-plugin` (metadata normalization), `kernel` (§3.4 fallback log), `events-plugin` (X2-5), `exceptions` (`logError` cause), `grpc-plugin` (§3.7), `notification-plugin` (`sendSettled` results) |
| `SerializedError` (`common`)                              | interface       | Return type of `serializeError`; the `error` member of `ChannelSendResult`                                                                                                                                     |
| `ChannelSendResult` (`common`)                            | type            | Return element of `INotifier.sendSettled`; read by an application retrying one channel                                                                                                                         |
| `INotifier.sendSettled?` (`common`, widened)              | optional method | Implemented by `NotificationService`; called by an application resolving `CAPABILITIES.NOTIFICATION`                                                                                                           |
| `GrpcPluginOptions.interceptors` (`grpc-plugin`, widened) | option          | Read by `buildConnectRouter`, passed to `createConnectRouter({ interceptors })` — see §4.1                                                                                                                     |

Nothing is added to any other package's `src/index.ts`. `exceptions`' responder implementation is
**internal** (not barrel-exported) — the interface it satisfies lives in `common`, and exporting the
class as well would give one concept two public names; a `barrel-exports.test.ts` assertion pins
that, the M56 precedent.

### 4.1 Options — every option names its consumer

| Option                           | Consumer                                                                                                              | Behavior (per implementation)                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GrpcPluginOptions.interceptors` | `buildConnectRouter` → `connectRuntime.createConnectRouter({ interceptors })`, after the built-in logging interceptor | Absent: only the built-in interceptor is installed. Present: composed after it, so a handler throw is logged before an application interceptor observes it. **Requires** the `connect-loader.ts:113-115` fix or the value never reaches Connect |
| `INotifier.sendSettled`          | `NotificationService.sendSettled`                                                                                     | Never throws; one result per requested channel, in request order. An unknown channel name reports `ok: false` rather than throwing, matching `send`'s existing treatment                                                                        |

No option is added to `ErrorHandlerOptions`: publishing the responder is unconditional. An opt-out
would be an option whose only effect is to reinstate a defect, and nothing would read it.

## 5. Implementation files

| File                                                                                                                                                | Purpose                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/errors/error-responder.ts`                                                                                                     | `ERROR_RESPONDER_STATE_KEY`, `IErrorResponder`, `ErrorResponseInit`, `respondWithError` + the no-responder fallback |
| `packages/common/src/errors/serialize-error.ts`                                                                                                     | `SerializedError`, `serializeError` with the bounded cause chain                                                    |
| `packages/common/src/services/notification.ts`                                                                                                      | `INotifier.sendSettled?` + `ChannelSendResult`                                                                      |
| `packages/common/src/index.ts`                                                                                                                      | Barrel additions                                                                                                    |
| `packages/exceptions/src/middleware/error-responder-impl.ts`                                                                                        | Internal `IErrorResponder` built from the resolved formatter and content type                                       |
| `packages/exceptions/src/middleware/error-handler.ts`                                                                                               | Publishes the responder before `next()`; `logError` cause via `serializeError`                                      |
| `packages/kernel/src/application/application.ts`                                                                                                    | Seven bodies via `respondWithError`; fallback-500 logging                                                           |
| `packages/storage-plugin/src/middleware/upload-middleware.ts`                                                                                       | `next()` out of the `try`; catch takes its parameter, reports and logs; six rejections via the responder            |
| `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts`                                                                                 | Tenant `400` via the responder                                                                                      |
| `packages/session-plugin/src/middleware/session-middleware.ts`                                                                                      | Tenant-mismatch `403`; the C3 forward-reference comment rewritten                                                   |
| `packages/session-plugin/src/middleware/csrf-form-middleware.ts`                                                                                    | Form-CSRF `403`                                                                                                     |
| `packages/auth-plugin/src/guards/index.ts`                                                                                                          | Nine guard rejections                                                                                               |
| `packages/http-security-plugin/src/middleware/request-size-middleware.ts`, `csrf-middleware.ts`                                                     | `413` and two `403`s                                                                                                |
| `packages/feature-flags-plugin/src/middleware/feature-flag-middleware.ts`                                                                           | Flag-guard rejection                                                                                                |
| `packages/logger-plugin/src/loggers/console-logger.ts`, `pino-logger.ts`                                                                            | Metadata `Error` normalization before redaction                                                                     |
| `packages/events-plugin/src/plugin/events-plugin.ts`                                                                                                | X2-5 call site                                                                                                      |
| `packages/grpc-plugin/src/interfaces/index.ts`, `transports/connect-router-builder.ts`, `transports/connect-loader.ts`, `src/plugin/grpc-plugin.ts` | `interceptors` option, built-in logging interceptor, the dropped-argument fix                                       |
| `packages/notification-plugin/src/services/notification-service.ts`                                                                                 | Channel-named causes + `sendSettled`                                                                                |
| `packages/cli/src/templates/rest.ts`                                                                                                                | C3 template arg                                                                                                     |
| `packages/starters/rest-starter/src/app.ts`                                                                                                         | C3 starter default                                                                                                  |
| `packages/testing/README.md`                                                                                                                        | X11-2's third option: a note beside the existing `plugins` / `autoStart` notes                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                            | src covered                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/error-responder.test.ts`                           | `errors/error-responder.ts`             | `respondWithError(ctx, { status: 400, title: 'Bad Request' })` against the `ErrorResponseInit` of §4; no-responder fallback shape; a responder under the key is delegated to; a non-conforming state value is ignored rather than thrown through  |
| `common/test/unit/serialize-error.test.ts`                           | `errors/serialize-error.ts`             | `serializeError(new Error('x', { cause: new Error('y') }))` shape; a cyclic cause terminates at the bound; a string input; a `null` input                                                                                                         |
| `exceptions/test/unit/error-responder-install.test.ts`               | `middleware/error-responder-impl.ts`    | Responder-produced `400` is **not** masked by `maskInternalErrors: true`; `application/problem+json` under `'rfc9457'`, `application/json; charset=utf-8` under `'default'`                                                                       |
| `exceptions/test/integration/error-format-agreement.test.ts`         | `middleware/error-handler.ts`           | One kernel app: a thrown `notFound()` and an unmatched route produce identical `type`/`title`/`status`/`content-type`, under `'default'`, `'rfc9457'`, and a custom formatter function — the non-default drive the self-review checklist requires |
| `exceptions/test/integration/short-circuit-format.test.ts`           | every converted middleware              | One app registering one route per converted middleware (seven routes covering the twenty-two call sites); each rejection carries the configured shape and its original status                                                                     |
| `exceptions/test/unit/barrel-exports.test.ts` (extend)               | `src/index.ts`                          | The responder implementation is **not** exported                                                                                                                                                                                                  |
| `kernel/test/integration/error-format-terminal.test.ts`              | `application/application.ts`            | All seven kernel bodies under a configured formatter; and unchanged from today with **no** `errorHandler` registered                                                                                                                              |
| `kernel/test/integration/unhandled-error-logging.test.ts`            | `application/application.ts`            | Real `LoggerPlugin`: a throwing handler emits one `error` line carrying message + stack; the body discloses neither; a 404 emits **no** error line                                                                                                |
| `storage-plugin/test/integration/upload-error-passthrough.test.ts`   | `middleware/upload-middleware.ts`       | A throwing handler behind the upload middleware answers identically to the same handler without it (the register's control); a genuinely malformed body still answers `400` and logs                                                              |
| `multi-tenancy-plugin/…`, `session-plugin/…` (extend existing)       | the three converted middlewares         | Status and disclosure text unchanged; body follows the configured format                                                                                                                                                                          |
| `auth-plugin/test/unit/guard-format.test.ts`                         | `guards/index.ts`                       | Each of the nine rejections keeps its status; short-circuit still prevents the handler running                                                                                                                                                    |
| `http-security-plugin/…`, `feature-flags-plugin/…` (extend existing) | the four converted sites                | As above                                                                                                                                                                                                                                          |
| `logger-plugin/test/unit/console-logger-error-metadata.test.ts`      | `loggers/console-logger.ts`             | A raw `Error` in metadata emits `message` and `stack`; a redact path into the normalized object still redacts; a non-`Error` value is untouched                                                                                                   |
| `logger-plugin/test/integration/pino-error-metadata.test.ts`         | `loggers/pino-logger.ts`                | Guarded **real** `npm:pino` import (the M4 precedent): a raw `Error` in metadata reaches the sink with its message — this is also where §8's pino-argument-order risk is settled                                                                  |
| `events-plugin/test/unit/handler-failure-logging.test.ts`            | `plugin/events-plugin.ts`               | The failure line carries the handler's message, not `{}`                                                                                                                                                                                          |
| `grpc-plugin/test/integration/handler-error-logging.test.ts`         | `transports/*`, `plugin/grpc-plugin.ts` | A throwing procedure still answers `{"code":"internal"}` AND logs the real message; an application interceptor supplied through the new option runs; a real-import guarded case proves `createConnectRouter` receives the options object          |
| `notification-plugin/test/unit/send-settled.test.ts`                 | `services/notification-service.ts`      | `AggregateError` members name their channel; `sendSettled` throws nothing and reports one `ok: false` naming the same channel                                                                                                                     |
| `cli/test/e2e/scaffold-runs-e2e.test.ts` (extend)                    | `templates/rest.ts`                     | A scaffolded project's validation failure and thrown error answer with the same `content-type` and body members                                                                                                                                   |
| `starters/rest-starter/test/unit/validation-format.test.ts`          | `src/app.ts`                            | Default is `'rfc9457'`; an explicit `options.validation` still wins                                                                                                                                                                               |

**Negative controls, each to be observed failing and then reverted** (the evidence bar, not a
formality): (1) revert `await next()` back inside the upload `try` — the passthrough test must fail
with the register's `400 Malformed request`; (2) remove the responder publication from
`errorHandler` — the agreement suite must fail while every no-handler test still passes, proving the
fallback path is genuinely separate; (3) restore `logger.error('…', { error })` at
`events-plugin.ts:100` **with** the logger normalization in place — the test must still pass, which
is what proves the normalization is load-bearing rather than the call site; then remove the
normalization too and watch it fail; (4) make the kernel terminal `throw` instead of responding —
the metrics assertion must show `status="500"` for an unmatched route, which is §3.1's rejected
alternative measured rather than asserted; (5) drop `interceptors` from the
`createConnectRouter(...)` call — the gRPC interceptor test must fail, proving the option is not
dead surface.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70f-error-visibility, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree — common/exceptions/kernel all change exported surface
deno task release:verify 0.1.0-alpha.8
```

## 8. Risks & mitigations

- **The sweep touches twenty-two call sites across eight packages.** A converted site that changes
  its status or its disclosure text is a security regression, not a formatting change (the CSRF
  rejection deliberately does not say which of session-or-token failed). Mitigation: each conversion
  is asserted against its **existing** test for status and text before the body assertion is added;
  no existing assertion is deleted, only extended — the M65 lesson about deleted coverage.
- **`pino-logger.ts:144-171` calls `this.#pino.error(message, metadata)`.** Pino's real signature is
  `error(obj, msg)`, so the argument order may mean metadata is dropped entirely on the pino path —
  in which case X2-5 has a third, larger face and every structured log in a pino-configured
  application is lost. This is **unverified** and must be settled by probing real pino before the
  logger change is written; the guarded real-import test in §6 is where the answer lands. If
  confirmed it is scoped in here (same family, same package, same milestone); if not, the plan
  records the probe result so the question is not re-raised.
- **Publishing the responder costs one `Map.set` per request** on every application registering
  `errorHandler`. Mitigation: the formatter and content type are already resolved at factory time
  (`error-handler.ts:127-133`), so the per-request work is one assignment of a pre-built object, and
  the responder object itself is constructed once in the closure — hoisted per AI_GUIDELINES §14,
  not rebuilt per request.
- **A site running before `errorHandler` gets the fallback shape.** `errorHandler` is contractually
  outermost at priority 0 and every first-party middleware sits above it, so this affects only a
  misconfigured application. Mitigation: documented in the `PUBLIC_API.md` note from C4 rather than
  guarded at runtime, since a guard would need the kernel to know a middleware's priority.
- **`common` gains four exports and one widened interface**, so the alpha.9 breaking-change list
  grows. Mitigation: `INotifier.sendSettled` is optional and every other addition is new surface, so
  nothing breaks for an implementor; the one genuine behaviour change is §3.11's `message` →
  `detail` in the no-handler fallback, which gets its own CHANGELOG entry with migration text rather
  than being folded into a release note.

## 9. Out of scope

- **A `405` for a method mismatch** (X9-6's third observation) — needs the router to distinguish "no
  such path" from "no such method on this path"; **M70g** owns kernel routing.
- **Upload buffering limits and the multipart parser's leniency** (X8-3, and the register's
  observation that three of four malformed bodies parse to zero parts and answer `200`) — **M70k**.
- **gRPC `basePath` reachability, native gRPC-binary, and the repair-versus-withdraw decision**
  (X7-2, X7-4) — **M70i**. This milestone only makes the plugin's failures visible.
- **`ILogger` gaining an `Error`-shaped parameter**, which the X2-5 row names as the longer-term fix
  — a required contract change breaking for every implementor, where §3.6's normalization plus
  `serializeError` closes the defect without one. Recorded for a future contract milestone.
- **Notification retry semantics beyond `sendSettled`** — the queue-side amplification (four emails
  for one upload) is fixable by a caller once per-channel results exist; changing `send` to be
  non-throwing would be a breaking contract change and is not taken here.
- **`createTestApp` installing `errorHandler` by default** — blocked by `testing`'s dependency graph
  (`testing/deno.json:6-9`); §3.4's kernel-side logging closes the row's substance and the README
  note closes the rest.

## 10. Deviations from this plan, recorded at implementation time

Three of this plan's claims did not survive implementation. They are recorded here rather than
silently worked around, so the archived plan describes what was built (the M50 / M52 / M70a
precedent).

- **§3.1 and §3.3 assumed `ctx.state` reaches every kernel site. It does not — three of the seven
  run before any middleware.** The shutdown-drain `503` and the malformed-request `400` execute
  before a request context exists at all, and the request-lifecycle hooks execute before the
  pipeline, so `errorHandler`'s `ctx.state` publication has not happened yet. Those three would have
  taken the no-handler fallback forever, even in an application that configures a format — the
  defect this milestone exists to close, surviving at the kernel's own sites. A second channel was
  added: `errorHandler` **brands** its middleware function with the same responder instance it
  publishes (`brandErrorResponder` / `errorResponderOf` / `ERROR_RESPONDER_BRAND` in `common`,
  `Symbol.for` per the M57 `SECURITY_METADATA` precedent), and the kernel reads that brand off the
  compiled chain once at startup and seeds it into the state those sites hand to `respondWithError`.
  §4's exported-surface table therefore undercounts: seven `common` exports shipped, not four.
- **§3.2's `ErrorResponderTarget` had to be narrower than `IRequestContext`.** The pre-pipeline
  sites have no context to pass, and handing a formatter a partial object would let a custom
  formatter read a documented member and throw — replacing the configured `503`/`400` with an
  unhandled `TypeError`. The responder therefore passes the formatter a context only when the target
  genuinely is one, and supplies the Problem Details `instance` from a separately captured safe
  path. That path is captured through a guard, because a request that failed URL parsing carries a
  `path` getter that throws.
- **The milestone changed a committed `common` contract the plan did not anticipate.**
  `IGrpcService.addService`'s `implementation` moved from `Partial<ServiceImpl>` to `unknown`,
  because an index-signature type rejects a class instance while Connect accepts one — which
  `withErrorLogging` needed, since it resolves procedures by property lookup rather than by
  enumerating own properties. `ServiceImpl` is left with no reader and is **removed** — the project
  is in prerelease, so a dead export is deleted rather than carried as deprecated surface
  (maintainer's call, which supersedes AI_GUIDELINES §9.2 for the alpha). Both are recorded in
  `CHANGELOG.md` and `PUBLIC_API.md`.

Two further items were settled by measurement during implementation and review:

- **§8's pino risk was real.** `PinoLogger` called `pino.error(message, metadata)` while pino's
  signature is `(obj, msg)`, so **every** structured metadata object was dropped on the pino path.
  Fixed; the guarded real-import test is the gate. A follow-on check confirmed real pino handles the
  resulting `(undefined, msg)` call for a metadata-less log correctly, so no message is lost.
- **§3.1's rejected alternative was re-confirmed, and the plan's premise about `add()` was stronger
  than stated.** `MiddlewarePipeline.add()` throws after `compile()`, so an `errorHandler`
  registered after `start()` is impossible — the kernel's startup-cached responder can never go
  stale.
