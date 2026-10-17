import { describe, expect, it, vi } from 'vitest';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { StaleClaimError } from '../../src/errors.ts';
import { FakeEvalRedisClient, FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';

const job = {
  id: 'j',
  name: 'email',
  data: { raw: '雪' },
  attempts: 0,
  maxAttempts: 3,
  availableAtMs: 0,
};

describe('Redis delivery lease', () => {
  it('uses the server clock, reclaims an abandoned delivery and keeps payload bytes unchanged', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client, visibilityTimeoutMs: 3000 });
    await queue.connect();
    try {
      await queue.enqueue(job);
      const [first] = await queue.reserve('email', 1, 1_000_000);
      expect(first).toMatchObject({ attempts: 1, claimToken: '1' });
      expect(client.calls.filter((call) => call.method === 'zadd').at(-1)?.args).toEqual([
        'queue:email:processing',
        3100,
        'j',
      ]);
      expect(await queue.reserve('email', 1, 1_000_000)).toEqual([]);
      client.serverNowMs = 3100;
      const [second] = await queue.reserve('email', 1, 1_000_000);
      expect(second).toMatchObject({ attempts: 2, claimToken: '2' });
      expect(await client.hget('queue:email:jobs', 'j')).toBe(JSON.stringify(job));
      for (const call of [
        () => queue.ack('email', 'j', first.claimToken),
        () => queue.requeue('email', 'j', 0, 2, first.claimToken),
        () => queue.deadLetter('email', 'j', 400, first.claimToken),
        () => queue.ack('email', 'j'),
        () => queue.requeue('email', 'j', 0, 2),
        () => queue.deadLetter('email', 'j', 400),
      ])
        await expect(call()).rejects.toBeInstanceOf(StaleClaimError);
      expect(await queue.depths!('email')).toEqual({ ready: 0, processing: 1, dead: 0 });
      expect(await queue.claimRenewal!.extend('email', 'j', first.claimToken!)).toBe(false);
      client.serverNowMs = 5000;
      expect(await queue.claimRenewal!.extend('email', 'j', second.claimToken!)).toBe(true);
      client.serverNowMs = 7000;
      expect(await queue.reserve('email', 1, 1_000_000)).toEqual([]);
      await queue.ack('email', 'j', second.claimToken);
      expect(await client.hget('queue:email:claims', 'j')).toBeNull();
      expect(await client.hget('queue:email:stalls', 'j')).toBeNull();
      await expect(queue.requeue('email', 'j', 0, 2, second.claimToken)).rejects.toBeInstanceOf(
        StaleClaimError,
      );
      const renewal = queue.claimRenewal!;
      await queue.disconnect();
      expect(queue.claimRenewal).toBeUndefined();
      expect(await renewal.extend('email', 'j', second.claimToken!)).toBe(false);
    } finally {
      await queue.disconnect();
    }
  });

  it('removes ready and processing orphans, including claims and stalls, and reclaims pre-upgrade jobs', async () => {
    const client = new FakeEvalRedisClient();
    const queue = new RedisQueue({ client });
    await queue.connect();
    try {
      for (const state of ['ready', 'processing']) {
        await client.zadd(`queue:email:${state}`, 0, state);
        await client.hset('queue:email:claims', state, 'old');
        await client.hset('queue:email:stalls', state, '4');
      }
      await client.hset(
        'queue:email:jobs',
        'legacy',
        JSON.stringify({ ...job, id: 'legacy', attempts: 2 }),
      );
      await client.zadd('queue:email:processing', 0, 'legacy');
      const [legacy] = await queue.reserve('email', 10, 100);
      expect(legacy).toMatchObject({ id: 'legacy', attempts: 3 });
      for (const orphan of ['ready', 'processing']) {
        expect(await client.hget('queue:email:claims', orphan)).toBeNull();
        expect(await client.hget('queue:email:stalls', orphan)).toBeNull();
      }
      expect(await queue.depths!('email')).toEqual({ ready: 0, processing: 1, dead: 0 });
      await queue.requeue('email', 'legacy', 200, 4, legacy.claimToken);
      expect(await client.hget('queue:email:stalls', 'legacy')).toBeNull();
      client.serverNowMs = 200;
      const [again] = await queue.reserve('email', 1, 200);
      expect(again.attempts).toBe(4);
      await queue.deadLetter('email', 'legacy', 200, again.claimToken);
      expect(await client.hget('queue:email:claims', 'legacy')).toBeNull();
      expect(await queue.depths!('email')).toEqual({ ready: 0, processing: 0, dead: 1 });
    } finally {
      await queue.disconnect();
    }
  });

  it('keeps the no-eval fallback without claims or reclaim and warns only once across connects', async () => {
    const client = new FakeRedisClient();
    const report = vi.fn();
    const queue = new RedisQueue({
      client,
      visibilityTimeoutMs: 1000,
      connectionErrorReporter: { report, recovered() {} },
    });
    await queue.connect();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].message).toContain('visibilityTimeoutMs is inactive');
    expect(queue.claimRenewal).toBeUndefined();
    await queue.enqueue(job);
    expect((await queue.reserve('email', 1, 0))[0]).toEqual(job);
    expect(await queue.reserve('email', 1, 1_000_000)).toEqual([]);
    await queue.disconnect();
    await queue.connect();
    expect(report).toHaveBeenCalledTimes(1);
    await queue.ack('email', 'j');
    await queue.disconnect();
  });

  it('validates the positive lease length at construction without echoing values', () => {
    for (const value of [0, 1, 999, 999.9, -1, NaN, Infinity, 2_147_483_648, 'bad', null]) {
      expect(() => new RedisQueue({ visibilityTimeoutMs: value as number })).toThrow(
        'options.visibilityTimeoutMs',
      );
    }
    for (const value of [1000, 2_147_483_647])
      expect(() => new RedisQueue({ visibilityTimeoutMs: value })).not.toThrow();
  });
});
