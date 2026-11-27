# @setu-ts/resilience-plugin — protect calls to unreliable services

**Add:** `setu add resilience` wires `ResiliencePlugin()` in a recognized functional config.
Provides `CAPABILITIES.RESILIENCE` (`IResilienceService`).

## Retry and limit an upstream HTTP call

Keep one wrapped callable across requests:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { HardenedCall, IResilienceService, IRouterApi } from '@setu-ts/common';

export function registerBillingRoutes(router: IRouterApi): void {
  let billing: HardenedCall<string> | undefined;
  router.get('/billing-status', {
    handler: async (ctx) => {
      billing ??= ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE).wrap(
        async (signal) => {
          const response = await fetch('https://billing.example.com/status', { signal });
          if (!response.ok) throw new Error('Billing failed');
          return await response.text();
        },
        {
          retry: { limit: 3, delay: 100, backoff: 'exponential' },
          circuitBreaker: { threshold: 5, timeout: 10000, resetTimeout: 30000 },
          timeout: 2000, bulkhead: { maxConcurrent: 8 },
        },
      );
      return ctx.response.text(await billing(ctx.signal));
    },
  });
}
```

## Behaviour

- Layers execute bulkhead, circuit breaker, retry, timeout, then the function.
- Breaker and bulkhead state live per `wrap`; retain the callable across requests.
- A breaker policy is a count or rate arm, not both.
- `retry.limit` counts total attempts (safe integer at least 1); delay is finite and non-negative.
  Invalid defaults throw RangeError at registration; selected policies at wrap. All timing is ms;
  timeout applies per attempt.
- Breakers skip already-aborted calls and count the final result after retries. An unrecovered
  timeout fails even if the function ignores abort and later resolves; without timeout, it succeeds.
- Timeout aborts the attempt's signal. Forward it to the underlying I/O to cancel that work;
  ignoring it only rejects the caller's wait. Caller cancellation stops retries and queued work.
- A full bulkhead rejects after its queue fills; omitted `maxQueue` means no waiting queue.

## Other options

- `retry: true`, `circuitBreaker: true` and `bulkhead: true` require matching `defaultRetry`,
  `defaultCircuitBreaker` and `defaultBulkhead` policies on `ResiliencePlugin`.
- Omitted/`false` layers are disabled; an object overrides the default.
- `TimeoutError`, `BulkheadFullError` and `CircuitOpenError` carry HTTP hints 504, 503 and 503.
