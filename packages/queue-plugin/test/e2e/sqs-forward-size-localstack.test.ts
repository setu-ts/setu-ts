import { describe, expect, it, vi } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';

describe(
  'SQS size-limited dead-letter forward',
  { skip: !process.env['AWS_LOCALSTACK_ENDPOINT_URL'] },
  () => {
    it(
      'forwards the body without attributes after the native size refusal and deletes the source',
      { timeout: 20000 },
      async () => {
        const sdk = await import('@aws-sdk/client-sqs');
        const runtime = createNodeRuntimeServices();
        const endpoint = process.env['AWS_LOCALSTACK_ENDPOINT_URL']!;
        const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
        const client = new sdk.SQSClient({
          endpoint,
          region: 'us-east-1',
          credentials,
          maxAttempts: 1,
        });
        const urls: string[] = [];
        let queue: SqsQueue | undefined;
        try {
          const prefix = 'm143p-size-' + runtime.uuid();
          const { QueueUrl: source } = await client.send(
            new sdk.CreateQueueCommand({ QueueName: prefix + '-source' }),
          );
          urls.push(source!);
          const { QueueUrl: target } = await client.send(
            new sdk.CreateQueueCommand({
              QueueName: prefix + '-target',
              Attributes: { MaximumMessageSize: '1024' },
            }),
          );
          urls.push(target!);
          const blank = { v: 1, id: 'size', name: 'build', data: '' };
          const body = JSON.stringify({
            ...blank,
            data: 'x'.repeat(1024 - JSON.stringify(blank).length),
          });
          expect(new TextEncoder().encode(body)).toHaveLength(1024);
          await client.send(new sdk.SendMessageCommand({ QueueUrl: source!, MessageBody: body }));
          const warn = vi.fn();
          queue = new SqsQueue(
            runtime,
            {
              endpoint,
              region: 'us-east-1',
              credentials,
              queues: { build: source! },
              deadLetterQueues: { build: target! },
              visibilityTimeoutSeconds: 2,
            },
            { error: vi.fn(), warn },
          );
          await queue.connect();
          const [job] = await queue.reserve('build', 1, runtime.now());
          await queue.deadLetter('build', job!.id, runtime.now(), job!.claimToken!);
          const result = await client.send(
            new sdk.ReceiveMessageCommand({
              QueueUrl: target!,
              MessageAttributeNames: ['All'],
              WaitTimeSeconds: 1,
            }),
          );
          expect(result.Messages?.[0]?.Body).toBe(body);
          expect(Object.keys(result.Messages?.[0]?.MessageAttributes ?? {})).toEqual([]);
          expect(
            warn.mock.calls.filter(([m]) => String(m).includes('metadata omitted')),
          ).toHaveLength(1);
          await new Promise<void>((resolve) => runtime.setTimeout(resolve, 3000));
          const remaining = await client.send(
            new sdk.ReceiveMessageCommand({ QueueUrl: source!, WaitTimeSeconds: 0 }),
          );
          expect(remaining.Messages ?? []).toEqual([]);
        } finally {
          try {
            await queue?.disconnect();
          } finally {
            await Promise.allSettled(
              urls.map((QueueUrl) => client.send(new sdk.DeleteQueueCommand({ QueueUrl }))),
            );
            client.destroy();
          }
        }
      },
    );
  },
);
