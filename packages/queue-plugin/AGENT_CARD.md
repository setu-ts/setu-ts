# @setu-ts/queue-plugin — background jobs and retries

**Add it:** `setu add queue` adds it and wires `QueuePlugin()` with its processors seam in a
recognized functional config. It provides `CAPABILITIES.QUEUE` (`IQueue`).

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

`setu g job receipt` writes `src/jobs/receipt.job.ts` and wires it into
`QueuePlugin({ processors: [...QUEUE_PROCESSORS] })`; fill in its factory:

```ts
import type { IServiceRegistry } from '@setu-ts/common';
import type { QueueProcessorDefinition } from '@setu-ts/queue-plugin';

/** Shared with the routes that read it; both import this module. */
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

- `add` resolves to the job ID only; the job runs on a later poll (`pollIntervalMs`, default 1000
  ms), so a test polls its read-back route until the result appears. `delayMs` is milliseconds.
- Read-back state can live in a module both files import; the factory gets `services` to resolve
  capabilities at `onInit` (a capability resolved there must be registered, e.g. `LoggerPlugin`).
- `job.attempts` is 1 on first delivery. Throwing fails an attempt; make effects safe to repeat.
- `onFailed` runs once after attempts are exhausted, before dead-lettering, not on retries.
- Default processor concurrency is 1 per name.
- The default memory adapter is process-local. Processor factories resolve at `onInit`, when
  capabilities are registered; shutdown stops polling and disconnects the adapter.

## Other options

- `adapter: 'redis'` or `'rabbitmq'` uses `url`; `'sqs'` uses `sqs`.
- `schedule` registers recurring jobs with a cron expression.
- `behaviors` wraps processor execution; `diagnostics` observes approved queue names only.

<!-- card-allow: LoggerPlugin -->
