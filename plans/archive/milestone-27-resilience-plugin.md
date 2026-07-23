# Milestone 27 — Resilience Plugin (`@hono-enterprise/resilience-plugin`)

> **Status:** Planning. Branch: `feat/27-resilience-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

This milestone delivers a zero-dependency resilience plugin under the existing
`CAPABILITIES.RESILIENCE` (`'resilience'`) token. Today `common` ships only the `CircuitState` type
and the `ICircuitBreaker` port; the ROADMAP, ARCHITECTURE, and PUBLIC_API all reference an
`IResilienceService` with a `wrap(fn, options)` API that does not exist in `common` (see §2 C1). M27
commits that missing service contract (plus its policy/option types) to `common`, then implements it
as a `ResilienceService` that composes four pure resilience patterns — circuit breaker, retry with
backoff, timeout, and bulkhead — around a caller-supplied async function. `wrap` returns a hardened
callable that reuses one shared pattern chain (the circuit breaker's state persists across calls).
The boundary: resilience is **pure, in-process, and stateless at the plugin level** — no timers to
tear down, no external store, no network. It protects an arbitrary `() => Promise<T>`; it is not
HTTP middleware and does not itself retry HTTP requests, talk to Redis, or persist breaker state.

- **In scope:** the `IResilienceService` contract + `WrapOptions`, `CircuitBreakerPolicy`,
  `RetryPolicy`, `BulkheadPolicy`, `BackoffStrategy` types added to `common`; `ResiliencePlugin`
  factory registering the service under `CAPABILITIES.RESILIENCE`; four pattern implementations
  (`circuit-breaker.ts`, `retry.ts`, `timeout.ts`, `bulkhead.ts`); a fixed composition order for
  combined patterns; `TimeoutError` / `BulkheadFullError` / `CircuitOpenError` exported for consumer
  `instanceof` handling; the monotonic clock (`runtime.hrtime()`) driving the breaker reset and
  failure windows and `runtime.setTimeout` driving retry backoff and the timeout race.
- **NOT this milestone:** distributed / shared breaker state across instances (a future Redis-backed
  resilience milestone); resilience HTTP middleware or per-route wrapping (not in the ROADMAP M27
  surface); `@Retry` / `@CircuitBreaker` decorators (a later decorator-integration milestone);
  hedging, fallback values, and rate limiting (rate limiting is owned by
  `@hono-enterprise/auth-plugin`, M16b); true call cancellation on timeout (the underlying promise
  cannot be aborted through the committed `() => Promise<T>` signature — documented in §3.5).

## 1. Contracts verified from SOURCE (not names)

| Reference                                               | Source (file:line)                                                                        | Verified surface / fact                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CircuitState`                                          | `packages/common/src/services/resilience.ts:17`                                           | `type CircuitState = 'closed' \| 'open' \| 'half-open'` — the exact union the breaker's `state` must expose.                                                                                                                                                                     |
| `ICircuitBreaker`                                       | `packages/common/src/services/resilience.ts:28-41`                                        | `{ readonly state: CircuitState (:30); execute<T>(fn: () => Promise<T>): Promise<T> (:40) }`. JSDoc (:37) says `execute` "fails fast when the circuit is open; otherwise propagates the call's own error". No other methods.                                                     |
| No `IResilienceService` in common                       | `packages/common/src/services/resilience.ts` (whole file, 42 lines)                       | The file defines ONLY `CircuitState` + `ICircuitBreaker`. There is no `IResilienceService`, `wrap`, `RetryPolicy`, `WrapOptions`, `BulkheadPolicy`, or `BackoffStrategy` anywhere in `common` (grep of `packages/common/src`).                                                   |
| `common` barrel resilience export                       | `packages/common/src/index.ts:152`                                                        | `export type { CircuitState, ICircuitBreaker } from './services/resilience.ts';` — the block M27 extends (C1 deliverable).                                                                                                                                                       |
| `RetryOptions` / `SchedulerBackoff` names already taken | `packages/common/src/index.ts:171,174`; `packages/common/src/services/scheduler.ts:45,52` | The scheduler already exports `RetryOptions` and `SchedulerBackoff` from the barrel. Resilience must use distinct names (`RetryPolicy`, `BackoffStrategy`) to avoid a barrel collision.                                                                                          |
| `CAPABILITIES.RESILIENCE`                               | `packages/common/src/tokens.ts:77`                                                        | Token value `'resilience'`; already committed. JSDoc (:76) reads "Resilience patterns (circuit breaker, retry, timeout, bulkhead)".                                                                                                                                              |
| `createCapabilityToken` grammar                         | `packages/common/src/tokens.ts:143-153`                                                   | Lowercase kebab-case segments, optional dot namespacing; colons illegal. The bare `'resilience'` token and the plugin name `'resilience-plugin'` both satisfy the grammar.                                                                                                       |
| `IPlugin`                                               | `packages/common/src/plugin.ts:470-501`                                                   | `{ name (:472); version (:474); dependencies? (:477); optionalDependencies? (:479); provides? (:481); consumes? (:492); priority? (:494); register(ctx): void \| Promise<void> (:500) }`.                                                                                        |
| `IPluginContext`                                        | `packages/common/src/plugin.ts:409-441`                                                   | `services: IServiceRegistry (:411)`, `health: IHealthApi (:419)`, `lifecycle: ILifecycleApi (:429)`, `runtime: IRuntimeServices` — non-optional (:435), `config?` (:437), `logger?` (:439).                                                                                      |
| `IRuntimeServices` clock + timers                       | `packages/common/src/runtime.ts:159,166,174,180`                                          | `now(): number` epoch ms (:159), `hrtime(): number` monotonic ms (:166), `setTimeout(fn, ms): TimerHandle` (:174), `clearTimeout(handle): void` (:180). The plugin drives every duration/window from these — never `Date.now()`.                                                 |
| `IServiceRegistry.register`                             | `packages/common/src/registry.ts` (`register<T>(token, instance, options?)`)              | Used to register the `IResilienceService` instance under `CAPABILITIES.RESILIENCE`; single (non-multi) provider.                                                                                                                                                                 |
| `PLUGIN_PRIORITY`                                       | `packages/common/src/types.ts:78-90`                                                      | `HIGHEST:0, HIGH:100, NORMAL:500, OPENAPI:700, LOW:900, LOWEST:1000`. The plugin uses `NORMAL` (ordinary capability plugin).                                                                                                                                                     |
| Duplicate-name guard                                    | `packages/kernel/src/registry/plugin-resolver.ts:110-116`                                 | Two plugins with the same `name` throw at startup ("Duplicate plugin name").                                                                                                                                                                                                     |
| Duplicate-provider guard                                | `packages/kernel/src/registry/plugin-resolver.ts:127-134`                                 | Two plugins providing the same capability token throw at startup ("Capability '…' is provided by both …"). So a second `ResiliencePlugin` registration is a startup error — the intended single-provider behavior.                                                               |
| QueuePlugin / SchedulerPlugin factory precedent         | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts` (archived plan M18 §1)         | Factory `XPlugin(options?): IPlugin`; `provides: [token]`; `register(ctx)` builds the service from `ctx.runtime` + options and `ctx.services.register<IX>(token, service)`. M27 mirrors this shape (no health/onClose — §3.7).                                                   |
| ROADMAP M27                                             | `ROADMAP.md:2809-2875`                                                                    | Scope, registration example (`defaultCircuitBreaker.{threshold,timeout,resetTimeout}`, `defaultRetry.{limit,delay,backoff}`), programmatic API (`resilience.wrap(fn, { circuitBreaker, retry, timeout })`), file list, deliverables (circuit breaker, retry, timeout, bulkhead). |
| ARCHITECTURE resilience                                 | `ARCHITECTURE.md:1353-1362`                                                               | Responsibilities: circuit breaker; retry with backoff; timeout; bulkhead. Public API: `ResiliencePlugin()`; `IResilienceService`. Extension points: custom patterns / breaker strategies. Rule: "Patterns are composable; no external dependencies".                             |
| PUBLIC_API resilience row                               | `PUBLIC_API.md:3963`                                                                      | The `@hono-enterprise/common` service-contract table lists Resilience as providing only `ICircuitBreaker`, `CircuitState` — `IResilienceService` is absent (the C1 conflict).                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                           | Doc deliverable (same PR)                                                                                                                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `IResilienceService` is consumed in `ROADMAP.md:2835` (`ctx.services.get<IResilienceService>('resilience')`) and named as the public API in `ARCHITECTURE.md:1360`, but no `IResilienceService` contract exists in `packages/common/src/services/resilience.ts` (verified whole file: only `CircuitState` + `ICircuitBreaker`), and `PUBLIC_API.md:3963` lists the Resilience contract as only `ICircuitBreaker`, `CircuitState`. A capability token whose consumer surface (`wrap`) has no committed port leaves the seam undefined — the M10 `IOrmAdapter` lesson and the exact M18 `IScheduler` situation. | M27 **adds** to `packages/common/src/services/resilience.ts` (keeping the existing `CircuitState` + `ICircuitBreaker`): `IResilienceService`, `WrapOptions`, `CircuitBreakerPolicy`, `RetryPolicy`, `BulkheadPolicy`, and `BackoffStrategy`, and extends the barrel export at `packages/common/src/index.ts:152`. The implementing milestone commits its port (the M12/M13/M14/M15/M18 precedent). | Edit `PUBLIC_API.md:3963` Resilience row to list the committed types, and add a Resilience section showing the `IResilienceService.wrap` signature block; ship the new `common` source additions + barrel edit in the same PR. |
| C2 | The ROADMAP M27 registration example (`ROADMAP.md:2818-2828`) configures only `defaultCircuitBreaker` and `defaultRetry`, and the programmatic `wrap` example (`ROADMAP.md:2838-2843`) passes only `{ circuitBreaker, retry, timeout }` — yet bulkhead is a mandatory responsibility in both `ARCHITECTURE.md:1358` and the ROADMAP deliverables (`ROADMAP.md:2871`). The registration/`wrap` examples omit the surface needed to actually use bulkhead.                                                                                                                                                      | Add a `defaultBulkhead?: BulkheadPolicy` plugin option and a `bulkhead?: boolean \| BulkheadPolicy` field to `WrapOptions` (§3.6). `bulkhead: true` consumes `defaultBulkhead`; a policy object overrides per-wrap; absent means no bulkhead. This makes bulkhead a first-class, consumed option consistent with `circuitBreaker`/`retry`.                                                         | Edit the `ROADMAP.md:2818-2843` M27 registration and `wrap` examples to include `defaultBulkhead` and the `wrap` `bulkhead` option; document it in the new PUBLIC_API Resilience section.                                      |
| C3 | `CircuitBreakerPolicy` in the ROADMAP registration carries three fields — `threshold`, `timeout`, `resetTimeout` (`ROADMAP.md:2820-2823`) — but no committed doc defines what `timeout` means for a circuit breaker (`resetTimeout` is clearly the open→half-open cooldown; `timeout` is undefined and risks becoming dead surface).                                                                                                                                                                                                                                                                          | Define `timeout` as the **rolling failure window in milliseconds**: the breaker counts failures whose age (measured by `runtime.hrtime()`) is within `timeout` ms, and trips open only when `threshold` failures fall inside that window (§3.3). This gives every `CircuitBreakerPolicy` field a consumed, tested behavior.                                                                        | Document the `timeout` semantics in the committed `CircuitBreakerPolicy` JSDoc and in the PUBLIC_API Resilience section (same PR as C1).                                                                                       |

## 3. Design decisions

### 3.1 The `IResilienceService` contract is committed to `common` by this milestone

- **Decision:** Add the following to `packages/common/src/services/resilience.ts` (below the
  existing `CircuitState` + `ICircuitBreaker`), and extend the barrel export at
  `packages/common/src/index.ts:152`. `ResilienceService` registers under `CAPABILITIES.RESILIENCE`.

  ```typescript
  export type BackoffStrategy = 'fixed' | 'exponential';

  export interface CircuitBreakerPolicy {
    /** Failures within the `timeout` window that trip the breaker open. */
    readonly threshold: number;
    /** Rolling failure window in ms; failures older than this are dropped. */
    readonly timeout: number;
    /** Cooldown in ms before an open breaker moves to half-open. */
    readonly resetTimeout: number;
  }

  export interface RetryPolicy {
    /** Maximum total attempts (1 = no retry). */
    readonly limit: number;
    /** Base backoff delay in ms. */
    readonly delay: number;
    /** Backoff strategy applied to `delay`. */
    readonly backoff: BackoffStrategy;
  }

  export interface BulkheadPolicy {
    /** Maximum concurrent in-flight executions. */
    readonly maxConcurrent: number;
    /** Max queued executions once concurrency is saturated. Defaults to 0. */
    readonly maxQueue?: number;
  }

  export interface WrapOptions {
    readonly circuitBreaker?: boolean | CircuitBreakerPolicy;
    readonly retry?: boolean | RetryPolicy;
    readonly timeout?: number;
    readonly bulkhead?: boolean | BulkheadPolicy;
  }

  export interface IResilienceService {
    /**
     * Wraps `fn` with the selected patterns and returns a hardened callable
     * that reuses one shared pattern chain across invocations.
     */
    wrap<T>(fn: () => Promise<T>, options?: WrapOptions): () => Promise<T>;
  }
  ```

- **Why:** Consumers resolve `ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE)` and
  call `wrap`; a bare token with no port is the undefined-seam defect (M10). The option/policy types
  live in `common` because they are part of `wrap`'s public signature — a consumer needs them to
  build the argument. Names are distinct from the scheduler's `RetryOptions`/`SchedulerBackoff` (§1)
  to avoid a barrel collision.
- **Test home:** `packages/common/test/unit/index.test.ts` (extended) asserts the new types
  compile-resolve from the barrel; `resilience-service.test.ts` asserts the registered object
  satisfies `IResilienceService`.

### 3.2 `wrap` builds the pattern chain once and returns a state-preserving closure

- **Decision:** `ResilienceService.wrap(fn, options)` resolves the effective policies once (§3.6),
  constructs each enabled pattern instance once, composes them into a single hardened callable, and
  returns that callable. The circuit breaker instance is created inside `wrap` and closed over, so
  its failure count and state persist across every invocation of the returned function; the bulkhead
  limiter is likewise created once and shared, so its concurrency accounting is real. Per-invocation
  work is only the actual call path, never re-parsing options or re-constructing patterns
  (AI_GUIDELINES §14 — hoist per-request work).
- **Why:** A breaker that reset its state on every call would never trip; a bulkhead reconstructed
  per call would never limit concurrency. Building once and closing over the state is the
  correctness requirement, and it also satisfies the hoisting rule.
- **Test home:** `resilience-service.test.ts` asserts that calling the returned function repeatedly
  accumulates breaker failures across calls (N failing calls trip the breaker on call N+1), proving
  the state is shared, not per-call.

### 3.3 Circuit breaker — states match `CircuitState`, monotonic clock drives windows

- **Decision:** `CircuitBreaker implements ICircuitBreaker` (the committed port) in
  `src/patterns/circuit-breaker.ts`. Constructor:
  `(policy: CircuitBreakerPolicy, hrtime: () => number)` — the monotonic clock is injected, never
  `Date.now()`. State machine over the exact `CircuitState` union:
  - **closed:** `execute(fn)` runs `fn`. On success it records nothing to the failure window (and a
    prior half-open trial success has already reset it — see below). On failure it appends the
    current `hrtime()` to a failure-timestamp list, drops timestamps older than `policy.timeout` ms
    (the rolling window, C3), and if the remaining count `>= policy.threshold` transitions to
    **open** and records `openedAt = hrtime()`; then it re-throws the call's own error.
  - **open:** `execute(fn)` checks `hrtime() - openedAt`. If `< policy.resetTimeout` it fails fast
    by throwing `CircuitOpenError` **without invoking `fn`**. Once `>= policy.resetTimeout` it
    transitions to **half-open** and proceeds with a single trial (below).
  - **half-open:** `execute(fn)` runs `fn` as a trial. Success ⇒ transition to **closed** and clear
    the failure window. Failure ⇒ transition back to **open**, reset `openedAt = hrtime()`, and
    re-throw the call's error. Concurrent calls while half-open beyond the single trial fail fast
    with `CircuitOpenError` (only one probe at a time).
  - `state` getter returns the current `CircuitState`, recomputing the open→half-open eligibility
    lazily so a read after `resetTimeout` reports `half-open`.
- **Why:** Matches the committed `ICircuitBreaker` JSDoc ("fails fast when open; otherwise
  propagates the call's own error") and the `CircuitState` union exactly. Using `hrtime()`
  (monotonic) for both the reset cooldown and the rolling failure window is the CLAUDE.md "Never mix
  clocks" rule — these are durations, and a wall-clock jump must not open or heal the breaker.
- **Test home:** `circuit-breaker.test.ts` with a fake `hrtime` asserts: threshold failures within
  the window trip `closed → open`; failures spread beyond `policy.timeout` do NOT trip (old ones
  dropped); an open breaker throws `CircuitOpenError` without calling `fn` (call-count 0) until
  `resetTimeout` elapses; after `resetTimeout` the next call is a half-open trial; a half-open
  success closes and clears; a half-open failure re-opens and resets `openedAt`; `state` reports
  each transition.

### 3.4 Retry — pure backoff helper matching `RetryPolicy`, timers from the runtime

- **Decision:** `src/patterns/retry.ts` exports two internal functions:
  `computeBackoffMs(attempt, policy): number` (pure — `'fixed'` ⇒ `policy.delay`; `'exponential'` ⇒
  `policy.delay * 2 ** (attempt - 1)`, with `attempt` 1-based) and
  `runWithRetry(fn, policy, timers)` where `timers` supplies `setTimeout`/`clearTimeout` from the
  runtime. `runWithRetry` calls `fn`; on rejection with `attempt < policy.limit` it waits
  `computeBackoffMs(attempt, policy)` ms (a promise resolved by `timers.setTimeout`) and retries; at
  `attempt === policy.limit` it re-throws the last error. `limit` is the maximum total attempts
  (`limit: 1` means a single attempt, no retry) — matching the M18 scheduler `RetryOptions` reading.
- **Why:** Isolates the backoff math for direct unit testing; the delay is a duration driven by
  `runtime.setTimeout` (advanced deterministically by the fake runtime in tests), never a busy wait
  or `Date.now()` loop.
- **Test home:** `retry.test.ts` asserts `computeBackoffMs` values (fixed = `delay`; exponential =
  `delay`, `2·delay`, `4·delay` at attempts 1/2/3), and `runWithRetry` behavior: success on first
  attempt (no delay armed); reject-then-succeed retries once and waits the computed backoff;
  reject-until-`limit` throws the last error after exactly `limit` attempts.

### 3.5 Timeout — race against a runtime timer; documented non-cancellation

- **Decision:** `src/patterns/timeout.ts` exports `runWithTimeout(fn, ms, timers): Promise<T>` which
  races `fn()` against a `timers.setTimeout(…, ms)` that rejects with `TimeoutError`. Whichever
  settles first wins; the pending timer is always cleared via `timers.clearTimeout` in a `finally`
  so no handle leaks. Because the committed protected-call signature is `() => Promise<T>` with no
  `AbortSignal`, the underlying operation is **not cancelled** on timeout — it runs to completion in
  the background; only the caller's await rejects. This is documented in the `runWithTimeout` JSDoc
  and the PUBLIC_API note.
- **Why:** A timer leak on every fast call would accumulate handles (the M19 active-requests-gauge
  class of leak); the `finally` clear prevents it. Honest documentation of non-cancellation avoids a
  docs-vs-behavior lie (CLAUDE.md).
- **Test home:** `timeout.test.ts` with a fake runtime asserts: `fn` that resolves before `ms`
  returns its value and the timer is cleared (no pending handle); `fn` that never resolves rejects
  with `TimeoutError` once the fake clock advances past `ms`; the timer is cleared on both paths.

### 3.6 Bulkhead — concurrency limiter with bounded queue; default policy resolution

- **Decision:** `src/patterns/bulkhead.ts` exports a `Bulkhead` class constructed from a
  `BulkheadPolicy`. It tracks `active` in-flight count and a FIFO waiter queue of pending resolvers.
  `run(fn)`: if `active < maxConcurrent`, increment `active` and run `fn`; else if
  `queue.length < (maxQueue ?? 0)`, push a resolver and await its turn, then run; else reject
  immediately with `BulkheadFullError`. A `finally` decrements `active` and dequeues the next waiter
  (promoting it into an execution slot). Effective-policy resolution for all three configurable
  patterns lives in the service (§3.2): for `circuitBreaker`/`retry`/`bulkhead`, a `true` value uses
  the plugin's `defaultCircuitBreaker`/`defaultRetry`/`defaultBulkhead`; a policy object overrides
  per-wrap; a falsy/absent value disables the layer. `true` with no matching default configured
  throws at `wrap` time with a precise message (e.g.
  `"resilience.wrap: bulkhead: true requires
  defaultBulkhead in ResiliencePlugin options"`), so
  the `default*` options are live surface, not decorative.
