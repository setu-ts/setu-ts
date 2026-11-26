import { Buffer } from 'node:buffer';
import { vi } from 'vitest';
import {
  InMemoryBroker,
  KafkaBroker,
  NatsBroker,
  RabbitMqBroker,
  RedisStreamsBroker,
  GcpPubSubBroker,
  ServiceBusBroker,
} from '../../src/index.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { clockRuntime } from './clock-runtime.ts';
import { FakeAmqpConnection } from './fake-amqplib-client.ts';
import { FakeKafkaFactory } from './fake-kafkajs-client.ts';
import { FakeNatsConnection, FakeNatsMessage } from './fake-nats-client.ts';
import { FakeRedisStreamsClient } from './fake-ioredis-client.ts';
import { pubSubTransport, serviceBusTransport, flushCloud } from './cloud-transports.ts';

/** Every first-party broker arm; checked against the package barrel in conformance. */
export const FAN_OUT_ARMS = [
  'memory',
  'redis-streams',
  'rabbitmq',
  'nats',
  'kafka',
  'pubsub',
  'service-bus',
] as const;
/** The first-party broker discriminant. */
export type FanOutArm = (typeof FAN_OUT_ARMS)[number];

/** Models server queues: peers in one group compete; different groups receive copies. */
class DeliveryBus {
  readonly groups = new Map<string, Set<(payload: string) => void | Promise<void>>>();
  readonly #cursor = new Map<string, number>();
  add(group: string, deliver: (payload: string) => void | Promise<void>): () => void {
    const peers = this.groups.get(group) ?? new Set();
    peers.add(deliver);
    this.groups.set(group, peers);
    return () => {
      peers.delete(deliver);
      if (peers.size === 0) this.groups.delete(group);
    };
  }
  async publish(payload: string): Promise<void> {
    for (const [name, peers] of this.groups) {
      const index = this.#cursor.get(name) ?? 0;
      this.#cursor.set(name, index + 1);
      await [...peers][index % peers.size]!(payload);
    }
    await flushCloud();
  }
}

