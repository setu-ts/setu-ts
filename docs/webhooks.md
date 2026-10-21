# Inbound webhooks

Verify a delivery before writing anything, commit the work with its tier-C idempotency record, and
answer `2xx` quickly. Send heavy work through one of the side-effect paths below.

## Verify before any work

Verify the provider's signature over the **raw bytes**, before JSON parsing or validation
middleware. Use `crypto.subtle.verify` for cryptographic comparison rather than comparing signature
strings. Verify a signed timestamp against a tolerance too (five minutes here): an old captured
request must be refused even after its idempotency record has been purged. Never log the secret or
signature. The provider's actual signing format takes precedence over this illustrative protocol.

This example protocol signs the ASCII timestamp in seconds, a dot, and the exact request bytes with
HMAC-SHA256. It carries a hex signature in `webhook-signature` and the timestamp in
`webhook-timestamp`. These are example protocol headers, not a particular provider's API.
`IRequest.bytes()` supplies the raw body; no JSON or body-validation middleware should precede this
route. Import a verification-only HMAC key at startup using the secret from your secret manager and
`runtime.subtle.importKey`.

Bound the body read with `RuntimePlugin({ maxBodyBytes })`; the example uses 1 MiB and also refuses
an oversized declared `Content-Length` before `bytes()`. The runtime bound is still required when
the header is absent or understates the body size.

If global CSRF protection is enabled, exclude only `/webhooks/provider` from both session-plugin
form CSRF (`csrf.exclude: ['/webhooks/provider']`) and http-security's
`csrfMiddleware({ exclude: ['/webhooks/provider'] })`. The verified signature is this route's CSRF
defence. Keep CSRF enabled for the rest of the application; never disable it wholesale.

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IIdempotencyService, IRuntimeServices } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';

interface Delivery { id: string; type: string; }

const maxBodyBytes = 1024 * 1024;
export const webhookRuntime = RuntimePlugin({ maxBodyBytes });

export function registerWebhook(app: IKernelApplication, key: CryptoKey): void {
  app.router.post('/webhooks/provider', async (ctx) => {
    const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    const declaredLength = ctx.request.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > maxBodyBytes) {
      return ctx.response.status(413).json({ error: 'Delivery too large' });
    }
    const stamp = ctx.request.headers.get('webhook-timestamp') ?? '';
    const signature = ctx.request.headers.get('webhook-signature') ?? '';
    const signedAt = Number(stamp) * 1000;
    if (!/^\d{1,12}$/.test(stamp) || !/^[a-fA-F0-9]{64}$/.test(signature) ||
      Math.abs(runtime.now() - signedAt) > 5 * 60 * 1000) {
      return ctx.response.status(401).json({ error: 'Invalid delivery' });
    }
    const raw = await ctx.request.bytes();
    const prefix = new TextEncoder().encode(`${stamp}.`);
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix);
    signed.set(raw, prefix.length);
    const mac = new Uint8Array(32);
    for (let i = 0; i < mac.length; i++) mac[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
    if (!await runtime.subtle.verify('HMAC', key, mac, signed)) {
      return ctx.response.status(401).json({ error: 'Invalid delivery' });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return ctx.response.status(400).json({ error: 'Invalid event' }); }
    if (typeof parsed !== 'object' || parsed === null ||
      !('id' in parsed) || typeof parsed.id !== 'string' ||
      !/^[\x21\x23-\x7e]{1,255}$/.test(parsed.id) ||
      !('type' in parsed) || typeof parsed.type !== 'string') {
      return ctx.response.status(400).json({ error: 'Invalid event' });
    }
    const event: Delivery = { id: parsed.id, type: parsed.type };
    const idempotency = ctx.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
    const { value } = await idempotency.within<{ accepted: true }, IUnitOfWork>({
      key: event.id,
      namespace: 'webhooks.receive',
      scope: 'webhook:provider',
      fingerprint: { id: event.id, type: event.type },
    }, async (uow) => {
      // Apply this event's business changes through this same unit of work.
      await uow.getRepository<Delivery>('WebhookReceipt').create(event);
      return { accepted: true };
    });
    return ctx.response.status(200).json(value);
  });
}
```

Register the bounded `webhookRuntime` above, `DatabasePlugin`, `SchedulerPlugin` and
`IdempotencyPlugin({ transactional: { store: createDatabaseIdempotencyStore() } })`, then start the
application and call `registerWebhook` with the verification key. The
[tier-C README example](../packages/idempotency-plugin/README.md#tier-c-the-work-and-its-record-commit-together)
shows that composition; Workers instead need manual purge from a Cron Trigger. Install the outer
[error handler](../packages/exceptions/README.md) so a retryable refusal reaches the provider as an
HTTP error.

## De-duplicate with tier C

Use the provider's event id as `key`; it must be 1–255 characters in `0x21`–`0x7E`, excluding `"`,
so the example refuses invalid ids before `within`. `scope` is required and normally comes from
authenticated identity. Webhooks have no signed-in principal: the fixed `webhook:provider` scope
deliberately shares the verified provider's events across deliveries. Use a distinct scope for each
provider/account whose event-id space is independent, and derive it from trusted endpoint
configuration rather than an unsigned request field. A concurrent duplicate can reject with a
retryable `409` before the winner commits; the provider should retry that non-2xx response.

