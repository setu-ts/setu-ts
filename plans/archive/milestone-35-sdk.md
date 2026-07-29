# Milestone 35 — SDK (`@hono-enterprise/sdk`)

> **Status:** Planning. Branch: `feat/m35-sdk`. `main` is protected — the implementation and all
> review fixes remain on this branch until a single PR merges it.

## 0. Objective & scope

Turn the M0 SDK stub into a portable, zero-npm-dependency client library for applications that
consume a Hono Enterprise API. The package owns an injectable web-`fetch` HTTP client, bearer-token
and API-key request interceptors, per-origin retry/circuit-breaker/rate-limit protection, and a pure
generator that turns the OpenAPI 3.1 subset emitted by M21 into type-checked TypeScript client
source. It does not register a plugin, resolve capabilities, create a server, fetch a specification,
or write files.

- **In scope:** the `IHttpClient` request contract and `createClient()` factory; JSON request and
  response handling; request/response interceptor pipeline; bearer-token and API-key factories;
  retry with fixed/exponential backoff, honoring a delta-seconds `Retry-After`; a per-origin circuit
  breaker; a per-origin sliding-window rate limiter; a default web-standard timing adapter; pure
  OpenAPI-to-TypeScript generation; package README and public-API documentation.
- **NOT this milestone:**
  - A framework plugin, capability token, service-registry integration, or any dependency on a
    running Hono Enterprise application. The SDK is an external-consumer library.
  - Uploads, multipart/form-data, streaming request bodies, WebSocket clients, cookie jars, and
    response streaming. M35 intentionally supports JSON APIs, the only media type M21 emits for
    request and response schemas.
  - Response interceptors that observe failures. Interceptors run only after a successful parse
    (§3.3); error handling is the caller's `try`/`catch` around `request()`. An error-observing
    interceptor hook is deliberately deferred rather than accidentally omitted.
  - The HTTP-date form of `Retry-After`. Honoring it requires a wall clock, which §3.5 deliberately
    denies the SDK; only the delta-seconds form is read (§3.4).
  - Fetching an OpenAPI URL, selecting an output directory, formatting generated files, and writing
    generated source. Those are application or CLI concerns; M34's CLI owns command execution and
    filesystem writes.
  - OpenAPI features M21 does not emit: callbacks, links, discriminators, security-scheme execution,
    parameter serialization styles beyond repeated query keys, and non-JSON media types.
  - Sharing breaker or rate-limit state across browser tabs, processes, or SDK instances. That would
    require a distributed coordination port and is not part of a client library.

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                                                                            | Verified surface / fact                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK's current surface                 | `packages/sdk/src/index.ts:1-10`                                                                                              | The package is an M0 stub containing only `export {}`; it has no committed SDK API to preserve.                                                                                                                                                                |
| SDK package manifest                  | `packages/sdk/deno.json:1-6`                                                                                                  | Named `@hono-enterprise/sdk`, versioned `0.1.0-alpha.2`, exports only `./src/index.ts`, and has NO `imports` map yet.                                                                                                                                          |
| Prerelease import-range convention    | `packages/cli/deno.json:9-10`; `packages/openapi-plugin/deno.json:10-11`                                                      | In-repo JSR imports are pinned `jsr:@hono-enterprise/<pkg>@^0.1.0-alpha.2`. A bare `^0.1.0` range does NOT match a prerelease, and `deno publish` does not warn.                                                                                               |
| SDK roadmap scope                     | `ROADMAP.md:3556-3595`                                                                                                        | M35 explicitly owns HTTP client, JWT/API-key authentication, retry, circuit breaker, rate limiting, interceptors, OpenAPI generation, and full coverage.                                                                                                       |
| SDK roadmap progress row              | `ROADMAP.md:4426`                                                                                                             | The M35 row is `⬜` and must be flipped to `✅` in this milestone's own PR.                                                                                                                                                                                    |
| Architecture boundary                 | `ARCHITECTURE.md:1441-1450`                                                                                                   | The SDK is for external consumers, must work in browsers and servers, and names custom interceptors as its extension point.                                                                                                                                    |
| Dependency graph claim                | `ROADMAP.md:386`; `ARCHITECTURE.md:1447`                                                                                      | Both documents say `sdk` depends on `common, kernel`. M35 needs no kernel surface.                                                                                                                                                                             |
| Committed-contract rule               | `CLAUDE.md` step 5 ("Starting a new milestone")                                                                               | A committed contract is implemented exactly and never redefined, widened, or re-declared. This is why M35 consumes `common`'s policy types rather than cloning them locally (§3.1).                                                                            |
| Shared retry policy                   | `packages/common/src/services/resilience.ts:54,81-88`                                                                         | `RetryPolicy` has exactly `limit`, `delay`, `backoff`; `limit` is total attempts, not retries. `BackoffStrategy` is `fixed` or `exponential`.                                                                                                                  |
| Shared breaker policy                 | `packages/common/src/services/resilience.ts:17,61-70`                                                                         | `CircuitBreakerPolicy` uses `threshold`, rolling failure-window `timeout`, and `resetTimeout`; `CircuitState` is `closed`, `open`, `half-open`.                                                                                                                |
| Existing resilience semantics         | `packages/resilience-plugin/src/patterns/retry.ts:19-60`; `packages/resilience-plugin/src/patterns/circuit-breaker.ts:18-120` | Exponential delay is `delay * 2^(attempt - 1)`; the breaker has a rolling window, one half-open probe, and fails fast while open. M35 reimplements these private mechanisms because the SDK must not depend on a server plugin.                                |
| Barrel-name collision — breaker error | `packages/resilience-plugin/src/errors.ts:36-47`; `packages/resilience-plugin/src/index.ts:23`                                | `CircuitOpenError` is ALREADY an exported runtime class. A second class of that name in the SDK would clash in a consumer's import list and make cross-package `instanceof` silently false. Hence `ClientCircuitOpenError` (§4).                               |
| Barrel-name collision — OpenAPI types | `packages/openapi-plugin/src/index.ts:21-28`                                                                                  | `OpenApiDocument`, `OpenApiOperation`, `OpenApiParameter`, `OpenApiRequestBody`, `OpenApiResponse` are ALREADY exported types. M35's structural copies are intentionally different in shape, so they take the `SdkOpenApi*` prefix (§3.6).                     |
| Distinct-naming precedent             | `packages/common/src/services/resilience.ts:43-54,73-81`                                                                      | The repo's stated convention for this exact hazard: "Named distinctly from the scheduler's `SchedulerBackoff` / `RetryOptions` to avoid a barrel collision."                                                                                                   |
| Fetch injection precedent             | `packages/notification-plugin/src/http/default-http.ts:16-33`                                                                 | A narrow, injectable HTTP port whose DEFAULT delegates to web-standard `fetch` is the established seam. M35 applies the same default-plus-injection shape to timing (§3.5).                                                                                    |
| M21 document shape                    | `packages/openapi-plugin/src/generators/openapi-generator.ts:11-112,193-245`                                                  | M21 emits OpenAPI `3.1.0`, `paths`, optional component schemas, JSON-only request bodies and JSON response content.                                                                                                                                            |
| M21 operationId charset               | `packages/openapi-plugin/src/generators/openapi-generator.ts:253-256,268,305-309`                                             | `#generateOperationId` is called with the CONVERTED template, so `/users/:id` yields `get-users-{id}`. IDs carry braces and every other character legal in a path segment — not only hyphens. Two distinct paths can also slug to ONE id (`/a-b/c`, `/a/b-c`). |
| M21 operationId is always present     | `packages/openapi-plugin/src/generators/openapi-generator.ts:49,268`                                                          | `operationId` is a required, always-emitted field. A "missing operationId" diagnostic is only reachable if M35's own input type marks it optional (§3.6).                                                                                                      |
| M21 parameter locations               | `packages/openapi-plugin/src/generators/openapi-generator.ts:73,318-380`                                                      | `in` is typed `'path' \| 'query' \| 'header' \| 'cookie'`; the generator itself emits only the first three. The `cookie` arm must survive into M35's input type or the unsupported-location diagnostic is dead code.                                           |
| M21 schema subset                     | `packages/openapi-plugin/src/transformers/zod-to-openapi.ts:12-53,89-127`                                                     | Output schemas may contain primitives, arrays, objects, `required`, `additionalProperties`, `enum`, `const`, `anyOf`, `allOf`, and component `$ref`. Unknown Zod values degrade to an empty schema.                                                            |
| M21 emits `null` and `integer`        | `packages/openapi-plugin/src/transformers/zod-to-openapi.ts:14,96,268-276`                                                    | `type` includes `'null'` and `'integer'`; `ZodBigInt` yields `integer` and `ZodNullable` yields `anyOf: [inner, { type: 'null' }]`. Both must be mapped (§3.6).                                                                                                |
| M21 `additionalProperties` is a union | `packages/openapi-plugin/src/transformers/zod-to-openapi.ts:24`                                                               | Typed `boolean \| OpenApiSchemaObject`. The boolean arm needs a stated mapping, not just the map-value arm.                                                                                                                                                    |
| Release allow-list and its JSDoc      | `scripts/release-packages.ts:64-78`                                                                                           | `packages/sdk` sits in `UNPUBLISHED_PACKAGES`, documented as "Milestone 0 stubs whose `src/index.ts` is `export {}`" — false once M35 lands.                                                                                                                   |
| Release verifier's blind spot         | `scripts/verify-release.ts:22,127-142`                                                                                        | Check 4 proves no PUBLISHED package is a stub. There is NO reverse check, so leaving a real package in `UNPUBLISHED_PACKAGES` passes green. This must be fixed by hand (C5).                                                                                   |
| `deno doc --lint` is not a repo gate  | `deno doc --lint packages/resilience-plugin/src/index.ts` → 7 errors                                                          | A complete, merged milestone fails it (undocumented constructors). It is NOT one of CLAUDE.md's four gates and is therefore excluded from §7.                                                                                                                  |
| Type-only `src` files clear the bar   | `packages/resilience-plugin/src/interfaces/index.ts`; `packages/notification-plugin/src/interfaces/index.ts`                  | Shipped packages already carry `src` files with zero runtime statements, so `contracts.ts` and `openapi-types.ts` do not endanger the per-file coverage bar.                                                                                                   |
| Public-API and JSDoc requirements     | `AI_GUIDELINES.md:85` (§1.6), `:414` (§7.2), `:444` (§7.3), `:564` (§10.1), `:596` (§10.5)                                    | Every barrel export needs JSDoc and an entry in `PUBLIC_API.md`; §1.6 requires public factories to return interfaces rather than concrete classes.                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                                                                                                                                           | Doc deliverable (same PR)                                                                                                                                                                                                               |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:386` and `ARCHITECTURE.md:1447` require `common, kernel`, while the SDK's documented browser/server external-consumer boundary has no reason to import kernel.                                                                           | The SDK's only in-repo import is type-level, from `@hono-enterprise/common`, pinned `jsr:@hono-enterprise/common@^0.1.0-alpha.2`. It imports neither `kernel` nor any plugin and adds no npm dependency. `verbatim-module-syntax` keeps the emitted JavaScript free of any import. | Correct both dependency-graph rows and the SDK architecture table to say `common` only; explain that it is not a plugin or capability consumer.                                                                                         |
| C2 | `ARCHITECTURE.md:1448` calls `HttpClient` public API, while `AI_GUIDELINES.md:85` (§1.6) requires public factories to expose interfaces instead of implementation classes.                                                                           | Export `IHttpClient` and `createClient()`. Keep the stateful `HttpClient` class internal to `src/http/http-client.ts`; callers receive the interface.                                                                                                                              | Replace the architecture public-API cell with `IHttpClient`, `createClient()`, interceptor factories, and `generateOpenApiClient()`. Add the full API reference to `PUBLIC_API.md`.                                                     |
| C3 | `ROADMAP.md:3562-3581` promises rate limiting and interceptor behavior, but its implementation-file and test lists omit their modules and test homes.                                                                                                | Keep the advertised functionality and make its source/test ownership explicit.                                                                                                                                                                                                     | Expand the M35 implementation-file and test lists in `ROADMAP.md` to match §5 and §6 of this plan.                                                                                                                                      |
| C4 | `README.md:168,319,320,383,386,394` calls the SDK a stub, calls the CLI a stub (already false since M34), and says M34 is next.                                                                                                                      | Mark SDK as implemented, correct the stale CLI stub line, and make M35 the completed tooling item; leave later milestones unclaimed.                                                                                                                                               | Update the SDK and CLI status rows and the next-milestone wording at all six lines in `README.md`; add `packages/sdk/README.md`.                                                                                                        |
| C5 | `scripts/release-packages.ts:64-78` lists `packages/sdk` under `UNPUBLISHED_PACKAGES` with JSDoc asserting those entries are `export {}` stubs. `scripts/verify-release.ts` has no reverse check, so the stale entry and its false JSDoc stay green. | Move `packages/sdk` into `PUBLISHED_PACKAGES` in Tier 3 (depends on `common` only, published after it) in THIS PR, and narrow the `UNPUBLISHED_PACKAGES` JSDoc to the three starters.                                                                                              | Edit `scripts/release-packages.ts` (both lists and the JSDoc). Note in the PR body that the next release must run `release:create-packages` and `release:link-repos` before the first sdk publish — tokenless OIDC needs the repo link. |
| C6 | `CLAUDE.md`'s "Current status" section still lists M35 as the next milestone, and this plan sits at `plans/` root.                                                                                                                                   | Both are milestone-completion obligations that ship in this PR, not afterwards.                                                                                                                                                                                                    | Flip the `CLAUDE.md` status entry to complete, point "Next milestone" at M36, and `git mv plans/milestone-35-sdk.md plans/archive/`.                                                                                                    |

## 3. Design decisions

### 3.1 Package boundary and dependencies

- **Decision:** `@hono-enterprise/sdk` is a standalone web-platform library. Its only package import
  is type-only `RetryPolicy`, `CircuitBreakerPolicy`, and `BackoffStrategy` from
  `@hono-enterprise/common`, pinned `jsr:@hono-enterprise/common@^0.1.0-alpha.2`. It has no
  dependency on `kernel`, `runtime`, or any plugin and adds no npm dependency. All three types are
  **re-exported from the SDK barrel** so a consumer configuring `retry` or `circuitBreaker` can name
  their types without adding `@hono-enterprise/common` to their own manifest.
- **Why:** An SDK consumer should not construct an application or receive server capabilities merely
  to invoke an HTTP API. Cloning the two policy shapes locally was rejected: `CLAUDE.md` step 5
  forbids re-declaring a committed contract, and a near-duplicate would let the client's meaning of
  `limit` drift from the server's. Re-export is identity, so no new symbol and no collision.
- **Test home:** `test/unit/sdk.test.ts` verifies the default client with an injected fetch
  function; `test/unit/barrel-exports.test.ts` verifies no internal implementation is exported and
  that the three re-exported policy types resolve.

### 3.2 Public client contract and JSON boundary

- **Decision:** `createClient(options)` returns `IHttpClient`, whose one generic method is
  `request<TResponse, TBody = never>(request: ClientRequest<TBody>): Promise<ClientResponse<TResponse>>`.
  `ClientRequest` carries a method, relative path, query values, headers, optional JSON body, and
  `AbortSignal`; `ClientResponse` carries status, headers, and typed data. The factory requires a
  base URL and accepts default headers, a fetch seam, timing seam, resilience policies, rate-limit
  policy, and interceptor arrays. These pure data shapes are `type` aliases; `IHttpClient` and
  `IClientTiming` are the two public behavioral ports. The client serializes only the `json` field,
  sets `content-type: application/json` only when it serializes one, and parses successful JSON or
  `+json` responses; a successful empty response yields `undefined` as `TResponse`.
- **Why:** M21 emits JSON bodies only, so this avoids accepting non-repeatable stream bodies that
  cannot be retried safely. A single request method is small, expressive, and the common target for
  generated operations without dead convenience-method surface.
- **Test home:** `test/unit/http-client.test.ts` covers URL/query construction, header precedence,
  JSON serialization/parsing, empty success, absolute-path rejection, abort propagation, and invalid
  JSON rejection; `test/e2e/generated-client.test.ts` invokes the same method through generated
  code.

### 3.3 Interceptors and authentication

- **Decision:** A request interceptor receives a mutable `ClientRequestContext` containing the
  resolved `URL` and `Headers`; request interceptors execute once in registration order before an
  outbound attempt sequence. A response interceptor receives a successful `ClientResponse<T>` and
  its immutable request description; response interceptors execute in registration order after JSON
  parsing, and are **skipped entirely** when the request throws `HttpClientError`,
  `ClientCircuitOpenError`, an abort, or a transport rejection — errors reach the caller's
  `try`/`catch`, never an interceptor. `createBearerAuthInterceptor(token)` and
  `createApiKeyAuthInterceptor(key, headerName)` are request-interceptor factories; each accepts a
  literal or an async value provider and sets its header only when the request has not already
  supplied that header.
- **Why:** The request context supports the extension point without exposing client state. Running
  interceptors once avoids repeating application side effects for retry attempts. Caller-supplied
  credentials intentionally win, permitting endpoint-specific authentication while keeping the
  configured credential as the normal default. Skipping failures keeps the response-interceptor
  signature total (`ClientResponse<T>` in, `ClientResponse<T>` out) instead of forcing every
  interceptor to narrow a success/error union; the error-observing variant is listed out of scope in
  §0 so its absence is a decision rather than an omission.
- **Test home:** `test/unit/auth-interceptor.test.ts` covers literal and async credentials, default
  and custom API-key headers, supplied-header precedence, and provider rejection;
  `test/unit/http-client.test.ts` covers request/response ordering and confirms failed HTTP
  responses skip response interceptors.

### 3.4 Retry, failures, and circuit breaking

- **Decision:** The client wraps each logical request as **circuit breaker → retry loop → rate-limit
  wait → fetch**. The retry loop is enabled only by an explicit `RetryPolicy` and retries transport
  rejections plus statuses `408`, `425`, `429`, and `500` through `599`; it retries `GET`, `HEAD`,
  `OPTIONS`, `PUT`, and `DELETE` only. It never automatically retries `POST`, `PATCH`, or an aborted
  request. When a retryable response carries a `Retry-After` header whose value parses as
  **delta-seconds**, that delay replaces the computed backoff for that attempt; a `Retry-After` in
  HTTP-date form is ignored (§0) and the computed backoff applies. Retry waits are not otherwise
  capped — every wait is abort-aware, so a caller bounds a hostile `Retry-After` with
  `ClientRequest.signal`.
- **Breaker failure predicate (the mechanism, not just the outcome):** because the breaker is the
  OUTERMOST layer, it would count every inner throw by default. It therefore takes an explicit
  `isFailure: (error: unknown) => boolean` predicate at construction. The client supplies a
  predicate that returns `false` for `HttpClientError` (a non-retryable non-2xx, that is, a
  user/input error) and for an abort, and `true` for everything else — an exhausted retry sequence,
  a transport rejection, or a retryable status that never recovered. An exhausted transient sequence
  therefore records exactly ONE failure for that origin, not one per attempt. An open circuit throws
  exported `ClientCircuitOpenError` before consuming a rate-limit slot. Breaker instances are keyed
  by URL origin, have a rolling failure window, and allow one half-open probe.
- **Why:** Retrying unsafe writes can duplicate side effects. Counting an exhausted transient
  sequence once prevents a single request with several attempts from immediately opening a circuit,
  and separating user/input errors from dependency failures prevents 4xx traffic from taking an API
  origin offline. Making the predicate an explicit constructor parameter — rather than teaching the
  breaker about HTTP — keeps the breaker a pure state machine and puts the classification in one
  testable place.
- **Test home:** `test/unit/retry-strategy.test.ts` covers fixed/exponential schedules,
  total-attempt count, status classification, safe-method gate, delta-seconds `Retry-After`
  override, ignored HTTP-date `Retry-After`, and final propagation;
  `test/unit/circuit-breaker.test.ts` covers rolling-window, open, half-open-success,
  half-open-failure, single-probe behavior, and both arms of the injected `isFailure` predicate;
  `test/integration/client-resilience.test.ts` verifies the composed order, the
  one-failure-per-exhausted-sequence rule, that an `HttpClientError` leaves the breaker closed, and
  per-origin isolation.

### 3.5 Rate limiting and deterministic time

- **Decision:** `ClientRateLimitPolicy` is an optional `{ maxRequests, windowMs }` sliding-window
  limiter. It is keyed by origin and applied to every fetch attempt immediately before `fetch`; once
  the window is full, the client waits until the oldest retained timestamp expires. `IClientTiming`
  exposes `now()` and abort-aware `sleep(ms, signal?)`. `ClientOptions.timing` is **optional** and
  defaults to the exported `createDefaultClientTiming()`, which implements `now()` with
  `performance.now()` and `sleep()` with `setTimeout` plus an `abort` listener. Tests inject a
  deterministic implementation instead. `createClient()` validates policy values themselves
  (`retry.limit >= 1`, `rateLimit.maxRequests >= 1`, `rateLimit.windowMs > 0`, breaker
  `threshold >= 1`) and throws at construction on an invalid one. A caller aborting while queued
  rejects with the abort reason and does not consume a slot.
- **Why:** Rate limiting belongs beside the client instance that creates load, not in a global. A
  narrow timing port makes backoff, breaker windows, and rate-limit waits testable without real
  time. Requiring the caller to supply one was rejected: it makes the common case (configure retry,
  get retry) hostile, and the repo's established shape is a default-plus-injection seam
  (`createDefaultNotificationHttp(fetchImpl = fetch)`). `performance.now()` is monotonic and
  web-standard, which is exactly what the breaker window and rate-limit window need; it also keeps
  `Date.now()` out of the package entirely, so the SDK never mixes clocks and never reaches for a
  runtime-specific API.
- **Test home:** `test/unit/rate-limiter.test.ts` covers immediate admission, boundary expiry,
  per-origin windows, queued delay, and abort; `test/unit/timing.test.ts` covers
  `createDefaultClientTiming()` — monotonic non-decreasing `now()`, a `sleep(0)` that resolves, a
  `sleep` rejecting with the abort reason when its signal aborts mid-wait, and a `sleep` given an
  already-aborted signal; `test/unit/sdk.test.ts` covers policy validation, the injected-timing
  path, and the defaulted-timing path.

### 3.6 OpenAPI generation contract

- **Decision:** `generateOpenApiClient(document, options?)` is a pure function returning a
  TypeScript source string. It accepts the M21-compatible structural `SdkOpenApiDocument` defined
  locally in `src/codegen/openapi-types.ts`; it does not import the openapi plugin. The
  `SdkOpenApi*` prefix is mandatory, not stylistic: `OpenApiDocument`, `OpenApiOperation`,
  `OpenApiParameter`, `OpenApiRequestBody`, and `OpenApiResponse` are already exported types on the
  openapi-plugin barrel with different shapes (§1), and the repo's convention for that hazard is a
  distinct name. The `Client*` prefix stays reserved for runtime client shapes.
- **The local types are deliberately WIDER than M21's emitted output**, so every §3.7 diagnostic is
  reachable and coverable rather than dead code: `operationId` is optional (M21 always emits one),
  and `SdkOpenApiParameter.in` keeps the `cookie` arm (M21's type has it; its generator never emits
  it). A generator whose error branches cannot be reached would silently fail the per-file branch
  bar.
- The generator emits component types, operation argument types, response types, and a
  `createApi(client: IHttpClient)` factory. Schema mapping is total over the M21 vocabulary: `$ref`
  → the named component type; `type` `string`/`number`/`boolean` → the matching primitive; `integer`
  → `number`; `null` → `null`; `array` → `items[]`; `object` → properties with `required` driving
  optionality; `additionalProperties` as a schema → `Record<string, T>`, as `true` →
  `Record<string, unknown>`, as `false` → the object's declared properties only; `enum` → a union of
  its literals; `const` → that single literal; `anyOf` → a union (so a nullable `anyOf: [T, null]`
  renders `T | null`); `allOf` → an intersection; an empty schema → `unknown`. Each generated
  operation substitutes and percent-encodes path values, passes repeated query values to the client,
  preserves headers, forwards JSON bodies, and returns the union of documented successful JSON
  response types plus `void` for documented successful responses without JSON.
- **Why:** This is exactly the documented output vocabulary of M21, makes codegen usable without
  bringing a server plugin to browser bundles, and avoids promising full OpenAPI support that the
  upstream generator itself does not produce.
- **Test home:** `test/unit/openapi-codegen.test.ts` covers every supported schema form including
  `null`, `integer`, and all three `additionalProperties` arms, plus parameters, JSON
  request/response types, no-content success, `$ref`, safe source escaping, and output determinism;
  `test/e2e/generated-client.test.ts` imports a checked generated fixture and performs a typed
  request through a fake `IHttpClient`.

### 3.7 Code-generation failures and names

- **Decision:** Code generation throws exported `OpenApiCodegenError` with the path/method or
  component name when it sees a malformed local component reference, a duplicate generated operation
  name, an absent `operationId`, a parameter whose location is not path/query/header, a JSON request
  body outside the M21 shape, or a schema cycle that cannot be represented without a named
  component.
- **Identifier derivation:** M21 operation IDs are NOT merely hyphenated. `#generateOperationId`
  receives the already-converted OpenAPI template, so `/users/:id` becomes `get-users-{id}` — braces
  and every other character legal in a path segment reach the ID, and the parameterized case is the
  common one. Derivation is therefore full sanitization, not a hyphen-to-camel pass: split the ID on
  every run of characters outside `[A-Za-z0-9]`, lower-camel-join the parts, drop a leading digit
  run into a `n`-prefixed form, and fall back to `operation` when nothing survives. The original
  operation ID is retained in a JSDoc comment on the generated method and in collision diagnostics.
