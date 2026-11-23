import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { IMessageBroker } from '@setu-ts/common';
import type { IAmqpConnection } from '../../src/interfaces/index.ts';
import {
  GcpPubSubBroker,
  KafkaBroker,
  NatsBroker,
  RabbitMqBroker,
  RedisStreamsBroker,
  ServiceBusBroker,
  JsonSerializer,
} from '../../src/index.ts';

/** The six cross-process broker arms used by both messaging and backplane conformance. */
export const REAL_FAN_OUT_ARMS = [
  'redis-streams',
  'rabbitmq',
  'nats',
  'kafka',
  'pubsub',
  'service-bus',
] as const;
/** A cross-process broker discriminant. */
export type RealFanOutArm = (typeof REAL_FAN_OUT_ARMS)[number];

/** Whether the selected real backend has explicitly configured test endpoints. */
export function realFanOutEnabled(arm: RealFanOutArm): boolean {
  if (arm === 'service-bus')
    return Boolean(
      process.env['SERVICEBUS_CONNECTION_STRING'] &&
      process.env['SERVICEBUS_ADMIN_CONNECTION_STRING'],
    );
  if (arm === 'pubsub') return Boolean(process.env['PUBSUB_EMULATOR_HOST']);
  return Boolean(
    process.env[
      arm === 'redis-streams'
        ? 'REDIS_URL'
        : arm === 'rabbitmq'
          ? 'RABBITMQ_URL'
          : arm === 'nats'
            ? 'NATS_URL'
            : 'KAFKA_BROKERS'
    ],
  );
}

/** Polls real delivery state, parsing no partial process output and imposing no timing ratio. */
export async function untilReal(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30000,
): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for real broker delivery');
}

