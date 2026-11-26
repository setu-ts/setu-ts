import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { SnsPublisher } from '../../src/sns/sns-publisher.ts';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { fakeTelemetry, TRACEPARENT } from '../fixtures/fake-telemetry.ts';

const endpoint = process.env.AWS_LOCALSTACK_ENDPOINT_URL;
describe('SNS jobs through raw and wrapped SQS subscriptions', { skip: !endpoint }, () => {
  const runtime = createNodeRuntimeServices();
  const config = {
    endpoint: endpoint!,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
  const prefix = `m143p-${crypto.randomUUID()}`;
  const urls: string[] = [];
  const subscriptions: string[] = [];
  const queues: SqsQueue[] = [];
  let topicArn: string | undefined;
  let publisher: SnsPublisher | undefined;
  let clean: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const sqs = await import('@aws-sdk/client-sqs');
    const sns = await import('@aws-sdk/client-sns');
    const sqsClient = new sqs.SQSClient(config);
    const snsClient = new sns.SNSClient(config);
    clean = async () => {
      try {
        for (const SubscriptionArn of subscriptions)
          await snsClient.send(new sns.UnsubscribeCommand({ SubscriptionArn }));
        if (topicArn) await snsClient.send(new sns.DeleteTopicCommand({ TopicArn: topicArn }));
        for (const QueueUrl of urls) await sqsClient.send(new sqs.DeleteQueueCommand({ QueueUrl }));
      } finally {
        sqsClient.destroy();
        snsClient.destroy();
      }
    };
    topicArn = (await snsClient.send(new sns.CreateTopicCommand({ Name: prefix }))).TopicArn!;
    const dead = (await sqsClient.send(new sqs.CreateQueueCommand({ QueueName: `${prefix}-dead` })))
      .QueueUrl!;
    urls.push(dead);
    for (const raw of [true, false]) {
      const url = (
        await sqsClient.send(
          new sqs.CreateQueueCommand({ QueueName: `${prefix}-${raw ? 'raw' : 'wrapped'}` }),
        )
      ).QueueUrl!;
      urls.push(url);
      const arn = (
        await sqsClient.send(
          new sqs.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
        )
      ).Attributes!.QueueArn!;
      await sqsClient.send(
        new sqs.SetQueueAttributesCommand({
          QueueUrl: url,
          Attributes: {
            Policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Principal: { Service: 'sns.amazonaws.com' },
                  Action: 'sqs:SendMessage',
                  Resource: arn,
                  Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
                },
              ],
            }),
          },
        }),
      );
      const subscription = await snsClient.send(
        new sns.SubscribeCommand({
          TopicArn: topicArn,
          Protocol: 'sqs',
          Endpoint: arn,
          Attributes: { RawMessageDelivery: String(raw) },
          ReturnSubscriptionArn: true,
        }),
      );
      subscriptions.push(subscription.SubscriptionArn!);
      const queue = new SqsQueue(
        runtime,
        { ...config, queues: { build: url }, deadLetterQueues: { build: dead } },
        undefined,
        { maxAttempts: 7 },
      );
      queues.push(queue);
      await queue.connect();
    }
    publisher = new SnsPublisher({
      ...config,
      topicArn,
      runtime,
      telemetry: fakeTelemetry().service,
    });
    await publisher.connect();
  });
  afterAll(async () => {
    await publisher?.disconnect();
    for (const queue of queues) await queue.disconnect();
    await clean?.();
  });
  it('preserves producer traceparent, payload and consumer defaults on both subscriptions', async () => {
    expect(queues).toHaveLength(2);
    expect(
      await publisher!.publishJob('build', { reportId: 'r1' }, { headers: { tenant: 't1' } }),
    ).toBeTruthy();
    for (const queue of queues) {
      let delivered: Awaited<ReturnType<SqsQueue['reserve']>> = [];
      await vi.waitFor(
        async () => {
          delivered = await queue.reserve('build', 1, runtime.now());
          expect(delivered).toHaveLength(1);
        },
        { timeout: 10_000, interval: 100 },
      );
      const job = delivered[0]!;
      expect(job.data).toEqual({ reportId: 'r1' });
      expect(job.maxAttempts).toBe(7);
      expect(job.headers).toEqual({ tenant: 't1', traceparent: TRACEPARENT });
      await queue.ack('build', job.id, job.claimToken!);
    }
  });
});