- **Duplicate names have two distinct sources, and both throw:** M21 itself can emit ONE id for two
  paths (`/a-b/c` and `/a/b-c` both slug to `get-a-b-c`), and sanitization can collapse two distinct
  ids onto one identifier (`get-users-{id}` and `get-users-id`). The generator detects duplicates
  after derivation and reports both original ids plus their path/method, so the diagnostic is
  actionable regardless of which source produced it.
- **Why:** Hyphen-only handling would emit a syntax error for the majority of real specs. Failing
  with source location is safer than emitting an apparently valid client whose public API has
  silently collided or whose request cannot be serialized as specified.
- **Test home:** `test/unit/openapi-codegen.test.ts` covers each error with diagnostic text, both
  duplicate sources, brace-bearing and hostile path/component names, digit-leading ids, an id that
  sanitizes to nothing, and the `cookie` parameter location; `test/fixtures/generated-client.ts` is
  the reviewed, compile-checked deterministic output fixture.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                                                       | Kind              | Consumer / real code path that READS it                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `createClient`                                                                                                                        | factory function  | Application code creates an `IHttpClient`; generated `createApi()` accepts this returned client.                     |
| `IHttpClient`                                                                                                                         | interface         | Application code and generated source call `request<TResponse, TBody>()`; tests use a fake implementation.           |
| `ClientOptions`                                                                                                                       | options interface | `createClient()` reads every field to create the fetch/timing/policy/interceptor pipeline.                           |
| `ClientRequest`                                                                                                                       | type              | `IHttpClient.request()` and generated operation methods use it to describe an outbound JSON request.                 |
| `ClientResponse`                                                                                                                      | type              | `IHttpClient.request()` resolves it and response interceptors read/return it.                                        |
| `ClientRequestContext`                                                                                                                | type              | Custom request interceptors and auth factories read/mutate its URL and headers.                                      |
| `ClientRequestInterceptor`                                                                                                            | function type     | `ClientOptions.requestInterceptors` invokes each interceptor before resilient execution.                             |
| `ClientResponseInterceptor`                                                                                                           | function type     | `ClientOptions.responseInterceptors` invokes each interceptor after successful parsing.                              |
| `IClientTiming`                                                                                                                       | interface         | `ClientOptions.timing` drives retry and rate-limit waits plus breaker timestamps.                                    |
| `createDefaultClientTiming`                                                                                                           | factory function  | `createClient()` calls it when `ClientOptions.timing` is omitted; consumers call it to wrap or decorate the default. |
| `ClientRateLimitPolicy`                                                                                                               | type              | `ClientOptions.rateLimit` creates each origin limiter.                                                               |
| `RetryPolicy`, `CircuitBreakerPolicy`, `BackoffStrategy`                                                                              | re-exported types | Consumers name the types of `ClientOptions.retry` and `ClientOptions.circuitBreaker` without importing `common`.     |
| `createBearerAuthInterceptor`                                                                                                         | factory function  | Consumers place its returned interceptor in `ClientOptions.requestInterceptors`.                                     |
| `createApiKeyAuthInterceptor`                                                                                                         | factory function  | Consumers place its returned interceptor in `ClientOptions.requestInterceptors`.                                     |
| `HttpClientError`                                                                                                                     | error class       | Consumers catch failed non-2xx responses and inspect status, headers, and parsed body.                               |
| `ClientCircuitOpenError`                                                                                                              | error class       | Consumers catch the client's fail-fast circuit state; named distinctly from resilience-plugin's `CircuitOpenError`.  |
| `OpenApiCodegenError`                                                                                                                 | error class       | Build tooling catches and reports actionable invalid-spec diagnostics.                                               |
| `generateOpenApiClient`                                                                                                               | pure function     | Application build tooling turns an M21 OpenAPI JSON document into a typed source file.                               |
| `SdkOpenApiDocument`                                                                                                                  | type              | Build tooling types the document passed into `generateOpenApiClient`.                                                |
| `SdkOpenApiPathItem`, `SdkOpenApiOperation`, `SdkOpenApiParameter`, `SdkOpenApiRequestBody`, `SdkOpenApiResponse`, `SdkOpenApiSchema` | types             | The nested fields of `SdkOpenApiDocument` type the M21-compatible source document.                                   |
| `OpenApiCodegenOptions`                                                                                                               | options interface | `generateOpenApiClient()` reads its output export name and SDK import specifier.                                     |

