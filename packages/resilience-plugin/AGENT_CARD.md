# @setu-ts/resilience-plugin — circuit breaker, retry, timeout and bulkhead

`setu add resilience` installs it and registers `ResiliencePlugin()` in a recognized functional
config; otherwise add that line in `setu.config.ts`. `CAPABILITIES.RESILIENCE` resolves after
`app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IResilienceService } from '@setu-ts/common';
import { ResiliencePlugin } from '@setu-ts/resilience-plugin';

app.register(
  ResiliencePlugin({
    defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
    defaultCircuitBreaker: { threshold: 5, timeout: 10_000, resetTimeout: 30_000 },
  }),
);

await app.start();
const resilience = app.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);

const callApi = resilience.wrap(
  async (signal) => {
    void signal; // forward it to the I/O for real cancellation
    return 'ok';
  },
  { circuitBreaker: true, retry: true, timeout: 2000, bulkhead: { maxConcurrent: 8 } },
);
await callApi();
```

- `resilience.wrap` layers **bulkhead → circuitBreaker → retry → timeout → fn**. `retry: true`,
  `circuitBreaker: true` and `bulkhead: true` use the matching `default*` policy and throw when none
  is configured. Pass a policy object to override one call.
- **Hoist the wrapped callable.** State is built once per `wrap`; a `wrap` written inside a handler
  is fresh per request, so its breaker can never open and the mistake is silent.
- Each attempt receives an abort signal; the timeout aborts it. Passing a caller signal to the
  wrapped callable cancels the whole chain, including a retry loop or a queued bulkhead call.
- Errors for `instanceof`: `TimeoutError` (504), `BulkheadFullError` (503) and `CircuitOpenError`
  (503). A full bulkhead sheds rather than queueing past `maxQueue`.
- `defaultRetry` uses `limit`, `delay` and `backoff` (`'fixed'` or `'exponential'`);
  `defaultCircuitBreaker` uses `threshold`, `timeout` and `resetTimeout`, all milliseconds.
