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
});
