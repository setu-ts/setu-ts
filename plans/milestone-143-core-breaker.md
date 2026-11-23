# Milestone 143 Core follow-up — One Breaker Trip Rule, With a Rate Arm (`@setu-ts/common`, `@setu-ts/sdk`)

> **Status:** Planning. Branch: `feat/m143-core-breaker`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

V13-104 ("Circuit breaker only counts absolute failures, no rate option") is owned by M143c
(Services lane), which decided OD4 A (a percent rate arm with a minimum volume, as a union) and OD4b
A (the SDK breaker moves onto one shared trip rule in `common`). This follow-up ships the two halves
M143c handed over (M143c plan §11): the Core half — the `CircuitBreakerPolicy` union and the pure
trip primitive `createBreakerWindow` in `@setu-ts/common` — and the SDK half — `@setu-ts/sdk`'s
per-origin breaker moved onto that primitive, which gives it the rate arm and drops its
clear-on-success behaviour. The SDK half is the CLI lane's by the lane table; it lands here because
the union breaks the SDK's compile (`sdk/src/circuit-breaker/circuit-breaker.ts:96` reads
`policy.threshold`) and no CLI-lane session is active. The PR body flags it as a cross-lane edit.

- **In scope:** the union and its two named arms with JSDoc per field; `createBreakerWindow` and
  `IBreakerWindow`; `breakerPolicyRangeError` (the one policy check); a conformance table test over
  both arms; the `@setu-ts/common/breaker-window` subpath (§3.8, OD-E); the SDK breaker, its
  construction check and its failure classifier on the primitive; the one-line compile guard in
  `resilience-plugin` (§3.7, OD-A); `PUBLIC_API.md` (Common Resilience, Resilience plugin re-export
  line, SDK), the `common` and `sdk` READMEs and agent cards, `CHANGELOG.md`, `docs/upgrading.md`,
  and the SDK type-only docs (§3.8).
- **NOT this milestone:** `resilience-plugin`'s `CircuitBreaker` on the primitive, its rate arm,
  `validateCircuitBreakerPolicy`, its README and tests (M143c §3.7, which replaces the guard in §3.7
  below); `service-discovery-plugin` and `grpc-plugin` (M143c); the other Core follow-ups
  (`createDnsResolver`, the drain marker — separate Core sessions).

## 1. Contracts verified from SOURCE (not names)

Read on `origin/develop` at `a8fa7a440` (2026-11-23).

