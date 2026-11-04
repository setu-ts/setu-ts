# Milestone 131b — Kernel, runtime and plugin contracts (`@setu-ts/runtime`, `@setu-ts/kernel` and 14 more)

> **Status:** Planning. Branch: `feat/m131b-kernel-runtime-contracts`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

The `0.11.0` smoke programme (Parts 19–21 and the regression run) left seventeen rows in which a
kernel, runtime or plugin contract does something its caller cannot predict: a taken port crashes
the Node process, a cancelled upload is logged and counted as a server fault, the DI container's
"every finding at once" stops at a controller, a request scope closes under a handler that is still
running, a `sessionStamp` change can be reverted, a Kafka group's first join redelivers what it
already delivered, an OpenAPI component is named after whichever operation used it first. This
milestone makes each of those contracts hold, or — where a runtime check is impossible (X90-2) —
states the real contract. All seventeen rows were re-checked against `develop` at `53e7a9fa4` on
2026-11-04: none was fixed by the PRs merged since `0.11.0` (§1).

- **In scope:** X92-1, X92-2, X87-3, X95b-1, X92-3, X92-4 (process lifecycle and the diagnostics
  listener); X90-2 … X90-6 (container and kernel); V11-13, X89-1, V10-2 remainder, V11-6, V11-1,
  V11-12 (plugin contracts). Packages: `runtime`, `kernel`, `common`, `exceptions`, `di-plugin`,
  `decorator-plugin`, `resilience-plugin`, `auth-plugin`, `messaging-plugin`, `openapi-plugin`,
  `sdk`, `diagnostics-plugin` (doc only), `react-router-plugin` (README), `full-stack-starter`,
  `view-plugin` (README), plus `cli` and `metrics-plugin`, which the ROADMAP section did not list
  (maintainer decision 2026-11-04: keep the CLI rows and X95b-1's metrics half here; the ROADMAP
  package list is corrected in this PR, C1).
- **NOT this milestone:** closing the `smoke/DEFECTS.md` rows (needs a re-run on the next published
  version, memory `defect-closure-needs-published-reverify`); the `ci:local` memory-headroom fix
  (its own task); the `apps/full-stack` example (#553 merged); a framework request timeout (none
  exists; X90-5 fixes the kernel side of an early-responding middleware, not a timeout feature); the
  remaining M131c (CLI gates, generators, workspace deploy) and M131d (docs, examples, website)
  rows.

## 1. Contracts verified from SOURCE (not names)

All lines are on `develop` at `53e7a9fa4`.

