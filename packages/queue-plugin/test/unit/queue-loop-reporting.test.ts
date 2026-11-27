/**
 * `QueueService` loop-failure reporting (M131a X88-9): a recurring-scheduling or
 * depth-probe failure reports once per state change — one `warn` when the
 * failure starts, one `info` on recovery, nothing per poll in between. Without
 * it a 30 s outage produced 75 error lines that buried the one that matters.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { QueueService } from '../../src/services/queue-service.ts';
import type { QueueLogger } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import { SqsDeadLetterTargetMissingError } from '../../src/index.ts';

/** A logger that records warn/info/error lines, as the state tracker needs. */
function recordingLogger() {
  const warns: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    infos,
    errors,
    logger: {
      error: (message: string): void => {
        errors.push(message);
      },
      warn: (message: string): void => {
        warns.push(message);
      },
      info: (message: string): void => {
        infos.push(message);
      },
    },
  };
}

describe('QueueService loop-failure reporting (M131a X88-9)', () => {
  it.each([false, true])(
    'keeps same-name recurring entries in separate failure episodes, failedFirst=%s',
    async (failedFirst) => {
      const runtime = new FakeRuntimeServices(0);
      const adapter = new MemoryQueue();
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
      const service = new QueueService(adapter, runtime, { logger, pollIntervalMs: 100 });
      const failedData = { entry: 'A' };
      const a = { id: 'A', name: 'one', data: failedData, cron: '* * * * *', nextRunAtMs: 0 };
      const b = { id: 'B', name: 'one', data: { entry: 'B' }, cron: '* * * * *', nextRunAtMs: 0 };
      vi.spyOn(adapter, 'fetchRecurringDue').mockResolvedValue(failedFirst ? [a, b] : [b, a]);
      let healthy = false;
      const enqueue = vi
        .spyOn(adapter, 'enqueue')
        .mockImplementation((job) =>
          job.data === failedData && !healthy
            ? Promise.reject(new Error('entry A unavailable'))
            : Promise.resolve(),
        );
      await service.connect();
      try {
        await runtime.advanceMs(300);
        expect(enqueue).toHaveBeenCalledTimes(6);
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith('queue recurring enqueue failed', {
          error: 'Error: entry A unavailable',
          name: 'one',
        });
        expect(logger.info).not.toHaveBeenCalled();
        healthy = true;
        await runtime.advanceMs(100);
        expect(logger.info).toHaveBeenCalledExactlyOnceWith('queue recurring enqueue recovered', {
          failures: 3,
          name: 'one',
        });
        expect(logger.warn).toHaveBeenCalledTimes(1);
      } finally {
        await service.disconnect();
        expect(runtime.timerCount).toBe(0);
      }
    },
  );

  it.each(
    (['reserve', 'poll', 'recurring enqueue', 'recurring', 'depth-probe'] as const).flatMap(
      (loop) => [false, true].map((errorOnly) => ({ loop, errorOnly })),
    ),
  )('masks URL userinfo in $loop failures, errorOnly=$errorOnly', async ({ loop, errorOnly }) => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = Object.assign(new MemoryQueue(), {
      ...(loop === 'poll'
        ? {
            prepareConsumer: () =>
              Promise.reject(
                new SqsDeadLetterTargetMissingError('one', 'source', 'attributes-unavailable'),
              ),
          }
        : {}),
    });
    const report = vi.fn<QueueLogger['error']>();
    const info = vi.fn<NonNullable<QueueLogger['info']>>();
    const logger = errorOnly
      ? { error: report, info }
      : { error: vi.fn<QueueLogger['error']>(), warn: report, info };
    const service = new QueueService(adapter, runtime, { logger, pollIntervalMs: 100 });
    const failure = new Error('offline https://user:secret@host\nretry refused');
    let recover: () => void;
    if (loop === 'reserve') {
      const reserve = vi.spyOn(adapter, 'reserve').mockRejectedValue(failure);
      recover = () => {
        reserve.mockResolvedValue([]);
      };
      service.process('one', () => {});
    } else if (loop === 'recurring enqueue') {
      vi.spyOn(adapter, 'fetchRecurringDue').mockResolvedValue([
        { id: 'r', name: 'one', data: {}, cron: '* * * * *', nextRunAtMs: 0 },
      ]);
      const enqueue = vi.spyOn(adapter, 'enqueue').mockRejectedValue(failure);
      recover = () => {
        enqueue.mockResolvedValue();
      };
    } else if (loop === 'recurring') {
      const fetchDue = vi.spyOn(adapter, 'fetchRecurringDue').mockRejectedValue(failure);
      recover = () => fetchDue.mockRestore();
    } else if (loop === 'depth-probe') {
      const depths = vi.spyOn(adapter, 'depths').mockRejectedValue(failure);
      recover = () => depths.mockRestore();
      service.process('one', () => {});
    } else {
      service.process('one', () => {});
      recover = () => {};
    }
    await service.connect();
    if (loop === 'poll') {
      // Preparation supplies the existing poll backstop's hrtime read.
      for (let index = 0; index < 30; index++) await Promise.resolve();
      const hrtime = vi.spyOn(runtime, 'hrtime').mockImplementation(() => {
        throw failure;
      });
      recover = () => hrtime.mockRestore();
    }
    const checkHealth = loop === 'depth-probe' ? service.createHealthIndicator() : undefined;
    try {
      if (checkHealth !== undefined) {
        for (let index = 0; index < 3; index++) await checkHealth();
      } else {
        await runtime.advanceMs(300);
      }
      const line = `queue ${loop} failed`;
      const failures = report.mock.calls.filter(([message]) => message === line);
      expect(failures).toHaveLength(1);
      const metadata = failures[0]![1];
      expect(metadata).toMatchObject({
        error: expect.stringContaining('https://***@host'),
        ...(loop === 'reserve' || loop === 'recurring enqueue' || loop === 'depth-probe'
          ? { name: 'one' }
          : {}),
      });
      expect(metadata?.['error']).not.toContain('secret');
      expect(metadata?.['error']).not.toMatch(/[\r\n]/);
      expect(metadata).not.toHaveProperty('stack');
      recover();
      if (checkHealth !== undefined) await checkHealth();
      else await runtime.advanceMs(100);
      expect(info).toHaveBeenCalledExactlyOnceWith(`queue ${loop} recovered`, {
        failures: 3,
        ...(loop === 'reserve' || loop === 'recurring enqueue' ? { name: 'one' } : {}),
      });
      expect(report.mock.calls.filter(([message]) => message === line)).toHaveLength(1);
    } finally {
      recover();
      await service.disconnect();
      expect(runtime.timerCount).toBe(0);
    }
  });

  it('tracks a poll backstop failure and its recovery independently of reserve tasks', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = Object.assign(new MemoryQueue(), {
      prepareConsumer: () =>
        Promise.reject(
          new SqsDeadLetterTargetMissingError('one', 'source', 'attributes-unavailable'),
        ),
    });
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const service = new QueueService(adapter, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    service.process('one', () => {});
    for (let i = 0; i < 30; i++) await Promise.resolve();
    vi.spyOn(runtime, 'hrtime').mockImplementationOnce(() => {
      throw new Error('clock');
    });
    await runtime.advanceMs(100);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('queue poll failed', {
      error: 'Error: clock',
    });
    await runtime.advanceMs(100);
    expect(logger.info).toHaveBeenCalledWith('queue poll recovered', { failures: 1 });
    await service.disconnect();
  });
  it('tracks reserve failures by name and reports each episode count on recovery', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const reserve = vi.spyOn(adapter, 'reserve').mockRejectedValue(new Error('offline'));
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const service = new QueueService(adapter, runtime, { logger, pollIntervalMs: 100 });
    service.process('one', () => {});
    service.process('two', () => {});
    await service.connect();
    await runtime.advanceMs(300);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('queue reserve failed', {
      error: 'Error: offline',
      name: 'one',
    });
    expect(logger.error).not.toHaveBeenCalled();
    reserve.mockResolvedValue([]);
    await runtime.advanceMs(100);
    expect(logger.info).toHaveBeenCalledWith('queue reserve recovered', {
      name: 'one',
      failures: 3,
    });
    expect(logger.info).toHaveBeenCalledWith('queue reserve recovered', {
      name: 'two',
      failures: 3,
    });
    await service.disconnect();
  });
  it('reports recurring enqueue failures once and recovers with the count', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const service = new QueueService(adapter, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    vi.spyOn(adapter, 'fetchRecurringDue').mockResolvedValue([
      { id: 'r', name: 'one', data: {}, cron: '* * * * *', nextRunAtMs: 0 },
    ]);
    const enqueue = vi.spyOn(adapter, 'enqueue').mockRejectedValue(new Error('offline'));
    await runtime.advanceMs(300);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    enqueue.mockResolvedValue();
    await runtime.advanceMs(100);
    expect(logger.info).toHaveBeenCalledWith('queue recurring enqueue recovered', {
      name: 'one',
      failures: 3,
    });
    await service.disconnect();
  });
  it('reports one warn for 100 consecutive recurring failures, one info on recovery, one warn on a new failure', async () => {
    const runtime = new FakeRuntimeServices();
    const { logger, warns, infos } = recordingLogger();
    const adapter = new MemoryQueue();
    const service = new QueueService(adapter, runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
      logger,
    });
    await service.connect();

    // The recurring loop runs `#processRecurring` every tick; it throws only
    // when `fetchRecurringDue` throws, so drive the state tracker through it.
    const fetchDue = vi
      .spyOn(adapter, 'fetchRecurringDue')
      .mockRejectedValue(new Error('backend down'));

    // 100 consecutive failures: exactly ONE warn, nothing per poll.
    await runtime.advanceMs(100 * 100);
    expect(warns.filter((m) => m.includes('recurring'))).toHaveLength(1);

    // Recovery: exactly ONE info.
    fetchDue.mockResolvedValue([]);
    await runtime.advanceMs(100);
    expect(infos.filter((m) => m.includes('recurring'))).toHaveLength(1);

    // A new failure after recovery: one more warn.
    fetchDue.mockRejectedValue(new Error('backend down again'));
    await runtime.advanceMs(100);
    expect(warns.filter((m) => m.includes('recurring'))).toHaveLength(2);

    await service.disconnect();
  });

  it('reports through error when the logger has no warn (CodeRabbit #543)', async () => {
    const runtime = new FakeRuntimeServices();
    const errors: string[] = [];
    const adapter = new MemoryQueue();
    const service = new QueueService(adapter, runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
      logger: { error: (message: string): void => void errors.push(message) },
    });
    await service.connect();
    vi.spyOn(adapter, 'fetchRecurringDue').mockRejectedValue(new Error('backend down'));
    await runtime.advanceMs(100 * 10);
    expect(errors.filter((m) => m.includes('recurring'))).toHaveLength(1);
    await service.disconnect();
  });

  it('warns again after a recovery when the logger has no info (CodeRabbit #543)', async () => {
    const runtime = new FakeRuntimeServices();
    const warns: string[] = [];
    const adapter = new MemoryQueue();
    const service = new QueueService(adapter, runtime, {
      defaultMaxAttempts: 3,
      pollIntervalMs: 100,
      logger: { error: (): void => {}, warn: (message: string): void => void warns.push(message) },
    });
    await service.connect();
    const fetchDue = vi
      .spyOn(adapter, 'fetchRecurringDue')
      .mockRejectedValue(new Error('backend down'));
    await runtime.advanceMs(100 * 5);
    fetchDue.mockResolvedValue([]);
    await runtime.advanceMs(100);
    fetchDue.mockRejectedValue(new Error('backend down again'));
    await runtime.advanceMs(100);
    expect(warns.filter((m) => m.includes('recurring'))).toHaveLength(2);
    await service.disconnect();
  });
});
