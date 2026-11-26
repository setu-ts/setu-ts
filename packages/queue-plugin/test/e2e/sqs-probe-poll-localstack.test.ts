import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';

const endpoint = process.env['AWS_LOCALSTACK_ENDPOINT_URL'];

describe('SQS real reachability and long poll', { skip: !endpoint }, () => {
  it(
    'receives a message arriving during a wait within one second and reports a deleted queue down',
    { timeout: 45000 },
    async () => {
      const sdk = await import('@aws-sdk/client-sqs');
      const runtime = createNodeRuntimeServices();
      const config = {
        endpoint: endpoint!,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      };
      const admin = new sdk.SQSClient(config);
      const name = 'm143m-' + runtime.uuid();
      let url: string | undefined;
      let queue: SqsQueue | undefined;
      let deleted = false;
      try {
        url = (await admin.send(new sdk.CreateQueueCommand({ QueueName: name }))).QueueUrl!;
        queue = new SqsQueue(runtime, {
          ...config,
          queues: { build: url },
          deadLetterQueues: { build: false },
          waitTimeSeconds: 20,
          requestTimeoutMs: 15000,
        });
        await queue.connect();
        expect(await queue.isHealthy!()).toBe(true);
        const receive = queue.reserve<{ value: number }>('build', 1, runtime.now());
        await new Promise<void>((resolve) => runtime.setTimeout(resolve, 250));
        const sentAt = runtime.hrtime();
        await queue.enqueue({
          id: name,
          name: 'build',
          data: { value: 42 },
          attempts: 0,
          maxAttempts: 3,
          availableAtMs: runtime.now(),
        });
        const jobs = await receive;
        expect(runtime.hrtime() - sentAt).toBeLessThan(1000);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.data).toEqual({ value: 42 });
        await queue.ack('build', name, jobs[0]!.claimToken!);
        const attributes = await admin.send(
          new sdk.GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
          }),
        );
        expect(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
        await admin.send(new sdk.DeleteQueueCommand({ QueueUrl: url }));
        deleted = true;
        expect(await queue.isHealthy!()).toBe(false);
      } finally {
        await queue?.disconnect();
        if (url !== undefined && !deleted)
          await admin.send(new sdk.DeleteQueueCommand({ QueueUrl: url }));
        admin.destroy();
      }
    },
  );
});
