/**
 * Real RabbitMQ: a field AMQP cannot encode is refused before amqplib queues a
 * confirm callback, so later publishes on the channel are confirmed as their
 * own (M106 security audit F1). Guarded by `RABBITMQ_URL`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const url = Deno.env.get('RABBITMQ_URL');

/** Resolves `'resolved'`, `'rejected'` or `'pending'` after `ms`. */
function outcome(promise: Promise<void>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('pending'), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('REAL RabbitMqBroker confirm window (guarded)', () => {
  it('refuses an unencodable message id and topic without shifting later confirms', {
    ignore: url === undefined,
  }, async () => {
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      url: url!,
      exchangeName: `m106-confirm-${crypto.randomUUID()}`,
    });
    await broker.connect();
    try {
      // The payload `messageId` route predates M106; a 256-byte topic is the
      // routing key. Both exceed AMQP's 255-byte short string.
      await expect(broker.publish('m106.confirm', { messageId: 'm'.repeat(256) })).rejects
        .toThrow('message id exceeds');
      await expect(broker.publish('t'.repeat(256), { n: 0 })).rejects.toThrow(
        'routing key (the topic) exceeds',
      );
      // Before the fix each of these stayed pending until the NEXT ack arrived.
      const results: string[] = [];
      for (let n = 1; n <= 3; n++) {
        results.push(await outcome(broker.publish('m106.confirm', { n }), 2_000));
      }
      expect(results).toEqual(['resolved', 'resolved', 'resolved']);
    } finally {
      await broker.disconnect();
    }
  });
});
