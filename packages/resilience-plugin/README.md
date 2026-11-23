# @setu-ts/resilience-plugin

Circuit breaker, retry, timeout, and bulkhead. Registers an `IResilienceService` under
`CAPABILITIES.RESILIENCE` (`'resilience'`).

Zero dependencies. `wrap()` composes the four patterns around any
`(signal: AbortSignal) => Promise<T>` in a fixed order — **bulkhead → circuitBreaker → retry →
timeout → fn** — and builds them once per `wrap` into a state-preserving closure, so the breaker and
bulkhead accumulate state across calls.

## Installation

```typescript
import { ResiliencePlugin } from '@setu-ts/resilience-plugin';
```

## Usage

```typescript
import { ResiliencePlugin } from '@setu-ts/resilience-plugin';
import { CAPABILITIES, type IResilienceService } from '@setu-ts/common';

app.register(
  ResiliencePlugin({
    defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
  }),
);

const resilience = app.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);

// `retry: true` consumes the plugin default; `timeout` is per-wrap.
const callApi = resilience.wrap(() => externalApi.call(), { retry: true, timeout: 2000 });

await callApi();
```

> **Hoist the wrapped call.** `wrap()` builds its breaker, bulkhead and retry state ONCE, into the
> returned closure — so a `wrap()` written inside a handler runs fresh on every request and its
> circuit breaker can never open (retry and timeout still work, which makes the mistake silent).
> Wrap at module or plugin scope; call per request.

## Options

| Option                  | Type                   | Description                                                                                                                                                                        |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultCircuitBreaker` | `CircuitBreakerPolicy` | Count or rate policy, consumed when a `wrap` sets `circuitBreaker: true`. Invalid defaults throw `RangeError` at plugin registration; invalid explicit policies throw at `wrap()`. |
| `defaultRetry`          | `RetryPolicy`          | Consumed when a `wrap` sets `retry: true`.                                                                                                                                         |
| `defaultBulkhead`       | `BulkheadPolicy`       | Consumed when a `wrap` sets `bulkhead: true`.                                                                                                                                      |

Setting a pattern to `true` with **no matching plugin default throws** — an unconfigured policy is a
mistake, not a silent no-op. A retry `limit` must be a safe integer at least 1 and `delay` must be
finite and non-negative. Invalid `defaultRetry` throws `RangeError` during plugin registration; an
invalid policy selected by `wrap` throws `RangeError` when wrapping, before the function runs.
`limit: 1` is valid and executes one attempt. Delays are milliseconds.

## Errors

`TimeoutError`, `BulkheadFullError`, and `CircuitOpenError` are exported for `instanceof` handling,
and each carries an HTTP status an application running `errorHandler` answers with. Shedding is the
bulkhead's purpose, so the status is part of the contract rather than an implementation detail:

| Error               | Served status | The condition the caller can act on                             |
| ------------------- | ------------- | --------------------------------------------------------------- |
| `BulkheadFullError` | `503`         | The bulkhead is at capacity and shed the call — back off.       |
| `CircuitOpenError`  | `503`         | The breaker is failing fast on a failing dependency — back off. |
| `TimeoutError`      | `504`         | The protected call did not answer within its deadline.          |

**None of them carries `Retry-After`.** The bulkhead's queue drains on the order of one protected
call's latency, which the framework does not measure, so it holds no honest value to state; `503` is
itself the retryable signal (RFC 9110). The rate limiter's `Retry-After` is the deliberate asymmetry
— a fixed window genuinely knows when it resets.

## Semantics

- The circuit breaker uses a monotonic rolling failure window with an open → half-open cooldown.
- A count policy `{ threshold, timeout, resetTimeout }` trips at `threshold` failures within
  `timeout` ms. A rate policy `{ failureRateThreshold, minimumCalls, timeout, resetTimeout }` trips
  on a failure when at least `minimumCalls` calls are in the window and at least
  `failureRateThreshold` percent failed. Both successes and failures count toward `minimumCalls`.
  The rate window uses ten buckets of `timeout / 10` ms: expiry is bucket-granular, so a call counts
  for between `0.9 * timeout` and `timeout`. Success never clears failures. Only a successful
  half-open probe resets the window. Already-aborted calls are not recorded; a mid-flight abort is
  recorded as failure.
- Policies use the shared `breakerPolicyRangeError` validation: `threshold` and `minimumCalls` are
  positive safe integers, `failureRateThreshold` is finite from 1 to 100, `timeout` is finite and
  greater than 0 (count) or at least 10 (rate), at most 2147483647; `resetTimeout` is finite from 0
  to 2147483647. Fields of both arms, or neither arm, are refused.
- **`timeout` cancels the attempt.** The wrapped function receives an `AbortSignal` that the timeout
  aborts when the deadline elapses, with the `TimeoutError` as its `reason`; the timer is cleared in
  a `finally`. Forward the signal to your I/O (`fetch(url, { signal })`) and the call is genuinely
  cancelled. Work that ignores the signal keeps running in the background while the caller's `await`
  rejects — a property of the supplied function, not of the wrapper.
- The bulkhead is a bounded FIFO queue; overflow rejects with `BulkheadFullError`.

## Exports

| Export                    | Kind      |
| ------------------------- | --------- |
| `ResiliencePlugin`        | function  |
| `BulkheadFullError`       | class     |
| `CircuitOpenError`        | class     |
| `TimeoutError`            | class     |
| `ResiliencePluginOptions` | interface |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#resilience-setu-tsresilience-plugin).
