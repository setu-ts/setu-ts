# Milestone 101d — two sides of a service call that disagree

> **Status:** Complete. Branch: `feat/m101d-call-sides-agree`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Five pairs of first-party components sit on the two ends of one call and give different answers
about the same request: the SDK client and the receiving server about which trace a call belongs to;
a React Router route middleware and the kernel's error responder about the shape of a refusal; the
OpenAPI document and `fetch` about whether a `3xx` is observable; the server's `Retry-After` hint
and the client's retry policy about how long to wait; and `createFullStackAppFromConfig` and the
code that follows it about which configuration snapshot is in force. In every case the fix makes the
second half read what the first half already decided. Closes `smoke/DEFECTS.md` rows **V8-10, V8-11,
V8-27, V8-28, V8-29**.

**Sequence (decided in `PLAN-BRIEF.md`):** independent of every other M101 letter. V8-10 widens
`common`'s trace-context INPUT type; M101a does not touch that file. M101h lands after this letter
and documents the final shapes; it must not re-document the SDK retry cap, the trace interceptor, or
the React Router boundary.

- **In scope:** `packages/common` (one parameter-type widening in `trace-context.ts`),
  `packages/sdk` (trace interceptor, `Retry-After` cap, codegen `3xx` handling),
  `packages/telemetry-plugin` (the type-level proof that `activeSpanContext()` feeds the codec, and
  one doc note), `packages/react-router-plugin` (documented refusal boundary, pinned by test),
  `packages/starters/full-stack-starter` (config snapshot accessor), plus the CLI full-stack
  template's `require-user.server.ts` header comment, and `apps/full-stack` (one refusing route and
  its smoke assertion — §3.2's real-runtime pin; no package `src`).