- **Why:** A bulkhead caps concurrent load on a fragile dependency and sheds excess (fail-fast) once
  the queue is full — the ARCHITECTURE-mandated bulkhead responsibility. Throwing on
  `true`-without-a-default keeps every `default*` option consumed and every `wrap` honest
  (dead-option / dead-surface rules).
- **Test home:** `bulkhead.test.ts` asserts: up to `maxConcurrent` calls run concurrently; the
  `(maxConcurrent+1)`th with `maxQueue > 0` queues and runs after a slot frees; the overflow call
  with a full queue rejects with `BulkheadFullError`; `active` returns to 0 after all settle (via
  the `finally`). `resilience-service.test.ts` asserts the default-resolution + the
  `true`-without-default throw for each of `circuitBreaker`/`retry`/`bulkhead`.

### 3.7 Composition order is fixed: bulkhead → circuit breaker → retry → timeout → fn

- **Decision:** When multiple patterns are enabled, the service composes them in one fixed order,
  outermost to innermost: **bulkhead(circuitBreaker(retry(timeout(fn))))**. Each disabled layer is
  omitted (pass-through). Consequences, all specified so no test improvises them:
  - The bulkhead gate is outermost — a rejected (queue-full) call never touches the breaker, retry,
    or `fn`.
  - The circuit breaker wraps the whole retry sequence, so one logical `wrap` invocation counts as
    at most one breaker failure regardless of internal retries, and an open breaker fails fast
    **before any retry attempt or `fn` call**.
  - Retry re-runs `timeout(fn)`, so each attempt gets an independent timeout.
  - Timeout is innermost, bounding a single attempt of `fn`.
