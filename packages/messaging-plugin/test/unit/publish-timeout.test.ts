import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  MessagingPlugin,
  NatsBroker,
  RedisStreamsBroker,
  PublishTimeoutError,
} from '../../src/index.ts';
import type { MessagingPluginOptions } from '../../src/index.ts';
import { FakeNatsConnection } from '../fixtures/fake-nats-client.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';
import { FakeKafkaFactory } from '../fixtures/fake-kafkajs-client.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import type { IPubSubTransport } from '../../src/brokers/pubsub-broker.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import {
  DEFAULT_PUBLISH_TIMEOUT_MS,
  resolvePublishTimeoutMs,
} from '../../src/brokers/publish-timeout.ts';

describe('publish timeout policy', () => {
  it('defaults to 15 seconds and accepts zero and the timer ceiling', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15000);
    expect(resolvePublishTimeoutMs(undefined)).toBe(15000);
    for (const value of [0, 25, 2147483647]) expect(resolvePublishTimeoutMs(value)).toBe(value);
  });
  it.each([-1, NaN, Infinity, 2147483648])('refuses %s naming publishTimeoutMs', (value) => {
    expect(() => resolvePublishTimeoutMs(value)).toThrow(RangeError);
    expect(() => resolvePublishTimeoutMs(value)).toThrow('publishTimeoutMs');
  });
});

type Arm = 'nats' | 'redis-streams' | 'kafka' | 'pubsub' | 'rabbitmq';
const arms: Arm[] = ['kafka', 'pubsub', 'rabbitmq', 'redis-streams', 'nats'];

async function stalled(arm: Arm, publishTimeoutMs: number) {
  const pending = Promise.withResolvers<void>();
  let options: MessagingPluginOptions;
  let release = () => pending.resolve();
  if (arm === 'nats') {
    const client = new FakeNatsConnection();
    vi.spyOn(client.jetstream(), 'publish').mockImplementation(async () => {
      await pending.promise;
      return { stream: 'MESSAGING', seq: 1, duplicate: false };
    });
    options = { broker: arm, client, publishTimeoutMs };
  } else if (arm === 'redis-streams') {
    const client = new FakeRedisStreamsClient();
    vi.spyOn(client, 'xadd').mockImplementation(async () => {
      await pending.promise;
      return '1-0';
    });
    options = { broker: arm, client, publishTimeoutMs };
  } else if (arm === 'kafka') {
    const client = new FakeKafkaFactory();
    vi.spyOn(client.producer(), 'send').mockReturnValue(pending.promise);
    options = { broker: arm, client, publishTimeoutMs };
  } else if (arm === 'pubsub') {
    const client: IPubSubTransport = {
      publish: () => pending.promise,
      open: () => Promise.resolve({ close: async () => {} }),
      createSubscription: async () => {},
      deleteSubscription: async () => {},
      close: async () => {},
      isHealthy: () => Promise.resolve(true),
    };
    options = { broker: arm, client, publishTimeoutMs };
  } else {
    const client = new FakeAmqpConnection({ withholdConfirms: true });
    const channel = await client.createChannel();
    release = () => channel.releaseConfirms();
    options = { broker: arm, client, publishTimeoutMs };
  }
  const app = createApplication({
    plugins: [RuntimePlugin(), MessagingPlugin({ ...options, tracing: false })],
  });
  await app.start();
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  return { app, broker, release };
}

describe('M119a publish uncertainty across five arms', () => {
  it.each(arms)('%s throws PublishTimeoutError at the forwarded non-default bound', async (arm) => {
    vi.useFakeTimers();
    const { app, broker, release } = await stalled(arm, 45);
    try {
      const outcome = broker.publish('orders', {}).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(44);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const error = await outcome;
      expect(error).toBeInstanceOf(PublishTimeoutError);
      expect(error).toMatchObject({ topic: 'orders', timeoutMs: 45 });
      const backend = {
        kafka: 'Kafka',
        pubsub: 'Pub/Sub',
        rabbitmq: 'RabbitMQ',
        'redis-streams': 'Redis',
        nats: 'NATS',
      }[arm];
      expect((error as Error).message).toBe(
        arm === 'rabbitmq'
          ? 'RabbitMQ did not accept the message published to exchange "messaging" with routing key "orders" within 45 ms (publishTimeoutMs); it may still be accepted'
          : `${backend} did not acknowledge the message published to "orders" within 45 ms (publishTimeoutMs); it may still be delivered`,
      );
    } finally {
      release();
      await app.stop();
      vi.useRealTimers();
    }
  });

  it.each(['redis-streams', 'nats'] as const)(
    '%s with zero remains unbounded until the send answers',
    async (arm) => {
      vi.useFakeTimers();
      const { app, broker, release } = await stalled(arm, 0);
      try {
        let settled = false;
        const publish = broker.publish('orders', {}).then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(settled).toBe(false);
        release();
        await publish;
        expect(settled).toBe(true);
      } finally {
        release();
        await app.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each(['redis-streams', 'nats'] as const)(
    '%s refuses invalid bounds in plugin and constructor',
    (broker) => {
      for (const publishTimeoutMs of [-1, NaN, Infinity, 2147483648]) {
        expect(() => MessagingPlugin({ broker, publishTimeoutMs })).toThrow(RangeError);
        const Broker = broker === 'nats' ? NatsBroker : RedisStreamsBroker;
        expect(
          () => new Broker(createFakeRuntime(), new JsonSerializer(), { publishTimeoutMs }),
        ).toThrow(RangeError);
      }
    },
  );
});
