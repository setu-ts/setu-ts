/**
 * Header conformance across every first-party broker.
 *
 * M75 §3.6 makes `MessageMetadata.headers` a populated contract: each broker
 * carries framework-owned transport headers out through its own channel, reads
 * them back on delivery, and reports `{}` — never `undefined` — when the
 * transport carried none.
 *
 * The point of running ONE assertion table over all seven is that a broker
 * wired to the wrong channel, or one that forgets the read side, fails here.
 * An earlier revision of this file drove `InMemoryBroker` alone and would have
 * passed with the other six broken.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MessageMetadata } from '@setu-ts/common';
import { InMemoryBroker } from '../../src/brokers/in-memory-broker.ts';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { NatsBroker } from '../../src/brokers/nats-broker.ts';
import { KafkaBroker } from '../../src/brokers/kafka-broker.ts';
import { GcpPubSubBroker } from '../../src/brokers/pubsub-broker.ts';
import { ServiceBusBroker } from '../../src/brokers/service-bus-broker.ts';
import type { IPubSubTransport } from '../../src/brokers/pubsub-broker.ts';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeRedisStreamsClient } from '../fixtures/fake-ioredis-client.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeNatsConnection } from '../fixtures/fake-nats-client.ts';
import { FakeKafkaFactory } from '../fixtures/fake-kafkajs-client.ts';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TOPIC = 'orders';

/**
 * One broker under test: how to build it, how to read what it put on the wire,
 * and how to build a second instance that will deliver a seeded header.
 */
interface BrokerCase {
  readonly name: string;
  /** A broker whose publish path can be inspected. */
  readonly publisher: () => Promise<{
    broker: MessageBrokerAdapter;
    /** The header names/values the transport actually received. */
    sentHeaders: () => Readonly<Record<string, string>>;
  }>;
  /** A broker that will deliver one message carrying `headers`. */
  readonly deliverer: (
    headers: Readonly<Record<string, string>> | undefined,
  ) => Promise<MessageBrokerAdapter>;
}

/** Collects the flat XADD field list a Redis publish produced. */
function redisSentHeaders(client: FakeRedisStreamsClient): Readonly<Record<string, string>> {
  const call = client.calls.find((c) => c.method === 'xadd');
  const args = (call?.args ?? []) as string[];
  // args: [name, id, 'payload', serialized, ...headerFieldPairs]
  const out: Record<string, string> = {};
  for (let i = 4; i + 1 < args.length; i += 2) out[args[i]] = args[i + 1];
  return out;
}