| Reference                    | Source (file:line)                                                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node listen                  | `packages/runtime/src/adapters/node/node-http-adapter.ts:138-166`, `:547-560`                                                                     | `defaultNodeServeHost.serve` returns `mod.serve({ ...options })`; `listen()` awaits it, stores the server and returns. `@hono/node-server` 2.1.5 `serve()` calls `server.listen()` and returns synchronously with no `'error'` listener, so EADDRINUSE becomes an uncaught exception after `start()` resolved. |
| Bun / Deno listen            | `bun-http-adapter.ts:326`, `deno-http-adapter.ts:302`                                                                                             | `Bun.serve` and `Deno.serve` throw synchronously on a taken port (probed), so their `listen()` already rejects.                                                                                                                                                                                                |
| Kernel start failure path    | `packages/kernel/src/application/application.ts:536-554`, `:811-818`                                                                              | `start()` awaits `adapter.listen` and on a rejection runs `runClose()`, which closes the diagnostics connector. Only the Node adapter is wrong.                                                                                                                                                                |
| Diagnostics listen pattern   | `packages/runtime/src/diagnostics/node-local-diagnostics-listener.ts:261-310`                                                                     | Already binds with `once('listening')`/`once('error')` and rejects with the native error; the model for X92-1.                                                                                                                                                                                                 |
| `IHttpAdapter.listen`        | `packages/common/src/runtime.ts:483-490`                                                                                                          | JSDoc says nothing about a failed bind.                                                                                                                                                                                                                                                                        |
| devtool entry                | `packages/cli/src/devtool/dev-entry.ts:136-141`                                                                                                   | `await createApp(...); await app.start(...)` with no catch; the generated `main.ts` uses `boot().catch(... 'Startup failed: ...'; runtime.exit(1))` (`cli/src/templates/project-files.ts:704-713`).                                                                                                            |
| Node `start` script          | `packages/cli/src/templates/project-files.ts:1694`                                                                                                | `node <flags>--enable-source-maps dist/main.js`; no check that `dist/main.js` exists. Bun runs `main.ts` and is unaffected.                                                                                                                                                                                    |
| Body read                    | `packages/runtime/src/adapters/shared/fetch-mapping.ts:48`, `:237-255`, `:281-306`                                                                | `RequestBodyTooLargeError` (413 hint) exists; the uncapped `#raw.arrayBuffer()` and `readBounded` let a native read rejection (Node `Error: aborted`, Bun `AbortError`) through unbranded.                                                                                                                     |
| errorHandler log level       | `packages/exceptions/src/middleware/error-handler.ts:199-205`, `:348-375`                                                                         | An unbranded throw normalises to `internalServerError`; `logError` logs `error` for status ≥ 500 and `warn` below.                                                                                                                                                                                             |
| Metrics on a throw           | `packages/metrics-plugin/src/collectors/http-collector.ts:165-178`                                                                                | Hard-codes `status = '500'` and increments `errorsCounter` for every throw, hinted or not.                                                                                                                                                                                                                     |
| Status hint reader           | `packages/common/src/errors/status-hint.ts:175`                                                                                                   | `httpStatusHintOf(error): HttpStatusHint \| undefined` — the cross-package way to read a status.                                                                                                                                                                                                               |
| Diagnostics eviction         | `node-local-diagnostics-listener.ts:83`, `:207-223`                                                                                               | At 32 sockets the oldest idle socket is destroyed, a paired client's keep-alive socket included. M126 §3.13 (`plans/archive/milestone-126-node-diagnostics-listener.md:461-479`) accepted the eviction but not the client-visible `UND_ERR_SOCKET`.                                                            |
| Diagnostics refusal statuses | `docs/diagnostics-protocol.md:168-190`                                                                                                            | Every unauthenticated refusal is 400, 401, 429 or 503; only a MAC-verified request is answered below 400.                                                                                                                                                                                                      |
| devtool usage                | `packages/cli/src/commands/devtool.ts:366`, `:386`                                                                                                | `Usage: ${cliInvocation('deno')} devtool enable …`; siblings print `Usage: setu …` (`agents.ts:138`, `build.ts:129`, `check.ts:146`).                                                                                                                                                                          |
| Typed token                  | `packages/common/src/container.ts:39-41`                                                                                                          | `createToken<T>(name)` returns `Object.freeze({ name })`; `T` is erased, so no runtime check can know the intended type.                                                                                                                                                                                       |
| Compiler validation          | `packages/di-plugin/src/container/compiler.ts:100-104`, `:114-121`, `:128-171`                                                                    | `compileAll()` validates every root; `compile(token)` validates one subgraph; `#validate` walks each root with no dedupe.                                                                                                                                                                                      |
| Controller instantiation     | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:270-271`, `:286-293`, `:992`                                                            | One provider registered under token and class; `register()` resolves a controller through `container.resolve`, which compiles and throws for its subgraph before DiPlugin's `close()` → `compileAll()` (`di-plugin.ts:107-117`).                                                                               |
| `setHeaders`                 | `packages/kernel/src/context/response.ts:42-70`, `:108-121`; `packages/common/src/http.ts:230-253`                                                | The frozen-template fast path builds a `Headers` once; otherwise entries are applied one by one through `header()`, so entries before an invalid one stay set. The JSDoc promises the same errors as `header`, not atomicity.                                                                                  |
| Request settlement           | `packages/kernel/src/application/application.ts:1136-1141`, `:1718-1760`                                                                          | Settlement runs `handle.takeDeferred()` when the pipeline promise resolves; a middleware that responds without awaiting `next()` settles it while the handler is pending. DiPlugin's `forRequest` registers scope disposal on `ctx.defer` (`di-plugin/src/container/container.ts:268-297`).                    |
| Route refusals               | `packages/kernel/src/router/router.ts:349`, `:357`, `:370`                                                                                        | Three `throw new Error(...)`; `common/src/errors/` has no routing error. The decorator side has `routeLabel` (`decorator-plugin.ts:457-459`) but `registerOnRouter` (`:806-830`) does not wrap.                                                                                                                |
| Retry loop                   | `packages/resilience-plugin/src/patterns/retry.ts:83-98`                                                                                          | `for (attempt = 1; attempt <= policy.limit; …)`; a limit of 0 or `NaN` never runs `fn` and throws `undefined`. No resilience option is validated (`resilience-plugin.ts:35-49`, `services/resilience-service.ts:37-44`).                                                                                       |
| Stamp check                  | `packages/auth-plugin/src/sign-in/auth-session-service.ts:234-242`; `sign-in/session-stamp.ts:72-76`; `strategies/auth-session-strategy.ts:85-95` | A mismatch returns `null` (anonymous) and leaves the record; a throwing reader also returns no match. The strategy sees only `IRequest`.                                                                                                                                                                       |
| Middleware order             | `packages/auth-plugin/src/plugin/auth-plugin.ts:71`; `packages/session-plugin/src/plugin/session-plugin.ts:131`                                   | Auth middleware runs at 300, after the session middleware, so `ctx` there has a writable `ISession` (`delete`, `regenerate`).                                                                                                                                                                                  |
| Kafka first-join seek        | `packages/messaging-plugin/src/brokers/kafka-start-offsets.ts:16-28`; `kafka-broker.ts:944`, `:971`, `:1049-1057`                                 | Records only the first delivered offset per partition and seeks to the minimum, so `[first, lastDelivered]` is handed over again. M119a §3.4 chose this as at-least-once.                                                                                                                                      |
| Component naming             | `packages/openapi-plugin/src/generators/openapi-generator.ts:48-56`, `:527-528`, `:1274-1336`                                                     | `#hook` transforms a reused node, then claims a name from the site hint (`<op>Body`); a nested node descended into first takes the root's name. `$defs` naming discards Zod's id.                                                                                                                              |
| Starter security options     | `packages/starters/full-stack-starter/src/app.ts:50-59`, `:88-117`                                                                                | `fullStackOpenApiOptions` adjusts OpenAPI options; `httpSecurity` is passed through untouched, so a hand-composed app keeps http-security-plugin's `no-referrer` default (`security-headers-middleware.ts:86`, `:140-146`).                                                                                    |
| View layout                  | `packages/cli/src/commands/add-view.ts:318-324`; `packages/view-plugin/src/render/render-view.ts:66`; `decorator-plugin.ts:407`                   | The generated layout opens at `<html lang='en'>`; `renderView` and `@Render` both send the engine's output unchanged.                                                                                                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                        | Resolution (picked side)                                                      | Doc deliverable (same PR)                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| C1  | ROADMAP M131b lists 14 packages but its rows need `cli` and `metrics-plugin`                                                                                                                                    | Keep the rows here (maintainer, 2026-11-04)                                   | ROADMAP M131b package list adds `cli`, `metrics-plugin`, `common`                  |
| C2  | `docs/upgrading.md:640-641` and the `ContainerValidationError` JSDoc promise "every finding at once"; a decorated controller breaks it                                                                          | The code is fixed to match (§3.8)                                             | None beyond the fix; the claim becomes true                                        |
| C3  | `packages/common/src/http.ts` `defer` JSDoc: "buffered responses wait for cleanup", and the di-plugin README "released when the response is finished" — neither says cleanup can run before the handler returns | The kernel is fixed (§3.10); the docs gain "after the handler settles"        | `common/src/http.ts` `defer` JSDoc, `di-plugin/README.md`, PUBLIC_API `forRequest` |
| C4  | auth-plugin README "Ending every session of a user" (l.827-835) promises an ending; the code only suspends                                                                                                      | The code is fixed (§3.13); README states revocation and the reader-fault case | `auth-plugin/README.md`, PUBLIC_API `sessionStamp` row                             |
| C5  | messaging-plugin README l.553-559 "nothing published before … is replayed" is silent on redelivering already-delivered messages                                                                                 | The code is fixed (§3.14)                                                     | messaging-plugin README sentence; M119a CHANGELOG wording untouched (released)     |
| C6  | `docs/mvc.md:235` shows a layout with no doctype                                                                                                                                                                | Layout emits it (§3.17)                                                       | `docs/mvc.md` example, view-plugin README                                          |
| C7  | `createToken` JSDoc, `di-plugin/README.md:72`, `AGENT_CARD.md:44` and PUBLIC_API imply the token's type is enforced                                                                                             | Documentation states the real contract (§3.7)                                 | those four places                                                                  |

