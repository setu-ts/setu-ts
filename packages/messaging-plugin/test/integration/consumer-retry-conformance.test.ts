import * as messaging from '../../src/index.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  RabbitMqBroker,
  RedisStreamsBroker,
  GcpPubSubBroker,
  ServiceBusBroker,
  JsonSerializer,
} from '../../src/index.ts';
import { clockRuntime } from '../fixtures/clock-runtime.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';
import { pubSubTransport, serviceBusTransport, flushCloud } from '../fixtures/cloud-transports.ts';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { untilReal } from '../fixtures/real-fan-out.ts';

const arms = ['rabbitmq', 'redis-streams', 'pubsub', 'service-bus'] as const;

/** Real guards: REDIS_URL, RABBITMQ_URL, PUBSUB_EMULATOR_HOST, SERVICEBUS_CONNECTION_STRING, SERVICEBUS_ADMIN_CONNECTION_STRING. */
for (const arm of arms) {
  const enabled =
    arm === 'service-bus'
      ? Boolean(
          process.env['SERVICEBUS_CONNECTION_STRING'] &&
          process.env['SERVICEBUS_ADMIN_CONNECTION_STRING'],
        )
      : Boolean(
          process.env[
            arm === 'rabbitmq'
              ? 'RABBITMQ_URL'
              : arm === 'redis-streams'
                ? 'REDIS_URL'
                : 'PUBSUB_EMULATOR_HOST'
          ],
        );
  it(
    `${arm} real retry budget retains the exhausted payload`,
    { skip: !enabled, timeout: 60000 },
    async () => {
      const runtime = createNodeRuntimeServices();
      const prefix = 'm143p-' + runtime.uuid();
      const topic = prefix;
      const queue = prefix + '-retry';
      const serializer = new JsonSerializer();
      const payload = { retained: prefix };
      const starts: number[] = [];
      const maxAttempts = arm === 'pubsub' ? 5 : 3;
      const delay = arm === 'pubsub' ? 1000 : 400;
      const consumerRetry = { maxAttempts, delaysMs: [delay] };
      const handler = (): never => {
        starts.push(performance.now());
        throw new Error('temporary');
      };
      let stored: unknown;
      if (arm === 'redis-streams') {
        const { Redis } = await import('ioredis');
        const admin = new Redis(process.env['REDIS_URL']!);
        const target = `${topic}.dead.${queue}`;
        const broker = new RedisStreamsBroker(runtime, serializer, {
          url: process.env['REDIS_URL']!,
          consumerRetry,
          reclaimIntervalMs: 150,
          blockSizeMs: 50,
        });
        try {
          await broker.connect();
          await broker.subscribe(topic, handler, { queue });
          await broker.publish(topic, payload);
          await untilReal(async () => (await admin.xlen(target)) === 1);
          const entries = await admin.xrange(target, '-', '+');
          const fields = entries[0]![1];
          stored = JSON.parse(fields[fields.indexOf('payload') + 1]!);
        } finally {
          await broker.disconnect();
          await admin.del(topic, target);
          await admin.quit();
        }
      } else if (arm === 'rabbitmq') {
        const amqp = await import('amqplib');
        const admin = await amqp.connect(process.env['RABBITMQ_URL']!);
        const channel = await admin.createChannel();
        const broker = new RabbitMqBroker(runtime, serializer, {
          url: process.env['RABBITMQ_URL']!,
          exchangeName: prefix,
          consumerRetry,
        });
        try {
          await broker.connect();
          await broker.subscribe(topic, handler, { queue });
          await broker.publish(topic, payload);
          await untilReal(
            async () => (await channel.checkQueue(queue + '.dead')).messageCount === 1,
          );
          const message = await channel.get(queue + '.dead');
          expect(message).not.toBe(false);
          if (message !== false) {
            stored = JSON.parse(message.content.toString());
            channel.ack(message);
          }
        } finally {
          await broker.disconnect();
          for (const name of [queue, queue + '.dead', queue + `.retry.${delay}ms`])
            await channel.deleteQueue(name);
          await channel.deleteExchange(prefix);
          await admin.close();
        }
      } else if (arm === 'pubsub') {
        const { PubSub } = await import('@google-cloud/pubsub');
        const projectId = process.env['PUBSUB_PROJECT_ID'] ?? 'he-test';
        const admin = new PubSub({ projectId });
        const target = prefix + '-dead';
        const sink = admin.subscription(prefix + '-sink');
        const broker = new GcpPubSubBroker(runtime, serializer, {
          projectId,
          consumerRetry,
          deadLetterTopic: target,
        });
        try {
          await admin.createTopic(topic);
          await admin.createTopic(target);
          await admin.topic(target).createSubscription(sink.name);
          sink.on('message', (message) => {
            stored = JSON.parse(new TextDecoder().decode(message.data));
            message.ack();
          });
          await broker.connect();
          await broker.subscribe(topic, handler, { queue });
          await broker.publish(topic, payload);
          await untilReal(() => stored !== undefined, 45000);
        } finally {
          await broker.disconnect();
          await sink.close();
          for (const name of [topic, target]) {
            for (const sub of (await admin.topic(name).getSubscriptions())[0]) await sub.delete();
            await admin.topic(name).delete();
          }
          await admin.close();
        }
      } else {
        const { ServiceBusAdministrationClient, ServiceBusClient } =
          await import('@azure/service-bus');
        const adminConnectionString = process.env['SERVICEBUS_ADMIN_CONNECTION_STRING']!;
        const admin = new ServiceBusAdministrationClient(adminConnectionString);
        const data = new ServiceBusClient(process.env['SERVICEBUS_CONNECTION_STRING']!);
        const broker = new ServiceBusBroker(runtime, serializer, {
          connectionString: process.env['SERVICEBUS_CONNECTION_STRING']!,
          adminConnectionString,
          consumerRetry,
        });
        const dead = data.createReceiver(topic, queue, { subQueueType: 'deadLetter' });
        try {
          await admin.createTopic(topic);
          await admin.createSubscription(topic, queue);
          await broker.connect();
          await broker.subscribe(topic, handler, { queue });
          await broker.publish(topic, payload);
          await untilReal(() => starts.length === maxAttempts);
          const messages = await dead.receiveMessages(1, { maxWaitTimeInMs: 10000 });
          expect(messages).toHaveLength(1);
          stored = JSON.parse(messages[0]!.body as string);
          expect(messages[0]!.deadLetterReason).toBe('setu-attempts-exhausted');
          await dead.completeMessage(messages[0]!);
        } finally {
          await broker.disconnect();
          await dead.close();
          await data.close();
          await admin.deleteTopic(topic);
        }
      }
      expect(stored).toEqual(payload);
      if (arm === 'pubsub') {
        // The emulator forwards at five attempts, but its first retry can ignore minimumBackoff.
        expect(starts.length).toBeGreaterThanOrEqual(maxAttempts);
        expect(starts.length).toBeLessThanOrEqual(10);
      } else {
        expect(starts).toHaveLength(maxAttempts);
        for (let index = 1; index < starts.length; index++)
          expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(delay);
      }
    },
  );
}

