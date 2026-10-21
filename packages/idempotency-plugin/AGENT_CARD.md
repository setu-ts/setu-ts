# @setu-ts/idempotency-plugin — one effect per key

`setu add idempotency` adds the dependency and inserts `IdempotencyPlugin()` — the memory store. It
registers `CAPABILITIES.IDEMPOTENCY`. The guarantee is no duplicate processing within the store's
limits, not exactly-once side effects.

```ts
import { IdempotencyPlugin, idempotent } from '@setu-ts/idempotency-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createPaymentApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), IdempotencyPlugin({ store: { type: 'memory' } })],
  });
  app.router.post('/payments', {
    middleware: [idempotent({ required: true })],
    handler: (ctx) => ctx.response.status(201).json({ id: 'pay-1' }),
  });
  return app;
}
```

```ts
import { idempotentIngress } from '@setu-ts/idempotency-plugin';

export const ingress = idempotentIngress({ jobNames: ['charge-card'] });
```

- `store` is `{ type: 'memory' }` (default), `{ type: 'redis', namespace, url }` (or `client`; needs
  the `ioredis` peer), or `{ type: 'custom', store }`. Memory is per process; across replicas use
  Redis, or `DurableObjectIdempotencyStore` from `@setu-ts/cloudflare-plugin` as a custom store.
- `idempotent()` reads the Idempotency-Key header by default, answers `401` without a principal
  (`principal: 'required'`), `400` for a missing key when `required`, `422` on a fingerprint
  mismatch and `409` while a claim is in progress.
- List `idempotent()` LAST in a route's `middleware` array, after guards and validation: a rejected
  request must not consume the key. `required: false` lets an unkeyed request through, and
  `response: 'status'` stores no body or headers.
- `idempotentIngress({ topics?, jobNames? })` covers queue jobs and broker messages; anything not
  listed passes through. Add `queue` to a competing-consumer `subscribe` so replicas share one
  consumer identity.
- `within(options, fn)` commits work and its record in one transaction; configure
  `transactional: { store }`, e.g. `createDatabaseIdempotencyStore` from `@setu-ts/database-plugin`.
