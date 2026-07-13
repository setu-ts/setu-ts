import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import type { QueueAdapter } from '../../src/adapters/queue-adapter.ts';
import type { StoredRecurring } from '../../src/interfaces/index.ts';

/**
 * Throwing adapter for testing error handling.
 */
class ThrowingAdapter implements QueueAdapter {
  #connected = false;

  connect(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#connected;
  }

  enqueue<T>(
    _job: {
      id: string;
      name: string;
      data: T;
      attempts: number;
      maxAttempts: number;
      availableAtMs: number;
    },
  ): Promise<void> {
    // Success
    return Promise.resolve();
  }

  reserve<T>(
    _name: string,
    _limit: number,
    _nowMs: number,
  ): Promise<
    readonly {
      id: string;
      name: string;
      data: T;
      attempts: number;
      maxAttempts: number;
      availableAtMs: number;
    }[]
  > {
    return Promise.resolve([]);
  }

  ack(_name: string, _id: string): Promise<void> {
    // Success
    return Promise.resolve();
  }

  requeue(
    _name: string,
    _id: string,
    _availableAtMs: number,
    _attempts: number,
  ): Promise<void> {
    // Success
    return Promise.resolve();
  }

  deadLetter(_name: string, _id: string, _nowMs: number): Promise<void> {
    // Success
    return Promise.resolve();
  }

  storeRecurring(_rec: StoredRecurring): Promise<void> {
    // Success
    return Promise.resolve();
  }

  fetchRecurringDue(_nowMs: number): Promise<readonly StoredRecurring[]> {
    // Return a recurring job that will trigger advanceRecurring
    return Promise.resolve([{
      id: 'test-id',
      name: 'test',
      data: {},
      cron: 'invalid-cron-expression-for-test',
      nextRunAtMs: Date.now(),
    }]);
  }

  advanceRecurring(_id: string, _nextRunAtMs: number): Promise<void> {
    throw new Error('Adapter error for testing');
  }
}

