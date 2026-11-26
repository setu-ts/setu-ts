import { describe, expect, it } from 'vitest';

describe(
  'Pub/Sub emulator policy capability probe',
  { skip: !process.env['PUBSUB_EMULATOR_HOST'] },
  () => {
    it(
      'records observed retry backoff and dead-letter forwarding without assuming emulator support',
      { timeout: 45000 },
      async () => {
        const { PubSub } = await import('@google-cloud/pubsub');
        const admin = new PubSub({ projectId: process.env['PUBSUB_PROJECT_ID'] ?? 'he-test' });
        const prefix = 'm143p-' + crypto.randomUUID();
        const topic = admin.topic(prefix);
        const target = admin.topic(prefix + '-dead');
        const source = admin.subscription(prefix + '-consumer');
        const sink = admin.subscription(prefix + '-sink');
        const starts: number[] = [];
        let forwarded = false;
        try {
          await topic.create();
          await target.create();
          await target.createSubscription(sink.name);
          await topic.createSubscription(source.name, {
            retryPolicy: { minimumBackoff: { seconds: 1 }, maximumBackoff: { seconds: 1 } },
            deadLetterPolicy: { deadLetterTopic: target.name, maxDeliveryAttempts: 5 },
            expirationPolicy: { ttl: { seconds: 86400 } },
          });
          const [metadata] = await source.getMetadata();
          const expiryStored = Number(metadata.expirationPolicy?.ttl?.seconds) === 86400;
          const policyStored = Number(metadata.retryPolicy?.minimumBackoff?.seconds) === 1;
          source.on('message', (message) => {
            starts.push(performance.now());
            message.nack();
          });
          sink.on('message', (message) => {
            forwarded = true;
            message.ack();
          });
          await topic.publishMessage({ data: new TextEncoder().encode('probe') });
          const deadline = performance.now() + 20000;
          while (!forwarded && starts.length < 8 && performance.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
          expect(starts.length).toBeGreaterThan(0);
          const gaps = starts.slice(1).map((start, index) => Math.round(start - starts[index]!));
          process.stdout.write(
            JSON.stringify({
              probe: 'pubsub-policy-behavior',
              deliveries: starts.length,
              gapsMs: gaps,
              retryBackoffObserved: gaps.length > 0 && gaps.every((gap) => gap >= 1000),
              deadLetterObserved: forwarded,
              retryPolicyStored: policyStored,
              expirationPolicyStored: expiryStored,
            }) + '\n',
          );
        } finally {
          await source.close();
          await sink.close();
          await source.delete().catch(() => {});
          await sink.delete().catch(() => {});
          await topic.delete().catch(() => {});
          await target.delete().catch(() => {});
          await admin.close();
        }
      },
    );
  },
);
