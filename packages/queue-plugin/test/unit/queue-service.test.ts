import { EventEmitter } from 'node:events';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
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

/**
 * A MemoryQueue whose enqueue() rejects with a caller-supplied error, standing
 * in for a transport that loses its backend while a job is being enqueued.
 */
class FailingEnqueueQueue extends MemoryQueue {
  constructor(private readonly failure: unknown) {
    super();
  }
  override enqueue(_job: unknown): Promise<void> {
    return Promise.reject(this.failure);
  }
}

/**
 * An event-emitting Redis client whose writes fail. `status` is what the queue
 * reads at dispatch; `onWrite` runs inside the failing write, standing in for
 * what the driver does between dispatch and failure (a reconnect, a state
 * change).
 */
class FailingRedisClient extends EventEmitter {
  status: string;
  constructor(
    status: string,
    private readonly failure: Error,
    private readonly onWrite: (client: FailingRedisClient) => void,
  ) {
    super();
    this.status = status;
  }
  #fail(): Promise<never> {
    this.onWrite(this);
    return Promise.reject(this.failure);
  }
  zadd = (): Promise<never> => this.#fail();
  hset = (): Promise<never> => this.#fail();
  zrangebyscore = (): Promise<string[]> => Promise.resolve([]);
  zrem = (): Promise<number> => Promise.resolve(0);
  hget = (): Promise<null> => Promise.resolve(null);
  hdel = (): Promise<number> => Promise.resolve(0);
  del = (): Promise<number> => Promise.resolve(0);
  quit = (): Promise<void> => Promise.resolve();
}

/**
 * A lost connection (ioredis \`MaxRetriesPerRequestError\`) answers 504 in
 * every client state: ioredis rejects commands already sent with the same
 * error, and a driver writes a queued command as soon as a socket opens, so no
 * state the framework can observe proves the command was never written (M131a
 * security audits).
 */
const LOST_CONNECTION_CASES = [
  ['reconnecting', false, 'reconnecting'],
  ['reconnecting', true, 'reconnecting'],
  ['reconnecting', false, 'ready'],
  ['ready', false, 'ready'],
] as const;

function maxRetries(): Error {
  const e = new Error(
    'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
  );
  e.name = 'MaxRetriesPerRequestError';
  return e;
}

describe('QueueService.add backend-fault wrapping (M131a X88-5)', () => {
  it.each(LOST_CONNECTION_CASES)(
    'dispatch %s, reconnect %s, failure %s → 504',
    async (before, reconnect, after) => {
      const runtime = new FakeRuntimeServices();
      const lost = maxRetries();
      const client = new FailingRedisClient(before, lost, (c) => {
        if (reconnect) c.emit('connect');
        c.status = after;
      });
      const service = new QueueService(new RedisQueue({ client }), runtime, {
        defaultMaxAttempts: 3,
        pollIntervalMs: 100,
      });
      await service.connect();
      try {
        await expect(service.add('jobs', { n: 1 })).rejects.toSatisfy((thrown: unknown) => {
          const e = thrown as Error;
          return e instanceof BackendOutcomeUnknownError && e.cause === lost;
        });
      } finally {
        await service.disconnect();
      }
      // The watch is detached on disconnect: the shared client keeps no listener.
      expect(client.listenerCount('error')).toBe(0);
    },
  );

  it('RedisQueue keeps its error listener through QUIT, then detaches (N-4)', async () => {
    const client = new FailingRedisClient('ready', new Error('unused'), () => {});
    client.quit = (): Promise<void> => {
      client.emit('error', new Error('write EPIPE'));
      return Promise.resolve();
    };
    const report = vi.fn();
    const queue = new RedisQueue({
      client,
      connectionErrorReporter: { report, recovered: vi.fn() },
    });
    await queue.connect();
    await queue.disconnect();
    // QUIT's EPIPE reached the reporter (the other report is the adapter's own
    // inactive-lease notice for a client without eval).
    expect(report.mock.calls.some(([error]) => (error as Error).message === 'write EPIPE')).toBe(
      true,
    );
    expect(client.listenerCount('error')).toBe(0);
  });

  it('RedisQueue: a failed connect and its retry leave one listener pair (N-3)', async () => {
    const client = Object.assign(new FailingRedisClient('wait', new Error('unused'), () => {}), {
      attempts: 0,
      connect(this: { attempts: number }): Promise<void> {
        return ++this.attempts === 1 ? Promise.reject(new Error('refused')) : Promise.resolve();
      },
    });
    const queue = new RedisQueue({ client });
    await expect(queue.connect()).rejects.toThrow('refused');
    expect(client.listenerCount('error')).toBe(0);
    await queue.connect();
    expect(client.listenerCount('error')).toBe(1);
    await queue.disconnect();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('RedisQueue: a failed connect does not detach a concurrent attempt’s listeners (R3-2)', async () => {
    let release: (() => void) | undefined;
    const client = Object.assign(new FailingRedisClient('wait', new Error('unused'), () => {}), {
      attempts: 0,
      connect(this: { attempts: number }): Promise<void> {
        this.attempts++;
        if (this.attempts === 1) {
          return new Promise<void>((_resolve, reject) => {
            release = () => reject(new Error('refused'));
          });
        }
        return Promise.resolve();
      },
    });
    const queue = new RedisQueue({ client });
    const first = queue.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await queue.connect();
    release!();
    await expect(first).rejects.toThrow('refused');
    // The second attempt's listeners survive the first attempt's failure.
    expect(client.listenerCount('error')).toBe(1);
    await queue.disconnect();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('RedisQueue: a rejected QUIT forces a disconnect before detaching (R3-3)', async () => {
    const client = new FailingRedisClient('ready', new Error('unused'), () => {});
    const order: string[] = [];
    client.quit = (): Promise<void> => {
      order.push('quit');
      return Promise.reject(new Error('Command timed out'));
    };
    Object.assign(client, {
      disconnect: () => {
        order.push(`disconnect (error listeners ${client.listenerCount('error')})`);
      },
    });
    const queue = new RedisQueue({ client });
    await queue.connect();
    await expect(queue.disconnect()).rejects.toThrow('Command timed out');
    expect(order).toEqual(['quit', 'disconnect (error listeners 1)']);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('wraps a refusal before any send as BackendUnavailableError (503)', async () => {
    const runtime = new FakeRuntimeServices();
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    });
    const service = new QueueService(new FailingEnqueueQueue(refused), runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });
    await service.connect();
    try {
      await expect(service.add('jobs', { n: 1 })).rejects.toSatisfy(
        (thrown: unknown) => thrown instanceof BackendUnavailableError && thrown.cause === refused,
      );
    } finally {
      await service.disconnect();
    }
  });

  it('answers 504 for a lost connection on an adapter that reports no state', async () => {
    const runtime = new FakeRuntimeServices();
    const lost = maxRetries();
    const service = new QueueService(new FailingEnqueueQueue(lost), runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });
    await service.connect();
    try {
      await expect(service.add('jobs', { n: 1 })).rejects.toBeInstanceOf(
        BackendOutcomeUnknownError,
      );
    } finally {
      await service.disconnect();
    }
  });

  it('wraps a sent-with-no-answer fault as BackendOutcomeUnknownError (504)', async () => {
    const runtime = new FakeRuntimeServices();
    const timedOut = new Error('Command timed out');
    const service = new QueueService(new FailingEnqueueQueue(timedOut), runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });
    await service.connect();
    try {
      await expect(service.add('jobs', { n: 1 })).rejects.toSatisfy((thrown: unknown) => {
        const e = thrown as Error;
        return e instanceof BackendOutcomeUnknownError && e.cause === timedOut;
      });
    } finally {
      await service.disconnect();
    }
  });

  it('passes an unrecognised shape through unchanged', async () => {
    const runtime = new FakeRuntimeServices();
    const programming = new Error('Cannot read properties of undefined');
    const service = new QueueService(new FailingEnqueueQueue(programming), runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });
    await service.connect();
    try {
      await expect(service.add('jobs', { n: 1 })).rejects.toBe(programming);
    } finally {
      await service.disconnect();
    }
  });
});