describe('consumer retry budget and dead payload conformance', () => {
  it('covers every broker arm exposing consumerRetry', () => {
    const configured: Record<(typeof arms)[number], true> = {
      rabbitmq: true,
      'redis-streams': true,
      pubsub: true,
      'service-bus': true,
    };
    expect(Object.keys(configured).sort()).toEqual([...arms].sort());
    expect(
      Object.keys(messaging)
        .filter(
          (name) =>
            name.endsWith('Broker') &&
            !['InMemoryBroker', 'NatsBroker', 'KafkaBroker'].includes(name),
        )
        .sort(),
    ).toEqual(
      ['RabbitMqBroker', 'RedisStreamsBroker', 'GcpPubSubBroker', 'ServiceBusBroker'].sort(),
    );
  });
  it.each(arms)(
    '%s spaces attempts, invokes the handler five times, and retains the payload',
    async (arm) => {
      const clock = clockRuntime();
      const serializer = new JsonSerializer();
      const starts: number[] = [];
      const dead: unknown[] = [];
      const payload = { retained: 'dead-store-canary' };
      const serialized = JSON.stringify(payload);
      const retry = { maxAttempts: 5, delaysMs: [200] };
      const handler = vi.fn((message: unknown) => {
        expect(message).toEqual(payload);
        starts.push(clock.runtime.now());
        throw new Error('temporary');
      });
      let close: () => Promise<void>;
      if (arm === 'rabbitmq') {
        const client = new FakeAmqpConnection();
        const broker = new RabbitMqBroker(clock.runtime, serializer, {
          client,
          consumerRetry: retry,
        });
        await broker.connect();
        close = () => broker.disconnect();
        try {
          await broker.subscribe('orders', handler, { queue: 'workers' });
          const channel = await client.createChannel();
          let properties: Record<string, unknown> = {};
          for (let count = 0; count < 10; count++) {
            await channel.deliver(serialized, properties, 'workers');
            const copy = channel.calls.filter((call) => call.method === 'publish').at(-1)!;
            if (copy.args[1] === 'workers.dead') {
              dead.push(JSON.parse(new TextDecoder().decode(copy.args[2] as Uint8Array)));
              break;
            }
            expect(copy.args[1]).toBe('workers.retry.200ms');
            properties = copy.args[3] as Record<string, unknown>;
            await clock.advance(200);
          }
        } finally {
          await close();
        }
      } else if (arm === 'redis-streams') {
        const client = new FakeRedisStreamsClient({ now: clock.runtime.now });
        const broker = new RedisStreamsBroker(clock.runtime, serializer, {
          client,
          consumerRetry: retry,
          reclaimIntervalMs: 100,
          blockSizeMs: 1,
        });
        await broker.connect();
        close = () => broker.disconnect();
        try {
          await broker.subscribe('orders', handler, { queue: 'workers' });
          await broker.publish('orders', payload);
          await clock.advance(2000);
          for (const copy of client.calls.filter(
            (call) => call.method === 'xadd' && call.args[0] === 'orders.dead.workers',
          )) {
            const index = copy.args.indexOf('payload');
            dead.push(JSON.parse(copy.args[index + 1] as string));
          }
        } finally {
          await close();
        }
      } else if (arm === 'pubsub') {
        const fake = pubSubTransport();
        const broker = new GcpPubSubBroker(clock.runtime, serializer, {
          client: fake.transport,
          consumerRetry: retry,
          deadLetterTopic: 'dead',
        });
        await broker.connect();
        close = () => broker.disconnect();
        try {
          await broker.subscribe('orders', handler);
          let deliveries = 0;
          const deliver = (): void => {
            deliveries++;
            const policy = fake.opens[0]!.options?.create;
            fake.opens[0]!.deliver({
              payload: serialized,
              deliveryAttempt: deliveries,
              messageId: 'one',
              ack: () => {},
              nack: () => {
                if (
                  policy?.deadLetterPolicy !== undefined &&
                  deliveries >= policy.deadLetterPolicy.maxDeliveryAttempts
                )
                  dead.push(payload);
                else if (deliveries < 10)
                  clock.runtime.setTimeout(deliver, policy?.retryPolicy?.minimumBackoffMs ?? 0);
              },
            });
          };
          deliver();
          await flushCloud();
          await clock.advance(2000);
        } finally {
          await close();
        }
      } else {
        const fake = serviceBusTransport();
        const broker = new ServiceBusBroker(clock.runtime, serializer, {
          client: fake.transport,
          consumerRetry: retry,
        });
        await broker.connect();
        close = () => broker.disconnect();
        try {
          await broker.subscribe('orders', handler);
          let deliveries = 0;
          const deliver = (): void => {
            const deliveryCount = deliveries++;
            void fake.opens[0]!.deliver({
              payload: serialized,
              deliveryCount,
              ack: () => {},
              nack: () => {
                if (deliveries < 10) clock.runtime.setTimeout(deliver, 0);
              },
              deadLetter: () => {
                dead.push(payload);
                return Promise.resolve();
              },
            });
          };
          deliver();
          await flushCloud();
          await clock.advance(2000);
        } finally {
          await close();
        }
      }
      expect(handler).toHaveBeenCalledTimes(5);
      expect(dead).toEqual([payload]);
      expect(starts).toHaveLength(5);
      for (let index = 1; index < starts.length; index++)
        expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(200);
      expect(clock.timerCount()).toBe(0);
    },
  );
});
