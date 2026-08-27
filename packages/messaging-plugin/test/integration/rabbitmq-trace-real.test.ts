// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/** Real RabbitMQ trace-header round trip, guarded by `RABBITMQ_URL`. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MessageMetadata } from '@setu-ts/common';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('REAL RabbitMqBroker trace headers (guarded)', () => {
  it('round-trips traceparent through AMQP properties.headers', async () => {
    const url = Deno.env.get('RABBITMQ_URL');
    if (url === undefined) {
      console.log('SKIP: RABBITMQ_URL not set');
      return;
    }

    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      url,
      exchangeName: `m75-trace-${crypto.randomUUID()}`,
    });
    await broker.connect();

    const received: MessageMetadata[] = [];
    const subscription = await broker.subscribe('m75.trace', (_message, metadata) => {
      received.push(metadata);
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await broker.publishWithHeaders('m75.trace', { id: 'message-1' }, {
        traceparent: TRACEPARENT,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received).toHaveLength(1);
      expect(received[0]?.headers?.traceparent).toBe(TRACEPARENT);
    } finally {
      await subscription.unsubscribe();
      await broker.disconnect();
    }
  });
});
