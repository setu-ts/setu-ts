# @setu-ts/queue-plugin — background jobs and retries

**Add it:** `setu add queue` installs it and wires `QueuePlugin()` with its processors seam in a
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

## Register the matching processor in setu.config.ts

```ts
import { QueuePlugin } from '@setu-ts/queue-plugin';
import type { IJob } from '@setu-ts/common';

export const queue = QueuePlugin({
  processors: [{
    name: 'receipt',
    processor: async (job: IJob<{ orderId: string }>) => {
      console.log(job.data.orderId);
    },
    options: { concurrency: 2 },
  }],
});
```

## Behaviour the types do not show

- `add` resolves to the job ID, before processing completes; `delayMs` is milliseconds.
- `job.attempts` is 1 on first delivery. Throwing fails an attempt; make effects safe to repeat.
- `onFailed` runs once after attempts are exhausted, before dead-lettering. It does not run for
  attempts that will be retried; its own errors are logged and swallowed.
- Default processor concurrency is 1 per name; default `pollIntervalMs` is 1000 milliseconds.
- The default memory adapter is process-local. Processor factories resolve at `onInit`, when
  capabilities are registered; shutdown stops polling and disconnects the adapter.

## Other options

- `adapter: 'redis'` or `'rabbitmq'` uses `url`; `'sqs'` uses `sqs`.
- `schedule` registers recurring jobs with a cron expression.
- `behaviors` wraps processor execution; `diagnostics` observes approved queue names only.