## 3. Design decisions

### 3.1 X92-1 — the Node adapter waits for the bind

- **Decision:** `defaultNodeServeHost.serve` wraps `mod.serve(options, onListening)` in a promise
  that resolves on `'listening'` and rejects on the server's first `'error'`, attaching
  `server.once('error', …)` synchronously after `serve()` returns and before the event loop turns;
  on error it calls `server.close()` and rejects with the native error (`code: 'EADDRINUSE'`),
  removing the opposite listener once one of them fires. No new error class: Bun and Deno already
  reject with their native errors, and the generated `main.ts` prints
  `Startup failed: <describeError>`. The kernel's existing `start()` failure path then closes the
  diagnostics connector. `NodeServeHost` is public and injectable (constructor, `:530-531`) and
  `NodeServer` exposes only `close()`, so `listen()` cannot watch an injected host's bind: the
  `NodeServeHost.serve` JSDoc makes "resolves once bound; rejects when the port cannot be bound" the
  host's obligation, the default host implements it, and `NodeServer` stays `{ close() }`. The
  `IHttpAdapter.listen` JSDoc says the same of every adapter.
- **Why:** the defect is the adapter alone (§1); a named error would add public surface no caller
  branches on.
- **Test home:** `packages/runtime/test/unit/node-http-adapter.test.ts` (real import: hold a port
  with `node:net`; `listen` rejects with `code === 'EADDRINUSE'`; no `uncaughtException`) and
  `packages/kernel/test/integration/start-port-conflict.test.ts` (`app.start({ port })` rejects; a
  `--devtool`-style connector registered on the app is closed afterwards).

### 3.2 X92-2 — the devtool entry reports a start failure

- **Decision:** the generated devtool entry (`cli/src/devtool/dev-entry.ts`) wraps creation and
  start in the same `boot().catch` shape the generated `main.ts` uses and prints
  `setu devtool: startup failed: <describeError>. The connector did not start.`, then exits 1. The
  listeners keep rejecting with the native error.
- **Why:** the listener already fails closed; only the entry lacks the catch.
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts` (the rendered entry contains the catch
  and the message); the scaffold e2e boots it.

### 3.3 X87-3 — `npm start` without a build names the build

- **Decision:** the generated Node `start` script becomes
  `node -e "require('node:fs').existsSync('dist/main.js')||(console.error('dist/main.js is missing; run the build script first'),process.exit(1))" && node <flags>--enable-source-maps dist/main.js`.
  It is one script, not a `prestart`, because pnpm and Bun do not run pre-scripts by default. Double
  quotes work in `sh` and `cmd`. Deno and Bun templates are unchanged.
- **Why:** a raw `MODULE_NOT_FOUND` trace hides the cause; the check costs one `node -e` at start.
- **Test home:** `packages/cli/test/unit/project-files-scripts.test.ts` (the Node `start` script
  carries the check and still ends in `dist/main.js`), the `redis-develop-outputs.json` fixture
  regenerated, and the scaffold e2e (`npm start` before `build` exits 1 with the message; after
  `build` it serves).

### 3.4 X95b-1 — a body the client abandoned is a client fault

- **Decision:** `#readBody` and `readBounded` catch any native read rejection that is not a
  `RequestBodyTooLargeError` and rethrow a new `RequestBodyReadError` (exported from
  `@setu-ts/runtime` beside `RequestBodyTooLargeError`, `cause` set) branded with
  `withHttpStatusHint` as **400**, detail
  `The request body could not be read; the client closed the connection.` Bun's
  `Request body exceeded maxRequestBodySize` rejection maps to `RequestBodyTooLargeError` (413).
  `errorHandler` then logs it at `warn` (existing `< 500` rule). Without `errorHandler`, the
  kernel's `#finishFailure` (`application.ts:1695-1716`) today answers 500 and reports at `error`
  whatever the hint says; it now honours a hint whose status is 400–499: it answers that status with
  the hint's own title and detail through `respondWithError` (as `errorHandler`'s
  `buildErrorFromInit` does), and reports at `warn`. Other hints and unhinted errors keep today's
  500 and `error`. That rule is one exported function, `fallbackErrorStatus` in `@setu-ts/common`,
  and every place that predicts the served status for a throw uses
  `responder?.statusFor?.(error) ?? fallbackErrorStatus(error)`: the HTTP metrics collector (errors
  counted only when that status is ≥ 500) and the request logger, which read `?? 500` and logged a
  409 response as 500 (found at verification, 2026-11-04).