| Reference                                     | Source (file:line)                                                                                                                                                                                                                                                                                                               | Verified surface / fact                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CircuitBreakerPolicy`                        | `packages/common/src/services/resilience.ts:96-106`                                                                                                                                                                                                                                                                              | An interface `{ readonly threshold; readonly timeout; readonly resetTimeout }`, all `number`, `@since 0.1.0`. No validation anywhere in `common`.                                                                                                                                                                                                               |
| `WrapOptions.circuitBreaker`                  | `packages/common/src/services/resilience.ts:149`                                                                                                                                                                                                                                                                                 | `boolean \| CircuitBreakerPolicy`; widens with the union, no edit.                                                                                                                                                                                                                                                                                              |
| `common` barrel                               | `packages/common/src/index.ts:476` (type export block), `:94` and `:97` (value exports `createCachedProbe`, `deadlineRangeError`, `withDeadline`)                                                                                                                                                                                | The resilience types are type-only exports; pure helpers are exported as values from their own files. `deadlineRangeError` is the sibling shape "returns the refusal or `null`" this plan copies (`packages/common/src/health/deadline.ts`).                                                                                                                    |
| `services/` holds value exports               | `packages/common/src/services/cursor.ts`, `write-precondition.ts`, `outbox.ts` (each has `export function`)                                                                                                                                                                                                                      | A pure function beside its contract in `src/services/` has precedent.                                                                                                                                                                                                                                                                                           |
| Readers of `policy.threshold` (compile break) | `packages/resilience-plugin/src/patterns/circuit-breaker.ts:122`; `packages/sdk/src/circuit-breaker/circuit-breaker.ts:96`; `packages/sdk/src/sdk.ts:39`                                                                                                                                                                         | Three source readers. The union has no common `threshold`, so all three fail to compile unless narrowed. M143c §4 names the `resilience-plugin` reader, but its §3.7 does not plan for the merge order (this PR lands first), so this plan keeps it compiling (§3.7).                                                                                           |
| Other readers of the type                     | `packages/sdk/src/http/http-client.ts:121,140,256-257`; `sdk/src/http/contracts.ts:12,15,205`; `sdk/src/index.ts:31`; `resilience-plugin/src/services/resilience-service.ts:133`; `resilience-plugin/src/interfaces/index.ts:43`                                                                                                 | Pass the policy through or re-export it; none reads an arm field. They compile unchanged.                                                                                                                                                                                                                                                                       |
| Count rule, resilience-plugin                 | `packages/resilience-plugin/src/patterns/circuit-breaker.ts:116-126`                                                                                                                                                                                                                                                             | Push `now`, keep `t > now - timeout`, trip at `length >= threshold`. Never clears on a closed-state success; clears on a half-open success (`:101-103`); a failed probe reopens without touching the window (`:105-109`).                                                                                                                                       |
| Count rule, SDK                               | `packages/sdk/src/circuit-breaker/circuit-breaker.ts:76-101`                                                                                                                                                                                                                                                                     | Keep `at - ts < timeout`, push, trip at `length >= threshold` (the same rule). Clears the window and closes on **every** success (`:77-80`). A failed probe sets `failures = [at]` and restarts the cooldown (`:89-92`). A non-failure error records nothing (`:85`). Any success, even one settling after the circuit tripped, sets `openedAt = null` (`:79`). |
| SDK failure classifier                        | `packages/sdk/src/http/http-client.ts:257-266`                                                                                                                                                                                                                                                                                   | `HttpClientError` → failure iff `status >= 500`; abort → not a failure; anything else → failure. Boolean.                                                                                                                                                                                                                                                       |
| SDK breaker validation                        | `packages/sdk/src/sdk.ts:24,37-42`; `sdk/src/http/contracts.ts:204`                                                                                                                                                                                                                                                              | `createClient` throws `Error('circuitBreaker.threshold must be >= 1')`; nothing else checked; `HttpClient` constructed directly checks nothing (unlike retry, which `HttpClient` validates itself at `http-client.ts:139`).                                                                                                                                     |
| SDK open-circuit message                      | `packages/sdk/src/circuit-breaker/circuit-breaker.ts:64-66`                                                                                                                                                                                                                                                                      | `` `Circuit breaker open for origin; ${failures.length} failures in window` ``.                                                                                                                                                                                                                                                                                 |
| SDK timing                                    | `packages/sdk/src/http/contracts.ts:154-156` `IClientTiming.now()`                                                                                                                                                                                                                                                               | Monotonic ms; the breaker passes `timing.now` as the window clock.                                                                                                                                                                                                                                                                                              |
| Tests pinning the old type                    | `packages/common/test/unit/index.test.ts:136,161` (`:161` reads `_cb.threshold`, which still compiles because the declared type narrows on assignment); `resilience-plugin/test/unit/{circuit-breaker,resilience-service}.test.ts:6-7`; `sdk/test/unit/sdk.test.ts:182-188`                                                      | Count-arm literals stay assignable. `sdk.test.ts:188` asserts the old message and changes with §3.5.                                                                                                                                                                                                                                                            |
| Docs naming the type                          | `PUBLIC_API.md:9220,9282,14162,16051,16238`; `packages/common/README.md:443`; `packages/sdk/README.md:91,119,258-290,596,639`; `packages/sdk/AGENT_CARD.md:54`; `packages/resilience-plugin/README.md:46`                                                                                                                        | `sdk/README.md:283` states "A successful probe closes the circuit and clears the window" (stays true); nothing documents the closed-state clear. `resilience-plugin/README.md:46` is M143c's.                                                                                                                                                                   |
| SDK's type-only `common` rule                 | `packages/sdk/test/unit/type-only-common.test.ts:3-75` (M98n §3.3, audit row O10); `packages/sdk/README.md:10,331-332`; `ARCHITECTURE.md:1624`; `PUBLIC_API.md:13981`; comments at `sdk/src/trace/trace-context-interceptor.ts:4`, `sdk/src/diagnostics/outbound-http-observations.ts:8-13`, `sdk/src/http/observed-fetch.ts:28` | Every SDK import of `common` is `import type`; a source scan and a `deno info` module-graph check refuse a value import. The outbound-HTTP collector and the trace validator are deliberate local copies kept in step by shared test tables. Importing `createBreakerWindow` is the SDK's first runtime edge into `common` (§3.8).                              |
| `common` exports map                          | `packages/common/package.json` `exports` (`.` only), `sideEffects: false`; `packages/common/deno.json` `exports: "./src/index.ts"`; subpath precedent `packages/validation-plugin/{package,deno}.json` `./zod`                                                                                                                   | `common` has no subpath today. A new subpath also needs the snippets `tsconfig` path alias, the fence-compiler and api-docs target counts in root tests (M137c's `./zod` checklist).                                                                                                                                                                            |
| M143c design source                           | M143c plan §3.7, §11 (Core OD4 and CLI OD4b bullets), §12 OD4/OD4b, on `feat/m143c-calls-between-services`                                                                                                                                                                                                                       | Primitive surface `recordSuccess()`, `recordFailure(): boolean`, `reset()`, `failures`; count arm exact timestamps; rate arm ten buckets over `timeout`; trip at `calls >= minimumCalls && failures * 100 / calls >= failureRateThreshold`; `failureRateThreshold` 1–100; monotonic clock as a function; half-open stays per package.                           |

### 1.1 Compared with (sibling code and established frameworks)

Read on 2026-11-23 from the docs and source named; "not verified" where the source was not readable.

| Question                              | This repo (both breakers)       | Resilience4j                                                                           | Polly v8                                                   | opossum                                                     | Hystrix                                       |
| ------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Rate unit and default                 | none (count only)               | percent, `failureRateThreshold` 50 (docs table)                                        | ratio, `FailureRatio` 0.1 (docs defaults)                  | percent, `errorThresholdPercentage` 50 (`lib/circuit.js`)   | percent, `errorThresholdPercentage` 50 (wiki) |
| Minimum volume                        | none                            | `minimumNumberOfCalls` 100                                                             | `MinimumThroughput` 100                                    | `volumeThreshold` 0                                         | `requestVolumeThreshold` 20                   |
| Comparison                            | count `>=`                      | `>=` (`CircuitBreakerMetrics.java`)                                                    | not verified (docs example "meets the threshold")          | `>` (`lib/circuit.js` `fail()`)                             | `>=` (`HystrixCircuitBreaker.java`)           |
| Time window and buckets               | exact timestamps over `timeout` | time-based: one bucket per second over `slidingWindowSize` s; count-based also offered | `SamplingDuration` 30 s in 10 buckets (`HealthMetrics.cs`) | `rollingCountTimeout` 10 s in 10 buckets (`lib/status.js`)  | 10 s in 10 buckets (wiki)                     |
| Expiry granularity                    | exact                           | bucket                                                                                 | bucket                                                     | bucket                                                      | bucket                                        |
| Closed-state success clears failures? | plugin no; **SDK yes**          | no (`ClosedState.onSuccess`)                                                           | no (`IncrementSuccess`)                                    | no                                                          | no (`markSuccess` acts on half-open only)     |
| Reset when                            | half-open success               | new `ClosedState` on transition to closed                                              | not verified                                               | never (stats kept on close)                                 | half-open success (`resetStream`)             |
| Predicate-excluded error              | SDK: ignored                    | not-recorded → counted as **success**; `ignoreExceptions` → neither                    | not verified                                               | `errorFilter` → **success** (`handleError` emits `success`) | not verified                                  |
| Absolute-count trip offered           | yes (only form)                 | no                                                                                     | no                                                         | no (`maxFailures` deprecated)                               | no                                            |
| Half-open trials                      | one                             | 10, closes after all complete                                                          | one (docs diagram)                                         | one                                                         | one                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                     | Resolution (picked side)                                                                                                            | Doc deliverable (same PR)                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| C1  | `sdk/README.md:271-278` calls the SDK breaker "rolling-window" with "`threshold` counted failures inside it", while the code clears the window on every success (`circuit-breaker.ts:77-80`), so it is "N failures since the last success".  | The README's rule wins: the SDK moves onto the shared window and stops clearing on a closed-state success (OD4b A, decided).        | `sdk/README.md` Circuit Breaker section states the rule and the rate arm; `CHANGELOG.md` Changed line; upgrade note. |
| C2  | M143c plan §3.7 says the union breaks only the SDK's compile; `resilience-plugin/src/patterns/circuit-breaker.ts:122` reads `threshold` too.                                                                                                 | Source wins: this PR keeps `resilience-plugin` compiling with the guard in §3.7 (OD-A), and the hand-over note to M143c records it. | Hand-over note in the shared notes folder; the PR body.                                                              |
| C4  | `sdk/README.md:288-290` says a 4xx `HttpClientError` "does **not**" count; under §3.4 a 4xx counts as a success in the rate arm's denominator. `common/README.md:443` and `sdk/README.md:639` list `CircuitBreakerPolicy` as an "interface". | Code wins after this PR: a 4xx is never a failure and is a call on the rate arm; the type is a union.                               | The README sentence states both; the two kind cells read "type".                                                     |
| C5  | The SDK's type-only rule (§1) against OD4b's "trip rule lives once in `common`".                                                                                                                                                             | §3.8 (OD-E).                                                                                                                        | Every doc and comment named in the §1 type-only row.                                                                 |
| C3  | `sdk/src/http/contracts.ts:204` and `sdk/src/sdk.ts:24` document only "`threshold < 1` throws".                                                                                                                                              | Replaced by the shared check (§3.5).                                                                                                | The two JSDoc blocks and `PUBLIC_API.md` SDK `ClientOptions`.                                                        |

## 3. Design decisions

### 3.1 The policy is a union of two named arms

- **Decision:** in `packages/common/src/services/resilience.ts`:
  - `CircuitBreakerCountPolicy { readonly threshold: number; readonly timeout: number; readonly resetTimeout: number; readonly failureRateThreshold?: never; readonly minimumCalls?: never }`
    — today's interface, unchanged in meaning, renamed as an arm.
  - `CircuitBreakerRatePolicy { readonly failureRateThreshold: number; readonly minimumCalls: number; readonly timeout: number; readonly resetTimeout: number; readonly threshold?: never }`.
  - `type CircuitBreakerPolicy = CircuitBreakerCountPolicy | CircuitBreakerRatePolicy`,
    `@since 0.1.0` kept, with a JSDoc paragraph naming both arms and that a policy holding fields of
    both is refused (§3.5).
  - JSDoc per field: `threshold` (failures within `timeout` that trip; positive safe integer),
    `failureRateThreshold` (percent of calls in the window that are failures, 1–100, compared with
    `>=`), `minimumCalls` (calls the window must hold before the rate is checked; positive safe
    integer), `timeout` (window length in ms of the monotonic clock: exact on the count arm, ten
    buckets of `timeout / 10` on the rate arm), `resetTimeout` (cooldown in ms before half-open).
  - The `?: never` members make a literal with fields of both arms a compile error; they are
    type-only and read by nothing at run time (the runtime refusal is §3.5).
- **Why:** OD4 A (decided). Named arms let an application type a constant and let both breakers
  narrow with `policy.threshold !== undefined` (`'threshold' in policy` does not narrow: the
  `?: never` member declares the property on the rate arm too; checked with tsc under `strict` and
  `exactOptionalPropertyTypes`); `?: never` closes TypeScript's non-discriminated-union
  excess-property gap, which otherwise accepts `{ threshold, failureRateThreshold, … }`.
- **Test home:** `packages/common/test/unit/breaker-window.test.ts` (type rows with
  `// @ts-expect-error` for the mixed literal and for a rate literal missing `minimumCalls`);
  `packages/common/test/unit/index.test.ts:136` keeps its count literal.