- **Why:** This order gives coherent semantics: concurrency shedding first, then fail-fast on an
  open circuit, then bounded retries each with a per-attempt deadline. It also yields the mandatory
  short-circuit guarantees (below): an open breaker and a full bulkhead each stop all inner stages,
  including `fn`.
- **Test home:** `resilience-service.test.ts` (the combined-patterns / short-circuit tests): with
  all four enabled, an open breaker leaves `fn` call-count at 0 and no retry runs; a full bulkhead
  leaves the breaker and `fn` untouched; a timeout on one attempt triggers a retry (fresh timeout)
  rather than a single failure counting straight to the breaker.

### 3.8 `ResiliencePlugin` — single synchronous provider, no health indicator, no `onClose`

- **Decision:** `ResiliencePlugin(options?): IPlugin` with `name: 'resilience-plugin'`, `version`
  matching `deno.json`, `provides: [CAPABILITIES.RESILIENCE]`, `priority: PLUGIN_PRIORITY.NORMAL`
  (500), no declared `dependencies` (it uses only the always-present `ctx.runtime`). `register(ctx)`
  is **synchronous** (`void`): it builds `new ResilienceService(ctx.runtime, options)` and calls
  `ctx.services.register<IResilienceService>(CAPABILITIES.RESILIENCE, service)`. It registers **no
  health indicator and no `onClose`** — the service holds no timers, connections, or global state to
  report or tear down (per-`wrap` breaker/bulkhead state lives in the returned closures and is
  garbage-collected with them). A second `ResiliencePlugin` registration throws at startup via the
  kernel duplicate-name and duplicate-provider guards (§1) — the intended single-provider behavior.