- **Why:** the peer leaving is not a server fault, and a counted 500 per cancelled upload makes the
  error-rate alert lie.
- **Test home:** `packages/runtime/test/unit/fetch-mapping.test.ts` (a body stream that errors →
  `RequestBodyReadError` with a 400 hint; Bun's size message → `RequestBodyTooLargeError`);
  `packages/exceptions/test/unit/error-handler-logging.test.ts` (logged at `warn`, served 400);
  `packages/kernel/test/unit/finish-failure-hint.test.ts` (no `errorHandler`: a 400-hinted throw is
  answered 400 with its detail and reported at `warn`; a 503-hinted and an unhinted throw keep 500
  and `error`); `packages/metrics-plugin/test/unit/http-collector.test.ts` (a 400-hinted throw
  counted as 400 and not as an error; an unhinted throw still counted as 500).

### 3.5 X92-3 — a paired client's socket survives a flood

- **Decision:** keep the 32-socket cap. A socket becomes `trusted` once a response on it carries a
  status below 400; by the protocol (§1) only a MAC-verified request gets one. At the cap the
  listener evicts the oldest idle **untrusted** socket, and an idle trusted socket only when no idle
  untrusted socket exists.
- **Why:** the cap's purpose (a bound on sockets) holds; an unpaired flood can no longer cost the
  paired client its keep-alive socket.
- **Test home:** `packages/runtime/test/unit/node-local-diagnostics-listener.test.ts` (fake sockets:
  a trusted idle socket survives 40 untrusted newcomers; with only trusted idle sockets the oldest
  goes) and `node-local-diagnostics-listener-real.test.ts` (under a 32-socket unpaired flood,
  keep-alive paired polls see 0 failures).

### 3.6 X92-4 — devtool usage names `setu`

- **Decision:** both usage strings become
  `Usage: setu devtool enable [member] [--devtool-port <n>] [--dir <path>] [--dry-run]`, like the
  sibling commands.
- **Why:** the line was hard-coded to the Deno invocation.
- **Test home:** `packages/cli/test/unit/devtool-refusals.test.ts` (the two assertions now expect
  `Usage: setu devtool enable`).

### 3.7 X90-2 — a typed token's type is compile-time only

- **Decision:** documentation only. The `createToken` JSDoc, the di-plugin README and AGENT_CARD and
  PUBLIC_API state that `T` is erased at runtime, that `tsc` (the generated `check` and `build`
  scripts) is the gate, and that `start:dev` / `tsx` does not type-check. No runtime check: neither
  the token nor the class carries the intended type (§1), and an opt-in guard would widen a
  committed `common` export and still run per resolve, not at boot.
- **Why:** the only honest fix without a contract change.
- **Test home:** none (documentation); `pnpm run check:docs` covers the prose.

### 3.8 X90-3 — boot validation reports every finding once

- **Decision:** (1) `DecoratorPlugin`'s controller instantiation, while the container is still open,
  catches `ContainerValidationError` from `container.resolve` and registers the controller's routes
  against a holder that resolves the controller on the first route call (controller routes come from
  class metadata, so registration needs no instance). DiPlugin's `close()` → `compileAll()` then
  throws the full set, which includes the controller's subgraph, and start fails; when `close()`
  succeeds, the graph was validated whole, so the holder's later resolve cannot fail validation. A
  container that is already closed, and any error other than `ContainerValidationError`, rethrow at
  once. (2) `#validate` skips a root that is an alias of an entry already walked, and dedupes
  findings by kind and failing edge (`missing`: the last two path tokens; `cycle`: the member set;
  `captive`: the captive and scoped tokens).
- **Why:** M125 promised every finding at once; today one finding hides the rest and another appears
  three times.
- **Test home:** `packages/di-plugin/test/unit/compiler.test.ts` (one missing edge reached from two
  roots and an alias → one finding);
  `packages/decorator-plugin/test/integration/boot-validation.test.ts` (a controller-reachable
  missing dependency plus an unrelated missing factory dependency → `app.start()` rejects with both,
  each once).

### 3.9 X90-4 — `setHeaders` is atomic

- **Decision:** `setHeaders` validates every entry before touching the response. The frozen-template
  path keeps its cached `Headers`; a frozen record whose template fails caches the build error in
  the same `WeakMap` and rethrows it before any write. The non-template path stages entries into a
  scratch `Headers` and copies it into the response only when all succeeded. The JSDoc and
  PUBLIC_API say "atomic: when any entry is invalid, none is set". The change is measured against
  M88's response-path benchmark; a regression beyond run-to-run noise on the frozen path blocks it.
- **Why:** a half-applied header set is a state no caller can reason about.
- **Test home:** `packages/kernel/test/unit/response.test.ts`
  (`{ 'x-before', 'bad name', 'x-after' }`, frozen and unfrozen, with and without prior headers:
  throws `TypeError` and `x-before` is absent).

### 3.10 X90-5 — request cleanup waits for the handler

- **Decision:** the kernel records the terminal stage's promise on the request handle. When
  settlement runs while that promise is pending (a middleware answered without awaiting `next()`),
  the response is still sent at once, but the deferred cleanups are detached and run after the
  handler's promise settles; the request stays in `#inFlight` until then, so the shutdown drain
  waits for it within its existing bound. `ctx.signal` keeps its committed meaning (fires on
  connection sever only). The `defer` JSDoc, the di-plugin README and PUBLIC_API `forRequest` say
  cleanup runs after the response is sent and the handler has settled.
- **Why:** closing a scope under running code turns a timeout into `ScopeDisposedError`s and
  disposal warnings.
- **Test home:** `packages/kernel/test/unit/request-context-defer.test.ts` (a middleware responds
  without `next()` while the handler awaits a gate: the deferred cleanup has not run; releasing the
  gate runs it; shutdown waits for it) and `packages/di-plugin/test/e2e/request-scope-e2e.test.ts`
  (the scoped instance is not disposed while the handler runs).

### 3.11 X90-6 — route registration refusals are named

- **Decision:** a new `RouteRegistrationError` in `packages/common/src/errors/route-registration.ts`
  with `reason: 'regex-parameter' | 'unsupported-pattern' | 'duplicate'`, `method` and `path`; the
  router throws it at its three refusals with the same messages. `DecoratorPlugin.registerOnRouter`
  catches it and rethrows the same class with the message prefixed by `routeLabel`
  (`Route GET /x (Ctrl.method): …`) and `{ cause }`.
- **Why:** a decorated route's refusal named neither controller nor method.
- **Test home:** `packages/kernel/test/unit/router.test.ts` (`instanceof` and `reason` for each
  refusal) and `packages/decorator-plugin/test/unit/plugin/route-registration-error.test.ts`
  (`@Get('/files/*.json')` → message names `Ctrl.method`).

### 3.12 V11-13 — retry limits are validated

- **Decision:** one internal `validateRetryPolicy(policy, label)` throws `RangeError` when `limit`
  is not a safe integer ≥ 1 or `delay` is negative or not finite. It runs in `ResiliencePlugin`
  registration for `defaultRetry` and in `#resolveRetry` for a per-call policy. `RangeError` follows
  the repository's numeric-option precedent (`worker-pool-plugin/src/services/sizing.ts:56-66`,
  `messaging-plugin/src/outbox/options.ts:58-61`).