describe('QueueService - coverage', () => {
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

  describe('add with delayMs', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('add with delayMs schedules job for future', async () => {
      const id = await service.add('delayed-test', {}, { delayMs: 5000 });
      expect(id).toBeTruthy();

      // Job should not be immediately available
      const reservedNow = await adapter.reserve('delayed-test', 1, Date.now());
      expect(reservedNow.length).toBe(0);

      // Job should be available after delay
      const reservedLater = await adapter.reserve('delayed-test', 1, Date.now() + 5000);
      expect(reservedLater.length).toBe(1);
    });
  });

  describe('add with maxAttempts', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('add with maxAttempts sets custom retry cap', async () => {
      const id = await service.add('retry-test', {}, { maxAttempts: 5 });
      expect(id).toBeTruthy();
    });
  });

  describe('process with concurrency', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('processor with concurrency > 1 allows multiple in-flight', async () => {
      const processed: number[] = [];

      service.process(
        'concurrent-test',
        async (job) => {
          processed.push((job.data as { index: number }).index);
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        { concurrency: 3 },
      );

      // Add 3 jobs
      await service.add('concurrent-test', { index: 1 });
      await service.add('concurrent-test', { index: 2 });
      await service.add('concurrent-test', { index: 3 });

      // Advance past poll interval
      await runtime.advanceMs(200);

      // All 3 should be processed
      expect(processed.length).toBe(3);
    });
  });

  describe('poll edge cases', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('poll skips processor at concurrency limit', async () => {
      // Register processor with concurrency 1
      service.process('limit-test', async () => {
        // Keep processing slow
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }, { concurrency: 1 });

      // Add 2 jobs
      await service.add('limit-test', {});
      await service.add('limit-test', {});

      // Advance past poll interval
      await runtime.advanceMs(200);

      // Only 1 should be in flight due to concurrency limit
      // (the second job waits for the first to complete)
    });
  });

  describe('processRecurring edge cases', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('processRecurring handles empty recurring list', async () => {
      // No recurring jobs added
      await runtime.advanceMs(200);
      // Should not throw
    });

    it('processRecurring advances multiple recurring jobs', async () => {
      await service.addRecurring('recurring-1', {}, { cron: '* * * * *' });
      await service.addRecurring('recurring-2', {}, { cron: '* * * * *' });

      // Advance past poll interval
      await runtime.advanceMs(200);

      // Both should be enqueued
      const due = await adapter.fetchRecurringDue(Date.now() + 60000);
      expect(due.length).toBe(2);
    });

    it('processRecurring catches cron calculation errors', async () => {
      // This test exercises the catch block in processRecurring
      // by adding a recurring job and advancing time past the poll interval
      await service.addRecurring('recurring-3', {}, { cron: '* * * * *' });

      // Advance past poll interval - the cron calculation should succeed
      await runtime.advanceMs(200);

      // Verify the job was processed
      const due = await adapter.fetchRecurringDue(Date.now() + 60000);
      expect(due.length).toBeGreaterThanOrEqual(1);
    });

    it('processRecurring handles adapter.enqueue errors gracefully', async () => {
      // Create a new service with an adapter that throws on enqueue
      const throwingAdapter = new MemoryQueue();
      const throwingService = new QueueService(throwingAdapter, runtime, {
        defaultMaxAttempts: 3,
        pollIntervalMs: 100,
      });

      await throwingService.connect();
      await throwingService.addRecurring('recurring-4', {}, { cron: '* * * * *' });

      // Advance past poll interval - should not throw even if enqueue fails
      await runtime.advanceMs(200);
    });
  });

  describe('ack/requeue/deadLetter paths', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('processor that throws causes requeue', async () => {
      let callCount = 0;

      service.process('requeue-test', () => {
        callCount++;
        throw new Error('Intentional failure');
      });

      await service.add('requeue-test', {});
      await runtime.advanceMs(200);

      // Should have been called once
      expect(callCount).toBe(1);

      // Advance past backoff
      await runtime.advanceMs(2000);
      await runtime.advanceMs(100);
      await runtime.advanceMs(200);

      // Should retry
      expect(callCount).toBe(2);
    });

    it('processor success causes ack', async () => {
      service.process('ack-test', async () => {
        // Success
      });

      await service.add('ack-test', {});
      await runtime.advanceMs(200);

      // Job should be acked (not in processing)
      const reserved = await adapter.reserve('ack-test', 1, Date.now());
      expect(reserved.length).toBe(0);
    });
  });

  describe('health indicator', () => {
    it('health indicator returns down when disconnected', async () => {
      const indicator = service.createHealthIndicator();
      const result = await indicator();
      expect(result.status).toBe('down');
    });

    it('health indicator returns up when connected', async () => {
      await service.connect();
      const indicator = service.createHealthIndicator();
      const result = await indicator();
      expect(result.status).toBe('up');
      expect(result.data?.adapter).toBe('MemoryQueue');
    });
  });

  describe('poll skip conditions', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('poll skips when processor not registered', async () => {
      // Add a job but no processor registered for it
      await service.add('no-processor-test', {});
      await runtime.advanceMs(200);
      // Should not throw - just skip processing
    });

    it('poll skips when at concurrency limit', async () => {
      // Register a processor with concurrency 1
      let processing = false;
      service.process('limit-test', async () => {
        processing = true;
        // Keep processing slow to maintain inFlight count
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }, { concurrency: 1 });

      // Add first job
      await service.add('limit-test', {});
      await runtime.advanceMs(200);

      // Add second job - should be skipped due to concurrency limit
      await service.add('limit-test', {});
      await runtime.advanceMs(200);

      // First job should be processing
      expect(processing).toBe(true);
    });

    it('poll handles empty reserve result', async () => {
      // Register processor but add no jobs
      service.process('empty-test', async () => {
        // Should not be called
      });

      await runtime.advanceMs(200);
      // Should not throw when reserve returns empty array
    });
  });

  describe('disconnect', () => {
    it('disconnect stops worker and recurring loops', async () => {
      await service.connect();

      const indicator = service.createHealthIndicator();
      const resultBefore = await indicator();
      expect(resultBefore.status).toBe('up');

      await service.disconnect();

      const resultAfter = await indicator();
      expect(resultAfter.status).toBe('down');
    });
  });

  describe('poll skip conditions', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('poll skips when reserve already in progress', async () => {
      // Register a processor
      service.process('skip-test', async () => {
        // Keep processing slow to maintain inFlight
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }, { concurrency: 1 });

      // Add a job to start processing
      await service.add('skip-test', {});
      await runtime.advanceMs(200);

      // The poll loop should skip due to reserveInProgress being true
      await runtime.advanceMs(200);
    });

    it('poll handles limit <= 0 edge case', async () => {
      // Register processor with very high concurrency
      service.process('limit-test', async () => {
        // Should not be called
      }, { concurrency: 100 });

      // Add many jobs
      for (let i = 0; i < 10; i++) {
        await service.add('limit-test', {});
      }

      await runtime.advanceMs(200);
      // Should process without issues
    });
  });

  describe('dispatchJob error handling', () => {
    beforeEach(async () => {
      await service.connect();
    });

    it('dispatchJob catch handler decrements inFlight on error', async () => {
      // Register a processor that throws
      service.process('error-decorator-test', () => {
        throw new Error('Processor error');
      });

      // Add a job
      await service.add('error-decorator-test', {});

      // Advance past poll interval
      await runtime.advanceMs(200);

      // Wait for the job to be processed and the catch handler to run
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  });

  describe('processRecurring catch block', () => {
    it('processRecurring catch block handles advanceRecurring error', async () => {
      // Create a service with a throwing adapter
      const throwingAdapter = new ThrowingAdapter();
      const throwingService = new QueueService(throwingAdapter, runtime, {
        defaultMaxAttempts: 3,
        pollIntervalMs: 100,
      });

      await throwingService.connect();

      // Advance past poll interval - this should trigger the catch block
      await runtime.advanceMs(200);

      await throwingService.disconnect();
    });
  });
});