### 3.2 `createBreakerWindow(policy, now)` holds the trip rule once

- **Decision:** new file `packages/common/src/services/breaker-window.ts`, exported from the barrel:

  ```ts
  export interface IBreakerWindow {
    recordSuccess(): void;
    recordFailure(): boolean; // true when this failure trips the policy
    reset(): void;
    readonly failures: number;
  }
  export function createBreakerWindow(
    policy: CircuitBreakerPolicy,
    now: () => number,
  ): IBreakerWindow;
  ```

  `createBreakerWindow` first throws `breakerPolicyRangeError(policy)` when it is non-null (§3.5),
  then snapshots the policy fields (a caller mutating its object later changes nothing — the SDK
  retry precedent, `client-resilience.test.ts:297`). `now` is read once per `record*` call and once
  per `failures` read; it is a monotonic ms clock (`runtime.hrtime`, `IClientTiming.now`). No
  timers, no runtime API.

- **Count arm (exact):** `recordFailure()` reads `t = now()`, appends it, drops every timestamp with
  `t - ts >= timeout`, keeps at most the newest `threshold` timestamps (older ones cannot change a
  `>= threshold` answer, so memory is bounded by `threshold`), and returns `length >= threshold`.
  `recordSuccess()` does nothing. `failures` is the count with `now() - ts < timeout`. This is
  exactly both packages' rule today (§1) minus the SDK's clear.
