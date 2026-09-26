/**
 * The failure-reporting path must never cost the job it reports on.
 *
 * A thrown value is caller-controlled. `QueueService.#report` converted a
 * non-Error with a bare `new Error(String(error))` OUTSIDE its guard, so a
 * processor rethrowing `{ toString: 1 }` (or a revoked `Proxy`) made the report
 * itself throw: the exception escaped `runJob` before the requeue or
 * dead-letter call, and with a logger registered the job was left in its
 * processing state for the life of the process. Also covered: the metrics
 * collector's own report path, and the diagnostics observation slot of an
 * attempt whose runner rejects before settling.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ICounter, IMetricsService } from '@setu-ts/common';
import { QueueService } from '../../src/services/queue-service.ts';
import type { QueueLogger } from '../../src/services/queue-service.ts';
import {
  toReportableError,
  UNDESCRIBABLE_ERROR_MESSAGE,
} from '../../src/services/reportable-error.ts';
import { QueueCollector } from '../../src/metrics/queue-collector.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import {
  compileQueueDiagnosticsPolicy,
  QueueObservationCollector,
} from '../../src/diagnostics/queue-observation-collector.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

/** A value whose string conversion throws: `toString` is not a function. */
const UNSTRINGIFIABLE = { toString: 1 } as unknown as Error;

/** A revoked proxy: even `instanceof` on it throws. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** An Error whose `message` getter throws. */
class HostileMessageError extends Error {
  override get message(): string {
    throw new Error('message getter');
  }
}

describe('toReportableError', () => {
  it('passes an Error through, wraps a describable value, and never throws', () => {
    const error = new Error('real');
    expect(toReportableError(error)).toBe(error);
    expect(toReportableError('plain').message).toBe('plain');
    expect(toReportableError(42).message).toBe('42');
    expect(toReportableError(UNSTRINGIFIABLE).message).toBe(UNDESCRIBABLE_ERROR_MESSAGE);
    expect(toReportableError(revokedProxy()).message).toBe(UNDESCRIBABLE_ERROR_MESSAGE);
  });
});

/** A memory adapter that records which settlement the runner reached. */
class RecordingQueue extends MemoryQueue {
  readonly settled: string[] = [];

  override ack(name: string, id: string, claimToken: string): Promise<void> {
    this.settled.push('ack');
    return super.ack(name, id, claimToken);
  }

  override requeue(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
    claimToken: string,
  ): Promise<void> {
    this.settled.push('requeue');
    return super.requeue(name, id, availableAtMs, attempts, claimToken);
  }

  override deadLetter(name: string, id: string, nowMs: number, claimToken: string): Promise<void> {
    this.settled.push('deadLetter');
    return super.deadLetter(name, id, nowMs, claimToken);
  }
}

async function runOne(
  thrown: unknown,
  maxAttempts: number,
): Promise<{ settled: string[]; logged: { message: string; error: unknown }[] }> {
  const runtime = new FakeRuntimeServices(1_000);
  const adapter = new RecordingQueue();
  const logged: { message: string; error: unknown }[] = [];
  const logger: QueueLogger = {
    error: (message, metadata) => logged.push({ message, error: metadata?.error }),
  };
  const service = new QueueService(adapter, runtime, { pollIntervalMs: 10, logger });
  await service.connect();
  service.process('job', () => {
    throw thrown;
  });
  await service.add('job', {}, { maxAttempts });
  await runtime.advanceMs(20);
  await service.disconnect();
  return { settled: adapter.settled, logged };
}

describe('QueueService — reporting a failure never strands the job', () => {
  it('requeues a job whose thrown value cannot be stringified', async () => {
    const { settled, logged } = await runOne(UNSTRINGIFIABLE, 3);
    expect(settled).toEqual(['requeue']);
    expect(logged).toEqual([
      { message: 'queue job failed — retrying', error: UNDESCRIBABLE_ERROR_MESSAGE },
    ]);
  });

  it('dead-letters a job whose thrown value is a revoked proxy', async () => {
    const { settled, logged } = await runOne(revokedProxy(), 1);
    expect(settled).toEqual(['deadLetter']);
    expect(logged[0].error).toBe(UNDESCRIBABLE_ERROR_MESSAGE);
  });

  it('settles a job whose thrown Error has a throwing message getter', async () => {
    const { settled } = await runOne(new HostileMessageError(), 1);
    expect(settled).toEqual(['deadLetter']);
  });
});

describe('QueueCollector — the metrics report path never escapes', () => {
  function refusingMetrics(thrown: unknown): IMetricsService {
    const counter = {
      inc: () => {
        throw thrown;
      },
    } as unknown as ICounter;
    return { counter: () => counter } as unknown as IMetricsService;
  }

  it('reports an undescribable refusal with the fixed message', () => {
    const reported: string[] = [];
    const collector = new QueueCollector(
      refusingMetrics(UNSTRINGIFIABLE),
      (error) => void reported.push(error.message),
    );
    expect(() => collector.jobSettled('job', 'completed')).not.toThrow();
    expect(reported).toEqual([UNDESCRIBABLE_ERROR_MESSAGE]);
  });

  it('swallows a reporter that itself throws', () => {
    const collector = new QueueCollector(refusingMetrics(new Error('refused')), () => {
      throw new Error('reporter broken');
    });
    expect(() => collector.jobSettled('job', 'completed')).not.toThrow();
  });
});

describe('QueueService — an attempt whose runner rejects before settling', () => {
  it('releases its observation slot and counts it dropped', async () => {
    /** A runtime whose wall clock can be made to throw mid-run. */
    class BreakingRuntime extends FakeRuntimeServices {
      broken = false;
      override now(): number {
        if (this.broken) {
          throw new Error('clock unavailable');
        }
        return super.now();
      }
    }
    const runtime = new BreakingRuntime(1_000);
    const observation = new QueueObservationCollector(
      compileQueueDiagnosticsPolicy({
        enabled: true,
        instanceAlias: 'worker',
        queues: { job: 'jobs' },
      }),
      runtime,
      true,
    );
    const service = new QueueService(new MemoryQueue(), runtime, {
      pollIntervalMs: 10,
      observer: observation,
    });
    await service.connect();
    // The retry branch reads the clock for its backoff BEFORE the settlement
    // call, so a clock that throws there rejects the runner unsettled.
    service.process('job', () => {
      runtime.broken = true;
      throw new Error('fail');
    });
    await service.add('job', {});
    await runtime.advanceMs(20);
    runtime.broken = false;
    const batch = observation.read(0);
    expect(batch.attempts).toEqual([]);
    expect(batch.droppedAttempts).toBe(1);
    await service.disconnect();
  });
});