/** Builds two real broker adapters sharing a protocol-shaped fake backend. */
export async function fanOutPair(arm: FanOutArm): Promise<{
  brokers: readonly [MessageBrokerAdapter, MessageBrokerAdapter];
  tick(): Promise<void>;
  resourceCount(): number;
  close(): Promise<void>;
}> {
  const clock = clockRuntime();
  let id = 1;
  const runtime = {
    ...clock.runtime,
    uuid: () => `${(id++).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
  };
  const serializer = new JsonSerializer();
  const bus = new DeliveryBus();
  let brokers: [MessageBrokerAdapter, MessageBrokerAdapter];
  let count = (): number => bus.groups.size;
  if (arm === 'memory') {
    // Memory has no external backend. Its two logical clients share one process-local broker.
    const broker = new InMemoryBroker(runtime, serializer);
    brokers = [broker, broker];
    count = () => 0;
  } else if (arm === 'redis-streams') {
    const client = new FakeRedisStreamsClient({ now: runtime.now });
    await client.xadd('unused', '*', 'payload', '{}'); // The fake's synthetic 0-0 is not a valid Redis entry ID.
    brokers = [0, 1].map(
      () => new RedisStreamsBroker(runtime, serializer, { client, blockSizeMs: 1 }),
    ) as [RedisStreamsBroker, RedisStreamsBroker];
    count = () =>
      client.calls.filter((call) => call.method === 'xgroup' && call.args[0] === 'CREATE').length;
  } else if (arm === 'rabbitmq') {
    const client = new FakeAmqpConnection();
    const channel = await client.createConfirmChannel!();
    const consume = channel.consume.bind(channel);
    const cancellations = new Map<string, () => void>();
    vi.spyOn(channel, 'consume').mockImplementation(async (queue, callback, options) => {
      const result = await consume(queue, callback, options);
      cancellations.set(
        result.consumerTag,
        bus.add(queue, (payload) =>
          callback({ content: Buffer.from(payload), properties: { headers: {} } }),
        ),
      );
      return result;
    });
    const cancel = channel.cancel.bind(channel);
    vi.spyOn(channel, 'cancel').mockImplementation(async (tag) => {
      cancellations.get(tag)?.();
      cancellations.delete(tag);
      await cancel(tag);
    });
    const publish = channel.publish.bind(channel);
    vi.spyOn(channel, 'publish').mockImplementation(
      (exchange, routingKey, content, properties, confirm) => {
        const accepted = publish(exchange, routingKey, content, properties, confirm);
        void bus.publish((content as Buffer).toString());
        return accepted;
      },
    );
    brokers = [0, 1].map(
      () => new RabbitMqBroker(runtime, serializer, { client, consumerRetry: false }),
    ) as [RabbitMqBroker, RabbitMqBroker];
  } else if (arm === 'nats') {
    const client = new FakeNatsConnection();
    const manager = await client.jetstreamManager();
    const js = client.jetstream();
    const get = js.consumers.get.bind(js.consumers);
    let seq = 0;
    const cancellations = new Map<string, Array<() => void>>();
    vi.spyOn(js.consumers, 'get').mockImplementation(async (stream, name) => {
      const consumer = await get(stream, name);
      const stop = bus.add(name, (payload) =>
        consumer.push(new FakeNatsMessage(payload, ++seq, 0, 'frames')),
      );
      cancellations.set(name, [...(cancellations.get(name) ?? []), stop]);
      return consumer;
    });
    const remove = manager.consumers.delete.bind(manager.consumers);
    vi.spyOn(manager.consumers, 'delete').mockImplementation((stream, name) => {
      for (const stop of cancellations.get(name) ?? []) stop();
      cancellations.delete(name);
      return remove(stream, name);
    });
    const publish = js.publish.bind(js);
    vi.spyOn(js, 'publish').mockImplementation(async (topic, bytes, options) => {
      await bus.publish(new TextDecoder().decode(bytes));
      return publish(topic, bytes, options);
    });
    brokers = [0, 1].map(() => new NatsBroker(runtime, serializer, { client })) as [
      NatsBroker,
      NatsBroker,
    ];
  } else if (arm === 'kafka') {
    const client = new FakeKafkaFactory();
    brokers = [0, 1].map(() => new KafkaBroker(runtime, serializer, { client })) as [
      KafkaBroker,
      KafkaBroker,
    ];
    count = () => client.groupIds.filter((group) => group.includes('-fanout-')).length;
  } else if (arm === 'pubsub') {
    const fake = pubSubTransport();
    vi.mocked(fake.transport.open).mockImplementation((_topic, name, deliver) => {
      const stop = bus.add(name, (payload) => deliver({ payload, ack: () => {}, nack: () => {} }));
      return Promise.resolve({
        created: true,
        close: () => {
          stop();
          return Promise.resolve();
        },
      });
    });
    vi.mocked(fake.transport.publish).mockImplementation((_topic, bytes) =>
      bus.publish(new TextDecoder().decode(bytes)),
    );
    brokers = [0, 1].map(
      () =>
        new GcpPubSubBroker(runtime, serializer, { client: fake.transport, consumerRetry: false }),
    ) as [GcpPubSubBroker, GcpPubSubBroker];
  } else {
    const fake = serviceBusTransport();
    vi.mocked(fake.transport.open).mockImplementation((_topic, name, deliver) => {
      const stop = bus.add(name, (payload) => deliver({ payload, ack: () => {}, nack: () => {} }));
      return Promise.resolve({
        close: () => {
          stop();
          return Promise.resolve();
        },
      });
    });
    vi.mocked(fake.transport.send).mockImplementation((_topic, payload) => bus.publish(payload));
    brokers = [0, 1].map(
      () =>
        new ServiceBusBroker(runtime, serializer, { client: fake.transport, consumerRetry: false }),
    ) as [ServiceBusBroker, ServiceBusBroker];
  }
  await brokers[0].connect();
  if (brokers[1] !== brokers[0]) await brokers[1].connect();
  return {
    brokers,
    tick: () => clock.advance(100),
    resourceCount: count,
    close: async () => {
      await brokers[0].disconnect();
      if (brokers[1] !== brokers[0]) await brokers[1].disconnect();
    },
  };
}
