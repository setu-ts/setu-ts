import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ILogger } from '@setu-ts/common';
import {
  attachSchedulerCollector,
  SchedulerService,
} from '../../src/services/scheduler-service.ts';
import { SchedulerObservationCollector } from '../../src/diagnostics/scheduler-observations.ts';
import { MemoryLock } from '../../src/lock/memory-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('scheduler cancellation outcomes', () => {
  const services: SchedulerService[] = [];
  afterEach(async () => {
    for (const service of services.splice(0)) await service.disconnect();
  });

  async function setup(runtime = new FakeRuntime(), lock = new MemoryLock(runtime)) {
    const logger: ILogger = {
      level: 'debug',
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: () => logger,
    };
    const collector = new SchedulerObservationCollector(
      'scheduler',
      new Map([['job', 'job']]),
      () => runtime.now(),
      () => runtime.hrtime(),
    );
    const settled = vi.spyOn(collector, 'fireSettled');
    const service = new SchedulerService(runtime, lock, { logger });
    services.push(service);
    attachSchedulerCollector(service, collector);
    await service.connect();
    return { service, runtime, lock, logger, collector, settled };
  }

  for (const final of ['succeeded', 'failed'] as const) {
    for (const resumeEarly of [false, true]) {
      it(`a paused one-shot that ${final} is removed, including resume before settlement: ${resumeEarly}`, async () => {
        const { service, runtime, lock, settled, logger } = await setup();
        const releases = vi.spyOn(lock, 'release');
        const gate = deferred();
        const handler = vi.fn(async () => {
          await gate.promise;
          if (final === 'failed') throw new Error('final failure');
        });
        await service.delay('job', 0, handler);
        const now = runtime.now();
        await runtime.advanceTo(now);
        expect(handler).toHaveBeenCalledTimes(1);
        await service.pause('job');
        if (resumeEarly) await service.resume('job');
        gate.resolve();
        await runtime.advanceTo(now);
        await expect(service.resume('job')).rejects.toThrow('No scheduled job');
        expect(handler).toHaveBeenCalledTimes(1);
        expect(runtime.getPendingTimerCount()).toBe(0);
        expect(releases.mock.calls.filter(([key]) => key.endsWith(':once'))).toHaveLength(1);
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          'dispatched',
          final === 'succeeded',
          expect.any(Number),
        );
        if (final === 'failed') {
          expect(logger.error).toHaveBeenCalledWith(
            "Job 'job' failed after 1 attempt(s)",
            expect.anything(),
          );
          expect(logger.error).toHaveBeenCalledWith(
            "Job 'job' failed permanently",
            expect.anything(),
          );
        } else {
          expect(logger.error).not.toHaveBeenCalled();
        }
      });
    }
  }

  for (const outcome of ['succeeded', 'failed', 'cancelled', 'not-fired'] as const) {
    it(`disconnect releases a one-shot slot for a later replica (${outcome})`, async () => {
      const { service: a, runtime, lock } = await setup();
      const releases = vi.spyOn(lock, 'release');
      const gate = deferred();
      const handler = vi.fn(async () => {
        await gate.promise;
        if (outcome !== 'succeeded') throw new Error('settled after disconnect');
      });
      await a.delay('job', outcome === 'not-fired' ? 100 : 0, handler, {
        retry: { limit: outcome === 'cancelled' ? 3 : 1, delay: 1000, backoff: 'fixed' },
      });
      const now = runtime.now();
      await runtime.advanceTo(now);
      await a.disconnect();
      gate.resolve();
      await runtime.advanceTo(now);
      expect(runtime.getPendingTimerCount()).toBe(0);
      expect(releases.mock.calls.filter(([key]) => key.endsWith(':once'))).toHaveLength(1);
      const { service: b } = await setup(runtime, lock);
      const replacement = vi.fn();
      await b.delay('job', 0, replacement);
      await runtime.advanceTo(now);
      expect(replacement).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(outcome === 'not-fired' ? 0 : 1);
      expect(runtime.getPendingTimerCount()).toBe(0);
    });
  }

  it('a one-shot paused mid-backoff stays registered and resumes at attempt 1 without success for cancellation', async () => {
    const { service, runtime, lock, settled, collector, logger } = await setup();
    const releases = vi.spyOn(lock, 'release');
    const attempts: number[] = [];
    await service.delay(
      'job',
      0,
      (job) => {
        attempts.push(job.attempts);
        if (attempts.length === 1) throw new Error('retry');
      },
      { retry: { limit: 3, delay: 1000, backoff: 'fixed' } },
    );
    const now = runtime.now();
    await runtime.advanceTo(now);
    await service.pause('job');
    await runtime.advanceTo(now + 2000);
    expect(attempts).toEqual([1]);
    expect(runtime.getPendingTimerCount()).toBe(0);
    await expect(service.getNextRun('job')).rejects.toThrow('paused');
    expect(releases.mock.calls.filter(([key]) => key.endsWith(':once'))).toHaveLength(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'dispatched',
      false,
      expect.any(Number),
    );
    expect(logger.error).not.toHaveBeenCalled();
    await service.resume('job');
    await runtime.advanceTo(now + 2000);
    expect(attempts).toEqual([1, 1]);
    await expect(service.getNextRun('job')).rejects.toThrow('No scheduled job');
    expect(collector.snapshot().records.find((r) => r.operation === 'fire')).toMatchObject({
      count: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('an old final fire cannot remove or release a new entry registered under the same name', async () => {
    const { service, runtime, lock } = await setup();
    const releases = vi.spyOn(lock, 'release');
    const gate = deferred();
    await service.delay('job', 0, () => gate.promise);
    const now = runtime.now();
    await runtime.advanceTo(now);
    await service.remove('job');
    const replacement = vi.fn();
    await service.delay('job', 100, replacement);
    gate.resolve();
    await runtime.advanceTo(now);
    expect(await service.getNextRun('job')).toBe(now + 100);
    expect(runtime.getPendingTimerCount()).toBe(1);
    expect(releases.mock.calls.filter(([key]) => key.endsWith(':once'))).toHaveLength(1);
    await runtime.advanceTo(now + 100);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  it('disconnect during an unfinished attempt records a non-success without retry or permanent-failure logs', async () => {
    const { service, runtime, settled, logger, collector } = await setup();
    const gate = deferred();
    const handler = vi.fn(async () => {
      await gate.promise;
      throw new Error('retryable failure');
    });
    await service.every('job', 100, handler, {
      retry: { limit: 3, delay: 1000, backoff: 'fixed' },
    });
    const due = await service.getNextRun('job');
    await runtime.advanceTo(due);
    await service.disconnect();
    gate.resolve();
    await runtime.advanceTo(due + 2000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      'dispatched',
      false,
      expect.any(Number),
    );
    expect(collector.snapshot().records.find((r) => r.operation === 'fire')).toMatchObject({
      succeeded: 0,
      failed: 1,
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(runtime.getPendingTimerCount()).toBe(0);
  });

  for (const stage of ['slot', 'mutex'] as const) {
    it(`pause during ${stage} acquire records a non-success before attempt 1`, async () => {
      const { service, runtime, lock, settled, collector } = await setup();
      const gate = deferred();
      const acquire = lock.acquire.bind(lock);
      vi.spyOn(lock, 'acquire').mockImplementation(async (key, ttl) => {
        const isMutex = key === 'scheduler:job:job';
        if (isMutex === (stage === 'mutex')) await gate.promise;
        return acquire(key, ttl);
      });
      const handler = vi.fn();
      await service.every('job', 100, handler);
      const due = await service.getNextRun('job');
      await runtime.advanceTo(due);
      await service.pause('job');
      gate.resolve();
      await runtime.advanceTo(due + 2000);
      expect(handler).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        'dispatched',
        false,
        expect.any(Number),
      );
      expect(collector.snapshot().records.find((r) => r.operation === 'fire')).toMatchObject({
        succeeded: 0,
        failed: 1,
      });
      expect(collector.snapshot().records.some((r) => r.operation === 'attempt')).toBe(false);
      expect(runtime.getPendingTimerCount()).toBe(0);
    });
  }
});
