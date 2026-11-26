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
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('queue poll failed', { error: 'clock' });
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
      error: 'offline',
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