- **Why:** Resilience is pure with zero npm deps, so `register` needs no `await import` and stays
  sync. Registering a health indicator or `onClose` with nothing to check or close would be dead
  surface that a test would then have to assert against a non-decision (the M10 "asserted health
  with no design" trap) — so both are deliberately absent, mirroring the stateless react-router
  plugin (M44).
- **Test home:** `resilience-plugin.test.ts` asserts the factory returns an `IPlugin` with
  `name: 'resilience-plugin'`, `provides: ['resilience']`, `priority: 500`; that `register(ctx)`
  registers an `IResilienceService` under `CAPABILITIES.RESILIENCE`; and that it registers no health
  indicator and no `onClose` (the fake context records neither call).

### 3.9 Zero external dependencies — no lazy `npm:` import, no real-import test

- **Decision:** The plugin has **zero npm dependencies**; every pattern is pure TypeScript over the
  runtime clock/timers. There is no optional dep, no `await import('npm:…')`, and therefore no
  guarded real-import test (the external-dep test rule does not apply here). This matches
  ARCHITECTURE's rule "no external dependencies".
- **Why:** Stating it explicitly closes the "did you forget the real-import test?" gap: there is no
  import to guard, so the rule is satisfied by absence.
- **Test home:** N/A — recorded here so the test plan's lack of a real-import row is a decision, not
  an omission.

## 4. Exported surface — every symbol names its consumer

| Exported symbol           | Kind                             | Consumer / real code path that READS it                                                                                                                         |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IResilienceService`      | interface (common)               | Any plugin/app resolving `ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE)` (ROADMAP.md:2835); implemented by `ResilienceService`.                 |
| `WrapOptions`             | interface (common)               | The `options` parameter of `IResilienceService.wrap`; read by `ResilienceService.wrap` to resolve policies.                                                     |
| `CircuitBreakerPolicy`    | interface (common)               | The `circuitBreaker` field of `WrapOptions` and the `defaultCircuitBreaker` plugin option; read by `CircuitBreaker`.                                            |
| `RetryPolicy`             | interface (common)               | The `retry` field of `WrapOptions` and `defaultRetry`; read by `computeBackoffMs` / `runWithRetry`.                                                             |
| `BulkheadPolicy`          | interface (common)               | The `bulkhead` field of `WrapOptions` and `defaultBulkhead`; read by `Bulkhead`.                                                                                |
| `BackoffStrategy`         | type (common)                    | The `backoff` field of `RetryPolicy`; branched on by `computeBackoffMs`.                                                                                        |
| `CircuitState`            | type (common, pre-existing)      | The `state` field of `ICircuitBreaker`, realized by the `CircuitBreaker` pattern's `state` getter (kept — not re-declared).                                     |
| `ICircuitBreaker`         | interface (common, pre-existing) | Implemented by the internal `CircuitBreaker` class (a real code path in the composed chain). Kept as-is.                                                        |
| `ResiliencePlugin`        | factory fn (resilience-plugin)   | `app.register(ResiliencePlugin({ … }))` (ROADMAP.md:2818; ARCHITECTURE.md:1360).                                                                                |
| `ResiliencePluginOptions` | type (resilience-plugin)         | Callers of `ResiliencePlugin(options)`; read by the factory + `ResilienceService` constructor to seed `defaultCircuitBreaker`/`defaultRetry`/`defaultBulkhead`. |
| `TimeoutError`            | class (resilience-plugin)        | Thrown by `runWithTimeout`; caught by consumers via `instanceof TimeoutError` to distinguish a deadline breach.                                                 |
| `BulkheadFullError`       | class (resilience-plugin)        | Thrown by `Bulkhead.run` on overflow; caught by consumers via `instanceof` to detect load shedding.                                                             |
| `CircuitOpenError`        | class (resilience-plugin)        | Thrown by `CircuitBreaker.execute` when open; caught by consumers via `instanceof` to detect fail-fast.                                                         |

Internal (intentionally NOT exported from `src/index.ts`, so they stay non-public seams):
`ResilienceService`, `CircuitBreaker`, `Bulkhead`, `computeBackoffMs`, `runWithRetry`,
`runWithTimeout`, and the `resolvePolicy`/`composeChain` helpers.

### 4.1 Options — every option names its consumer

| Option                                         | Consumer                                           | Behavior (per implementation)                                                                                |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `defaultCircuitBreaker?: CircuitBreakerPolicy` | `ResilienceService.wrap` (policy resolution, §3.6) | Used when a `wrap` sets `circuitBreaker: true`. `wrap` with `circuitBreaker: true` and no default throws.    |
| `defaultRetry?: RetryPolicy`                   | `ResilienceService.wrap`                           | Used when a `wrap` sets `retry: true`. `wrap` with `retry: true` and no default throws.                      |
| `defaultBulkhead?: BulkheadPolicy`             | `ResilienceService.wrap`                           | Used when a `wrap` sets `bulkhead: true`. `wrap` with `bulkhead: true` and no default throws (C2).           |
| `WrapOptions.circuitBreaker`                   | `ResilienceService.wrap` → `CircuitBreaker`        | `true` ⇒ `defaultCircuitBreaker`; a `CircuitBreakerPolicy` ⇒ that policy; absent/`false` ⇒ no breaker layer. |
| `WrapOptions.retry`                            | `ResilienceService.wrap` → `runWithRetry`          | `true` ⇒ `defaultRetry`; a `RetryPolicy` ⇒ that policy; absent/`false` ⇒ no retry layer.                     |
| `WrapOptions.timeout`                          | `ResilienceService.wrap` → `runWithTimeout`        | A number of ms bounding each attempt; absent ⇒ no timeout layer.                                             |
| `WrapOptions.bulkhead`                         | `ResilienceService.wrap` → `Bulkhead`              | `true` ⇒ `defaultBulkhead`; a `BulkheadPolicy` ⇒ that policy; absent/`false` ⇒ no bulkhead layer.            |
| `CircuitBreakerPolicy.threshold`               | `CircuitBreaker` (closed-state failure accounting) | Failures within the window that trip the breaker open.                                                       |
| `CircuitBreakerPolicy.timeout`                 | `CircuitBreaker` (rolling window, C3)              | Failures older than this many ms (by `hrtime()`) are dropped before the threshold check.                     |
| `CircuitBreakerPolicy.resetTimeout`            | `CircuitBreaker` (open→half-open cooldown)         | Ms an open breaker fails fast before allowing a half-open trial.                                             |
| `RetryPolicy.limit`                            | `runWithRetry`                                     | Maximum total attempts (`1` = no retry).                                                                     |
| `RetryPolicy.delay`                            | `computeBackoffMs`                                 | Base backoff delay in ms.                                                                                    |
| `RetryPolicy.backoff`                          | `computeBackoffMs`                                 | `'fixed'` ⇒ constant `delay`; `'exponential'` ⇒ `delay · 2^(attempt-1)`.                                     |
| `BulkheadPolicy.maxConcurrent`                 | `Bulkhead.run`                                     | Maximum concurrent in-flight executions.                                                                     |
| `BulkheadPolicy.maxQueue` (default `0`)        | `Bulkhead.run`                                     | Max queued executions once saturated; overflow rejects with `BulkheadFullError`.                             |

## 5. Implementation files

| File                                                            | Purpose                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/resilience.ts`                    | Edit: add `IResilienceService`, `WrapOptions`, `CircuitBreakerPolicy`, `RetryPolicy`, `BulkheadPolicy`, `BackoffStrategy` beside the existing `CircuitState` + `ICircuitBreaker` (C1/C2/C3). |
| `packages/common/src/index.ts`                                  | Edit: extend the resilience barrel export at line 152 with the new types.                                                                                                                    |
| `packages/resilience-plugin/src/patterns/circuit-breaker.ts`    | `CircuitBreaker implements ICircuitBreaker` — closed/open/half-open state machine, rolling failure window + reset cooldown via injected `hrtime` (§3.3).                                     |
| `packages/resilience-plugin/src/patterns/retry.ts`              | Pure `computeBackoffMs(attempt, policy)` + `runWithRetry(fn, policy, timers)` using `runtime.setTimeout` (§3.4).                                                                             |
| `packages/resilience-plugin/src/patterns/timeout.ts`            | `runWithTimeout(fn, ms, timers)` — race with `finally` timer cleanup; throws `TimeoutError` (§3.5).                                                                                          |
| `packages/resilience-plugin/src/patterns/bulkhead.ts`           | `Bulkhead` — concurrency counter + bounded FIFO waiter queue; throws `BulkheadFullError` on overflow (§3.6).                                                                                 |
| `packages/resilience-plugin/src/errors.ts`                      | `TimeoutError`, `BulkheadFullError`, `CircuitOpenError` classes (exported for consumer `instanceof`).                                                                                        |
| `packages/resilience-plugin/src/services/resilience-service.ts` | `ResilienceService implements IResilienceService` — policy resolution, one-time chain composition (§3.2/§3.7), owns the runtime clock/timers.                                                |
| `packages/resilience-plugin/src/plugin/resilience-plugin.ts`    | `ResiliencePlugin(options?): IPlugin` factory — synchronous `register` that builds the service and registers it under `CAPABILITIES.RESILIENCE` (§3.8).                                      |
| `packages/resilience-plugin/src/interfaces/index.ts`            | Type-only internal barrel: `ResiliencePluginOptions` (`defaultCircuitBreaker`/`defaultRetry`/`defaultBulkhead`) and any internal type aliases (chain layer type).                            |
| `packages/resilience-plugin/src/index.ts`                       | Public barrel: `ResiliencePlugin`, `ResiliencePluginOptions`, `TimeoutError`, `BulkheadFullError`, `CircuitOpenError`.                                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/index.test.ts` (extend)                           | `common/src/services/resilience.ts` + barrel | The new types compile-resolve from `@hono-enterprise/common` (`import type { IResilienceService, WrapOptions, CircuitBreakerPolicy, RetryPolicy, BulkheadPolicy, BackoffStrategy }`); an object literal satisfies `IResilienceService` (`wrap<T>(fn, options?)` shape).                                                                                                                                                                                                                                |
| `packages/resilience-plugin/test/unit/circuit-breaker.test.ts`               | `src/patterns/circuit-breaker.ts`            | With a fake `hrtime`: `threshold` failures inside `timeout` trip `closed → open`; failures spread past `timeout` do not trip (old dropped); open `execute` throws `CircuitOpenError` with `fn` call-count 0 until `resetTimeout`; after `resetTimeout` a half-open trial runs; trial success ⇒ `closed` + window cleared; trial failure ⇒ `open` + `openedAt` reset; `state` reports each transition. Calls type-check against `ICircuitBreaker.execute<T>` and `state: CircuitState`.                 |
| `packages/resilience-plugin/test/unit/retry.test.ts`                         | `src/patterns/retry.ts`                      | `computeBackoffMs(attempt, policy)`: fixed = `delay` at all attempts; exponential = `delay`, `2·delay`, `4·delay` at 1/2/3. `runWithRetry(fn, policy, timers)`: success first attempt (no timer armed); reject-then-succeed retries once after the computed backoff; reject-until-`limit` throws the last error after exactly `limit` attempts. Type-checks against `(fn: () => Promise<T>, policy: RetryPolicy, timers) => Promise<T>`.                                                               |
| `packages/resilience-plugin/test/unit/timeout.test.ts`                       | `src/patterns/timeout.ts`                    | `runWithTimeout(fn, ms, timers)`: fast-resolving `fn` returns its value and clears the timer (no pending handle); never-resolving `fn` rejects with `TimeoutError` once the fake clock passes `ms`; timer cleared on both paths (`finally`). Type-checks against `(fn: () => Promise<T>, ms: number, timers) => Promise<T>`.                                                                                                                                                                           |
| `packages/resilience-plugin/test/unit/bulkhead.test.ts`                      | `src/patterns/bulkhead.ts`                   | Up to `maxConcurrent` run concurrently; the next call with `maxQueue > 0` queues then runs after a slot frees; overflow with a full queue rejects with `BulkheadFullError`; `active` returns to 0 after all settle. Type-checks against `Bulkhead.run<T>(fn: () => Promise<T>)`.                                                                                                                                                                                                                       |
| `packages/resilience-plugin/test/unit/errors.test.ts`                        | `src/errors.ts`                              | `TimeoutError`, `BulkheadFullError`, `CircuitOpenError` are `instanceof Error`, carry their distinct `name`, and preserve a passed message.                                                                                                                                                                                                                                                                                                                                                            |
| `packages/resilience-plugin/test/unit/resilience-service.test.ts`            | `src/services/resilience-service.ts`         | `wrap` returns a callable; the breaker's state is shared across invocations (§3.2 — N failing calls trip on N+1); default-policy resolution for `circuitBreaker`/`retry`/`bulkhead` `true`; the `true`-without-default throw for each; combined-patterns composition order (§3.7): open breaker ⇒ `fn` call-count 0 and no retry (short-circuit), full bulkhead ⇒ breaker + `fn` untouched (short-circuit), per-attempt timeout drives a retry. Calls type-check against `IResilienceService.wrap<T>`. |
| `packages/resilience-plugin/test/unit/resilience-plugin.test.ts`             | `src/plugin/resilience-plugin.ts`            | `ResiliencePlugin()` returns an `IPlugin` with `name: 'resilience-plugin'`, `provides: ['resilience']`, `priority: 500`; `register(ctx)` registers an `IResilienceService` under `CAPABILITIES.RESILIENCE`; no health indicator and no `onClose` registered (fake context records neither).                                                                                                                                                                                                            |
| `packages/resilience-plugin/test/unit/barrel-exports.test.ts`                | `src/index.ts`                               | `ResiliencePlugin`, `ResiliencePluginOptions`, `TimeoutError`, `BulkheadFullError`, `CircuitOpenError` are exported; internal symbols (`ResilienceService`, `CircuitBreaker`, `Bulkhead`, `runWithRetry`, `runWithTimeout`, `computeBackoffMs`) are NOT exported.                                                                                                                                                                                                                                      |
| `packages/resilience-plugin/test/fixtures/fake-runtime.ts`                   | —                                            | Reusable fake `IRuntimeServices` controlling `hrtime()` and `setTimeout`/`clearTimeout` so window/backoff/timeout timing is deterministic; cross-checked against how the real runtime sets these (durations are monotonic `hrtime` deltas).                                                                                                                                                                                                                                                            |
| `packages/resilience-plugin/test/fixtures/fake-context.ts`                   | —                                            | Fake `IPluginContext` recording `services.register`, `health.register`, and `lifecycle.onClose` calls for the plugin test.                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/resilience-plugin/test/integration/resilience-integration.test.ts` | plugin + service + patterns                  | Register `ResiliencePlugin` in a kernel app, resolve `IResilienceService`, `wrap` a flaky function with all four patterns under a non-default configuration, drive it with the fake runtime, and assert the end-to-end combined behavior (retry recovers a transient failure; the breaker trips and fails fast after `threshold`; the bulkhead sheds overflow).                                                                                                                                        |