- **NOT this milestone:** a problem-details body for React Router DOCUMENT navigations (declined
  with cause in §3.2 — the error boundary is React Router's own contract); per-attempt interceptor
  re-execution in the SDK (interceptors run once per `request()`, `http-client.ts:189-193`, and the
  traceparent is stable across attempts); the HTTP-date form of `Retry-After` (M35 decision, kept);
  CLI scaffold changes beyond the one comment (M101g owns scaffolds); any `common` change beyond the
  parameter widening.

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextToTraceparent` input type          | `packages/common/src/trace-context.ts:51-62`                                                                      | parameter is `TelemetryContext`; the body reads ONLY `traceId`, `spanId`, `traceFlags ?? '01'` and validates them against the W3C regexes and the all-zero ids                                                                                                                         |
| `TelemetryContext`                         | `packages/common/src/services/telemetry.ts:78-89`                                                                 | REQUIRED `_opaque: typeof TELEMETRY_CONTEXT_OPAQUE` plus optional `traceId`/`spanId`/`traceFlags`/`tracestate` — the `_opaque` member is what makes a `SpanContext` unassignable (`TS2345`)                                                                                            |
| `SpanContext`                              | `packages/common/src/services/telemetry.ts:149-156`                                                               | `traceId`, `spanId`, `traceFlags` — all required strings, no `_opaque`                                                                                                                                                                                                                 |
| `ITelemetryService.activeSpanContext?()`   | `packages/common/src/services/telemetry.ts:224`                                                                   | optional member returning `SpanContext \| undefined` (M90i)                                                                                                                                                                                                                            |
| Codec consumers in telemetry               | `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:28,365-370`; `middleware/telemetry-middleware.ts:22,89` | both pass a `TelemetryContext`; a widened parameter keeps them compiling unchanged                                                                                                                                                                                                     |
| `common` barrel for the codec              | `packages/common/src/index.ts:100`                                                                                | `contextToTraceparent` is exported; no symbol is added by this letter                                                                                                                                                                                                                  |
| SDK interceptor contract                   | `packages/sdk/src/http/contracts.ts:79-83,93,173`                                                                 | `ClientRequestContext { url: URL; headers: Headers }`; `ClientRequestInterceptor = (ctx) => void \| Promise<void>`; `ClientOptions.requestInterceptors?: ClientRequestInterceptor[]`                                                                                                   |
| Interceptors run once, before retry        | `packages/sdk/src/http/http-client.ts:189-193,243,310`                                                            | the loop runs before the attempt sequence; `runWithRetry` wraps the fetch; `fetchInit` sets no `redirect`, so the platform default `follow` applies                                                                                                                                    |
| Interceptor precedent                      | `packages/sdk/src/auth/auth-interceptor.ts:24-30,45-52`                                                           | `createBearerAuthInterceptor(value)` returns a `ClientRequestInterceptor` that sets a header unless already present                                                                                                                                                                    |
| SDK `common` imports are type-only         | `packages/sdk/test/unit/type-only-common.test.ts:29,49`                                                           | every import from `common` must be `import type` and no module-graph edge may carry runtime code — so the SDK cannot call `contextToTraceparent` at runtime (the M98n precedent duplicated alias validation for the same reason, `diagnostics/outbound-http-observations.ts:8-12`)     |
| `ClientOptions.retry`                      | `packages/sdk/src/http/contracts.ts:164`; `packages/common/src/services/resilience.ts:116-123`                    | `retry?: RetryPolicy` where `RetryPolicy = { limit, delay, backoff }` — a `common` type with no cap member                                                                                                                                                                             |
| `Retry-After` handling                     | `packages/sdk/src/retry/retry-strategy.ts:39-48,59-121`                                                           | `parseRetryAfterDelta` returns delta-seconds × 1000 for a non-negative integer; at `:111-113` a parsed value REPLACES the computed backoff with no cap, then `timing.sleep(delay, signal)`                                                                                             |
| Codegen error arms                         | `packages/sdk/src/codegen/openapi-codegen.ts:748-755`                                                             | `getErrorArms` skips only `undefined` and `2xx`, so a `303` becomes an error arm typed from its (absent) body                                                                                                                                                                          |
| Codegen success types                      | `packages/sdk/src/codegen/openapi-codegen.ts:951-975`                                                             | only `2xx` contributes; an operation with no `2xx` schema yields `'void'`                                                                                                                                                                                                              |
| Generated-client e2e                       | `packages/sdk/test/e2e/generated-client.test.ts`                                                                  | drives a generated client against a real kernel application — the home for the redirect case                                                                                                                                                                                           |
| RR response bridge                         | `packages/react-router-plugin/src/handler/request-bridge.ts:80-101`                                               | `writeRRResponseToContext` copies `status`, every header and the body verbatim; nothing inspects the status or consults the error responder                                                                                                                                            |
| RR handler invocation                      | `packages/react-router-plugin/src/services/ssr-service.ts:56`                                                     | `bridgeRequestToRR(...)` is the only path a React Router response takes to `ctx.response`                                                                                                                                                                                              |
| Error responder seam                       | `packages/common/src/errors/error-responder.ts:132-136,146,173-181,206-232`                                       | `ErrorResponderTarget { state; response: IResponse; request? }`; `respondWithError(target, init)` writes through the FULL `IResponse` — there is no "build me a web `Response`" form, so a React Router middleware (which holds a `RouterContext`, not an `IResponse`) cannot reach it |
| RR context keys                            | `packages/react-router-plugin/src/handler/context-keys.ts:38,51,96`; `handler/load-context.ts:23-30`              | `servicesContext`, `userContext`, `contextKeyFor`; the default load context sets the registry and the principal                                                                                                                                                                        |
| Scaffold `requireUser`                     | `packages/cli/src/templates/full-stack-app-files.ts:416-451`                                                      | the generated middleware answers an anonymous request with `throw redirect('/login')` — a `302`, never a `403`; the X58 `403` came from an app-written `require-admin.server.ts`                                                                                                       |
| `createFullStackAppFromConfig`             | `packages/starters/full-stack-starter/src/from-config.ts:134-160`                                                 | `(build: (config: IConfig) => FullStackStarterOptions, options?) => Promise<IKernelApplication>`; the snapshot `config` is a local, passed into `build` and as `config.instance`, and returned to nobody                                                                               |
| Starter barrel                             | `packages/starters/full-stack-starter/src/index.ts:14-28`                                                         | exports `createFullStackApp`, `buildFullStackPlugins`, `createFullStackAppFromConfig`, `FromConfigOptions` and type re-exports                                                                                                                                                         |
| CLI call site of the factory               | `packages/cli/src/templates/full-stack.ts:47`                                                                     | the template renders the argument list; M85 appends `app.register(...)` AFTER the factory returns — the post-factory site V8-29 describes                                                                                                                                              |
| `PUBLIC_API.md` SDK retry/interceptor text | `PUBLIC_API.md:11682` section, interceptor paragraph at `+110`, `retry` row at `+71`                              | documents interceptors as "execute once in registration order before the outbound attempt sequence" (consistent with §1) and `retry` with no cap                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                                   |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` M101d says "add the interceptor to the SDK and accept the type both producers emit" as if one change; the SDK cannot import the codec at runtime (type-only pin, §1), so the two halves are separate: a `common` type widening for server-side callers, and an SDK interceptor that formats the header itself            | Both ship; the duplication of the W3C format inside the SDK is deliberate and recorded in the interceptor's JSDoc (the M98n precedent), not a §11.1 miss | Reported in the hand-back (no `ROADMAP.md` edit here); sdk README "Interceptors" gains the trace section; `PUBLIC_API.md` SDK section gains `createTraceContextInterceptor` |
| C2 | `ROADMAP.md` M101d for V8-11 offers "route the refusal through `respondWithError`, or document the boundary"; the responder writes through a full `IResponse` (§1), and React Router renders a thrown non-redirect `Response` into its error boundary for a document request, so the first arm is not reachable from route middleware | Document the boundary, and pin it by test so a later bridge change is deliberate (§3.2)                                                                  | react-router README `## Refusals and the error responder`; `PUBLIC_API.md:3915` section note; the scaffold's `require-user.server.ts` header comment                        |
| C3 | `PUBLIC_API.md` SDK section documents `retry` without stating what a `Retry-After` longer than the policy tolerates does; the code sleeps for it (`retry-strategy.ts:111-113`)                                                                                                                                                        | The cap rule in §3.4 becomes the documented behaviour                                                                                                    | `PUBLIC_API.md` SDK `retry` row + a `maxRetryAfterMs` row; sdk README "Retry"                                                                                               |
| C4 | sdk README "Generated names and shapes" and `PUBLIC_API.md` codegen text describe every non-`2xx` response as an error arm; Fetch follows only `301`, `302`, `303`, `307`, and `308`, while responses such as `304` remain observable                                                                                                 | auto-follow redirects are not error arms; observable `3xx` responses remain error arms (§3.3)                                                            | sdk README codegen section + `PUBLIC_API.md` codegen paragraph                                                                                                              |
| C5 | full-stack-starter README "Composing from configuration" and `PUBLIC_API.md:8808-8814` show `createFullStackAppFromConfig` returning the app alone, with no way to read the snapshot afterwards                                                                                                                                       | The snapshot is exposed through an additive accessor (§3.5); the return type is unchanged                                                                | both sections gain the accessor and a post-factory example                                                                                                                  |

## 3. Design decisions

### 3.1 V8-10 — `contextToTraceparent` accepts both producers; the SDK gains a trace interceptor

- **Decision:** two pieces. (a) `common`: `contextToTraceparent` takes a new structural
  `TraceparentSource = { readonly traceId?: string; readonly spanId?: string; readonly traceFlags?: string }`
  (exported as a type). `TelemetryContext` and `SpanContext` are both assignable to it, every
  existing caller compiles unchanged, and the function body is untouched. (b) `sdk`:
  `createTraceContextInterceptor(source: { activeSpanContext?(): SpanContext | undefined }): ClientRequestInterceptor`
  — a structural parameter so an `ITelemetryService` (type-only import) satisfies it without the SDK
  importing the plugin. Per request it calls `source.activeSpanContext?.()`, validates the three
  fields with the same W3C rules as the codec (32/16/2 lowercase hex, non-zero ids) and sets
  `traceparent: 00-<traceId>-<spanId>-<traceFlags>` unless the caller already set one (the
  `createBearerAuthInterceptor` rule). An absent or invalid context sets nothing.
- **Why:** the register's hand-written interceptor was ten lines and type-checked only after a cast;
  the framework should ship it. The SDK cannot import the codec at runtime (type-only pin, §1), so
  the format is written in the SDK with a JSDoc naming the `common` codec as the authority — the
  M98n precedent. The `common` widening is what lets server-side code (and the telemetry plugin's
  own tests) pass an `activeSpanContext()` result to `contextToTraceparent` without a cast, which is
  the `TS2345` the register hit. The result is `SpanContext | undefined` (and the member itself is
  optional on `ITelemetryService`), while `TraceparentSource` deliberately excludes `undefined`, so
  a caller narrows first (`if (active !== undefined) contextToTraceparent(active)`); the widening
  removes the cast, not the check.
- **Test home:** `packages/sdk/test/unit/trace-context-interceptor.test.ts` (unit: valid context →
  header; `undefined`/malformed/all-zero → no header; caller's header wins) and
  `packages/sdk/test/e2e/trace-propagation.test.ts` (new: a real kernel app reads `traceparent` off
  the inbound request through `common`'s `extractContextFromHeaders` — a TEST import, which the
  type-only pin does not scan — and echoes `traceId`/`spanId`; the SDK client with the interceptor
  over a fixed source thunk must produce the same ids). The `common` half is pinned in
  `packages/common/test/unit/trace-context.test.ts` with a case that passes a literal `SpanContext`
  object, and in `packages/telemetry-plugin/test/e2e/trace-continuity-real.test.ts` with one added
  case that reads `service.activeSpanContext()` on the real OTel service, fails the test when it is
  `undefined` (narrowing it), then passes the narrowed `SpanContext` to `contextToTraceparent` and
  asserts the header names the active span. **Negative control:** the telemetry line is a compile
  error (`TS2345`) with the widening reverted — `deno check` is the control; the e2e without the
  interceptor shows the server reading no `traceparent`.

### 3.2 V8-11 — the React Router refusal boundary is documented and pinned, not rerouted

- **Decision:** no bridge change. The documented rule: a React Router DOCUMENT request that a route
  middleware refuses is answered by React Router's own error boundary (HTML, the status the
  middleware threw), because that is React Router's contract for a browser navigation; the kernel's
  error responder (RFC 9457 under `errorHandler({ format: 'rfc9457' })`) governs kernel routes and
  the responder terminals, and the two are different protocols for different callers. The
  recommended shapes for an RR refusal are `throw redirect('/login')` for an anonymous navigation
  (what the scaffold already emits) and a thrown `data(..., 403)` rendered by the route's
  `ErrorBoundary` for a forbidden one; a fetch caller wanting the API shape calls the API member.
  The rule is stated in the react-router README, the `PUBLIC_API.md` React Router section, and the
  scaffold's `require-user.server.ts` header comment, and PINNED by a test so the bridge's verbatim
  copy is a decision rather than an accident.
- **Why:** `respondWithError` needs a full `IResponse` (§1) that React Router middleware never
  holds; a thrown web `Response` from middleware is rendered into the boundary for a document
  request, so a marker header cannot survive to the bridge; and rewriting an HTML `403` body into
  JSON at the bridge would break every application whose boundary IS the intended page. The ROADMAP
  offers documentation as the second arm; it is the only arm that does not fight React Router.
- **Test home:** two layers, because a fake `ServerBuild` can prove the bridge copies a response
  verbatim but cannot exercise React Router's own refusal path. (1) The BRIDGE pin:
  `packages/react-router-plugin/test/integration/react-router-integration.test.ts` gains "the bridge
  keeps an SSR response's status and content type beside an RFC 9457 kernel route": one kernel app
  with `errorHandler({ format: 'rfc9457' })`, a fake `ServerBuild` whose handler answers
  `403 text/html`, and a kernel route throwing a `403` — asserting `text/html` on the SSR path and
  `application/problem+json` on the kernel path in the SAME application. (2) The REFUSAL path, on
  the real React Router runtime: `apps/full-stack` gains a route whose module exports a route
  `middleware` that throws `data(null, { status: 403 })` and an `ErrorBoundary` rendering a marker
  string, and `apps/full-stack/smoke.ts` (the real Vite build `check:apps` already runs in CI)
  requests it as a document and asserts `403`, `text/html`, and the boundary's marker in the body,
  beside a kernel route answering `application/problem+json` in the same app. **Negative controls:**
  a bridge that rewrote the SSR `403` fails (1)'s content-type assertion; deleting the route's
  `ErrorBoundary` makes (2) render the root boundary instead and fails the marker assertion, which
  is what proves the response came from React Router's boundary rather than the kernel responder.
  The CLI comment is asserted by the existing template content test
  (`packages/cli/test/unit/templates/full-stack-app-files.test.ts`, extended with the sentence).

### 3.3 V8-27 — auto-follow redirects are neither error arms nor typed successes

- **Decision:** `getErrorArms` skips the exact statuses Fetch auto-follows (`301`, `302`, `303`,
  `307`, and `308`) alongside `2xx`; other concrete `3xx` responses, including `304`, remain error
  arms. An operation declaring an auto-follow status or the OpenAPI `3XX` range renders its success
  type as `unknown`, even beside a declared `2xx` schema — the body the client receives may be the
  follow target's, which the document does not describe. A generated-file header comment states that
  followed target bodies are not described and are typed as `unknown`.
- **Why:** an arm that can never fire is a lie the type system tells; `void` for a body that is the
  follow target's data is a second lie. `unknown` is the honest type for "something, not described
  here". Typing the follow TARGET was rejected: the document does not name it (a `Location` header
  is a runtime value) and the SDK has no redirect-tracking hook.
