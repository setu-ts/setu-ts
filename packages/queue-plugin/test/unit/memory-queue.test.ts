import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';

describe('MemoryQueue', () => {
  let queue: MemoryQueue;

  beforeEach(() => {
    queue = new MemoryQueue();
  });

  describe('lifecycle', () => {
    it('isReady() is false before connect', () => {
      expect(queue.isReady()).toBe(false);
    });

    it('isReady() is true after connect', async () => {
      await queue.connect();
      expect(queue.isReady()).toBe(true);
    });

    it('isReady() is false after disconnect', async () => {
      await queue.connect();
      await queue.disconnect();
      expect(queue.isReady()).toBe(false);
    });

    it('throws when enqueueing while not connected', async () => {
      await expect(
        queue.enqueue({
          id: '1',
          name: 'test',
          data: { foo: 'bar' },
          attempts: 0,
          maxAttempts: 3,
          availableAtMs: Date.now(),
        }),
      ).rejects.toThrow('MemoryQueue is not connected');
    });
  });

  describe('enqueue and reserve', () => {
    beforeEach(async () => {
      await queue.connect();
    });

    it('enqueue adds a job', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await queue.enqueue(job);
      const reserved = await queue.reserve('test', 1, Date.now());

      expect(reserved.length).toBe(1);
      expect(reserved[0].id).toBe('1');
      expect(reserved[0].data).toEqual({ foo: 'bar' });
    });

    it('reserve CLAIMS jobs (second reserve returns nothing)', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await queue.enqueue(job);

      const reserved1 = await queue.reserve('test', 1, Date.now());
      expect(reserved1.length).toBe(1);

      const reserved2 = await queue.reserve('test', 1, Date.now());
      expect(reserved2.length).toBe(0);
    });

    it('reserve honors limit', async () => {
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      });
      await queue.enqueue({
        id: '2',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      });

      const reserved = await queue.reserve('test', 1, Date.now());
      expect(reserved.length).toBe(1);
    });

    it('reserve honors availableAtMs (delayed jobs)', async () => {
      const now = Date.now();
      await queue.enqueue({
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: now + 1000,
      });

      const reserved = await queue.reserve('test', 1, now);
      expect(reserved.length).toBe(0);

      const reservedLater = await queue.reserve('test', 1, now + 1000);
      expect(reservedLater.length).toBe(1);
    });
  });

  describe('ack', () => {
    beforeEach(async () => {
      await queue.connect();
    });

    it('ack removes job from processing', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await queue.enqueue(job);
      const reserved = await queue.reserve('test', 1, Date.now());
      expect(reserved.length).toBe(1);

      await queue.ack('test', '1');

      // Job should be removed from processing
      const reserved2 = await queue.reserve('test', 1, Date.now());
      expect(reserved2.length).toBe(0);
    });
  });

  describe('requeue', () => {
    beforeEach(async () => {
      await queue.connect();
    });

    it('requeue moves job back to ready with new availableAtMs', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await queue.enqueue(job);
      await queue.reserve('test', 1, Date.now());

      const now = Date.now();
      await queue.requeue('test', '1', now + 5000, 1);

      // Should not be available yet
      const reserved1 = await queue.reserve('test', 1, now);
      expect(reserved1.length).toBe(0);

      // Should be available after delay
      const reserved2 = await queue.reserve('test', 1, now + 5000);
      expect(reserved2.length).toBe(1);
      expect(reserved2[0].attempts).toBe(1);
    });
  });

  describe('deadLetter', () => {
    beforeEach(async () => {
      await queue.connect();
    });

    it('deadLetter moves job from processing to dead', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: Date.now(),
      };

      await queue.enqueue(job);
      await queue.reserve('test', 1, Date.now());

      await queue.deadLetter('test', '1');

      // Should not be reservable
      const reserved = await queue.reserve('test', 1, Date.now());
      expect(reserved.length).toBe(0);
    });
  });

  describe('recurring', () => {
    beforeEach(async () => {
      await queue.connect();
    });

    it('storeRecurring stores a recurring job', async () => {
      const rec = {
        id: 'r1',
        name: 'test',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: Date.now(),
      };

      await queue.storeRecurring(rec);
      const due = await queue.fetchRecurringDue(Date.now());

      expect(due.length).toBe(1);
      expect(due[0].id).toBe('r1');
    });

    it('advanceRecurring updates nextRunAtMs', async () => {
      const rec = {
        id: 'r1',
        name: 'test',
        data: {},
        cron: '* * * * *',
        nextRunAtMs: Date.now(),
      };

      await queue.storeRecurring(rec);
      await queue.advanceRecurring('r1', Date.now() + 60000);

      const due = await queue.fetchRecurringDue(Date.now());
      expect(due.length).toBe(0); // Should be in the future

      const dueLater = await queue.fetchRecurringDue(Date.now() + 60000);
      expect(dueLater.length).toBe(1);
    });
  });
});
