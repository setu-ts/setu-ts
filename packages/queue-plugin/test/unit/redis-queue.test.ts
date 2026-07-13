import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisQueue, validateClient } from '../../src/adapters/redis-queue.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';

describe('RedisQueue', () => {
  describe('validateClient', () => {
    it('rejects null', () => {
      expect(validateClient(null)).toBe(false);
    });

    it('rejects non-object', () => {
      expect(validateClient('string')).toBe(false);
      expect(validateClient(123)).toBe(false);
    });

    it('rejects object missing methods', () => {
      expect(validateClient({})).toBe(false);
      expect(validateClient({ zadd: () => 0 })).toBe(false);
    });

    it('accepts object with all required methods', () => {
      const client = {
        zadd: () => 0,
        zrangebyscore: () => [],
        zrem: () => 0,
        hset: () => 0,
        hget: () => null,
        hdel: () => 0,
        del: () => 0,
        quit: () => Promise.resolve(),
      };
      expect(validateClient(client)).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('isReady() is false before connect', () => {
      const queue = new RedisQueue();
      expect(queue.isReady()).toBe(false);
    });

    it('isReady() is true after connect with fake client', async () => {
      const fakeClient = new FakeRedisClient();
      const queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
      expect(queue.isReady()).toBe(true);
    });

    it('isReady() is false after disconnect', async () => {
      const fakeClient = new FakeRedisClient();
      const queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
      await queue.disconnect();
      expect(queue.isReady()).toBe(false);
    });
  });

  describe('enqueue and reserve with fake client', () => {
    let fakeClient: FakeRedisClient;
    let queue: RedisQueue;

    beforeEach(async () => {
      fakeClient = new FakeRedisClient();
      queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
    });

    it('enqueue emits HSET + ZADD', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await queue.enqueue(job);

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'hset')).toBe(true);
      expect(calls.some((c) => c.method === 'zadd')).toBe(true);
    });

    it('reserve emits ZRANGEBYSCORE then ZREM + ZADD processing', async () => {
      const now = Date.now();
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      });

      const reserved = await queue.reserve('test', 1, now);

      expect(reserved.length).toBe(1);
      expect(reserved[0].id).toBe('1');

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'zrangebyscore')).toBe(true);
      expect(calls.some((c) => c.method === 'zrem')).toBe(true);
    });

    it('reserve CLAIMS jobs (second reserve returns nothing)', async () => {
      const now = Date.now();
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      });

      const reserved1 = await queue.reserve('test', 1, now);
      expect(reserved1.length).toBe(1);

      const reserved2 = await queue.reserve('test', 1, now);
      expect(reserved2.length).toBe(0);
    });

    it('reserve returns round-tripped payload', async () => {
      const now = Date.now();
      const job = {
        id: '1',
        name: 'test',
        data: { foo: 'bar', count: 42 },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      };

      await queue.enqueue(job);
      const reserved = await queue.reserve('test', 1, now);

      expect(reserved[0].data).toEqual({ foo: 'bar', count: 42 });
    });
  });

  describe('ack', () => {
    let fakeClient: FakeRedisClient;
    let queue: RedisQueue;

    beforeEach(async () => {
      fakeClient = new FakeRedisClient();
      queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
    });

    it('ack emits ZREM processing + HDEL', async () => {
      const now = Date.now();
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      });
      await queue.reserve('test', 1, now);

      await queue.ack('test', '1');

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'zrem')).toBe(true);
      expect(calls.some((c) => c.method === 'hdel')).toBe(true);
    });
  });

  describe('requeue', () => {
    let fakeClient: FakeRedisClient;
    let queue: RedisQueue;

    beforeEach(async () => {
      fakeClient = new FakeRedisClient();
      queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
    });

    it('requeue emits HSET + ZREM + ZADD with new score', async () => {
      const now = Date.now();
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      });
      await queue.reserve('test', 1, now);

      await queue.requeue('test', '1', now + 5000, 1);

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'hset')).toBe(true);
      expect(calls.some((c) => c.method === 'zrem')).toBe(true);
      expect(calls.some((c) => c.method === 'zadd')).toBe(true);
    });
  });

  describe('deadLetter', () => {
    let fakeClient: FakeRedisClient;
    let queue: RedisQueue;

    beforeEach(async () => {
      fakeClient = new FakeRedisClient();
      queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
    });

    it('deadLetter emits ZREM processing + ZADD dead', async () => {
      const now = Date.now();
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now,
      });
      await queue.reserve('test', 1, now);

      await queue.deadLetter('test', '1');

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'zrem')).toBe(true);
      expect(calls.some((c) => c.method === 'zadd')).toBe(true);
    });
  });

  describe('recurring', () => {
    let fakeClient: FakeRedisClient;
    let queue: RedisQueue;

    beforeEach(async () => {
      fakeClient = new FakeRedisClient();
      queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
    });

    it('storeRecurring stores in recurring hashes', async () => {
      const rec = {
        id: 'r1',
        name: 'test',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: Date.now(),
      };

      await queue.storeRecurring(rec);

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'hset')).toBe(true);
      expect(calls.some((c) => c.method === 'zadd')).toBe(true);
    });

    it('advanceRecurring updates nextRunAtMs', async () => {
      const now = Date.now();
      await queue.storeRecurring({
        id: 'r1',
        name: 'test',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: now,
      });

      await queue.advanceRecurring('r1', now + 60000);

      const calls = fakeClient.calls;
      expect(calls.some((c) => c.method === 'hset')).toBe(true);
      expect(calls.some((c) => c.method === 'zadd')).toBe(true);
    });
  });

  describe('throws when not connected', () => {
    let queue: RedisQueue;

    beforeEach(() => {
      queue = new RedisQueue();
    });

    it('enqueue throws', async () => {
      await expect(
        queue.enqueue({
          id: '1',
          name: 'test',
          data: {},
          attempts: 0,
          maxAttempts: 3,
          availableAtMs: Date.now(),
        }),
      ).rejects.toThrow('not connected');
    });

    it('reserve throws', async () => {
      await expect(queue.reserve('test', 1, Date.now())).rejects.toThrow('not connected');
    });
  });

  describe('guarded real-import', () => {
    it('connect() rejects with bad URL (enters loadIoredis)', async () => {
      const queue = new RedisQueue({ url: 'redis://localhost:9999' });
      await expect(queue.connect()).rejects.toThrow();
    });
  });
});
