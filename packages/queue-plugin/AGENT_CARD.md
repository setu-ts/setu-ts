# @setu-ts/queue-plugin — background jobs and retries

**Add it:** `setu add queue` wires `QueuePlugin()`; provides `CAPABILITIES.QUEUE` (`IQueue`).

## Enqueue work from a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue, IRouterApi } from '@setu-ts/common';

export function registerReceiptRoutes(router: IRouterApi): void {
  router.post('/orders/:id/receipt', {
    handler: async (ctx) => {
      const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
      const id = await queue.add('receipt', { orderId: ctx.params.id! }, {
        maxAttempts: 3, delayMs: 100,
      });
      return ctx.response.status(202).json({ id });
    },
  });
}
```

## Process the job

`setu g job receipt` writes and wires `src/jobs/receipt.job.ts`; fill its factory:

```ts
import type { IServiceRegistry } from '@setu-ts/common';
import type { QueueProcessorDefinition } from '@setu-ts/queue-plugin';

/** Shared with read-back routes. */
export const sentReceipts: string[] = [];

export function createReceiptJobProcessor(
  _services: IServiceRegistry,
): QueueProcessorDefinition<{ orderId: string }> {
  return {
    name: 'receipt',
    async processor(job) {
      sentReceipts.push(job.data.orderId);
    },
  };
}
```

## Behaviour the types do not show

- `add` returns the ID; processing runs on a later poll (`pollIntervalMs`: 1000 ms). Read back
  effects. Memory is process-local; `delayMs` uses milliseconds.
- Factories resolve at `onInit`. Default concurrency is 1 per name.
- `job.attempts` starts at 1. Throws retry; `onFailed` runs only after the last attempt.
- `retryDelayMs`: fixed milliseconds or a function of the failed attempt; absent keeps backoff.
  Throwing/nonfinite results warn once and retry immediately.
- `health.probeCacheMs`: 5000 (0 probes every read); `probeTimeoutMs`: 2000. Failures are cached.
  Reserve outages warn once per name; recovery logs at info.

## Other options

- `adapter`: memory, redis or rabbitmq (`url`), sqs (`sqs`); node-redis uses `client`.
- SQS consumed names need `deadLetterQueues[name]` (URL or false) or a redrive policy.
  `requestTimeoutMs`: 15000 (0 unbounded); `waitTimeSeconds`: 20 (0–20). Polls run independently per
  name and abort on disconnect. The QueueArn probe budgets
  `min(1500, floor(0.75 * health.probeTimeoutMs))` ms; missing queues and outages read down.
  `SnsPublisher` also accepts `requestTimeoutMs`.
- `schedule` adds recurring jobs; `behaviors` wraps processors; `diagnostics` observes approved
  names.
