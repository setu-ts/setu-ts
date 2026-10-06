/** Real Redis recovery through a kernel app + MessagingPlugin, not an injected fake. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Redis } from 'npm:ioredis@5.x';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, MessageHandler } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';

const redisUrl = Deno.env.get('REDIS_URL');
const guard = { ignore: redisUrl === undefined };
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + 2500;
  do {
    if (await check()) return true;
    await wait(20);
  } while (performance.now() < deadline);
  return false;
}
function application(topic: string, handler: MessageHandler, retryDelayMs = 150) {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      MessagingPlugin({
        broker: 'redis-streams',
        url: redisUrl!,
        defaultQueue: 'g',
        pollIntervalMs: 10,
        blockSizeMs: 10,
        reclaimIntervalMs: 20,
        consumerRetry: { maxAttempts: 3, delaysMs: [retryDelayMs, Math.max(retryDelayMs, 200)] },
        deadLetterMaxLen: 7,
        consumerIdleSweepMs: 200,
        subscriptions: [{ topic, handler }],
      }),
    ],
  });
}

describe('REAL Redis Streams redelivery', () => {
  it(
    'foreign sweeping preserves pending consumers while removing old empty consumers',
    guard,
    async () => {
      const topic = `fix3-sweep-${crypto.randomUUID()}`;
      const redis = new Redis(redisUrl!);
      const app = application(topic, () => {}, 1000);
      try {
        await redis.xgroup('CREATE', topic, 'g', '0', 'MKSTREAM');
        await redis.xreadgroup('GROUP', 'g', 'empty', 'STREAMS', topic, '>');
        const id = await redis.xadd(topic, '*', 'payload', '"m1"');
        await redis.xreadgroup('GROUP', 'g', 'pending', 'STREAMS', topic, '>');
        await app.start();
        // Sweep threshold 200 ms precedes the first reclaim tier 1000 ms.
        await wait(300);
        const consumers = await redis.xinfo('CONSUMERS', topic, 'g') as unknown[][];
        expect(consumers.some((c) => c[1] === 'empty')).toBe(false);
        expect(consumers.some((c) => c[1] === 'pending')).toBe(true);
        const pending = await redis.xpending(topic, 'g', '-', '+', 10) as Array<
          [string, string, number, number]
        >;
        expect(pending.map((p) => [p[0], p[1], p[3]])).toEqual([[id, 'pending', 1]]);
      } finally {
        await app.stop();
        await redis.del(topic, `${topic}.dead.g`);
        await redis.quit();
      }
    },
  );
  it('m1 is redelivered after restart while new m2 still arrives', guard, async () => {
    const topic = `fix3-restart-${crypto.randomUUID()}`;
    const redis = new Redis(redisUrl!);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = application(topic, (m) => {
      first.push(m);
      throw Error('once');
    });
    const b = application(topic, (m) => {
      second.push(m);
    });
    try {
      await a.start();
      await a.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(topic, 'm1');
      expect(await until(() => first.length === 1)).toBe(true);
      await a.stop();
      expect((await redis.xpending(topic, 'g'))[0]).toBe(1);
      await b.start();
      await b.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(topic, 'm2');
      expect(await until(() => second.includes('m2'))).toBe(true);
      expect(await until(() => second.includes('m1')), 'm1 redelivered after restart').toBe(true);
      expect(second.filter((m) => m === 'm1')).toHaveLength(1);
      expect((await redis.xpending(topic, 'g'))[0]).toBe(0);
    } finally {
      await b.stop();
      await a.stop();
      await redis.del(topic, `${topic}.dead.g`);
      await redis.quit();
    }
  });

  it('two replicas reclaim one pending entry: exactly one processes it', guard, async () => {
    const topic = `fix3-replicas-${crypto.randomUUID()}`;
    const redis = new Redis(redisUrl!);
    const delivered: unknown[] = [];
    const a = application(topic, (m) => {
      delivered.push(m);
    });
    const b = application(topic, (m) => {
      delivered.push(m);
    });
    try {
      await redis.xgroup('CREATE', topic, 'g', '0', 'MKSTREAM');
      await redis.xadd(topic, '*', 'payload', '"m1"');
      await redis.xreadgroup('GROUP', 'g', 'crashed', 'STREAMS', topic, '>');
      await wait(160);
      await a.start();
      await b.start();
      expect(await until(() => delivered.length > 0)).toBe(true);
      await wait(350);
      expect(delivered).toEqual(['m1']);
      expect((await redis.xpending(topic, 'g'))[0]).toBe(0);
    } finally {
      await a.stop();
      await b.stop();
      await redis.del(topic, `${topic}.dead.g`);
      await redis.quit();
    }
  });

  it(
    'an always-failing handler reaches the per-group dead stream with original fields',
    guard,
    async () => {
      const topic = `fix3-dead-${crypto.randomUUID()}`;
      const redis = new Redis(redisUrl!);
      let attempts = 0;
      const app = application(topic, () => {
        attempts++;
        throw Error('always');
      });
      try {
        await app.start();
        const id = await redis.xadd(topic, '*', 'payload', '{"m":"m1"}', 'traceparent', 'tp');
        expect(await until(async () => await redis.xlen(`${topic}.dead.g`) === 1)).toBe(true);
        expect(attempts).toBe(3);
        const entries = await redis.xrange(`${topic}.dead.g`, '-', '+');
        expect(entries[0][1]).toEqual([
          'payload',
          '{"m":"m1"}',
          'traceparent',
          'tp',
          'x-setu-source-id',
          id,
          'x-setu-deliveries',
          '3',
        ]);
        expect((await redis.xpending(topic, 'g'))[0]).toBe(0);
      } finally {
        await app.stop();
        await redis.del(topic, `${topic}.dead.g`);
        await redis.quit();
      }
    },
  );

  it('a clean stop leaves no dead consumer', guard, async () => {
    const topic = `fix3-clean-${crypto.randomUUID()}`;
    const redis = new Redis(redisUrl!);
    let delivered = false;
    const app = application(topic, () => {
      delivered = true;
    });
    try {
      await app.start();
      await app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING).publish(topic, 'm1');
      expect(await until(() => delivered)).toBe(true);
      expect((await redis.xinfo('CONSUMERS', topic, 'g') as unknown[]).length).toBe(1);
      await app.stop();
      expect(await redis.xinfo('CONSUMERS', topic, 'g')).toEqual([]);
    } finally {
      await app.stop();
      await redis.del(topic, `${topic}.dead.g`);
      await redis.quit();
    }
  });
});
