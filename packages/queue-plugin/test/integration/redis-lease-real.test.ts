import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { StaleClaimError } from '../../src/errors.ts';
import { REDIS_CLIENTS, redisOptions } from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  const url = process.env['REDIS_URL'];
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const runtime = createNodeRuntimeServices();
  const leaseMs = 1000;
  const job = {
    id: 'j',
    name: 'email',
    data: { raw: '雪', number: 3.14 },
    attempts: 0,
    maxAttempts: 3,
    availableAtMs: 0,
  };

  async function fixture(
    run: (queue: RedisQueue, other: RedisQueue, inspect: Redis, prefix: string) => Promise<void>,
  ): Promise<void> {
    const prefix = `m113c:lease:${crypto.randomUUID()}:`;
    const inspect = new Redis(url!);
    const queue = new RedisQueue({
      ...redisOptions(redisVariant, url!),
      keyPrefix: prefix,
      visibilityTimeoutMs: leaseMs,
    });
    const other = new RedisQueue({
      ...redisOptions(redisVariant, url!),
      keyPrefix: prefix,
      visibilityTimeoutMs: leaseMs,
    });
    try {
      await queue.connect();
      await other.connect();
      await run(queue, other, inspect, prefix);
    } finally {
      await queue.disconnect();
      await other.disconnect();
      const keys = await inspect.keys(`${prefix}*`);
      if (keys.length) await inspect.del(...keys);
      await inspect.quit();
    }
  }

  describe('Redis delivery lease against real Redis', { skip: url === undefined }, () => {
    it('reclaims a dead worker using TIME despite a skewed client clock, preserves bytes and removes orphans', async () => {
      await fixture(async (queue, other, inspect, prefix) => {
        await queue.enqueue(job);
        const before = await inspect.hget(`${prefix}email:jobs`, 'j');
        const [first] = await queue.reserve('email', 1, Number.MAX_SAFE_INTEGER);
        expect(first.attempts).toBe(1);
        const score = Number(await inspect.zscore(`${prefix}email:processing`, 'j'));
        const [seconds, micros] = await inspect.time();
        const serverNow = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
        expect(score - serverNow).toBeGreaterThan(leaseMs - 200);
        expect(score - serverNow).toBeLessThanOrEqual(leaseMs);
        expect(await other.reserve('email', 1, Number.MAX_SAFE_INTEGER)).toEqual([]);
        await wait(leaseMs + 100);
        const [again] = await other.reserve('email', 1, 0);
        expect(again).toMatchObject({ id: 'j', attempts: 2, data: job.data });
        expect(again.claimToken).not.toBe(first.claimToken);
        expect(await inspect.hget(`${prefix}email:jobs`, 'j')).toBe(before);
        for (const state of ['ready', 'processing']) {
          await inspect.zadd(`${prefix}email:${state}`, 0, state);
          await inspect.hset(`${prefix}email:claims`, state, 'old');
          await inspect.hset(`${prefix}email:stalls`, state, '10');
        }
        expect(await other.reserve('email', 10, runtime.now())).toEqual([]);
        for (const state of ['ready', 'processing']) {
          expect(await inspect.zscore(`${prefix}email:processing`, state)).toBeNull();
          expect(await inspect.hget(`${prefix}email:claims`, state)).toBeNull();
          expect(await inspect.hget(`${prefix}email:stalls`, state)).toBeNull();
        }
      });
    });

    it('a stale ack after reclaim leaves the new delivery intact', async () => {
      await fixture(async (queue, other, inspect, prefix) => {
        await queue.enqueue(job);
        const [first] = await queue.reserve('email', 1, runtime.now());
        await wait(leaseMs + 100);
        const [again] = await other.reserve('email', 1, runtime.now());
        const staleError: unknown = await queue.ack('email', 'j', first.claimToken).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(await inspect.zcard(`${prefix}email:processing`)).toBe(1);
        expect(staleError).toBeInstanceOf(StaleClaimError);
        expect(await inspect.hget(`${prefix}email:claims`, 'j')).toBe(again.claimToken);
        expect(await inspect.hget(`${prefix}email:jobs`, 'j')).not.toBeNull();
        await other.ack('email', 'j', again.claimToken);
        expect(await inspect.zcard(`${prefix}email:processing`)).toBe(0);
      });
    });

    it("selects due jobs by the reserving replica's clock, not Redis TIME (audit L2)", async () => {
      // availableAtMs is written by the enqueuing replica's clock, so a replica
      // whose clock is behind Redis must not run a delayed job early.
      await fixture(async (queue, _other, inspect) => {
        const [seconds] = await inspect.time();
        const serverNow = Number(seconds) * 1000;
        const skewedNow = serverNow - 120_000;
        await queue.enqueue({ ...job, availableAtMs: skewedNow + 60_000 });
        expect(await queue.reserve('email', 1, skewedNow)).toEqual([]);
        const [due] = await queue.reserve('email', 1, skewedNow + 60_000);
        expect(due.id).toBe('j');
        await queue.ack('email', 'j', due.claimToken);
      });
    });

    it('a long renewed job stays claimed past three leases', async () => {
      await fixture(async (queue, other) => {
        const work = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const service = new QueueService(queue, runtime, { pollIntervalMs: 20 });
        service.process('email', () => {
          entered.resolve();
          return work.promise;
        });
        await service.connect();
        try {
          await service.add('email', job.data);
          await entered.promise;
          const end = performance.now() + leaseMs * 3.5;
          while (performance.now() < end) {
            await wait(100);
            expect(await other.reserve('email', 1, runtime.now())).toEqual([]);
          }
          work.resolve();
          await wait(100);
          expect(await queue.depths!('email')).toEqual({ ready: 0, processing: 0, dead: 0 });
        } finally {
          work.resolve();
          await wait(50);
          await service.disconnect();
        }
      });
    });

    it('a poison job reaches dead after maxAttempts stalls without running again', async () => {
      await fixture(async (queue, other, inspect, prefix) => {
        await queue.enqueue(job);
        for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
          const [delivery] = await queue.reserve('email', 1, runtime.now());
          expect(delivery.attempts).toBe(attempt);
          await wait(leaseMs + 100);
        }
        let ran = false;
        const reports: string[] = [];
        const service = new QueueService(other, runtime, {
          pollIntervalMs: 20,
          logger: {
            error: (message) => {
              reports.push(message);
            },
          },
        });
        service.process('email', () => {
          ran = true;
        });
        await service.connect();
        try {
          const end = performance.now() + 2000;
          while (!(await inspect.zcard(`${prefix}email:dead`)) && performance.now() < end)
            await wait(20);
          expect(await inspect.zrange(`${prefix}email:dead`, 0, -1)).toEqual(['j']);
          expect(ran).toBe(false);
          expect(reports).toContain('queue job abandoned by a dead worker — dead-lettered');
          expect(await inspect.hget(`${prefix}email:claims`, 'j')).toBeNull();
          expect(await inspect.hget(`${prefix}email:stalls`, 'j')).toBeNull();
        } finally {
          await service.disconnect();
        }
      });
    });
  });
});