- **Why:** a limit of 0 boots and then rejects every call with `undefined`.
- **Test home:** `packages/resilience-plugin/test/unit/retry.test.ts` (limit 0, `NaN`, 1.5, negative
  delay → `RangeError`) and `test/unit/resilience-plugin.test.ts` (`register()` throws for
  `defaultRetry: { limit: 0 }`).

### 3.13 X89-1 — a stamp mismatch ends the session

- **Decision:** the stamp check becomes three-state (`match`, `mismatch`, `reader-fault`). On a
  definite `mismatch` the strategy marks the request in an internal `WeakMap<IRequest, true>`; the
  auth middleware, which runs after the session middleware, then deletes the auth record
  (`session.delete(AUTH_SESSION_KEY)`) and calls `session.regenerate()`. `verifiedCurrent(ctx)` does
  the same directly. A `reader-fault` answers anonymous for that request and leaves the record (a
  store outage must not sign everyone out). Non-HTTP `fromHeaders` callers (WebSocket upgrade) stay
  suspension-only, which the README states. With the default encrypted-cookie strategy there is no
  server-side record to delete, so a copied old cookie authenticates again if the stamp is restored
  to its old value, as does a stored id never presented while the stamp differed: the README,
  PUBLIC_API and upgrade notes say revocation happens when the old cookie is next presented (even on
  a request that throws, audit F1) and that stamps must only move forward on both strategies
  (maintainer decision 2026-11-04, after implementation found the limit; no stamp-history
  mechanism).
- **Why:** reverting a stamp revived every old cookie.
- **Test home:** `packages/auth-plugin/test/unit/session-stamp.test.ts` (three states),
  `test/unit/auth-session-strategy.test.ts` (mismatch marks; reader fault does not), and
  `test/integration/session-stamp-revocation.test.ts` (bump, request → anonymous and the session id
  changed; revert, request with the old cookie → still anonymous; a throwing reader leaves the
  record).

### 3.14 V10-2 remainder — the first-join seek skips what was delivered

- **Decision:** the broker tracks `lastDelivered` per partition beside `firstDelivered`. When
  `partitionsToSeek` chooses a seek, it also returns
  `skipThrough[p] = { from: first, to: lastDelivered }`; `eachMessage` commits without calling the
  handler for an offset in that window on that partition, delivers offsets in `[minimum, first)`,
  and clears the window once an offset beyond `to` arrives. The decision stays synchronous. The
  window logic lives in `kafka-start-offsets.ts` as a pure function.
