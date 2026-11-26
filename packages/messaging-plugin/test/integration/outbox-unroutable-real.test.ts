import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { RabbitMqBroker, JsonSerializer, UnroutableMessageError } from '../../src/index.ts';
import { outboxHarness, row } from '../fixtures/outbox.ts';
import { untilReal } from '../fixtures/real-fan-out.ts';

describe('real RabbitMQ outbox required routing', () => {
  it(
    'retains an unbound row, delivers after binding, and fails an unbound row at its budget',
    { skip: !process.env['RABBITMQ_URL'], timeout: 60000 },
    async () => {
      const runtime = createNodeRuntimeServices();
      const exchange = 'm143p-' + runtime.uuid();
      const amqp = await import('amqplib');
      const admin = await amqp.connect(process.env['RABBITMQ_URL']!);
      const channel = await admin.createChannel();
      const broker = new RabbitMqBroker(runtime, new JsonSerializer(), {
        url: process.env['RABBITMQ_URL']!,
        exchangeName: exchange,
        consumerRetry: false,
      });
      const h = await outboxHarness({
        options: {
          relay: {
            maxAttempts: 2,
            baseBackoffMs: 10,
            publishTimeoutMs: 1000,
            storeTimeoutMs: 100,
            claimLeaseMs: 3000,
            maxClockSkewMs: 5,
          },
        },
      });
      let lastError: unknown;
      h.broker.behaviour = async (call) => {
        try {
          await broker.publish(call.topic, call.message, call.options);
        } catch (error) {
          lastError = error;
          throw error;
        }
      };
      let queue: string | undefined;
      try {
        await broker.connect();
        const id = await h.write({ n: 1 });
        await h.sweep();
        expect(lastError).toBeInstanceOf(UnroutableMessageError);
        expect(await row(h.db, id)).toMatchObject({ status: 'pending', attempts: 1 });
        queue = (
          await channel.assertQueue(exchange + '-sink', { exclusive: true, autoDelete: true })
        ).queue;
        await channel.bindQueue(queue, exchange, '#');
        h.clock.advanceWall(10);
        await h.sweep();
        expect(await row(h.db, id)).toMatchObject({ status: 'sent' });
        await untilReal(async () => (await channel.checkQueue(queue!)).messageCount === 1);
        const delivery = await channel.get(queue);
        expect(delivery).not.toBe(false);
        if (delivery !== false) channel.ack(delivery);
        await channel.unbindQueue(queue, exchange, '#');
        const failed = await h.write({ n: 2 });
        await h.sweep();
        h.clock.advanceWall(10);
        await h.sweep();
        expect(await row(h.db, failed)).toMatchObject({ status: 'failed', attempts: 2 });
      } finally {
        await broker.disconnect();
        if (queue !== undefined) await channel.deleteQueue(queue);
        await channel.deleteExchange(exchange);
        await admin.close();
      }
    },
  );
});