describe('QueueService', () => {
  it('an unanswered probe reports unknown and skips depth reads', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const healthy = vi.spyOn(adapter, 'isHealthy').mockImplementation(() => new Promise(() => {}));
    const depths = vi.spyOn(adapter, 'depths');
    const service = new QueueService(adapter, runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
    });
    service.process('work', async () => {});
    await service.connect();
    try {
      const indicator = service.createHealthIndicator();
      const result = indicator();
      await runtime.advanceMs(2000);
      expect(await result).toEqual({
        status: 'up',
        data: { adapter: 'MemoryQueue', reachable: 'unknown' },
      });
      expect(await indicator()).toEqual(await result);
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(depths).not.toHaveBeenCalled();
    } finally {
      await service.disconnect();
    }
  });
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
      await expect(service.addRecurring('test', {}, { cron: 'bad' })).rejects.toThrow();
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

    it('returns up with reachable true when ready and reachable', async () => {
      await service.connect();
      const result = await service.createHealthIndicator()();
      expect(result.status).toBe('up');
      expect(result.data).toEqual({ adapter: 'MemoryQueue', reachable: true });
    });

    it('returns up with reachable unknown when the adapter cannot probe', async () => {
      const noProbe = new MemoryQueue();
      // Shadow the prototype isHealthy with an absent own property (M53 class).
      Object.defineProperty(noProbe, 'isHealthy', { value: undefined, configurable: true });
      const svc = new QueueService(noProbe, runtime, {
        defaultMaxAttempts: 3,
        pollIntervalMs: 100,
      });
      await svc.connect();
      const result = await svc.createHealthIndicator()();
      expect(result.status).toBe('up');
      expect(result.data).toEqual({ adapter: 'MemoryQueue', reachable: 'unknown' });
    });

    it('returns down with reachable false when ready but unreachable', async () => {
      class UnhealthyQueue extends MemoryQueue {
        override isHealthy(): Promise<boolean> {
          return Promise.resolve(false);
        }
      }
      const svc = new QueueService(new UnhealthyQueue(), runtime, {
        defaultMaxAttempts: 3,
        pollIntervalMs: 100,
      });
      await svc.connect();
      const result = await svc.createHealthIndicator()();
      expect(result.status).toBe('down');
      expect(result.data).toEqual({ adapter: 'UnhealthyQueue', reachable: false });
    });

    it('returns down when not ready', async () => {
      const indicator = service.createHealthIndicator();
      const result = await indicator();
      expect(result.status).toBe('down');
    });
  });
});