- **Test home:** `packages/sdk/test/unit/openapi-codegen.test.ts` (a `303`-only operation emits no
  `Error` union, no guard, and `unknown`; a `200`+`303` operation emits `unknown` and no `303` arm;
  a `304` remains an error arm; a `3XX` range emits `unknown`) and
  `packages/sdk/test/e2e/generated-client.test.ts` (a real kernel route answering `303` with
  `Location` to a `200` JSON route: the generated call resolves `200` with the target's body and the
  guard symbol does not exist). A third committed codegen fixture carrying a `303` operation joins
  the two existing ones so `deno task check` type-checks the emitted shape permanently (the M70m
  X11-9 precedent). **Negative control:** with the skip reverted the fixture gains an `Error303` arm
  and the e2e's absence assertion fails.

### 3.4 V8-28 — `Retry-After` is capped by the retry policy, and past the cap the error surfaces at once

- **Decision:** `ClientOptions.retry` widens from `RetryPolicy` to an SDK-local
  `ClientRetryPolicy = RetryPolicy & { readonly maxRetryAfterMs?: number }` (no `common` change —
  the cap is a CLIENT concern). The effective cap is `maxRetryAfterMs` when supplied, else the
  policy's own largest computed backoff, `delay * 2 ** (limit - 1)` for `'exponential'` and `delay`
  for `'fixed'`. When a parsed `Retry-After` exceeds the cap the request is NOT retried: the
  `HttpClientError` carrying the `429`/`503` is thrown immediately, headers intact, so the caller
  sees the server's hint. A `Retry-After` within the cap replaces the computed backoff as today.
  Every number used by that decision is validated at construction: `limit` must be a positive safe
  integer, `delay` must be finite and non-negative, the largest derived exponential delay must stay
  finite, and `maxRetryAfterMs` (when present) must be finite and non-negative. Runtime strings,
  `NaN`, and infinities throw without echoing the supplied value (the M90a `NaN`-fails-open rule).