### 4.1 Options — every option names its consumer

| Option                               | Consumer                             | Behavior (per implementation)                                                                                              |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `ClientOptions.baseUrl`              | `HttpClient` URL resolver            | Required base for every relative `ClientRequest.path`; absolute paths are rejected to prevent bypassing per-origin policy. |
| `ClientOptions.headers`              | `HttpClient` request builder         | Cloned into each request before request-specific headers and interceptors; request-specific values win.                    |
| `ClientOptions.fetch`                | `HttpClient` transport               | Called only after policy gates; injected fakes make tests network-free. Defaults to global `fetch`.                        |
| `ClientOptions.timing`               | retry strategy, breaker, limiter     | Supplies monotonic time and abort-aware waits. Optional; defaults to `createDefaultClientTiming()`.                        |
| `ClientOptions.retry`                | retry strategy                       | Enables the documented retry classification and selects total attempts/backoff; `limit < 1` throws at construction.        |
| `ClientOptions.circuitBreaker`       | origin breaker map                   | Creates a breaker lazily for each origin, with the §3.4 `isFailure` predicate; `threshold < 1` throws at construction.     |
| `ClientOptions.rateLimit`            | origin limiter map                   | Creates a limiter lazily for each origin; a non-positive `maxRequests`/`windowMs` throws at construction.                  |
| `ClientOptions.requestInterceptors`  | request pipeline                     | Runs each interceptor once in array order before the first possible fetch.                                                 |
| `ClientOptions.responseInterceptors` | response pipeline                    | Runs each interceptor once in array order after a successful body parse; skipped on any failure.                           |
| `ClientRequest.method`               | request builder and retry strategy   | Becomes the fetch method and determines retry safety.                                                                      |
| `ClientRequest.path`                 | URL resolver                         | Resolves against `baseUrl`; must be relative to keep origin-keyed protection meaningful.                                   |
| `ClientRequest.query`                | URL builder                          | Encodes primitive values and repeats array keys; omits nullish values.                                                     |
| `ClientRequest.headers`              | request builder and auth interceptor | Overrides default headers; its existing credential header prevents an auth interceptor from overwriting it.                |
| `ClientRequest.json`                 | request builder                      | Serialized with `JSON.stringify`; its presence selects JSON content type.                                                  |
| `ClientRequest.signal`               | fetch, timing, limiter               | Aborts fetches and queued waits, and bounds a hostile `Retry-After`; an aborted request is never retried.                  |
| `OpenApiCodegenOptions.sdkImport`    | source emitter                       | Changes the generated type-import specifier; default is `@hono-enterprise/sdk`.                                            |
| `OpenApiCodegenOptions.factoryName`  | source emitter                       | Sets and validates the exported generated factory name; default is `createApi`.                                            |

