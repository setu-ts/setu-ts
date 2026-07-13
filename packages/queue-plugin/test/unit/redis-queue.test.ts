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

    it('throws when not connected', async () => {
      const notConnectedQueue = new RedisQueue();
      await expect(
        notConnectedQueue.ack('test', '1'),
      ).rejects.toThrow('RedisQueue is not connected');
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

    it('ack handles job not in processing gracefully', async () => {
      // Ack a job that was never reserved
      await queue.ack('test', 'nonexistent');
      // Should not throw
    });
  });

  describe('reserve with missing payload', () => {
    let testFakeClient: FakeRedisClient;
    let testQueue: RedisQueue;

    beforeEach(async () => {
      testFakeClient = new FakeRedisClient();
      // Override hget to return null (no payload)
      testFakeClient.hget = async () => {
        await Promise.resolve();
        return null;
      };
      testQueue = new RedisQueue({ client: testFakeClient });
      await testQueue.connect();

      // Add to ready set manually
      await testFakeClient.zadd('queue:test:ready', Date.now(), '1');
    });

    it('reserve handles job with missing payload gracefully', async () => {
      const reserved = await testQueue.reserve('test', 1, Date.now());
      // Should return empty array since payload is missing
      expect(reserved.length).toBe(0);
    });
  });

  describe('reserve with no due jobs', () => {
    let testFakeClient2: FakeRedisClient;
    let testQueue2: RedisQueue;

    beforeEach(async () => {
      testFakeClient2 = new FakeRedisClient();
      testQueue2 = new RedisQueue({ client: testFakeClient2 });
      await testQueue2.connect();
    });

    it('reserve returns empty array when no jobs are due', async () => {
      const now = Date.now();
      await testQueue2.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now + 60000, // 1 minute in future
      });

      const reserved = await testQueue2.reserve('test', 1, now);
      expect(reserved.length).toBe(0);
    });
  });

  describe('fetchRecurringDue', () => {
    let testFakeClient3: FakeRedisClient;
    let testQueue3: RedisQueue;

    beforeEach(async () => {
      testFakeClient3 = new FakeRedisClient();
      testQueue3 = new RedisQueue({ client: testFakeClient3 });
      await testQueue3.connect();
    });

    it('fetchRecurringDue returns due recurring jobs', async () => {
      const now = Date.now();
      // Store a recurring job that's already due
      await testQueue3.storeRecurring({
        id: 'r1',
        name: 'test',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: now,
      });

      const due = await testQueue3.fetchRecurringDue(now);
      expect(due.length).toBe(1);
      expect(due[0].id).toBe('r1');
    });

    it('fetchRecurringDue returns empty array when no jobs due', async () => {
      const now = Date.now();
      // Store a recurring job that's not due yet
      await testQueue3.storeRecurring({
        id: 'r2',
        name: 'test2',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: now + 60000,
      });

      const due = await testQueue3.fetchRecurringDue(now);
      expect(due.length).toBe(0);
    });

    it('fetchRecurringDue handles missing payload gracefully', async () => {
      // Override hget to return null
      testFakeClient3.hget = async () => {
        await Promise.resolve();
        return null;
      };
      // Add to due set manually
      await testFakeClient3.zadd('queue:recurring:due', Date.now(), 'orphan');

      const due = await testQueue3.fetchRecurringDue(Date.now());
      // Should return empty array since payload is missing
      expect(due.length).toBe(0);
    });
  });

  describe('advanceRecurring', () => {
    let testFakeClient4: FakeRedisClient;
    let testQueue4: RedisQueue;

    beforeEach(async () => {
      testFakeClient4 = new FakeRedisClient();
      testQueue4 = new RedisQueue({ client: testFakeClient4 });
      await testQueue4.connect();
    });

    it('advanceRecurring updates nextRunAtMs', async () => {
      const now = Date.now();
      await testQueue4.storeRecurring({
        id: 'r1',
        name: 'test',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: now,
      });

      await testQueue4.advanceRecurring('r1', now + 60000);

      // Verify the update
      const due = await testQueue4.fetchRecurringDue(now + 60000);
      expect(due.length).toBe(1);
      expect(due[0].nextRunAtMs).toBe(now + 60000);
    });

    it('advanceRecurring returns early when recurring job not found', async () => {
      // Should not throw
      await testQueue4.advanceRecurring('nonexistent', Date.now());
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

    it('requeue returns early when job payload not found', async () => {
      // Try to requeue a job that doesn't exist in storage
      await queue.requeue('test', 'nonexistent', Date.now() + 5000, 1);
      // Should not throw
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

    it('throws when not connected', async () => {
      const notConnectedQueue = new RedisQueue();
      await expect(
        notConnectedQueue.deadLetter('test', '1', Date.now()),
      ).rejects.toThrow('RedisQueue is not connected');
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

      await queue.deadLetter('test', '1', now);

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

    it('throws when storeRecurring not connected', async () => {
      const notConnectedQueue = new RedisQueue();
      await expect(
        notConnectedQueue.storeRecurring({
          id: 'r1',
          name: 'test',
          data: {},
          cron: '* * * * *',
          nextRunAtMs: Date.now(),
        }),
      ).rejects.toThrow('RedisQueue is not connected');
    });

    it('throws when fetchRecurringDue not connected', async () => {
      const notConnectedQueue = new RedisQueue();
      await expect(
        notConnectedQueue.fetchRecurringDue(Date.now()),
      ).rejects.toThrow('RedisQueue is not connected');
    });

    it('throws when advanceRecurring not connected', async () => {
      const notConnectedQueue = new RedisQueue();
      await expect(
        notConnectedQueue.advanceRecurring('r1', Date.now()),
      ).rejects.toThrow('RedisQueue is not connected');
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

    it('advanceRecurring returns early when recurring job not found', async () => {
      // Try to advance a recurring job that doesn't exist
      await queue.advanceRecurring('nonexistent', Date.now() + 60000);
      // Should not throw
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

  describe('connect with already connected', () => {
    it('connect returns early when already connected', async () => {
      const fakeClient = new FakeRedisClient();
      const queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
      const isReadyBefore = queue.isReady();
      await queue.connect(); // Second connect should be no-op
      const isReadyAfter = queue.isReady();
      expect(isReadyBefore).toBe(true);
      expect(isReadyAfter).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('disconnect sets client to null and ready to false', async () => {
      const fakeClient = new FakeRedisClient();
      const queue = new RedisQueue({ client: fakeClient });
      await queue.connect();
      expect(queue.isReady()).toBe(true);
      await queue.disconnect();
      expect(queue.isReady()).toBe(false);
    });

    it('disconnect handles null client gracefully', async () => {
      const queue = new RedisQueue();
      // Should not throw even without connect
      await expect(queue.disconnect()).resolves.toBeUndefined();
    });
  });
});
