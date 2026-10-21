# @setu-ts/queue-plugin — background jobs with retries

Run `setu add queue`, then install. In a recognized functional config it wires `QueuePlugin()` with
the processors seam; otherwise follow the printed registration lines in `setu.config.ts`.

Enqueue through `CAPABILITIES.QUEUE`; `queue.add` resolves to the job ID, not completion:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue, IServiceRegistry } from '@setu-ts/common';

export async function enqueueReceipt(services: IServiceRegistry): Promise<string> {
  const queue = services.get<IQueue>(CAPABILITIES.QUEUE);
  return await queue.add('receipt', { orderId: 'o-1' }, { maxAttempts: 3, delayMs: 100 });
}
```

Register a matching `name` with `processor` and optional `options`:

```ts
import { QueuePlugin } from '@setu-ts/queue-plugin';
import type { IJob } from '@setu-ts/common';

export const jobs = QueuePlugin({
  processors: [{
    name: 'receipt',
    processor: async (job: IJob<{ orderId: string }>) => {
      await Promise.resolve(job.data.orderId); // replace with real work
    },
    options: { concurrency: 2 },
  }],
});
```

- Functional `setu g job receipt` writes `src/jobs/receipt.job.ts`: `RECEIPT_JOB`, payload field
  `id`, and `createReceiptJobProcessor`. Edit that processor; `src/jobs/index.ts` collects factories
  as `QUEUE_PROCESSORS`, wired to `QueuePlugin({processors:[...QUEUE_PROCESSORS]})` in
  `setu.config.ts`. Factories receive the service registry at `onInit`.
- Class-based generation requires queue and emits `src/ingress/receipt-job.ingress.ts` with
  `@Processor(RECEIPT_JOB)`. `src/ingress/index.ts` exports `INGRESS_HANDLERS`, passed to
  `DecoratorPlugin({ingress:[...INGRESS_HANDLERS]})` from `@setu-ts/decorator-plugin`.
- `adapter` defaults to `'memory'` (process-local). For Redis use `adapter: 'redis'` and `url`;
  RabbitMQ uses `adapter: 'rabbitmq'` and `url`; SQS uses `adapter: 'sqs'` and `sqs`.
- `job.data` is the payload; `job.attempts` starts at 1. Throw to fail an attempt; `maxAttempts`
  exhausted calls `options.onFailed(job,error)` before dead-lettering. Make side effects safe to
  repeat. `options.concurrency` defaults to 1; `pollIntervalMs` defaults to 1000. Wait for effects
  in tests; await `app.stop()` on shutdown to stop polling and disconnect.

<!-- card-allow: RECEIPT_JOB QUEUE_PROCESSORS INGRESS_HANDLERS -->