## 5. Implementation files

| File                                                  | Purpose                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/deno.json`                              | Add the sole type-level import `jsr:@hono-enterprise/common@^0.1.0-alpha.2`; keep the root barrel export and no npm dependency.               |
| `packages/sdk/src/index.ts`                           | Named public barrel only; exports the §4 surface and no stateful implementation classes.                                                      |
| `packages/sdk/src/sdk.ts`                             | Defines `createClient()`, validates policy values, defaults the timing seam, and wires options into the internal client.                      |
| `packages/sdk/src/http/contracts.ts`                  | Defines all documented client, interceptor, timing, and rate-limit interfaces; re-exports the three `common` policy types.                    |
| `packages/sdk/src/http/http-client.ts`                | Internal `HttpClient`: request construction, interceptor execution, response parsing, policy composition, and `HttpClientError` construction. |
| `packages/sdk/src/http/rate-limiter.ts`               | Internal per-origin sliding-window admission queue using `IClientTiming`.                                                                     |
| `packages/sdk/src/http/timing.ts`                     | Exported `createDefaultClientTiming()` over `performance.now()` and abort-aware `setTimeout`.                                                 |
| `packages/sdk/src/auth/auth-interceptor.ts`           | Bearer and API-key request-interceptor factories plus safe async credential resolution.                                                       |
| `packages/sdk/src/retry/retry-strategy.ts`            | Internal retry classification, `Retry-After` parsing, and the fixed/exponential retry loop over the shared policy types.                      |
| `packages/sdk/src/circuit-breaker/circuit-breaker.ts` | Internal per-origin rolling-window breaker state machine taking an injected `isFailure` predicate.                                            |
| `packages/sdk/src/errors.ts`                          | Exported `HttpClientError`, `ClientCircuitOpenError`, and `OpenApiCodegenError`.                                                              |
| `packages/sdk/src/codegen/openapi-types.ts`           | Public structural `SdkOpenApi*` OpenAPI 3.1 subset accepted by the pure generator.                                                            |
| `packages/sdk/src/codegen/openapi-codegen.ts`         | Pure source emitter, schema-to-TypeScript renderer, operation renderer, identifier derivation, and diagnostics.                               |
| `packages/sdk/README.md`                              | Installation, client/auth/resilience/interceptor examples, codegen workflow, supported OpenAPI subset, and portability limits.                |
| `PUBLIC_API.md`                                       | New SDK section documenting every barrel export, option, semantics, errors, and codegen boundary.                                             |
| `ARCHITECTURE.md`                                     | Correct SDK dependencies (C1), public surface (C2), and external-client boundary.                                                             |
| `ROADMAP.md`                                          | Correct the M35 file/test inventory (C3) and flip the `ROADMAP.md:4426` progress row to `✅` in this PR.                                      |
| `README.md`                                           | Correct the six stale SDK/CLI/next-milestone lines (C4).                                                                                      |
| `scripts/release-packages.ts`                         | Move `packages/sdk` to `PUBLISHED_PACKAGES` Tier 3 and narrow the `UNPUBLISHED_PACKAGES` JSDoc to the three starters (C5).                    |
| `CLAUDE.md`                                           | Flip the "Current status" entry for M35 to complete with its PR number and point "Next milestone" at M36 (C6).                                |
| `plans/archive/milestone-35-sdk.md`                   | `git mv` this plan on completion, in this same PR (C6).                                                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                 | src covered                                                                                                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/test/unit/barrel-exports.test.ts`           | `src/index.ts`                                                                                                                 | Runtime exports are exactly `createClient`, `createDefaultClientTiming`, two auth factories, three errors, and `generateOpenApiClient`; no internal class leaks; the three re-exported policy types resolve at compile time.                                                                                                              |
| `packages/sdk/test/unit/sdk.test.ts`                      | `src/sdk.ts`                                                                                                                   | `createClient(options): IHttpClient` uses supplied defaults, injected fetch, and injected `IClientTiming`; defaults timing to `createDefaultClientTiming()` when omitted; throws at construction on each invalid policy value.                                                                                                            |
| `packages/sdk/test/unit/http-contracts.test.ts`           | `src/http/contracts.ts`                                                                                                        | Compile-time fixture assigns every public option and checks `client.request<User, CreateUser>(request): Promise<ClientResponse<User>>`; no runtime-only type is asserted as coverage.                                                                                                                                                     |
| `packages/sdk/test/unit/http-client.test.ts`              | `src/http/http-client.ts`                                                                                                      | Covers relative URLs, query arrays, headers, JSON serialization and parse, 204, malformed JSON, non-2xx `HttpClientError`, abort, interceptor order, and response-interceptor skip on failure. All transport calls use injected fetch functions returning web `Response` objects.                                                         |
| `packages/sdk/test/unit/rate-limiter.test.ts`             | `src/http/rate-limiter.ts`                                                                                                     | Uses fake timing for admission, window expiry, per-origin isolation, queued waits, and abort-without-slot-consumption branches.                                                                                                                                                                                                           |
| `packages/sdk/test/unit/timing.test.ts`                   | `src/http/timing.ts`                                                                                                           | `createDefaultClientTiming()` returns a monotonic non-decreasing `now()`; `sleep(0)` resolves; `sleep` rejects with the abort reason when its signal aborts mid-wait and when given an already-aborted signal.                                                                                                                            |
| `packages/sdk/test/unit/auth-interceptor.test.ts`         | `src/auth/auth-interceptor.ts`                                                                                                 | `createBearerAuthInterceptor(token)` and `createApiKeyAuthInterceptor(key, headerName?)` resolve literal/async values, set correct headers, preserve explicit headers, and propagate provider errors.                                                                                                                                     |
| `packages/sdk/test/unit/retry-strategy.test.ts`           | `src/retry/retry-strategy.ts`                                                                                                  | Shared-policy total-attempt semantics, fixed/exponential delays, retryable statuses/transport rejections, unsafe-method exclusion, delta-seconds `Retry-After` override, ignored HTTP-date `Retry-After`, abort non-retry, and last-error propagation.                                                                                    |
| `packages/sdk/test/unit/circuit-breaker.test.ts`          | `src/circuit-breaker/circuit-breaker.ts`                                                                                       | Rolling window expiry, trip/open fail-fast, half-open transition, successful recovery, failed recovery, concurrent probe rejection, and both arms of the injected `isFailure` predicate.                                                                                                                                                  |
| `packages/sdk/test/unit/errors.test.ts`                   | `src/errors.ts`                                                                                                                | Error names, `instanceof`, HTTP status/header/body fields, and contextual codegen diagnostics.                                                                                                                                                                                                                                            |
| `packages/sdk/test/unit/openapi-codegen.test.ts`          | `src/codegen/openapi-types.ts`, `src/codegen/openapi-codegen.ts`                                                               | All supported M21 schema shapes including `null`, `integer`, and the three `additionalProperties` arms; parameter/body/response rendering; JSON escaping; brace-bearing and digit-leading id derivation; both duplicate sources; `cookie` location; invalid local refs; deterministic output against `test/fixtures/generated-client.ts`. |
| `packages/sdk/test/integration/client-resilience.test.ts` | `src/http/http-client.ts`, `src/http/rate-limiter.ts`, `src/retry/retry-strategy.ts`, `src/circuit-breaker/circuit-breaker.ts` | A fake fetch plus fake timing verifies the specified composition: an open circuit never waits or fetches; retry attempts each rate-limit; an exhausted transient sequence counts once; an `HttpClientError` leaves the breaker closed; separate origins do not share state.                                                               |
| `packages/sdk/test/e2e/generated-client.test.ts`          | `src/sdk.ts`, `src/http/http-client.ts`, `src/codegen/openapi-codegen.ts`                                                      | Imports the checked generated fixture, builds its API with `createClient()`, and verifies typed path/query/header/body forwarding plus a typed JSON response through injected fetch.                                                                                                                                                      |