/** Creates only namespaced test resources, and releases every created resource on close. */
export async function realFanOutPair(
  arm: RealFanOutArm,
  endpointOverride?: string,
): Promise<{
  brokers: readonly [IMessageBroker, IMessageBroker];
  topic: string;
  resources(): Promise<number>;
  close(): Promise<void>;
}> {
  const runtime = createNodeRuntimeServices();
  const prefix = 'm143p-' + runtime.uuid();
  const topic = prefix + '-frames';
  const serializer = new JsonSerializer();
  let brokers: [IMessageBroker, IMessageBroker];
  let resources: () => Promise<number>;
  let cleanup = (): Promise<void> => Promise.resolve();
  if (arm === 'redis-streams') {
    const { Redis } = await import('ioredis');
    const admin = new Redis(process.env['REDIS_URL']!);
    brokers = [0, 1].map(
      () =>
        new RedisStreamsBroker(runtime, serializer, {
          url: endpointOverride ?? process.env['REDIS_URL']!,
          defaultQueue: prefix,
          blockSizeMs: 50,
        }),
    ) as [RedisStreamsBroker, RedisStreamsBroker];
    resources = async () => ((await admin.xinfo('GROUPS', topic)) as unknown[]).length;
    cleanup = async () => {
      try {
        await admin.del(topic);
      } finally {
        await admin.quit();
      }
    };
  } else if (arm === 'rabbitmq') {
    const amqp = await import('amqplib');
    const admin = await amqp.connect(process.env['RABBITMQ_URL']!);
    const channel = await admin.createChannel();
    const queues = new Set<string>();
    const clients: IAmqpConnection[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const client = await amqp.connect(endpointOverride ?? process.env['RABBITMQ_URL']!);
        clients.push({
          createChannel: () => client.createChannel(),
          createConfirmChannel: async () => {
            const own = await client.createConfirmChannel();
            const assertQueue = own.assertQueue.bind(own);
            own.assertQueue = (queue, options) => {
              queues.add(queue);
              return assertQueue(queue, options);
            };
            return own;
          },
          close: () => client.close(),
          on: (event, listener) => {
            client.on(event, listener);
          },
          off: (event, listener) => {
            client.off(event, listener);
          },
        });
      }
    } catch (error) {
      await Promise.allSettled(clients.map((client) => client.close()));
      await admin.close();
      throw error;
    }
    brokers = clients.map(
      (client) =>
        new RabbitMqBroker(runtime, serializer, {
          client,
          defaultQueue: prefix,
          exchangeName: prefix,
          consumerRetry: false,
        }),
    ) as [RabbitMqBroker, RabbitMqBroker];
    resources = async () => {
      let count = 0;
      for (const queue of queues) {
        const probe = await admin.createChannel();
        probe.on('error', () => {});
        try {
          await probe.checkQueue(queue);
          count++;
        } catch (error) {
          if ((error as { code?: number }).code !== 404) throw error;
        } finally {
          await probe.close().catch(() => {});
        }
      }
      return count;
    };
    cleanup = async () => {
      // The brokers do not close an injected connection; close both here so a
      // test relay torn down afterwards cannot surface an unhandled close.
      await Promise.allSettled(clients.map((client) => client.close()));
      try {
        await channel.deleteExchange(prefix);
      } finally {
        await admin.close();
      }
    };
  } else if (arm === 'nats') {
    const nats = await import('nats');
    const admin = await nats.connect({ servers: process.env['NATS_URL']! });
    const manager = await admin.jetstreamManager();
    brokers = [0, 1].map(
      () =>
        new NatsBroker(runtime, serializer, {
          url: process.env['NATS_URL']!,
          streamName: prefix,
          streamSubjects: [topic],
          defaultQueue: prefix,
        }),
    ) as [NatsBroker, NatsBroker];
    resources = async () => (await manager.consumers.list(prefix).next()).length;
    cleanup = async () => {
      try {
        await manager.streams.delete(prefix);
      } finally {
        await admin.close();
      }
    };
  } else if (arm === 'kafka') {
    const { Kafka, logLevel } = await import('kafkajs');
    const endpoints = process.env['KAFKA_BROKERS']!.split(',');
    const kafka = new Kafka({ brokers: endpoints, clientId: prefix, logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
      });
    } catch (error) {
      await admin.disconnect();
      throw error;
    }
    brokers = [0, 1].map(
      () => new KafkaBroker(runtime, serializer, { brokers: endpoints, defaultQueue: prefix }),
    ) as [KafkaBroker, KafkaBroker];
    resources = async () => {
      const { groups } = await admin.listGroups();
      const names = groups
        .filter((group) => group.groupId.startsWith(prefix))
        .map((group) => group.groupId);
      return names.length === 0
        ? 0
        : (await admin.describeGroups(names)).groups.reduce(
            (count, group) => count + group.members.length,
            0,
          );
    };
    cleanup = async () => {
      try {
        const { groups } = await admin.listGroups();
        const names = groups
          .filter((group) => group.groupId.startsWith(prefix))
          .map((group) => group.groupId);
        if (names.length > 0) await admin.deleteGroups(names);
        await admin.deleteTopics({ topics: [topic] });
      } finally {
        await admin.disconnect();
      }
    };
  } else if (arm === 'pubsub') {
    const { PubSub } = await import('@google-cloud/pubsub');
    const projectId = process.env['PUBSUB_PROJECT_ID'] ?? 'he-test';
    const admin = new PubSub({ projectId });
    try {
      await admin.createTopic(topic);
    } catch (error) {
      await admin.close();
      throw error;
    }
    brokers = [0, 1].map(
      () =>
        new GcpPubSubBroker(runtime, serializer, {
          projectId,
          defaultQueue: prefix,
          consumerRetry: false,
        }),
    ) as [GcpPubSubBroker, GcpPubSubBroker];
    resources = async () => (await admin.topic(topic).getSubscriptions())[0].length;
    cleanup = async () => {
      try {
        for (const sub of (await admin.topic(topic).getSubscriptions())[0]) await sub.delete();
        await admin.topic(topic).delete();
      } finally {
        await admin.close();
      }
    };
  } else {
    const { ServiceBusAdministrationClient } = await import('@azure/service-bus');
    const admin = new ServiceBusAdministrationClient(
      process.env['SERVICEBUS_ADMIN_CONNECTION_STRING']!,
    );
    await admin.createTopic(topic);
    brokers = [0, 1].map(
      () =>
        new ServiceBusBroker(runtime, serializer, {
          connectionString: process.env['SERVICEBUS_CONNECTION_STRING']!,
          adminConnectionString: process.env['SERVICEBUS_ADMIN_CONNECTION_STRING']!,
          defaultQueue: prefix,
          consumerRetry: false,
        }),
    ) as [ServiceBusBroker, ServiceBusBroker];
    resources = async () => {
      let count = 0;
      for await (const _subscription of admin.listSubscriptions(topic)) count++;
      return count;
    };
    cleanup = async () => {
      await admin.deleteTopic(topic);
    };
  }
  const close = async (): Promise<void> => {
    try {
      await Promise.all(brokers.map((broker) => broker.disconnect()));
    } finally {
      await cleanup();
    }
  };
  try {
    for (const broker of brokers) await broker.connect();
  } catch (error) {
    await close();
    throw error;
  }
  return { brokers, topic, resources, close };
}
