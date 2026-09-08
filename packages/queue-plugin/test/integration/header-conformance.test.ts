/**
 * X34-1 — one table over every shipped adapter, so an adapter that stops
 * carrying the header channel fails HERE rather than in its own file.
 *
 * The `messaging-plugin` precedent (M75): a per-adapter test proves each
 * adapter does something; only a shared table proves they all do the SAME
 * thing. That matters more than usual here because the work is uneven —
 * memory, redis and rabbitmq carry a new `StoredJob` member for free (they
 * spread or serialize the whole job) while SQS names each field in an explicit
 * envelope, so SQS is the one that can silently drop it.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { StoredJob } from '../../src/interfaces/index.ts';
import type { QueueAdapter } from '../../src/adapters/queue-adapter.ts';

import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { createFakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

const HEADERS = {
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  'x-tenant': 't-1',
} as const;

/** Each adapter, connected and ready to take a job. */
const ADAPTERS: readonly { name: string; build: () => Promise<QueueAdapter> }[] = [
  {
    name: 'MemoryQueue',
    build: async () => {
      const queue = new MemoryQueue();
      await queue.connect();
      return queue;
    },
  },
  {
    name: 'RedisQueue',
    build: async () => {
      const queue = new RedisQueue({ client: new FakeRedisClient() });
      await queue.connect();
      return queue;
    },
  },
  {
    name: 'RabbitMqQueue',
    build: async () => {
      const queue = new RabbitMqQueue(new FakeRuntimeServices(), {
        client: createFakeAmqpConnection(),
      });
      await queue.connect();
      return queue;
    },
  },
  {
    name: 'SqsQueue',
    build: async () => {
      const queue = new SqsQueue(new FakeRuntimeServices(), {
        queues: { orders: 'https://sqs.us-east-1.amazonaws.com/1/orders' },
        client: new FakeSqsTransport(),
      });
      await queue.connect();
      return queue;
    },
  },
];

/** A job as `QueueService.add` would build it. */
function job(headers?: Readonly<Record<string, string>>): StoredJob<{ id: number }> {
  return {
    id: 'j-1',
    name: 'orders',
    data: { id: 9 },
    attempts: 0,
    maxAttempts: 3,
    availableAtMs: 0,
    ...(headers === undefined ? {} : { headers }),
  };
}

describe('queue header channel — conformance across every adapter', () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      it('carries the header map from enqueue through to reserve', async () => {
        const queue = await adapter.build();
        await queue.enqueue(job(HEADERS));

        const [reserved] = await queue.reserve<{ id: number }>('orders', 10, 1);
        expect(reserved?.headers).toEqual(HEADERS);
      });

      it('leaves the member ABSENT for a job that carried no channel', async () => {
        // Absent and `{}` are different answers on `IJob.headers`: absent means
        // there was no channel. An adapter reporting `{}` would say the channel
        // was read and was empty, which is false.
        const queue = await adapter.build();
        await queue.enqueue(job());

        const [reserved] = await queue.reserve<{ id: number }>('orders', 10, 1);
        expect(reserved).toBeDefined();
        expect('headers' in (reserved as object)).toBe(false);
      });

      it('carries an EMPTY map as an empty map, not as absent', async () => {
        // The other direction of the same distinction: a caller who passed `{}`
        // gets `{}` back.
        const queue = await adapter.build();
        await queue.enqueue(job({}));

        const [reserved] = await queue.reserve<{ id: number }>('orders', 10, 1);
        expect(reserved?.headers).toEqual({});
      });
    });
  }
});