Keep `within`'s `ttlMs` greater than twice the timestamp tolerance plus the allowed clock skew: the
same signed timestamp can be accepted both before and after its stated time. With this five-minute
tolerance, retain records for more than ten minutes plus skew. The default 86,400,000 ms (24 hours)
is sufficient here; the supported minimum of 60,000 ms is not.

Fingerprint stable semantic fields, here `{ id, type }`, rather than the entire parsed body. Retry
metadata can change without changing the event. A changed fingerprint under the same key is refused
with `422 fingerprint-mismatch`; repeatedly retrying that changed request will not fix the mismatch.
Include every field that determines your own business operation in its fingerprint.

Tier B's `idempotent()` can answer a concurrent pair `[200, 409]` and does not commit the business
write with the idempotency record. Tier C commits both together; a committed duplicate returns the
stored result without running the callback. See
[store guarantees](../packages/idempotency-plugin/README.md#store-guarantees).

## Side effects: integration events or queue jobs

For an integration event, write the outbox row **inside** the `within` callback using the supplied
unit of work. This is valid only when both stores use the same database; a store on another database
receives a row its relay cannot see. Dispatch after commit. The event definition below is supplied
by the application, as in the
[integration-event guide](../packages/messaging-plugin/README.md#integration-events):

```typescript
import type { IIdempotencyService } from '@setu-ts/common';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import type { IOutbox, IntegrationEventDefinition } from '@setu-ts/messaging-plugin';

export async function acceptAndPublish(
  idempotency: IIdempotencyService,
  outbox: IOutbox,
  definition: IntegrationEventDefinition<{ id: string }>,
  event: { id: string },
): Promise<void> {
  await idempotency.within({ key: event.id, namespace: 'webhooks.publish', scope: 'webhook:provider' },
    async (uow: IUnitOfWork) => {
      await uow.getRepository('WebhookReceipt').create(event);
      await outbox.write(uow, definition, event);
      return { accepted: true };
    });
  outbox.dispatch();
}
```

The M107 outbox targets integration events, not `IQueue`. For a queue job, enqueue **after** commit
on **every accepted delivery, including a replay**: a crash after commit but before enqueue must be
recoverable by the provider's retry. Make the job itself idempotent with `idempotentIngress`. Use
the event id in `ctx.payload.data.id` as its explicit key: `ctx.payload` is the whole `IJob`, and
its top-level `id` changes on every enqueue. The built-in `'auto'` and `'job-id'` key sources also
read that job id, so this recipe requires a custom key reading the event data:

```typescript
import type { IIdempotencyService, IQueue } from '@setu-ts/common';
import type { IUnitOfWork } from '@setu-ts/database-plugin';
import { idempotentIngress } from '@setu-ts/idempotency-plugin';
import { QueuePlugin } from '@setu-ts/queue-plugin';

export const queuePlugin = QueuePlugin({
  behaviors: [idempotentIngress({
    jobNames: ['process-webhook'],
    key: (ctx) => {
      const job = ctx.payload;
      if (typeof job !== 'object' || job === null || !('data' in job)) return undefined;
      const data = job.data;
      return typeof data === 'object' && data !== null && 'id' in data &&
        typeof data.id === 'string' ? data.id : undefined;
    },
  })],
});

export async function acceptAndEnqueue(
  idempotency: IIdempotencyService, queue: IQueue, event: { id: string },
): Promise<void> {
  await idempotency.within({ key: event.id, namespace: 'webhooks.queue', scope: 'webhook:provider' },
    async (uow: IUnitOfWork) => {
      await uow.getRepository('WebhookReceipt').create(event);
      return { accepted: true };
    });
  await queue.add('process-webhook', event);
}
```

Do not suppress enqueue when `replayed` is true. A failed enqueue must yield a non-2xx response so
the provider retries. The ingress behavior needs a shared tier-B store for cross-replica
de-duplication, a lease long enough for the job, and a TTL covering redelivery. It prevents
duplicate processing within that store's limits; external effects still need the provider's own
idempotency key. See the
[idempotency ingress contract](../packages/idempotency-plugin/README.md#ingress-the-allow-list-and-the-consumer-identity).

Keep the verified request path short: commit, schedule durable follow-up work, and return `2xx`.
