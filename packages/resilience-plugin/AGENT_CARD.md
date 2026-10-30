# @setu-ts/resilience-plugin — protect calls to unreliable services

**Add it:** `setu add resilience` adds it and wires `ResiliencePlugin()` in a recognized functional
config. It provides `CAPABILITIES.RESILIENCE` (`IResilienceService`).

## Retry and limit an upstream HTTP call

Keep one wrapped callable across requests; initialize it when services become available:

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

## Behaviour the types do not show

- Layers execute bulkhead, circuit breaker, retry, timeout, then the supplied function.
- Breaker and bulkhead state live per `wrap` call. Creating a wrapper on every request discards
  their shared state; retain the callable as above.
- `retry.limit` counts total attempts; `1` means no retry. Delays, breaker windows, cooldowns and
  timeouts are milliseconds. Timeout applies separately to each attempt.
- Timeout aborts the attempt's signal. Forward it to the underlying I/O to cancel that work;
  ignoring it only rejects the caller's wait. A caller signal cancels the whole chain.
- A full bulkhead rejects after its queue fills; omitted `maxQueue` means no waiting queue.

## Other options

- `retry: true`, `circuitBreaker: true` and `bulkhead: true` require matching `defaultRetry`,
  `defaultCircuitBreaker` and `defaultBulkhead` policies on `ResiliencePlugin`.
- Omitted or `false` policy layers are disabled; an explicit object overrides the default.
- `TimeoutError`, `BulkheadFullError` and `CircuitOpenError` carry HTTP hints 504, 503 and 503.
