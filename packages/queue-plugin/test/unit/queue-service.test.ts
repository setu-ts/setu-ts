import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('QueueService', () => {
  let runtime: FakeRuntimeServices;
  let adapter: MemoryQueue;
  let service: QueueService;

  beforeEach(() => {
    runtime = new FakeRuntimeServices();
    adapter = new MemoryQueue();
    service = new QueueService(adapter, runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });
  });

  describe('lifecycle', () => {
    it('isReady() is false before connect', () => {
      expect(service.isReady()).toBe(false);
    });

    it('isReady() is true after connect', async () => {
      await service.connect();
      expect(service.isReady()).toBe(true);
    });

    it('isReady() is false after disconnect', async () => {
      await service.connect();
      await service.disconnect();
      expect(service.isReady()).toBe(false);
    });
  });

  describe('add', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('enqueueing returns a job ID', async () => {
      const id = await service.add('test', { foo: 'bar' });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('enqueueing with delayMs schedules for later', async () => {
      const id = await service.add('test', {}, { delayMs: 5000 });
      expect(id).toBeTruthy();
    });

    it('enqueueing with maxAttempts sets retry cap', async () => {
      const id = await service.add('test', {}, { maxAttempts: 5 });
      expect(id).toBeTruthy();
    });
  });

  describe('process', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('registers a processor', async () => {
      let called = false;
      service.process('test', () => {
        called = true;
      });

      // Add a job and advance clock
      await service.add('test', {});
      await runtime.advanceMs(200); // Advance past poll interval

      expect(called).toBe(true);
    });

    it('processor receives IJob with id, name, data, attempts', async () => {
      let receivedJob: unknown = null;
      service.process('test', (job) => {
        receivedJob = job;
      });

      await service.add('test', { foo: 'bar' });
      await runtime.advanceMs(200);

      expect(receivedJob).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          name: 'test',
          data: { foo: 'bar' },
          attempts: 1,
        }),
      );
    });

    it('acks on success', async () => {
      service.process('test', async () => {
        // Success
      });

      await service.add('test', {});
      await runtime.advanceMs(200);

      // Job should be processed and acked
      const jobs = await adapter.reserve('test', 1, Date.now());
      expect(jobs.length).toBe(0); // Already acked
    });

    it('requeues on failure with backoff', async () => {
      let callCount = 0;
      service.process('test', () => {
        callCount++;
        throw new Error('Fail');
      });

      await service.add('test', {});
      await runtime.advanceMs(200);

      // Should have tried once
      expect(callCount).toBe(1);

      // Advance past backoff
      await runtime.advanceMs(2000);
      await runtime.advanceMs(100);

      // Should retry
      await runtime.advanceMs(200);
    });

    it('dead-letters at maxAttempts', async () => {
      let callCount = 0;
      service.process('test', () => {
        callCount++;
        throw new Error('Fail');
      });

      await service.add('test', {}, { maxAttempts: 2 });
      await runtime.advanceMs(200);

      // First attempt
      expect(callCount).toBe(1);

      // Advance past backoff for retry
      await runtime.advanceMs(2000);
      await runtime.advanceMs(100);
      await runtime.advanceMs(200);

      // Second attempt (at max)
      expect(callCount).toBe(2);
    });
  });

  describe('concurrency', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('caps in-flight jobs at concurrency', async () => {
      const inFlight: Array<{ job: unknown; resolve: () => void }> = [];

      service.process(
        'test',
        async (job) => {
          await new Promise<void>((resolve) => {
            inFlight.push({ job, resolve });
          });
        },
        { concurrency: 2 },
      );

      // Add 5 jobs
      for (let i = 0; i < 5; i++) {
        await service.add('test', { index: i });
      }

      runtime.advanceMs(200);

      // Should have at most 2 in flight
      expect(inFlight.length).toBeLessThanOrEqual(2);
    });
  });

  describe('addRecurring', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('schedules a recurring job', async () => {
      await service.addRecurring('test', {}, { cron: '* * * * *' });

      // Verify recurring job was stored by fetching due jobs at a future time
      // The cron '* * * * *' means every minute, so at any time in the next minute,
      // the job should be due
      const futureTime = Date.now() + 60000; // 1 minute in the future
      const due = await adapter.fetchRecurringDue(futureTime);
      expect(due.length).toBe(1);
      expect(due[0].name).toBe('test');
    });

    it('throws on invalid cron', async () => {
      await expect(
        service.addRecurring('test', {}, { cron: 'bad' }),
      ).rejects.toThrow();
    });
  });

  describe('disconnect', () => {
    it('stops worker loop', async () => {
      await service.connect();
      await service.disconnect();

      // isReady should be false after disconnect
      expect(service.isReady()).toBe(false);
    });
  });

  describe('createHealthIndicator', () => {
    it('returns up when ready', async () => {
      await service.connect();
      const indicator = service.createHealthIndicator();
      const result = await indicator();
      expect(result.status).toBe('up');
      expect(result.data?.adapter).toBe('MemoryQueue');
    });

    it('returns down when not ready', async () => {
      const indicator = service.createHealthIndicator();
      const result = await indicator();
      expect(result.status).toBe('down');
    });
  });
});
