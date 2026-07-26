# @hono-enterprise/resilience-plugin

Circuit breaker, retry, timeout, and bulkhead. Registers an `IResilienceService` under
`CAPABILITIES.RESILIENCE` (`'resilience'`).

Zero dependencies. `wrap()` composes the four patterns around any `() => Promise<T>` in a fixed
order — **bulkhead → circuitBreaker → retry → timeout → fn** — and builds them once per `wrap` into
a state-preserving closure, so the breaker and bulkhead accumulate state across calls.

## Installation

```typescript
import { ResiliencePlugin } from '@hono-enterprise/resilience-plugin';
```

## Usage

```typescript
import { ResiliencePlugin } from '@hono-enterprise/resilience-plugin';
import { CAPABILITIES, type IResilienceService } from '@hono-enterprise/common';

app.register(ResiliencePlugin({
  defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
}));

const resilience = app.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);

// `retry: true` consumes the plugin default; `timeout` is per-wrap.
const callApi = resilience.wrap(() => externalApi.call(), { retry: true, timeout: 2000 });

await callApi();
```

## Options

| Option                  | Type                   | Description                                         |
| ----------------------- | ---------------------- | --------------------------------------------------- |
| `defaultCircuitBreaker` | `CircuitBreakerPolicy` | Consumed when a `wrap` sets `circuitBreaker: true`. |
| `defaultRetry`          | `RetryPolicy`          | Consumed when a `wrap` sets `retry: true`.          |
| `defaultBulkhead`       | `BulkheadPolicy`       | Consumed when a `wrap` sets `bulkhead: true`.       |

Setting a pattern to `true` with **no matching plugin default throws** — an unconfigured policy is a
mistake, not a silent no-op.

## Errors

`TimeoutError`, `BulkheadFullError`, and `CircuitOpenError` are exported for `instanceof` handling.

## Semantics

- The circuit breaker uses a monotonic rolling failure window with an open → half-open cooldown.
- **`timeout` does not cancel the underlying work.** It races the promise and cleans up its timer in
  a `finally`; the wrapped function keeps running. Pass an `AbortSignal` yourself if the operation
  supports cancellation.
- The bulkhead is a bounded FIFO queue; overflow rejects with `BulkheadFullError`.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