const CASES: readonly BrokerCase[] = [
  {
    name: 'memory',
    publisher: async () => {
      const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
      await broker.connect();
      let sent: Readonly<Record<string, string>> = {};
      // In-memory has no wire: the headers it "sends" are the ones it delivers.
      await broker.subscribeWithHeaders(TOPIC, (_m, metadata) => {
        sent = metadata.headers ?? {};
      });
      return { broker, sentHeaders: () => sent };
    },
    // In-memory has no wire to seed: the test publishes into the same instance.
    deliverer: async (_headers) => {
      const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
      await broker.connect();
      return broker;
    },
  },
  {
    name: 'redis-streams',
    publisher: async () => {
      const client = new FakeRedisStreamsClient();
      const broker = new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), { client });
      await broker.connect();
      return { broker, sentHeaders: () => redisSentHeaders(client) };
    },
    deliverer: async (headers) => {
      const client = new FakeRedisStreamsClient({
        seededMessages: [{
          id: '1-0',
          payload: '{"id":1}',
          ...(headers ? { fields: headers } : {}),
        }],
      });
      const broker = new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
        client,
        pollIntervalMs: 1,
      });
      await broker.connect();
      return broker;
    },
  },
  {
    name: 'rabbitmq',
    publisher: async () => {
      const connection = new FakeAmqpConnection();
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
        client: connection,
      });
      await broker.connect();
      const channelRef = await connection.createChannel();
      return {
        broker,
        sentHeaders: () => {
          // FakeAmqpConnection memoizes one channel, so this is the channel the
          // broker published on.
          const channel = channelRef;
          const call = channel?.calls.find((c) => c.method === 'publish');
          const props = (call?.args?.[3] ?? {}) as { headers?: Record<string, string> };
          return props.headers ?? {};
        },
      };
    },
    deliverer: async (headers) => {
      const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
        client: new FakeAmqpConnection({
          seededMessages: [{
            topic: TOPIC,
            content: '{"id":1}',
            properties: headers ? { headers } : {},
          }],
        }),
      });
      await broker.connect();
      return broker;
    },
  },
  {
    name: 'nats',
    publisher: async () => {
      const values = new Map<string, string>();
      const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
        client: new FakeNatsConnection(),
        headersFactory: () => ({
          set: (k, v) => values.set(k, v),
          get: (k) => values.get(k),
          keys: () => values.keys(),
        }),
      });
      await broker.connect();
      return { broker, sentHeaders: () => Object.fromEntries(values) };
    },
    deliverer: async (headers) => {
      const values = new Map(Object.entries(headers ?? {}));
      const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
        client: new FakeNatsConnection({
          seededMessages: [{
            subject: TOPIC,
            data: '{"id":1}',
            seq: 1,
            timestamp: '2025-01-01T00:00:00.000Z',
            // A real MsgHdrs answers keys()/get(); `undefined` models a message
            // published without any headers at all.
            ...(headers
              ? { headers: { keys: () => values.keys(), get: (k: string) => values.get(k) } }
              : {}),
          }],
        }),
      });
      await broker.connect();
      return broker;
    },
  },
  {
    name: 'kafka',
    publisher: async () => {
      const factory = new FakeKafkaFactory();
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: factory,
      });
      await broker.connect();
      return {
        broker,
        sentHeaders: () => {
          const call = factory.producer().calls.find((c) => c.method === 'send');
          const options = call?.args?.[0] as
            | { messages?: Array<{ headers?: Record<string, string> }> }
            | undefined;
          return options?.messages?.[0]?.headers ?? {};
        },
      };
    },
    deliverer: async (headers) => {
      const broker = new KafkaBroker(createFakeRuntime(), new JsonSerializer(), {
        client: new FakeKafkaFactory({
          seededMessages: [{
            topic: TOPIC,
            value: '{"id":1}',
            partition: 0,
            offset: '0',
            timestamp: '1700000000000',
            headers: headers ?? {},
          }],
        }),
      });
      await broker.connect();
      return broker;
    },
  },
  {
    name: 'pubsub',
    publisher: async () => {
      let sent: Readonly<Record<string, string>> = {};
      const transport: IPubSubTransport = {
        publish: (_topic, _bytes, attributes) => {
          sent = attributes ?? {};
          return Promise.resolve();
        },
        open: () => Promise.resolve({ close: () => Promise.resolve() }),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createFakeRuntime(), new JsonSerializer(), {
        projectId: 'p',
        client: transport,
      });
      await broker.connect();
      return { broker, sentHeaders: () => sent };
    },
    deliverer: async (headers) => {
      const transport: IPubSubTransport = {
        publish: () => Promise.resolve(),
        open: (_topic, _sub, onMessage) => {
          onMessage({
            payload: '{"id":1}',
            ack: () => {},
            nack: () => {},
            ...(headers ? { attributes: headers } : {}),
          });
          return Promise.resolve({ close: () => Promise.resolve() });
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new GcpPubSubBroker(createFakeRuntime(), new JsonSerializer(), {
        projectId: 'p',
        client: transport,
      });
      await broker.connect();
      return broker;
    },
  },
  {
    name: 'service-bus',
    publisher: async () => {
      let sent: Readonly<Record<string, string>> = {};
      const transport: IServiceBusTransport = {
        send: (_topic, _body, applicationProperties) => {
          sent = applicationProperties ?? {};
          return Promise.resolve();
        },
        open: () => Promise.resolve({ close: () => Promise.resolve() }),
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
        connectionString: 'Endpoint=sb://x',
        client: transport,
      });
      await broker.connect();
      return { broker, sentHeaders: () => sent };
    },
    deliverer: async (headers) => {
      const transport: IServiceBusTransport = {
        send: () => Promise.resolve(),
        open: (_topic, _sub, onMessage) => {
          void onMessage({
            payload: '{"id":1}',
            ack: () => {},
            nack: () => {},
            ...(headers ? { applicationProperties: headers } : {}),
          });
          return Promise.resolve({ close: () => Promise.resolve() });
        },
        createSubscription: () => Promise.resolve(),
        deleteSubscription: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const broker = new ServiceBusBroker(createFakeRuntime(), new JsonSerializer(), {
        connectionString: 'Endpoint=sb://x',
        client: transport,
      });
      await broker.connect();
      return broker;
    },
  },
];

/** Waits for a polled broker to deliver, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('broker header conformance', () => {
  it('covers every first-party broker, so none can be missed', () => {
    // A broker added to the plugin without a row here would otherwise be
    // silently unverified.
    expect(CASES.map((c) => c.name)).toEqual([
      'memory',
      'redis-streams',
      'rabbitmq',
      'nats',
      'kafka',
      'pubsub',
      'service-bus',
    ]);
  });

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('carries framework headers out through its own transport channel', async () => {
        const { broker, sentHeaders } = await testCase.publisher();

        await broker.publishWithHeaders(TOPIC, { id: 1 }, { traceparent: TRACEPARENT });
        await waitFor(
          () => sentHeaders().traceparent === TRACEPARENT,
          `${testCase.name} publish header`,
        );

        expect(sentHeaders().traceparent).toBe(TRACEPARENT);
        await broker.disconnect();
      });

      it('surfaces delivered headers on MessageMetadata', async () => {
        const broker = await testCase.deliverer({ traceparent: TRACEPARENT });
        const seen: MessageMetadata[] = [];
        await broker.subscribeWithHeaders(TOPIC, (_m, metadata) => {
          seen.push(metadata);
        });
        // The memory broker has no seeded delivery — publish into itself.
        if (testCase.name === 'memory') {
          await broker.publishWithHeaders(TOPIC, { id: 1 }, { traceparent: TRACEPARENT });
        }
        await waitFor(() => seen.length > 0, `${testCase.name} delivery`);

        expect(seen[0]?.headers?.traceparent).toBe(TRACEPARENT);
        await broker.disconnect();
      });

      it('reports an empty object, not undefined, when no headers arrived', async () => {
        // `{}` means "read the channel, it was empty"; `undefined` would mean
        // "this transport has no channel" — the distinction §3.6 rests on.
        const broker = await testCase.deliverer(undefined);
        const seen: MessageMetadata[] = [];
        await broker.subscribeWithHeaders(TOPIC, (_m, metadata) => {
          seen.push(metadata);
        });
        if (testCase.name === 'memory') {
          await broker.publish(TOPIC, { id: 1 });
        }
        await waitFor(() => seen.length > 0, `${testCase.name} empty delivery`);

        expect(seen[0]?.headers).toEqual({});
        await broker.disconnect();
      });
    });
  }
});