- **Rate arm (ten buckets):** bucket width `w = timeout / 10`; the bucket key is
  `Math.floor(now() / w)`. A fixed ring of ten slots `{ key, calls, failures }`, slot index
  `key mod 10` (non-negative modulo); writing to a slot whose stored key differs zeroes it first. A
  slot counts toward the window when `currentKey - slot.key < 10`. `recordSuccess()` adds one call;
  `recordFailure()` adds one call and one failure, then returns
  `calls >= minimumCalls && failures * 100 >= failureRateThreshold * calls` (integer-safe form of
  `failures * 100 / calls >= failureRateThreshold`). `failures` is the windowed failure sum. A call
  therefore counts for between `0.9 · timeout` and `timeout` after it was recorded (stated in the
  JSDoc and both READMEs).
- **`reset()`** empties the window on both arms.
- **No clearing on a closed-state success** on the count arm or the rate arm (every compared
  library, §1.1).
- **What stays in each package:** the half-open state machine, the single-probe guard, cancellation,
  the error classes, and when to call `reset()`.
- **Why:** M143c §3.7 (maintainer condition on OD4b): one rule, written once. Ten buckets over the
  window match Polly, opossum and Hystrix; an aligned key grid needs no timer and no stored start
  time. `>=` matches Resilience4j and Hystrix (opossum alone uses `>`). Truncating the count arm to
  `threshold` entries bounds memory at any failure rate, which the two copies today do only because
  the state machine stops recording once open.
- **Test home:** `packages/common/test/unit/breaker-window.test.ts` — a conformance table (data,
  iterated by one `it.each`) of `{ policy, steps: [{ at, op }], expect: { trips, failures } }` rows
  covering: count — below threshold, at threshold, a failure aged out exactly at `timeout`, success
  does not clear, truncation keeps the answer, `failures` read after ageing; rate — below
  `minimumCalls` never trips, at `minimumCalls` at the rate trips, just under the rate does not,
  `failureRateThreshold: 100` needs all failures, one in three failing at 50 % does not trip at high
  volume, a bucket expires after ten widths but not nine, a slot reused after wrap-around is zeroed,
  a non-integer width (`timeout: 15`); both — `reset()` empties, the policy snapshot ignores later
  mutation, an invalid policy throws the same `RangeError` as `breakerPolicyRangeError`.