- **Why:** M119a's at-least-once choice redelivered messages the same consumer had just handled.
- **Test home:** `packages/messaging-plugin/test/unit/kafka-start-offsets.test.ts` (window
  computation) and the M119a table in `test/unit/kafka-broker.test.ts` (deliver 0:2 and 0:3, join
  with minimum 0, redeliver 0:2 and 0:3 → handler runs once each; 0:0 and 0:1 delivered).

### 3.15 V11-6 — a reused schema is named after itself

- **Decision:** the generator names a hoisted component from (a) the schema's own Zod
  `.meta({ id })` / registry id when it has one (the `onDefinitionClaim` hint when it is not Zod's
  mechanical `__schemaN` key, and the node's meta in `#hook`), otherwise (b) the site hint plus the
  node's path inside the site schema (`PostOrdersBodyLinesItems`), using the `path` the Zod 4
  override context already carries (`transformers/zod-to-openapi.ts:73-77`). The site root's name
  (`<op>Body`, `<op>Response200`) is reserved before descending, so a nested node can never take it.
  A nullable primitive (`anyOf` of one primitive and `null`) is no longer hoisted. The SDK needs no
  change; its `2`-suffix collision path stops firing.
- **Why:** a name that depends on traversal order changes when an unrelated operation is added.
- **Test home:** `packages/openapi-plugin/test/unit/component-naming.test.ts` (one schema reused
  nested in two bodies → each root keeps `<op>Body`, the nested schema gets its id or path name; a
  nullable string stays inline) and `packages/sdk/test/unit/codegen/reused-schema.test.ts` (no
  `Body2` type).

### 3.16 V11-1 — the full-stack starter keeps form posts working

- **Decision:** a `fullStackHttpSecurityOptions(options)` helper beside `fullStackOpenApiOptions`
  sets `headers.referrerPolicy: 'same-origin'` when `options.reactRouter` is set and the application
  gave no `referrerPolicy`, keeping an explicit value, `referrerPolicy: false`, or
  `headers: { enabled: false }` (`security-headers-middleware.ts:48`, `:74`).
  `composeFullStackPlugins` and `from-config.ts` apply it. A bare `ReactRouterPlugin` app gets a
  react-router-plugin README section (React Router refuses `Origin: null`; set `referrerPolicy`),
  because a plugin may not import another plugin.
- **Why:** Chrome sends `Origin: null` under `no-referrer`, and React Router refuses it.
- **Test home:** `packages/starters/full-stack-starter/test/unit/http-security-defaults.test.ts`
  (with `reactRouter` and no `httpSecurity`, a response carries `Referrer-Policy: same-origin`; an
  explicit `referrerPolicy`, `referrerPolicy: false` and `headers: { enabled: false }` are kept).

### 3.17 V11-12 — the generated view layout emits a doctype

- **Decision:** `setu add view` generates `<>{raw('<!DOCTYPE html>')}<html lang='en'>…</html></>`;
  `renderView` and `@Render` stay unchanged. `docs/mvc.md` and the view-plugin README show the
  doctype.
- **Why:** prepending in `renderView` would split it from `@Render`; prepending in the engine would
  reach mail bodies and partials.
- **Test home:** `packages/cli/test/unit/add-view.test.ts` (the generated layout's output starts
  with `<!DOCTYPE html>`).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Behaviour changes that callers can observe, each with an
upgrade note (`docs/upgrading.md`, `0.12.0`): `setHeaders` is atomic; a stamp mismatch now ends the
session; a retry `limit` below 1 is refused at registration; OpenAPI component names for reused
schemas change (regenerated clients rename types); a cancelled upload answers 400 and logs `warn`;
an application without `errorHandler` now answers a 4xx-hinted error (for example
`MalformedRequestBodyError`) with its hinted status instead of 500.

| Exported symbol                              | Kind     | Consumer / real code path that READS it                                                                                                                                                 |
| -------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RouteRegistrationError` (`@setu-ts/common`) | class    | thrown by `kernel/src/router/router.ts`; caught and rewrapped by `decorator-plugin`'s `registerOnRouter`; applications branch on `reason`                                               |
| `RequestBodyReadError` (`@setu-ts/runtime`)  | class    | thrown by `fetch-mapping.ts`; its status hint is read by `exceptions` `errorHandler` and `metrics-plugin`'s collector; applications may `instanceof` it like `RequestBodyTooLargeError` |
| `fallbackErrorStatus` (`@setu-ts/common`)    | function | the kernel's `#finishFailure`; `logger-plugin`'s request logger and `metrics-plugin`'s HTTP collector when no error responder is present                                                |

No other export is added or removed. `validateRetryPolicy`, `fullStackHttpSecurityOptions` (not
exported from the starter's `src/index.ts`) and the Kafka skip window are internal.

### 4.1 Options — every option names its consumer

| Option               | Consumer | Behavior (per implementation)                                                                                                                                         |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None added (checked) | —        | Existing options gain validation (`defaultRetry`, per-call `retry`) or a default (`httpSecurity.headers.referrerPolicy` under the full-stack starter); no new option. |

## 5. Implementation files

| File                                                                                                                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`                                                                                                                  | §3.1 bind wait                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`, `packages/runtime/src/index.ts`                                                                                   | §3.4 `RequestBodyReadError` and export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/runtime/src/diagnostics/node-local-diagnostics-listener.ts`                                                                                                      | §3.5 trusted eviction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/common/src/errors/route-registration.ts`, `packages/common/src/index.ts`                                                                                         | §3.11 error and export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/common/src/runtime.ts`, `packages/common/src/http.ts`, `packages/common/src/container.ts`                                                                        | JSDoc (§3.1, §3.9, §3.10, §3.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/kernel/src/context/response.ts`                                                                                                                                  | §3.9 atomic `setHeaders`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/kernel/src/application/application.ts`                                                                                                                           | §3.10 cleanup after the handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/kernel/src/router/router.ts`                                                                                                                                     | §3.11 named refusals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/di-plugin/src/container/compiler.ts`                                                                                                                             | §3.8 alias skip and dedupe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`                                                                                                                 | §3.8 deferred controller validation, §3.11 rewrap                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/metrics-plugin/src/collectors/http-collector.ts`                                                                                                                 | §3.4 hinted status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/resilience-plugin/src/patterns/retry.ts` (`validateRetryPolicy`), `src/plugin/resilience-plugin.ts`, `src/services/resilience-service.ts`                        | §3.12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/auth-plugin/src/sign-in/session-stamp.ts`, `src/sign-in/auth-session-service.ts`, `src/strategies/auth-session-strategy.ts`, `src/middleware/auth-middleware.ts` | §3.13                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/messaging-plugin/src/brokers/kafka-start-offsets.ts`, `src/brokers/kafka-broker.ts`                                                                              | §3.14                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/openapi-plugin/src/generators/openapi-generator.ts`, `src/transformers/zod-to-openapi.ts`                                                                        | §3.15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/starters/full-stack-starter/src/app.ts`, `src/from-config.ts`                                                                                                    | §3.16                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/cli/src/devtool/dev-entry.ts`, `src/templates/project-files.ts`, `src/commands/devtool.ts`, `src/commands/add-view.ts`                                           | §3.2, §3.3, §3.6, §3.17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Docs                                                                                                                                                                       | PUBLIC_API.md (new errors, `setHeaders`, `defer`/`forRequest`, `createToken`, `sessionStamp`, retry `@throws`, body errors), `docs/upgrading.md`, `docs/diagnostics-protocol.md`, `docs/mvc.md`, `docs/cli.md`, READMEs of di-plugin, auth-plugin, messaging-plugin, react-router-plugin, view-plugin, http-security-plugin, full-stack-starter; the AGENT_CARDs whose claims change (di-plugin, auth-plugin, runtime, resilience-plugin; `test/agent-card-gate.test.ts` checks them); CHANGELOG; ROADMAP (C1, status flip) |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                           | src covered                                                 | Key assertions (and the signature each call type-checks against)                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/test/unit/node-http-adapter.test.ts`                                                                                       | `node-http-adapter.ts`                                      | real `@hono/node-server` import: `listen(heldPort)` rejects `code === 'EADDRINUSE'`, no `uncaughtException`; a free port resolves (`IHttpAdapter.listen(port, hostname?)`) |
| `kernel/test/integration/start-port-conflict.test.ts`                                                                               | `application.ts` start path                                 | `app.start({ port })` rejects; nothing left bound                                                                                                                          |
| `kernel/test/unit/finish-failure-hint.test.ts`                                                                                      | `application.ts` `#finishFailure`                           | no `errorHandler`: 400-hinted throw answered 400 and reported at `warn`; 503-hinted and unhinted keep 500 and `error`                                                      |
| `runtime/test/unit/fetch-mapping.test.ts`                                                                                           | `fetch-mapping.ts`                                          | erroring stream → `RequestBodyReadError`, `httpStatusHintOf(e)?.status === 400`; Bun size message → `RequestBodyTooLargeError`                                             |
| `exceptions/test/unit/error-handler-logging.test.ts`                                                                                | existing                                                    | a `RequestBodyReadError` is logged at `warn`, served 400                                                                                                                   |
| `metrics-plugin/test/unit/http-collector.test.ts`                                                                                   | `http-collector.ts`                                         | 400-hinted throw counted `status="400"`, errors counter unchanged; unhinted throw counted 500                                                                              |
| `runtime/test/unit/node-local-diagnostics-listener.test.ts`, `…-real.test.ts`                                                       | `node-local-diagnostics-listener.ts`                        | trusted idle socket survives 40 untrusted newcomers; real flood: 0 paired failures                                                                                         |
| `cli/test/unit/dev-entry.test.ts`                                                                                                   | `dev-entry.ts`                                              | rendered entry has the catch and message                                                                                                                                   |
| `cli/test/unit/project-files-scripts.test.ts` + fixture                                                                             | `project-files.ts`                                          | Node `start` script carries the existence check                                                                                                                            |
| `cli/test/unit/devtool-refusals.test.ts`                                                                                            | `devtool.ts`                                                | `Usage: setu devtool enable`                                                                                                                                               |
| `cli/test/unit/add-view.test.ts`                                                                                                    | `add-view.ts`                                               | layout output starts with `<!DOCTYPE html>`                                                                                                                                |
| `di-plugin/test/unit/compiler.test.ts`                                                                                              | `compiler.ts`                                               | one missing edge from two roots and an alias → one finding                                                                                                                 |
| `decorator-plugin/test/integration/boot-validation.test.ts`                                                                         | `decorator-plugin.ts`                                       | controller-reachable plus unrelated missing dependency → both findings once                                                                                                |
| `kernel/test/unit/response.test.ts`                                                                                                 | `response.ts`                                               | atomic `setHeaders` (frozen, unfrozen, with prior headers)                                                                                                                 |
| `kernel/test/unit/request-context-defer.test.ts`, `di-plugin/test/e2e/request-scope-e2e.test.ts`                                    | `application.ts` settlement                                 | cleanup waits for the handler; shutdown drain waits too                                                                                                                    |
| `common/test/unit/route-registration-error.test.ts`                                                                                 | `route-registration.ts`                                     | constructor sets `reason`, `method`, `path`, `name`; `cause` kept; `instanceof` holds across the rewrap                                                                    |
| `kernel/test/unit/router.test.ts`, `decorator-plugin/test/unit/plugin/route-registration-error.test.ts`                             | `router.ts`, `route-registration.ts`, `decorator-plugin.ts` | `RouteRegistrationError` reason per refusal; decorated message names `Ctrl.method`                                                                                         |
| `resilience-plugin/test/unit/retry.test.ts`, `resilience-plugin.test.ts`                                                            | `retry.ts`, `resilience-plugin.ts`, `resilience-service.ts` | `RangeError` for 0, `NaN`, 1.5, negative delay; at registration and per call                                                                                               |
| `auth-plugin/test/unit/session-stamp.test.ts`, `auth-session-strategy.test.ts`, `test/integration/session-stamp-revocation.test.ts` | the four auth files                                         | three states; revocation on mismatch; reader fault leaves the record                                                                                                       |
| `messaging-plugin/test/unit/kafka-start-offsets.test.ts`, `kafka-broker.test.ts`                                                    | the two Kafka files                                         | skip window; handler once per offset                                                                                                                                       |
| `openapi-plugin/test/unit/component-naming.test.ts`, `sdk/test/unit/codegen/reused-schema.test.ts`                                  | `openapi-generator.ts`, `zod-to-openapi.ts`                 | stable names; no `Body2`                                                                                                                                                   |
| `starters/full-stack-starter/test/unit/http-security-defaults.test.ts`                                                              | `app.ts`, `from-config.ts`                                  | `Referrer-Policy: same-origin` default; explicit value kept                                                                                                                |

Every failing-before test is shown failing against `develop` before its fix lands (negative
control), as the "Before reporting a task done" rule requires.

## 7. Verification gates

```bash
git branch --show-current   # feat/m131b-kernel-runtime-contracts, never develop or main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run ci:local           # at parallelism >= 2, or not at all
pnpm run test:deno-lane
pnpm run check:apps
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

Also: `scaffold-runs-e2e` (X87-3, X92-2 and X92-4 change generated output), the M88 response-path
benchmark for §3.9, the x92 probes (`appport-entry.ts`, `x92-starve.mjs`) and
`x95b/probes/hostile.mjs` step 3 against the workspace build.

## 8. Risks & mitigations

- §3.10 changes request settlement, the hottest kernel path → the pending-handler branch is taken
  only when settlement precedes the handler; the common path is unchanged and measured with M88's
  benchmark.
- §3.9 adds a staging `Headers` on the non-template path → measured; the frozen-template path is
  unchanged.
- §3.13 regenerating a session id on mismatch could sign out a user whose stamp reader flaps → only
  a definite `mismatch` revokes; a `reader-fault` is a one-request suspension.
- §3.15 renames OpenAPI components → upgrade note: regenerated clients rename types;
  `setu client --check` reports the drift.
- §3.8 deferring a controller's validation error could hide it when DiPlugin is absent → the
  deferral applies only while a container exists and is open; without one the error is thrown at
  once.
- §3.5 trust is inferred from status < 400 → holds by the protocol's refusal table (§1); the
  security audit probes an unpaired flood and a forged success path.

### 8a. Design security review

Trust boundaries crossed: session lifetime (§3.13), the diagnostics connector's socket admission
(§3.5), request body handling and error egress (§3.4), request cleanup under concurrency (§3.10).
Threats and obligations, each probed by the committed-tree audit (a fresh Claude agent, per
CLAUDE.md, never Codex):

- **T1 (§3.13):** a reverted stamp or a replayed old cookie is accepted. **O1:** with a server-side
  session store, after a mismatch the old session id is anonymous forever; with encrypted-cookie
  sessions, an old cookie stays anonymous while the stamp keeps moving forward (restoring an old
  stamp is documented as unsupported); a reader fault never deletes a record.
- **T2 (§3.5):** an unpaired client gains `trusted` and pins sockets. **O2:** a socket becomes
  trusted only after a response below 400; an unauthenticated flood cannot evict a paired socket.
- **T3 (§3.4):** `RequestBodyReadError`'s detail or log echoes request data. **O3:** the served body
  and the log carry the fixed detail and the native error class only.
- **T4 (§3.10):** a detached cleanup outlives shutdown or runs twice. **O4:** each deferred cleanup
  runs exactly once, after the handler settles; the shutdown drain waits for it within its bound,
  and a handler still running when the bound expires has its cleanup run when it settles, after
  `stop()` returned (documented; disposing its scope earlier would reintroduce X90-5; audit F6).

## 9. Out of scope

- Validating the circuit-breaker and bulkhead numbers (equally unchecked today) — V11-13 is the
  retry limit; a follow-up row if wanted.

- A framework request-timeout feature or an abort signal on early settlement (`ctx.signal` keeps its
  contract) — none planned.
- A runtime type guard on DI tokens (§3.7) — would widen a committed `common` export.
- Closing the seventeen `smoke/DEFECTS.md` rows — after the next published version's re-run.
- M131c's CLI gates and workspace-deploy rows; M131d's documentation, examples and website rows.
