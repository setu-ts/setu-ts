import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

/**
 * A MemoryQueue whose ack() always rejects, standing in for a transport that
 * loses its backend between reserving a job and acknowledging it.
 */
class FailingAckQueue extends MemoryQueue {
  failedAcks = 0;

  override ack(_name: string, _id: string): Promise<void> {
    this.failedAcks++;
    return Promise.reject(new Error('backend unavailable during ack'));
  }
}

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

    it('connect() returns early when already connected', async () => {
      await service.connect();
      // Second connect should be a no-op
      await service.connect();
      expect(service.isReady()).toBe(true);
    });

    it('disconnect() handles being called when not connected', async () => {
      // Should not throw
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
      const jobs = await adapter.reserve('test', 1, runtime.now());
      expect(jobs.length).toBe(0); // Already acked
    });

    it('requeues on failure with backoff', async () => {
      let callCount = 0;
      service.process('test', () => {
        callCount++;
        throw new Error('Fail');
      });

      await service.add('test', {});
      // Poll interval is 1000ms, so advance past it
      await runtime.advanceMs(1100);

      // Should have tried once
      expect(callCount).toBe(1);

      // Advance past backoff (exponential: attempt 2 = 1000ms backoff)
      // Plus another poll interval to pick up the retried job
      await runtime.advanceMs(1000 + 1100);

      // Should retry - assert callCount increased
      expect(callCount).toBe(2);
    });

    it('dead-letters at maxAttempts', async () => {
      let callCount = 0;
      service.process('test', () => {
        callCount++;
        throw new Error('Fail');
      });

      await service.add('test', {}, { maxAttempts: 2 });
      // Poll interval is 1000ms
      await runtime.advanceMs(1100);

      // First attempt
      expect(callCount).toBe(1);

      // Advance past backoff for retry (attempt 2 = 1000ms) + poll interval
      await runtime.advanceMs(1000 + 1100);

      // Second attempt (at max)
      expect(callCount).toBe(2);

      // Job should be dead-lettered - verify via dead letters
      const deadLetters = adapter.getDeadLetters('test');
      expect(deadLetters.length).toBe(1);
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

      // Poll interval is 1000ms
      await runtime.advanceMs(1100);

      // Should have at most 2 in flight
      expect(inFlight.length).toBeLessThanOrEqual(2);
    });

    it('concurrency cap is not exceeded when the adapter ack() fails', async () => {
      // A failing ack rejects runJob after the in-flight slot was already
      // released. If that rejection releases the slot a SECOND time, inFlight
      // goes negative, `limit = concurrency - inFlight` grows past the cap, and
      // the next poll dispatches more jobs than `concurrency` allows.
      const failingAck = new FailingAckQueue();
      const failService = new QueueService(failingAck, runtime, {
        defaultMaxAttempts: 3,
        pollIntervalMs: 100,
      });
      await failService.connect();

      let concurrent = 0;
      let peakConcurrent = 0;
      // Phase 1 lets jobs run to completion (so their ack fails); phase 2 holds
      // them in flight so overlapping dispatches are observable.
      let gate: Promise<void> = Promise.resolve();

      failService.process(
        'test',
        async () => {
          concurrent++;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          await gate;
          concurrent--;
        },
        { concurrency: 2 },
      );

      // Phase 1: two jobs complete; both acks reject.
      await failService.add('test', { phase: 1 });
      await failService.add('test', { phase: 1 });
      await runtime.advanceMs(1100);
      expect(failingAck.failedAcks).toBe(2);

      // Phase 2: block the processor, then offer four more jobs. Only two may
      // ever be in flight at once.
      let openGate: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      for (let i = 0; i < 4; i++) {
        await failService.add('test', { phase: 2 });
      }
      await runtime.advanceMs(1100);

      expect(peakConcurrent).toBeLessThanOrEqual(2);

      openGate();
      await failService.disconnect();
    });
  });

  describe('double-dispatch regression (§3.5)', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('slow processor spanning 10+ poll ticks is dispatched exactly once', async () => {
      let dispatchCount = 0;
      let resolveJob: (() => void) | null = null;
      const jobProcessed = new Promise<void>((resolve) => {
        resolveJob = resolve;
      });

      service.process(
        'slow-job',
        async () => {
          dispatchCount++;
          await jobProcessed;
        },
        { concurrency: 1 },
      );

      // Add one job
      await service.add('slow-job', {});

      // Advance past 10 poll ticks (10 * 1000ms = 10000ms)
      await runtime.advanceMs(11000);

      // Should have dispatched exactly once (not re-dispatched due to reserve bug)
      expect(dispatchCount).toBe(1);

      // Clean up
      resolveJob!();
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
      const futureTime = runtime.now() + 60000; // 1 minute in the future
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

    it('disconnect handles being called when not connected', async () => {
      // Should not throw
      await service.disconnect();
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