### 3.3 The SDK breaker runs on the window

- **Decision:** `packages/sdk/src/circuit-breaker/circuit-breaker.ts` replaces `failures: number[]`
  with `createBreakerWindow(policy, () => timing.now())` and keeps `openedAt` and
  `halfOpenInFlight`.
  - A success outside a probe: `window.recordSuccess()` and nothing else — it never touches
    `openedAt`, so a call admitted while closed that settles after the trip no longer closes the
    circuit (today `:79` does). This matches `resilience-plugin`, whose closed path changes no state
    on success.
  - Half-open (probe) success: `window.reset()`, `openedAt = null` (unchanged outward behaviour,
    `README.md:283`).
  - A failure outside a probe:
    `if (window.recordFailure()) { openedAt = at; trippedWith = window.failures }` — unchanged in
    effect, including a late failure that restarts the cooldown of an already open circuit (both
    packages do that today). The count arm's window holds at most `threshold` entries (§3.2).
  - Failed probe: `window.reset(); window.recordFailure(); openedAt = at; trippedWith = 1` — the
    same state as today's `failures = [at]`.
  - Open message: `` `…; ${trippedWith} failures in window` `` (text unchanged), where `trippedWith`
    is the failure count snapshotted when the circuit opened. Reading `window.failures` at refusal
    time would report `0` once failures age out while the circuit stays open
    (`timeout < resetTimeout`, test `:117`); today's array never ages while open, so the snapshot
    keeps the message as it is.
  - The file's design-notes header drops the reset-on-success paragraph and states the shared rule.
- **Why:** OD4b A (decided); C1.
- **Test home:** `packages/sdk/test/unit/circuit-breaker.test.ts` — every existing row's third
  argument changes from a boolean predicate to the three-valued classifier (`() => true` →
  `() => 'failure'`; the `(err) => !(…)` rows at `:166` and `:261` → `'ignore'` for the excluded
  error), assertions unchanged; new rows: a late success after the trip leaves the circuit open; a
  success between failures no longer resets the count (count arm trips at 3 failures with successes
  interleaved inside `timeout`); the rate arm trips and fails fast; a failed probe then a refused
  call reports "1 failures in window"; `client-resilience.test.ts` one rate-arm row through
  `createClient`.

### 3.4 What a non-failure error counts as in the SDK (OD-B)

- **Decision (recommended, OD-B A):** the classifier becomes three-valued,
  `classify(error): 'failure' | 'success' | 'ignore'`, internal to the SDK:
  - `HttpClientError` with `status >= 500` → `'failure'`; with `status < 500` → `'success'` (the
    origin answered);
  - an abort → `'ignore'` (the caller left; says nothing about the origin);
  - anything else → `'failure'` (unchanged).
  - In the closed state `'success'` calls `recordSuccess()`. In half-open a non-failure error leaves
    the circuit probeable (unchanged, test `circuit-breaker.test.ts:157`), whether `'success'` or
    `'ignore'`: closing on a 4xx probe is a behaviour change nobody asked for.
- **Why:** on the count arm `recordSuccess()` is a no-op, so only the rate arm sees a difference: a
  4xx must sit in the denominator, or a client whose traffic is mostly 404s trips on its rare 5xx.
  Resilience4j counts a not-recorded exception as a success and opossum counts a filtered error as a
  success (§1.1); neither counts a cancellation. Rejected: B, ignore 4xx too (fewer calls in the
  denominator inflate the rate); C, count an abort as a success (dilutes the rate with requests that
  never reached the origin).
- **Test home:** `packages/sdk/test/unit/circuit-breaker.test.ts` (rate arm: 404s in the window keep
  one 5xx under the rate; aborts do not count toward `minimumCalls`); `http-client.test.ts` for the
  classifier's three outputs.

### 3.5 One policy check, in `common` (OD-C)

- **Decision (recommended, OD-C A):** export
  `breakerPolicyRangeError(policy: CircuitBreakerPolicy): RangeError | null` from
  `breaker-window.ts` (the `deadlineRangeError` shape). Rules, each refusal naming the field and the
  received value:
  - neither arm (no `threshold` and no `failureRateThreshold`), or fields of both → refused;
  - `threshold`, `minimumCalls`: positive safe integers;
  - `failureRateThreshold`: finite, `1 <= x <= 100`;
  - presence is `field !== undefined` everywhere (so a JavaScript `{ threshold: undefined, … }` is
    classified the same by the check and by both breakers);
  - `timeout`: finite, at most `2_147_483_647` (the timer range M143c §3.7 planned), and `> 0` on
    the count arm, `>= 10` on the rate arm (so the bucket width is at least 1 ms: a smaller width
    makes `Math.floor(now / w)` overflow towards `Infinity` and the slot index `NaN`);
    `resetTimeout`: finite, `0`–`2_147_483_647`.
  - Exact message form, produced by `common` itself:
    `` `circuitBreaker.${field} must be ${rule}; received ${String(value)}` `` (for example
    `circuitBreaker.threshold must be a positive safe integer; received 0`), and
    `circuitBreaker must set either threshold or failureRateThreshold, not both` /
    `…, received neither`. `createBreakerWindow` throws it. The SDK calls it in the `HttpClient`
    constructor (so it holds however the client is built, as `validateRetryPolicy` does at
    `http-client.ts:139`) and `createClient`'s own `threshold < 1` check is deleted. The message
    changes from `circuitBreaker.threshold must be >= 1` to the shared text above, unprefixed by the
    SDK. M143c's planned `validateCircuitBreakerPolicy` becomes a call to it.