`packages/resilience-plugin/src/interfaces/index.ts` is intentionally absent from the coverage rows:
it is a type-only barrel (interfaces / type aliases, zero runtime code), so `deno coverage` produces
no per-file entry for it; it is verified by `deno task check` and by every test importing its types.
If any runtime code (a constant, a guard) lands there during implementation, it moves to a `src/`
file with its own named test row — this file stays type-only.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/27-resilience-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- **Barrel name collision with the scheduler's `RetryOptions`/`SchedulerBackoff` →** resilience uses
  distinct names (`RetryPolicy`, `BackoffStrategy`); verified against `packages/common/src/index.ts`
  and `scheduler.ts` in §1. `deno task check` would fail on a duplicate export, but the distinct
  names prevent it up front.
- **Clock mixing (breaker window/reset) →** the breaker takes `hrtime` (monotonic) by injection and
  uses only `hrtime()` deltas for the rolling window and reset cooldown; no `Date.now()`, no
  wall-clock. The fake-runtime fixture advances `hrtime` deterministically.
- **Timer leak on timeout races →** `runWithTimeout` clears the pending timer in a `finally` on both
  the resolve and timeout paths; the test asserts no handle remains.
- **Breaker state not persisting across calls (would never trip) →** `wrap` constructs one breaker
  and closes over it; the service test drives repeated calls of the returned function and asserts
  the failure count accumulates across invocations.
- **Dead options →** every `default*` option is consumed by a `true`-valued `wrap` field, and a
  `true` without its default throws — verified per option in §4.1 and asserted in
  `resilience-service.test.ts`.
- **`exactOptionalPropertyTypes` / `verbatim-module-syntax` →** never assign `undefined` to an
  optional (omit it); type-only imports use `import type`. Both are recurring gate failures
  (CLAUDE.md pitfalls).

## 9. Out of scope

- Distributed / shared circuit-breaker state across instances (Redis-backed) — a future resilience
  milestone; M27 breaker state is per-process, per-`wrap`.
- Resilience HTTP middleware / per-route wrapping — not in the ROADMAP M27 surface (the API is the
  programmatic `wrap`).
- `@Retry` / `@CircuitBreaker` / `@Bulkhead` decorators and decorator-plugin auto-discovery — a
  later decorator-integration milestone.
- Fallback values, hedging, and true call cancellation on timeout — the committed `() => Promise<T>`
  signature carries no `AbortSignal`, so timeout rejects the await without cancelling the underlying
  operation (§3.5); adding cancellation would be a contract change for a future milestone.
- Rate limiting — owned by `@hono-enterprise/auth-plugin` (`rateLimitMiddleware`, M16b), not the
  resilience plugin.