The generated fixture is a reviewed deterministic artifact, not a logic snapshot: the unit test
compares it with generator output and the e2e test imports it so the workspace type-check validates
the emitted TypeScript against the SDK's actual public contract. No test contacts an external
service or mutates global `fetch`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m35-sdk, never main
deno task check:plan        # this plan lints clean
deno fmt
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

`deno doc --lint` is deliberately NOT a gate: no package in this repo passes it today
(`packages/resilience-plugin/src/index.ts` reports 7 undocumented-constructor errors), so adopting
it for M35 alone would hold this milestone to a bar nothing else meets. JSDoc completeness is
enforced by review against `AI_GUIDELINES.md` §7.2/§10.5 as everywhere else.

Non-gate checks to run by hand before reporting done:

```bash
grep -rn "new Function\|eval(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/sdk/src
grep -rn "CircuitOpenError\|OpenApiDocument" packages/sdk/src/index.ts   # must be Client*/SdkOpenApi*
deno run --allow-read scripts/verify-release.ts 0.1.0-alpha.2            # after the C5 list move
git ls-files plans/ | grep milestone-35                                  # must be ONLY plans/archive/…
```

Before requesting public-API approval, the PR description must identify the new SDK surface, the
dependency-graph correction, the absence of new runtime or npm dependencies, and the C5 release-list
move (noting that the next release must run `release:create-packages` and `release:link-repos`
before the first sdk publish, because tokenless OIDC requires the repo link). The ROADMAP progress
row, the `CLAUDE.md` status entry, and the plan archive all ship in this same PR.