- **Why:** a check written twice drifts as the trip rule did. Rejected: B, validate inside each
  package (M143c's plan as written) — two copies; C, validate only in `createBreakerWindow` — the
  SDK builds its window lazily per origin at the first request, so a bad policy would throw on the
  first call rather than at construction.
- **Test home:** `breaker-window.test.ts` (a refusal table, data-driven, one row per rule and
  boundary, plus the valid boundary values); `sdk/test/unit/sdk.test.ts:182-188` (new message) and a
  direct-`HttpClient` row in `client-resilience.test.ts`.

### 3.6 Exports, docs and versioning

- **Decision:** barrel exports `createBreakerWindow`, `breakerPolicyRangeError` (values) and
  `IBreakerWindow`, `CircuitBreakerCountPolicy`, `CircuitBreakerRatePolicy` (types), each with JSDoc
  and `@since 0.14.0`. `CHANGELOG.md` `[Unreleased]`: an Added entry (common, the rate arm and
  primitive; sdk, the rate arm) and a **BREAKING** Changed entry (`CircuitBreakerPolicy` is a union,
  so code reading `.threshold` off it must narrow; the SDK no longer clears its window on a
  closed-state success, and refuses an invalid policy at construction with the new message), both
  naming V13-104. `docs/upgrading.md` `## Unreleased` gets one subsection covering both. Ships in
  `0.14.0`.
- **Recording (OD-D, recommended A):** this follow-up has no ROADMAP letter. A: a CLAUDE.md "Current
  status" line "Milestone 143 Core follow-up — circuit breaker" naming V13-104's Core and SDK halves
  and the PR, and one sentence in ROADMAP.md's M143 section beside the M143c row ("V13-104's Core
  and SDK halves ship in the Core breaker follow-up"); no row flip, since V13-104 stays M143c's. B:
  a new ROADMAP letter (M143s) — rejected, the lane table already assigns the row.
- **Test home:** `packages/common/test/unit/barrel-exports.test.ts`; `check:docs` and the fence gate
  for README examples.

### 3.7 `resilience-plugin` keeps compiling until M143c (OD-A)

- **Decision (recommended, OD-A A):** a narrowing guard in
  `packages/resilience-plugin/src/patterns/circuit-breaker.ts`'s constructor: a policy with
  `policy.threshold === undefined` throws
  `RangeError('circuitBreaker: the rate arm (failureRateThreshold) is not supported by this version of @setu-ts/resilience-plugin')`,
  and `#policy` is typed `CircuitBreakerCountPolicy`; one test row. Nothing else in the package
  changes. M143c §3.7 then deletes the guard when it moves `CircuitBreaker` onto the window. The
  edit is cross-lane and is flagged as such.
- **Why:** this PR cannot merge with `resilience-plugin` failing `pnpm run check`, and an unguarded
  cast would silently run a rate policy as a count policy with `threshold` `undefined` (never trips:
  `length >= undefined` is false). Rejected: B, move `CircuitBreaker` onto the window here (does
  M143c's §3.7 without its validation, tests and docs, and races its branch); C, no edit and merge
  this PR only stacked under M143c (couples two PRs and leaves the SDK half waiting on M143c's F3).
- **Test home:** `packages/resilience-plugin/test/unit/circuit-breaker.test.ts` (one row: a rate
  policy throws the `RangeError`).

### 3.8 The SDK's first runtime edge into `common` (OD-E)

- **Decision (recommended, OD-E A):** `breaker-window.ts` is a leaf module — its only imports are
  `import type` from `./resilience.ts` — published as a new subpath `@setu-ts/common/breaker-window`
  (`package.json` `exports["./breaker-window"]` → `dist/services/breaker-window.{js,d.ts}`;
  `deno.json` `exports` becomes a map with `"."` and `"./breaker-window"`), and also re-exported
  from the barrel (the same module, so one implementation). The SDK value-imports
  `createBreakerWindow` and `breakerPolicyRangeError` from the subpath only.
  `type-only-common.test.ts` becomes: every SDK import of `common` is `import type` **except** value
  imports from `@setu-ts/common/breaker-window` (an allowlist of exactly that specifier, with a
  positive control that the scan sees it), and the `deno info` check asserts that the only runtime
  edge into `common` resolves to `breaker-window.ts` and that this module has no runtime dependency
  of its own. Doc deliverables: `sdk/README.md:10` and `:331-332`, `ARCHITECTURE.md:1624` (the SDK
  row), `PUBLIC_API.md:13981`, and the three source comments in the §1 type-only row, each restated
  as "type-only except the dependency-free breaker window"; the M137c subpath checklist (snippets
  `tsconfig` alias, fence-compiler and api-docs target counts).
- **Why:** OD4b A requires the rule written once in `common`; a leaf subpath keeps what the
  type-only rule protects — the browser SDK loads no other `common` code, bundled or not (`common`
  is `sideEffects: false`, but an unbundled ESM import of the barrel would load its whole graph).
  Rejected: B, import from the barrel and drop the rule (every unbundled SDK consumer loads all of
  `common`); C, a local SDK copy kept in step by importing `common`'s conformance table into an SDK
  test (the precedent of the outbound-HTTP collector, but two copies of the rule — what the
  maintainer's condition on OD4b rules out).
- **Test home:** `packages/sdk/test/unit/type-only-common.test.ts` (rewritten as above);
  `packages/common/test/unit/breaker-window.test.ts` imports the subpath specifier once, and
  `barrel-exports.test.ts` asserts the barrel and the subpath export the same function objects.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `CircuitBreakerPolicy` changes from an interface to a union, so code
that reads `.threshold` (or any arm field) off a `CircuitBreakerPolicy` no longer compiles without
narrowing; the SDK's breaker stops clearing on a closed-state success and its construction refusal
message changes — ships in minor `0.14.0`.

| Exported symbol                  | Kind      | Consumer / real code path that READS it                                                                                                                 |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CircuitBreakerPolicy`           | type      | Existing: `WrapOptions`, `resilience-plugin` options and service, `sdk` `ClientOptions`, `HttpClient`, the SDK breaker; now also `createBreakerWindow`. |
| `CircuitBreakerCountPolicy`      | type      | The union; `createBreakerWindow`'s count branch; `resilience-plugin`'s guarded `#policy` (§3.7).                                                        |
| `CircuitBreakerRatePolicy`       | type      | The union; `createBreakerWindow`'s rate branch; `breakerPolicyRangeError`'s rate rules.                                                                 |
| `IBreakerWindow`                 | interface | Return type of `createBreakerWindow`; the SDK breaker's window field; M143c's `CircuitBreaker`.                                                         |
| `createBreakerWindow`            | function  | `sdk/src/circuit-breaker/circuit-breaker.ts` (this PR); `resilience-plugin` `CircuitBreaker` (M143c).                                                   |
| `breakerPolicyRangeError`        | function  | `createBreakerWindow`; `sdk` `HttpClient` constructor (this PR); M143c's `validateCircuitBreakerPolicy`.                                                |
| `@setu-ts/common/breaker-window` | subpath   | The SDK's two value imports (§3.8). Exports `createBreakerWindow`, `breakerPolicyRangeError`, `IBreakerWindow` only.                                    |

### 4.1 Options — every option names its consumer

| Option                                 | Consumer                                                        | Behavior (per implementation)                                                                 |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `threshold`                            | count branch of `createBreakerWindow`                           | SDK: trip count (via the window). resilience-plugin: unchanged own rule until M143c.          |
| `failureRateThreshold`, `minimumCalls` | rate branch of `createBreakerWindow`; `breakerPolicyRangeError` | SDK: trip on rate (via the window). resilience-plugin: refused by the §3.7 guard until M143c. |
| `timeout`                              | both branches of `createBreakerWindow`                          | Count: exact window. Rate: ten buckets of `timeout / 10`.                                     |
| `resetTimeout`                         | each package's state machine (not the window)                   | Unchanged in both packages. Validated by `breakerPolicyRangeError`.                           |

## 5. Implementation files

| File                                                                                               | Purpose                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/index.ts`                                                                     | Barrel: two values, three types.                                                                                                                                                                                                     |
| `packages/common/package.json`, `packages/common/deno.json`                                        | The `./breaker-window` subpath (§3.8).                                                                                                                                                                                               |
| `test/fixtures/snippets/tsconfig.json` and the root fence-compiler and api-docs target-count tests | The subpath's path alias and counts (M137c checklist); also `test/deno-lane/lane.config.json` and `scripts/node-manifests.ts`, which name `@setu-ts/validation-plugin/zod` today and get the matching entry where they map subpaths. |
| `packages/common/src/services/resilience.ts`                                                       | The union and its two arms with field JSDoc.                                                                                                                                                                                         |
| `packages/common/src/services/breaker-window.ts` (new)                                             | `createBreakerWindow`, `IBreakerWindow`, `breakerPolicyRangeError`.                                                                                                                                                                  |
| `packages/sdk/src/circuit-breaker/circuit-breaker.ts`                                              | On the window; three-valued classifier input; header notes.                                                                                                                                                                          |
| `packages/sdk/src/http/http-client.ts`                                                             | Construction check through `breakerPolicyRangeError`; the classifier returns `'failure' \| 'success' \| 'ignore'`.                                                                                                                   |
| `packages/sdk/src/sdk.ts`                                                                          | Delete the `threshold < 1` check; JSDoc names the shared check.                                                                                                                                                                      |
| `packages/sdk/src/http/contracts.ts`                                                               | `circuitBreaker` JSDoc (both arms, the refusal).                                                                                                                                                                                     |
| `packages/resilience-plugin/src/patterns/circuit-breaker.ts`                                       | §3.7 guard only.                                                                                                                                                                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                      | src covered                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/breaker-window.test.ts` (new)       | `breaker-window.ts`, `resilience.ts` (types) | §3.2 conformance table and §3.5 refusal table, each data iterated by `it.each`; `createBreakerWindow(policy, () => clock)` against `(CircuitBreakerPolicy, () => number)`; `@ts-expect-error` type rows (§3.1).                                                        |
| `packages/common/test/unit/barrel-exports.test.ts`             | `index.ts`                                   | The two values are exported functions; type imports compile.                                                                                                                                                                                                           |
| `packages/common/test/unit/index.test.ts`                      | `index.ts`                                   | Count literal at `:136` unchanged; add a rate literal.                                                                                                                                                                                                                 |
| `packages/sdk/test/unit/circuit-breaker.test.ts`               | `circuit-breaker/circuit-breaker.ts`         | §3.3 and §3.4 rows; every existing row's predicate rewritten to the classifier (§3.3), assertions unchanged; `createCircuitBreaker(policy, timing, classify)` against `(CircuitBreakerPolicy, IClientTiming, (error: unknown) => 'failure' \| 'success' \| 'ignore')`. |
| `packages/sdk/test/unit/http-client.test.ts`                   | `http/http-client.ts`                        | Classifier outputs for 503, 404, abort, a transport `TypeError`; direct construction with an invalid policy throws.                                                                                                                                                    |
| `packages/sdk/test/unit/sdk.test.ts`                           | `sdk.ts`                                     | `createClient` with `threshold: 0` throws `RangeError` `circuitBreaker.threshold must be a positive safe integer; received 0`; a rate policy constructs.                                                                                                               |
| `packages/sdk/test/integration/client-resilience.test.ts`      | `http-client.ts`, breaker                    | A rate policy through `createClient` trips and then fails fast without fetching.                                                                                                                                                                                       |
| `packages/sdk/test/unit/http-contracts.test.ts`                | `http/contracts.ts` (types)                  | A rate policy is assignable to `ClientOptions.circuitBreaker`.                                                                                                                                                                                                         |
| `packages/sdk/test/unit/type-only-common.test.ts`              | all SDK `src/` imports                       | The allowlist and module-graph rules of §3.8, each with a positive control.                                                                                                                                                                                            |
| `packages/resilience-plugin/test/unit/circuit-breaker.test.ts` | `patterns/circuit-breaker.ts`                | One row: a rate policy throws the §3.7 `RangeError`; existing rows unchanged.                                                                                                                                                                                          |

No external dependency is added, so no guarded real-import test applies (checked).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143-core-breaker, never develop or main
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common sdk resilience-plugin   # edit loop; ANSI-stripped per-file table ≥ 90%
setu-suite-queue pnpm run ci:local                # once, on the final commit
setu-suite-queue pnpm run test:deno-lane
setu-suite-queue pnpm run release:publish --dry-run
setu-suite-queue pnpm run release:verify 0.13.0
```

Every behaviour change has a test that fails on `develop` and passes with the change (the SDK's
interleaved-success trip, the rate arm, the 404 denominator, the direct-construction refusal),
recorded under the worktree's `.tmp/`. A security audit is not required: the diff crosses no trust
boundary (no network input parsing, credentials, authorization, tenancy or data egress; the breaker
decides only whether the client's own outbound call is attempted).

## 8. Risks & mitigations

- **M143c builds on a different reading of the primitive** → the hand-over note in the shared folder
  lists the exact exported names, the guard to delete, `breakerPolicyRangeError` replacing its
  planned validator, and the conformance table as the rule's source of truth.
- **Existing SDK users relied on clear-on-success** (a slow drip with successes between never
  tripped) → BREAKING CHANGELOG entry and the upgrade note with the exact before/after.
- **Floating-point bucket keys at a non-integer width** → keys are `Math.floor(now / w)` of finite
  numbers; the conformance table has a `timeout: 15` row.
- **A caller holding a policy object of fields of both arms from JavaScript** → refused at
  construction by §3.5, not resolved by precedence.

## 9. Out of scope

- `resilience-plugin`'s rate arm, its window move, `validateCircuitBreakerPolicy`, README and tests
  — M143c §3.7.
- A count-based "last N calls" window (Resilience4j's default) — not asked for by V13-104; the union
  can grow a third arm later.
- Slow-call rate (Resilience4j) and half-open trial counts above one — no row asks for them.
- The `docs/` site pages for resilience — M143n repeats README changes.
