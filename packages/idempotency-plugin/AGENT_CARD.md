# @setu-ts/idempotency-plugin — replay keyed requests

**Add it:** `setu add idempotency` adds it and inserts `IdempotencyPlugin()` into a recognized
functional `setu.config.ts`. It provides `CAPABILITIES.IDEMPOTENCY` (`IIdempotencyService`).

## Replay a retried payment request

Authentication must establish a principal first. List this middleware after the route's guards and
validation:

```ts
import type { IRouterApi } from '@setu-ts/common';
import { idempotent } from '@setu-ts/idempotency-plugin';

export function registerPaymentRoutes(router: IRouterApi): void {
  router.post('/payments', {
    middleware: [idempotent({ required: true })],
    handler: (ctx) => ctx.response.status(201).json({ id: 'pay-1' }),
  });
}
```

## Behaviour the types do not show

- The default key comes from the Idempotency-Key header. Missing required keys answer 400 after the
  principal check; missing principals answer 401 by default.
- A key with a different fingerprint answers 422; an active claim answers 409.
- `leaseMs` and `ttlMs` are milliseconds, defaulting to 60000 and 86400000 for HTTP.
- The default memory store is process-local; it cannot coordinate replicas. A completed record
  suppresses repeat processing only within the store's retention and claim limits.
- Place `idempotent()` last: rejected guards or validation must not consume the key.

## Other options

- `store` selects memory, Redis (`type: 'redis'`, `namespace`, `url` or `client`) or a custom store.
- `required: false` passes unkeyed requests; `response: 'status'` retains no body or headers.
- `idempotentIngress({ topics, jobNames })` builds a factory for the host's `behaviors` array; work
  outside its allow-list passes through.
- `within` needs `transactional: { store }` to commit work and its idempotency record together.