## 8. Risks & mitigations

- Generated source can become syntactically invalid through hostile operation IDs, component names,
  paths, or string descriptions → derive every identifier by full non-alphanumeric sanitization
  (§3.7), quote property keys, escape string literals, detect post-derivation collisions, and
  compile-check the fixture.
- A new SDK export can silently clash with an already-published barrel → the §1 collision rows are
  the standing check; `ClientCircuitOpenError` and the `SdkOpenApi*` family exist for exactly this
  reason, and §7's grep re-checks the barrel before hand-off.
- Retrying write operations can duplicate side effects → retry only the documented idempotent
  methods; callers handle unsafe-write recovery explicitly.
- A hostile or misconfigured `Retry-After` can stall a caller → the wait is abort-aware and bounded
  by `ClientRequest.signal`; the HTTP-date form is ignored outright.
- A reusable request body can be consumed by the first attempt → support only JSON serialization in
  this milestone, producing a fresh string on each attempt.
- A breaker can hide a recovered service, count user errors as dependency failures, or let
  concurrent half-open calls stampede → use a monotonic timing seam, an explicit `isFailure`
  predicate (§3.4), a reset cooldown, and a single in-flight half-open probe.
- Client-side rate-limit waits can make tests slow and leak queued work → inject abort-aware timing,
  test all waits with a deterministic fake, and do not maintain module-level queues.