- **Why:** sleeping a minute inside a two-attempt policy is the client ignoring its own policy.
  Clamping the sleep DOWN to the cap was rejected: it would retry before the server said to, which
  is the one thing `Retry-After` exists to prevent; surfacing the error lets the caller decide.
  Defaulting the cap to the policy's own maximum needs no new number from the caller.
- **Test home:** `packages/sdk/test/unit/retry-strategy.test.ts` (within-cap sleeps the hint;
  past-cap throws without sleeping, the fake timing records zero sleeps; explicit cap wins; `fixed`
  and `exponential` defaults; `NaN` refused) and
  `packages/sdk/test/integration/client-resilience.test.ts` (a kernel route answering `429`
  `Retry-After: 60` under `retry: { limit: 2, delay: 100, backoff: 'exponential' }` rejects within
  the test's budget). **Negative control:** with the cap removed the integration case's fake clock
  records a 60 000 ms sleep.

### 3.5 V8-29 — the config snapshot is exposed through an additive accessor

- **Decision:** `full-stack-starter` exports `fullStackConfigOf(app: IKernelApplication): IConfig`,
  backed by a module-private `WeakMap` that `createFullStackAppFromConfig` populates with the SAME
  `config` object it passes to `build` and as `config.instance`. An app not built by the factory
  throws a named `FullStackConfigUnavailableError`. The return type of
  `createFullStackAppFromConfig` is unchanged.
- **Why:** returning `{ app, config }` breaks every caller — the CLI template awaits the result as
  the app and M85 appends `app.register(...)` to it. Mutating the kernel `Application` instance with
  a new property was rejected (a kernel object is not the starter's to extend). A `WeakMap` keyed by
  the returned app is the M69 `drizzle-database.ts` / M98e precedent, costs nothing when unused, and
  the accessor is the one place the "same snapshot" guarantee is stated: the object it returns is
  identical (`===`) to the one `build` received and the one `ConfigPlugin` registered.
- **Test home:** `packages/starters/full-stack-starter/test/integration/from-config.test.ts`
  (extended): `fullStackConfigOf(app)` is `===` the `build` argument and `===` the resolved
  `CAPABILITIES.CONFIG` after `start()`; a `createFullStackApp(...)` app throws the named error.
  **Negative control:** a second `loadConfig` in place of the stored snapshot fails the identity
  assertion.

### 3.6 Clock rule

- **Decision:** no `Date.now()` is introduced; the SDK cap compares parsed milliseconds against a
  computed number and sleeps through the injected `IClientTiming`.
- **Test home:** the forbidden-construct grep in §7.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                          | Kind             | Consumer / real code path that READS it                                                                               |
| -------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `TraceparentSource` (`common`)                           | type             | the parameter type of `contextToTraceparent`; named so `PUBLIC_API.md` can state it and a caller can annotate a value |
| `createTraceContextInterceptor` (`sdk`)                  | fn → interceptor | an application's `createClient({ requestInterceptors: [...] })`; run by `http-client.ts:189-193`                      |
| `ClientRetryPolicy` (`sdk`)                              | type             | `ClientOptions.retry`; read by `runWithRetry`                                                                         |
| `fullStackConfigOf` (`full-stack-starter`)               | fn               | post-factory application code (the CLI template's M85 `app.register(...)` site is the canonical caller)               |
| `FullStackConfigUnavailableError` (`full-stack-starter`) | class            | thrown by the accessor; `instanceof` for callers                                                                      |

`react-router-plugin/src/index.ts` and `telemetry-plugin/src/index.ts` are unchanged; each changed
barrel's `barrel-exports.test.ts` is extended (the M56 class), and the SDK's `type-only-common` test
must stay green with the new interceptor module in the graph.

### 4.1 Options — every option names its consumer

| Option                                 | Consumer                        | Behavior (per implementation)                                                                                                         |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ClientRetryPolicy.maxRetryAfterMs`    | `runWithRetry` via `HttpClient` | caps an honoured `Retry-After`; absent → the policy's largest computed backoff; a hint past the cap throws the response error at once |
| `createTraceContextInterceptor.source` | the interceptor, per request    | `activeSpanContext?.()` read at CALL time (the M52b thunk lesson), never captured at construction                                     |

## 5. Implementation files

| File                                                                                                                                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/trace-context.ts`                                                                                                                      | `TraceparentSource`; `contextToTraceparent(source: TraceparentSource)`                                                                                                                                                                                                                                                                                                  |
| `packages/common/src/index.ts`                                                                                                                              | barrel: `TraceparentSource` type                                                                                                                                                                                                                                                                                                                                        |
| `packages/sdk/src/trace/trace-context-interceptor.ts`                                                                                                       | `createTraceContextInterceptor`                                                                                                                                                                                                                                                                                                                                         |
| `packages/sdk/src/http/contracts.ts`                                                                                                                        | `ClientRetryPolicy`; `ClientOptions.retry` retyped                                                                                                                                                                                                                                                                                                                      |
| `packages/sdk/src/http/http-client.ts`                                                                                                                      | passes the validated retry policy to `runWithRetry`                                                                                                                                                                                                                                                                                                                     |
| `packages/sdk/src/sdk.ts`                                                                                                                                   | validates retry count, delay, derived exponential maximum, and `maxRetryAfterMs` at construction                                                                                                                                                                                                                                                                        |
| `packages/sdk/src/retry/retry-strategy.ts`                                                                                                                  | cap computation; past-cap throw                                                                                                                                                                                                                                                                                                                                         |
| `packages/sdk/src/codegen/openapi-codegen.ts`                                                                                                               | auto-follow `3xx` statuses skipped in `getErrorArms`; observable `3xx` retained; `unknown` for any redirect-capable operation; header comment                                                                                                                                                                                                                           |
| `packages/sdk/src/index.ts`                                                                                                                                 | barrel: interceptor + `ClientRetryPolicy`                                                                                                                                                                                                                                                                                                                               |
| `packages/sdk/test/fixtures/redirect-client.ts` (committed generated output)                                                                                | the third codegen fixture, type-checked by `deno task check`                                                                                                                                                                                                                                                                                                            |
| `packages/starters/full-stack-starter/src/from-config.ts`                                                                                                   | `WeakMap` registration; `fullStackConfigOf`; `FullStackConfigUnavailableError`                                                                                                                                                                                                                                                                                          |
| `packages/starters/full-stack-starter/src/index.ts`                                                                                                         | barrel                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/cli/src/templates/full-stack-app-files.ts`                                                                                                        | `require-user.server.ts` header comment (§3.2); no behaviour change                                                                                                                                                                                                                                                                                                     |
| `apps/full-stack/app/routes/…` (one route), `apps/full-stack/smoke.ts`                                                                                      | §3.2 real-runtime refusal pin: a route `middleware` throwing a `403` rendered by its `ErrorBoundary`, asserted through the real build                                                                                                                                                                                                                                   |
| `packages/sdk/README.md`, `packages/react-router-plugin/README.md`, `packages/starters/full-stack-starter/README.md`, `packages/telemetry-plugin/README.md` | the §2 deliverables (telemetry: one sentence pointing at the SDK interceptor from the trace-correlation section)                                                                                                                                                                                                                                                        |
| `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`                                                                                                        | contract notes; `Unreleased` entries (the codegen `3xx` change and the `Retry-After` cap are behaviour changes to generated output and to retry timing, both named); the "regenerate a client that documents a `3xx`" step under the upgrade guide's `## Unreleased` heading — none exists yet, so whichever of M101c/M101d lands first adds it and the other reuses it |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                   | src covered                                                 | Key assertions (and the signature each call type-checks against)                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/trace-context.test.ts` (extended)                                | `trace-context.ts`                                          | a literal `SpanContext` and a `TelemetryContext` both format to the same header; every existing validation case unchanged |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                               | `src/index.ts`                                              | `TraceparentSource` exported (compile-time assignment)                                                                    |
| `packages/telemetry-plugin/test/e2e/trace-continuity-real.test.ts` (one case added)         | none in telemetry; the `common` widening                    | the narrowed `service.activeSpanContext()` passed to `contextToTraceparent` names the active span — the `TS2345` control  |
| `packages/sdk/test/unit/trace-context-interceptor.test.ts` (new)                            | `trace/trace-context-interceptor.ts`                        | §3.1 unit cases; the source is read per call (a source that changes between two requests yields two headers)              |
| `packages/sdk/test/e2e/trace-propagation.test.ts` (new)                                     | `trace/trace-context-interceptor.ts`, `http/http-client.ts` | §3.1 kernel echo; without the interceptor the server reads no header                                                      |
| `packages/sdk/test/unit/retry-strategy.test.ts` (extended)                                  | `retry/retry-strategy.ts`                                   | §3.4 cases against `runWithRetry(fn, policy, method, timing, signal)` with the fake `IClientTiming` recording sleeps      |
| `packages/sdk/test/unit/http-client.test.ts` (extended)                                     | `http/http-client.ts`, `http/contracts.ts`                  | `maxRetryAfterMs: NaN`/`-1` throws at `createClient`; a valid cap reaches the strategy                                    |
| `packages/sdk/test/unit/sdk.test.ts` (extended)                                             | `sdk.ts`                                                    | hostile retry counts/delays and an overflowing exponential maximum throw; valid zero/fractional delays remain accepted    |
| `packages/sdk/test/integration/client-resilience.test.ts` (extended)                        | `retry/retry-strategy.ts`                                   | §3.4 kernel `429 Retry-After: 60` case rejects at once with the `HttpClientError` and its headers                         |
| `packages/sdk/test/unit/openapi-codegen.test.ts` (extended)                                 | `codegen/openapi-codegen.ts`                                | §3.3 shapes; the new fixture is byte-identical to `generateOpenApiClient(doc)` output                                     |
| `packages/sdk/test/e2e/generated-client.test.ts` (extended)                                 | `codegen/openapi-codegen.ts`                                | §3.3 live redirect case                                                                                                   |
| `packages/sdk/test/unit/barrel-exports.test.ts`, `type-only-common.test.ts`                 | `src/index.ts`                                              | new exports present; no runtime edge into `common`                                                                        |
| `packages/react-router-plugin/test/integration/react-router-integration.test.ts` (extended) | `handler/request-bridge.ts`                                 | §3.2 (1) side-by-side shapes through the bridge                                                                           |
| `apps/full-stack/smoke.ts` (extended, run by `check:apps`)                                  | none (example app)                                          | §3.2 (2) route-middleware `403` rendered by React Router's `ErrorBoundary` on the real runtime                            |
| `packages/cli/test/unit/templates/full-stack-app-files.test.ts` (extended)                  | `templates/full-stack-app-files.ts`                         | the boundary sentence is present in the emitted `require-user.server.ts`                                                  |
| `packages/starters/full-stack-starter/test/integration/from-config.test.ts` (extended)      | `from-config.ts`                                            | §3.5 identity assertions; the named error for a non-factory app                                                           |
| `packages/starters/full-stack-starter/test/unit/barrel-exports.test.ts` (extended)          | `src/index.ts`                                              | accessor and error exported                                                                                               |

Per-file bar: `trace-context-interceptor.ts` is new and lands at 100%; `retry-strategy.ts` gains
four branches (cap source, past-cap throw) all driven by the unit file; `openapi-codegen.ts` is
large and sits above 98% today — the two new arms are each driven by a unit case; `from-config.ts`
gains the accessor's two branches.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101d-call-sides-agree, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # README fence counts, export-table drift, upgrade-guide attribution
deno task publish:check     # committed tree
deno task release:verify 0.8.0
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/common/src packages/sdk/src packages/react-router-plugin/src packages/starters/full-stack-starter/src
```

Plus the negative controls, each observed failing and reverted: §3.1 (widening reverted → `TS2345`
in the telemetry e2e; interceptor removed → no header at the server), §3.3 (skip reverted →
`Error303` arm appears in the fixture), §3.4 (cap removed → 60 000 ms sleep recorded), §3.5 (second
load in place of the snapshot → identity fails).

## 8. Risks & mitigations

- Widening `contextToTraceparent`'s parameter is source-compatible for callers; an out-of-repo
  wrapper that re-declares the old signature narrows it and still compiles → no breaking change,
  recorded as `Changed` not `Breaking`.
- The SDK duplicates the W3C format → the interceptor's unit test shares its vectors with `common`'s
  `trace-context.test.ts` so the two cannot drift silently.
- Changing codegen output for redirect-capable and observable `3xx` operations changes
  already-published generated clients → a behaviour change to generated output, CHANGELOG +
  `docs/upgrading.md` ("regenerate") per the M58 precedent; a client that never documented a `3xx`
  is byte-identical (pinned by the two existing fixtures).
- Surfacing a past-cap `429` immediately changes retry timing for callers relying on the sleep →
  named in CHANGELOG as a behaviour change; `maxRetryAfterMs: Infinity` is refused (non-finite), so
  there is no "restore the uncapped sleep" switch — the ROADMAP asked for the cap and the surfaced
  error, not a disable arm.
- The React Router case depends on React Router rendering a thrown `Response` into the boundary →
  the integration test uses a fake `ServerBuild` answering `403 text/html` directly, so it pins the
  BRIDGE, not React Router's internals; the README states React Router's behaviour as React
  Router's.
- Dependencies: none on other letters; M101h must not re-document these shapes.

## 9. Out of scope

- M101h: every doc-only row (V8-30 is M101h's one code change and does not touch these packages).
- M101g: scaffold wiring; this letter edits one comment in one template string and nothing else in
  `packages/cli`.
- Per-attempt interceptor execution, `tracestate` propagation on the SDK side, and a
  `redirect:
  'manual'` option on `ClientOptions` — each a new SDK capability, not a disagreement
  between two shipped halves.
- Problem Details for React Router document navigations (declined, §3.2).

## 10. Design security review

> Corrective review completed during the security-finding fix pass, before the final fix commit and
> independent re-audit. The first committed-tree audit identified the missing review as S101D-2;
> this section records the threat model the re-audit must test rather than treating functional tests
> as security evidence.

### 10.1 Reviewed trust-boundary flows

1. An in-process telemetry provider returns span identity fields; the SDK validates and minimizes
   them into one outbound `traceparent` header that a remote dependency and intermediaries read.
2. A remote dependency controls the response status and `Retry-After`; the SDK parses only decimal
   delta-seconds and compares the result with a cap derived from trusted-but-fallible deployment
   configuration. A within-cap hint sleeps through `IClientTiming`; an over-cap hint surfaces the
   original error.
3. A build-time OpenAPI supplier controls response keys and schemas; codegen turns those records
   into TypeScript consumed by application developers, so hostile keys must not become executable
   source and redirect typing must not promise an unverified body shape.
4. A browser drives a React Router document request; route middleware refusals cross into the
   route-owned HTML error boundary, while API requests remain in the kernel Problem Details path.
5. Deployment configuration is loaded once and retained in a module-private `WeakMap`; only
   in-process code already holding the exact application object can recover that same snapshot.

### 10.2 Assets and attackers

| Asset                                               | Attacker / failure source                                                                    | Required property                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Client-process availability                         | malicious or overloaded remote dependency; malformed environment-derived retry configuration | no remote header may create a sleep above a finite validated cap; invalid policy values fail at construction                           |
| Outbound header integrity                           | buggy or hostile in-process telemetry provider; application-supplied header                  | malformed span data emits nothing; an existing caller header is never overwritten                                                      |
| Generated-client type integrity                     | untrusted or compromised build-time OpenAPI document                                         | only exact supported statuses affect arms; hostile record keys inject no source; redirect-capable results remain `unknown`             |
| Refusal confidentiality and protocol shape          | unauthenticated browser requester                                                            | the static route boundary reveals no internal error or config; API refusal semantics are not silently rewritten                        |
| Configuration snapshot confidentiality and identity | unrelated in-process code without the factory-created app reference                          | no network output or global registry is added; foreign apps fail closed; the returned snapshot is identity-equal to the registered one |

Trusted application code may deliberately choose a large finite retry delay or explicit cap. It is
not treated as a remote attacker, but deployment parsing is fallible: runtime strings, `NaN`, and
infinities are therefore hostile inputs even though the TypeScript surface names numbers.

### 10.3 Approved budgets and invariants

- A generated `traceparent` is exactly 55 ASCII characters and contains only lowercase hexadecimal
  W3C identity fields; CR, LF, NUL, wrong lengths, invalid hex, and all-zero ids produce no header.
- `retry.limit` is a positive safe integer; `retry.delay` and `maxRetryAfterMs` are finite and
  non-negative; an exponential policy is accepted only when `delay * 2 ** (limit - 1)` is finite.
- A decimal `Retry-After` at or below the effective cap may allocate one sleep for the current
  retry; a malformed or over-cap value allocates no server-directed sleep. One thousand over-cap
  refusals must leave no timer/state that prevents a following legitimate call.
- Retry parsing is anchored and linear. A one-million-digit header must be refused without a sleep;
  Fetch/runtime header-size enforcement remains the pre-materialization wire bound.
- M101d adds no request-keyed collection. The configuration map holds at most one entry per
  factory-created application and permits garbage collection through weak keys.
- Generated source contains no OpenAPI descriptions or response-key text, and own keys named
  `__proto__`, `constructor`, or `prototype` create no emitted declaration.

### 10.4 Design findings and resolutions

| ID      | Threat                                                                                                                | Resolution required in the committed implementation                                                               | Audit evidence required                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D101D-1 | `NaN`, infinity, a fraction/string count, or exponential overflow disables the default cap or adds a post-final sleep | validate count, delay, derived maximum, and explicit cap in `createClient`; fixed messages echo no supplied value | drive hostile numeric cases plus a valid zero/fractional delay; `Retry-After: 86400` cannot schedule after invalid construction |
| D101D-2 | dependency chooses an excessive or JavaScript-specific delay spelling                                                 | accept decimal digits only and surface the original error above the finite cap                                    | valid decimal positive control; `1e3`, `+3`, `0x10`, fraction, date, empty, and a huge digit string                             |
| D101D-3 | hostile span values inject or crash header construction                                                               | validate exact W3C fields before `Headers.set`, reject zero ids, preserve an existing header                      | valid header plus CR/LF/NUL/invalid/oversize/all-zero and caller-owned-header cases                                             |
| D101D-4 | repeated refusals retain timers or retry state                                                                        | over-cap response throws before sleep and all state stays call-local                                              | 1,000 refusals, zero sleeps, then one successful call                                                                           |
| D101D-5 | OpenAPI redirect/record input creates lying or injected generated code                                                | exact-code parsing, fixed redirect allowlist, range-to-`unknown`, and no interpolation of hostile keys            | 303 omitted, 304 retained, mixed/range returns `unknown`, hostile-key canaries absent                                           |
| D101D-6 | config accessor leaks or returns a different snapshot                                                                 | module-private weak association keyed by exact app; foreign app throws named error                                | identity positive control and foreign-app refusal                                                                               |

### 10.5 Independent implementation-audit obligations

The committed-tree auditor must run every evidence item in §10.4 with a legitimate positive control,
sweep all fifteen recurring repository threat classes, and temporarily remove each new security
control to prove the matching probe fails before restoring a clean tree. The audit must use an
emptied environment and only repository-scoped read/write permissions; no remote target or real
credential is authorized. Any code change after the audit invalidates its revision and requires the
fix-range re-audit procedure.