- M21's public document is structurally wider than its emitted subset → document the accepted
  subset, map every emitted schema construct (§3.6 is total over that vocabulary), and reject
  unsupported structures with a named error instead of emitting deceptive `any` types.
- A diagnostic can become unreachable dead code when the input type is narrower than the error it
  guards → widen `SdkOpenApiOperation.operationId` and `SdkOpenApiParameter.in` deliberately (§3.6)
  and cover both branches in `openapi-codegen.test.ts`.
- Browser/server compatibility can regress through a Node-specific dependency → retain zero npm
  dependencies, use only web `URL`, `Headers`, `Request`, `Response`, `AbortSignal`,
  `performance.now()`, and injected fetch/timing seams, then keep all tests free of runtime-specific
  APIs.

## 9. Out of scope

- Client authentication flows, JWT signing, refresh-token persistence, and server-side authorization
  remain the responsibility of `@hono-enterprise/auth-plugin` (M16/M16b); M35 only attaches supplied
  bearer or API-key credentials to outbound requests.
- Server-side retries, circuit breakers, timeout, and bulkhead registration remain
  `@hono-enterprise/resilience-plugin` (M27); this package owns independent client-side protection.
- OpenAPI document production remains `@hono-enterprise/openapi-plugin` (M21); M35 consumes a
  compatible document and never inspects application routes.
- A `honoe sdk generate` command remains a potential CLI extension after M35. This package offers
  the pure generator that such a command would call, but it has no filesystem or command-line code.
- Publishing the SDK to JSR. C5 moves it onto the release allow-list, but the actual publish happens
  in the next alpha release, which owns the version bump, `release:create-packages`, and
  `release:link-repos`.
- Starter wiring and generated example applications are Milestones 36 and 37.
