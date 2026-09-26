/**
 * M98f — the queue observation collector: minimization before buffering, the
 * M98a cursor contract over its bounded attempt ring, the bounded LRU job-alias
 * map and in-flight bound, settlement evidence, the disabled source, and the
 * bounded, non-overlapping depth scheduler.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { QueueSettlementState } from '@setu-ts/common';
import {
  compileQueueDiagnosticsPolicy,
  createDisabledQueueSource,
  QUEUE_COLLECTOR_ERRORS,
  QUEUE_COLLECTOR_LIMITS,
  QueueObservationCollector,
  readDepthResult,
  validateQueueReadArgs,
} from '../../src/diagnostics/queue-observation-collector.ts';
import type { QueueDepthReader } from '../../src/diagnostics/queue-observation-collector.ts';
import type { QueueDepths } from '../../src/adapters/queue-adapter.ts';
import type { QueueDiagnosticsOptions } from '../../src/interfaces/index.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

const RAW_ID_CANARY = 'raw-job-id-canary-SYNTHETIC';

/**
 * Drains the microtask queue without moving the fake clock, so a cycle whose
 * counts already resolved can finish reporting.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
}
const NAME_CANARY = 'job.name.canary';

function collector(
  overrides: Partial<QueueDiagnosticsOptions> = {},
  confirmsSettlement = true,
): { collector: QueueObservationCollector; runtime: FakeRuntimeServices } {
  const runtime = new FakeRuntimeServices(1_000);
  const policy = compileQueueDiagnosticsPolicy({
    enabled: true,
    instanceAlias: 'worker-a',
    queues: { [NAME_CANARY]: 'emails', 'image.resize': 'images', 'pdf.render': 'pdfs' },
    ...overrides,
  } as QueueDiagnosticsOptions);
  return {
    collector: new QueueObservationCollector(policy, runtime, confirmsSettlement),
    runtime,
  };
}

/** Records one full attempt: begin, advance, settle. */
async function record(
  target: QueueObservationCollector,
  runtime: FakeRuntimeServices,
  jobId: string,
  settlement: QueueSettlementState = 'acknowledged',
  name = NAME_CANARY,
): Promise<void> {
  const handle = target.begin(name, jobId, 1);
  await runtime.advanceMs(0);
  handle?.settled('completed', settlement);
}

describe('createDisabledQueueSource', () => {
  it('answers a frozen, disabled batch and observes nothing', () => {
    const batch = createDisabledQueueSource().read(0);
    expect(batch).toEqual({
      version: 1,
      state: 'disabled',
      depthCoverage: 'disabled',
      failure: 'none',
      attempts: [],
      depths: [],
      next: 0,
      lost: 0,
      closed: false,
      droppedAttempts: 0,
      evictedJobAliases: 0,
    });
    expect('instanceAlias' in batch).toBe(false);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.attempts)).toBe(true);
  });

  it('validates its arguments with the same fixed error as the active source', () => {
    const source = createDisabledQueueSource();
    expect(() => source.read(1)).toThrow(QUEUE_COLLECTOR_ERRORS.badCursor);
    expect(() => source.read(-1)).toThrow(RangeError);
    expect(() => source.read(0, 129)).toThrow(QUEUE_COLLECTOR_ERRORS.badCursor);
  });
});

describe('validateQueueReadArgs', () => {
  it('defaults the limit to 128 and accepts the inclusive bounds', () => {
    expect(validateQueueReadArgs(0, undefined, 0)).toBe(128);
    expect(validateQueueReadArgs(5, 1, 5)).toBe(1);
  });

  it('refuses a bad cursor or limit without echoing it', () => {
    for (
      const [after, limit] of [
        [Number.NaN, 1],
        [1.5, 1],
        ['0', 1],
        [Number.MAX_SAFE_INTEGER + 1, 1],
        [6, 1],
        [0, 0],
        [0, 1.5],
        [0, '1'],
      ] as const
    ) {
      expect(() => validateQueueReadArgs(after, limit, 5)).toThrow(
        QUEUE_COLLECTOR_ERRORS.badCursor,
      );
    }
  });
});

describe('QueueObservationCollector — attempts', () => {
  it('retains only aliases and framework primitives — never the job name or raw id', async () => {
    const { collector: target, runtime } = collector();
    const handle = target.begin(NAME_CANARY, RAW_ID_CANARY, 2)!;
    await runtime.advanceMs(250);
    handle.settled('retryable-error', 'requeued');
    await runtime.advanceMs(100);

    const batch = target.read(0);
    expect(batch.state).toBe('ready');
    expect(batch.instanceAlias).toBe('worker-a');
    expect(batch.attempts).toEqual([
      {
        sequence: 1,
        queueAlias: 'emails',
        jobAlias: 'j1',
        attempt: 2,
        durationMs: 250,
        outcome: 'retryable-error',
        settlement: 'requeued',
        ageMs: 100,
      },
    ]);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(RAW_ID_CANARY);
    expect(serialized).not.toContain(NAME_CANARY);
  });

  it('does not observe or count an unapproved job name', () => {
    const { collector: target } = collector();
    expect(target.begin('unapproved.job', 'x', 1)).toBeNull();
    const batch = target.read(0);
    expect(batch.state).toBe('no-data');
    expect(batch.attempts).toEqual([]);
    expect(batch.droppedAttempts).toBe(0);
  });

  it('keeps one alias per raw id across retries and allocates fresh ones for new ids', async () => {
    const { collector: target, runtime } = collector();
    await record(target, runtime, 'id-a');
    await record(target, runtime, 'id-b');
    await record(target, runtime, 'id-a');
    expect(target.read(0).attempts.map((a) => a.jobAlias)).toEqual(['j1', 'j2', 'j1']);
  });

  it('evicts the least-recently-used alias at 4,096 entries and counts it', async () => {
    const { collector: target, runtime } = collector();
    for (let index = 0; index < QUEUE_COLLECTOR_LIMITS.jobAliases; index++) {
      target.begin(NAME_CANARY, `id-${index}`, 1)?.settled('completed', 'acknowledged');
    }
    // Touch id-0 so id-1 becomes the least recently used.
    target.begin(NAME_CANARY, 'id-0', 1)?.settled('completed', 'acknowledged');
    expect(target.read(0).evictedJobAliases).toBe(0);
    target.begin(NAME_CANARY, 'id-new', 1)?.settled('completed', 'acknowledged');
    expect(target.read(0).evictedJobAliases).toBe(1);
    // id-0 survived; id-1 was evicted and a later attempt gets a NEW alias.
    await runtime.advanceMs(0);
    target.begin(NAME_CANARY, 'id-0', 1)?.settled('completed', 'acknowledged');
    target.begin(NAME_CANARY, 'id-1', 1)?.settled('completed', 'acknowledged');
    // The last two retained attempts: sequences 4099 and 4100.
    const aliases = target.read(QUEUE_COLLECTOR_LIMITS.jobAliases + 2).attempts.map((a) =>
      a.jobAlias
    );
    expect(aliases[0]).toBe('j1');
    expect(aliases[1]).toBe(`j${QUEUE_COLLECTOR_LIMITS.jobAliases + 2}`);
    expect(target.read(0).evictedJobAliases).toBe(2);
  });

  it('refuses to observe beyond 2,048 in-flight attempts and counts the drop', () => {
    const { collector: target } = collector();
    const handles = [];
    for (let index = 0; index < QUEUE_COLLECTOR_LIMITS.inFlightAttempts; index++) {
      handles.push(target.begin(NAME_CANARY, `id-${index}`, 1));
    }
    expect(handles.every((h) => h !== null)).toBe(true);
    expect(target.begin(NAME_CANARY, 'overflow', 1)).toBeNull();
    expect(target.read(0).droppedAttempts).toBe(1);
    // Settling one frees a slot.
    handles[0]!.settled('completed', 'acknowledged');
    expect(target.begin(NAME_CANARY, 'after', 1)).not.toBeNull();
  });

  it('drops an attempt number that is not a positive safe integer, before buffering', () => {
    const { collector: target } = collector();
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(target.begin(NAME_CANARY, 'x', attempt)).toBeNull();
    }
    const batch = target.read(0);
    expect(batch.droppedAttempts).toBe(5);
    expect(batch.attempts).toEqual([]);
    // A valid attempt after them is still observed.
    target.begin(NAME_CANARY, 'y', 1)!.settled('completed', 'acknowledged');
    expect(target.read(0).attempts.length).toBe(1);
  });

  it('records a completed call on an unconfirming adapter as unknown, keeping failed', () => {
    const { collector: target } = collector({}, false);
    for (const settlement of ['acknowledged', 'requeued', 'dead-lettered', 'failed'] as const) {
      target.begin(NAME_CANARY, settlement, 1)!.settled('completed', settlement);
    }
    expect(target.read(0).attempts.map((a) => a.settlement)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'failed',
    ]);
  });

  it('ignores a second settlement and a settlement after close', () => {
    const { collector: target } = collector();
    const handle = target.begin(NAME_CANARY, 'a', 1)!;
    handle.settled('completed', 'acknowledged');
    handle.settled('terminal-error', 'dead-lettered');
    expect(target.read(0).attempts.length).toBe(1);

    const late = target.begin(NAME_CANARY, 'b', 1)!;
    target.close();
    late.settled('completed', 'acknowledged');
    expect(target.read(0).attempts).toEqual([]);
    expect(target.begin(NAME_CANARY, 'c', 1)).toBeNull();
  });

  it('returns deeply frozen batches', () => {
    const { collector: target } = collector();
    target.begin(NAME_CANARY, 'a', 1)!.settled('completed', 'acknowledged');
    const batch = target.read(0);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.attempts)).toBe(true);
    expect(Object.isFrozen(batch.attempts[0])).toBe(true);
  });
});

describe('QueueObservationCollector — the M98a cursor contract', () => {
  function fill(count: number): QueueObservationCollector {
    const { collector: target } = collector();
    for (let index = 0; index < count; index++) {
      target.begin(NAME_CANARY, `id-${index}`, 1)!.settled('completed', 'acknowledged');
    }
    return target;
  }

  it('pages exclusively after the cursor and echoes the cursor on an empty page', () => {
    const target = fill(5);
    const first = target.read(0, 2);
    expect(first.attempts.map((a) => a.sequence)).toEqual([1, 2]);
    expect(first.next).toBe(2);
    expect(first.lost).toBe(0);
    const second = target.read(first.next, 128);
    expect(second.attempts.map((a) => a.sequence)).toEqual([3, 4, 5]);
    const empty = target.read(5);
    expect(empty.attempts).toEqual([]);
    expect(empty.next).toBe(5);
    expect(empty.lost).toBe(0);
  });

  it('throws for a cursor beyond the current sequence', () => {
    expect(() => fill(3).read(4)).toThrow(QUEUE_COLLECTOR_ERRORS.badCursor);
  });

  it('reports exact loss across eviction — after: 0 is not special-cased', () => {
    const target = fill(QUEUE_COLLECTOR_LIMITS.retainedAttempts + 10);
    const batch = target.read(0, 5);
    expect(batch.attempts[0].sequence).toBe(11);
    expect(batch.lost).toBe(10);
    // A pre-eviction cursor: the gap first - after - 1 EQUALS lost.
    const parked = target.read(3, 5);
    expect(parked.attempts[0].sequence).toBe(11);
    expect(parked.lost).toBe(parked.attempts[0].sequence - 3 - 1);
    // Every later sequence in the page is consecutive.
    expect(parked.attempts.map((a) => a.sequence)).toEqual([11, 12, 13, 14, 15]);
  });

  it('answers an empty closed batch after close, even for a cursor it had issued', () => {
    const target = fill(3);
    target.close();
    const closed = target.read(3);
    expect(closed.closed).toBe(true);
    expect(closed.attempts).toEqual([]);
    expect(closed.next).toBe(3);
    expect(closed.state).toBe('no-data');
  });
});

/** A controllable depth reader. */
function reader(overrides: Partial<QueueDepthReader> & {
  results?: Record<string, () => Promise<QueueDepths>>;
} = {}): QueueDepthReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scope: overrides.scope ?? 'shared-backend',
    supported: overrides.supported ?? (() => true),
    names: overrides.names ?? (() => [NAME_CANARY, 'image.resize', 'unapproved']),
    read: overrides.read ?? ((name: string) => {
      calls.push(name);
      const result = overrides.results?.[name];
      return result === undefined
        ? Promise.resolve({ ready: 3, processing: 1, dead: 0 })
        : result();
    }),
  };
}

const DEPTHS = { intervalMs: 1_000, timeoutMs: 100, concurrency: 2 } as const;

describe('QueueObservationCollector — depth scheduler', () => {
  it('reports disabled coverage and never counts when no depth policy is configured', async () => {
    const { collector: target, runtime } = collector();
    const counting = reader();
    target.startDepths(counting);
    await runtime.advanceMs(5_000);
    expect(counting.calls).toEqual([]);
    expect(target.read(0).depthCoverage).toBe('disabled');
    expect(runtime.timerCount).toBe(0);
  });

  it('is pending until started, then counts approved processor names only, completely', async () => {
    const { collector: target, runtime } = collector({ depths: DEPTHS });
    expect(target.read(0).depthCoverage).toBe('pending');
    const counting = reader();
    target.startDepths(counting);
    await settle();
    expect(counting.calls.sort()).toEqual(['image.resize', NAME_CANARY].sort());
    await runtime.advanceMs(40);
    const batch = target.read(0);
    expect(batch.state).toBe('ready');
    expect(batch.depthCoverage).toBe('complete');
    expect(batch.failure).toBe('none');
    expect(batch.depths).toEqual([
      {
        queueAlias: 'emails',
        ready: 3,
        processing: 1,
        dead: 0,
        scope: 'shared-backend',
        coverage: 'complete',
        ageMs: 40,
      },
      {
        queueAlias: 'images',
        ready: 3,
        processing: 1,
        dead: 0,
        scope: 'shared-backend',
        coverage: 'complete',
        ageMs: 40,
      },
    ]);
    expect(JSON.stringify(batch)).not.toContain(NAME_CANARY);
  });

  it('runs one immediate cycle and one per interval, and start is idempotent', async () => {
    const { collector: target, runtime } = collector({ depths: DEPTHS });
    const counting = reader({ names: () => [NAME_CANARY] });
    target.startDepths(counting);
    target.startDepths(counting);
    await settle();
    expect(counting.calls.length).toBe(1);
    await runtime.advanceMs(1_000);
    expect(counting.calls.length).toBe(2);
    await runtime.advanceMs(2_000);
    expect(counting.calls.length).toBe(4);
  });

  it('reports unavailable — never zero — when the adapter cannot count', async () => {
    const { collector: target } = collector({ depths: DEPTHS });
    const counting = reader({ supported: () => false });
    target.startDepths(counting);
    await settle();
    expect(counting.calls).toEqual([]);
    const batch = target.read(0);
    expect(batch.depthCoverage).toBe('unavailable');
    expect(batch.depths).toEqual([]);
  });

  it('reports a vacuously complete cycle when no approved name has a processor', async () => {
    const { collector: target } = collector({ depths: DEPTHS });
    target.startDepths(reader({ names: () => ['unapproved'] }));
    await settle();
    expect(target.read(0).depthCoverage).toBe('complete');
  });

  it('reports a failed count as partial with a fixed category, keeping earlier counts', async () => {
    const { collector: target, runtime } = collector({ depths: DEPTHS });
    let fail = false;
    const counting = reader({
      names: () => [NAME_CANARY, 'image.resize'],
      results: {
        'image.resize': () =>
          fail ? Promise.reject(new Error('canary-error-SYNTHETIC')) : Promise.resolve({
            ready: 9,
            processing: 0,
            dead: 1,
          }),
      },
    });
    target.startDepths(counting);
    await settle();
    fail = true;
    await runtime.advanceMs(1_000);
    const batch = target.read(0);
    expect(batch.failure).toBe('depth-read-failed');
    expect(batch.depthCoverage).toBe('partial');
    const images = batch.depths.find((d) => d.queueAlias === 'images')!;
    expect(images.coverage).toBe('complete');
    expect(images.ageMs).toBe(1_000);
    expect(batch.depths.find((d) => d.queueAlias === 'emails')!.coverage).toBe('partial');
    expect(JSON.stringify(batch)).not.toContain('canary-error-SYNTHETIC');
  });

  it('treats a synchronous throw and an invalid count shape as failed counts', async () => {
    const { collector: target } = collector({ depths: DEPTHS });
    target.startDepths(reader({
      names: () => [NAME_CANARY, 'image.resize'],
      read: (name: string) => {
        if (name === NAME_CANARY) {
          throw new Error('sync');
        }
        return Promise.resolve({ ready: -1, processing: 0, dead: 0 });
      },
    }));
    await settle();
    const batch = target.read(0);
    expect(batch.failure).toBe('depth-read-failed');
    expect(batch.depths).toEqual([]);
    expect(batch.depthCoverage).toBe('partial');
  });

  it('reports a hung count as timed out and never replaces it until it settles', async () => {
    const { collector: target, runtime } = collector({
      depths: { intervalMs: 1_000, timeoutMs: 100, concurrency: 1 },
    });
    let release: (value: QueueDepths) => void = () => {};
    let started = 0;
    const counting = reader({
      names: () => [NAME_CANARY],
      read: () => {
        started += 1;
        return new Promise<QueueDepths>((resolve) => {
          release = resolve;
        });
      },
    });
    target.startDepths(counting);
    await runtime.advanceMs(200);
    expect(target.read(0).failure).toBe('depth-read-timed-out');
    // Three more intervals: the hung raw promise still holds the only slot.
    await runtime.advanceMs(3_000);
    expect(started).toBe(1);
    expect(target.read(0).depthCoverage).toBe('partial');
    // Once it settles, the next cycle counts again.
    release({ ready: 1, processing: 0, dead: 0 });
    await runtime.advanceMs(1_000);
    expect(started).toBe(2);
  });

  it('keeps a hung count to its own slot so the other queues keep refreshing', async () => {
    const { collector: target, runtime } = collector({ depths: DEPTHS });
    const counting = reader({
      names: () => [NAME_CANARY, 'image.resize', 'pdf.render'],
      results: { [NAME_CANARY]: () => new Promise<QueueDepths>(() => {}) },
    });
    target.startDepths(counting);
    await runtime.advanceMs(200);
    await runtime.advanceMs(1_000);
    await runtime.advanceMs(1_000);
    const aliases = target.read(0).depths.map((d) => d.queueAlias).sort();
    expect(aliases).toEqual(['images', 'pdfs']);
    expect(counting.calls.filter((c) => c === NAME_CANARY).length).toBe(1);
  });

  it('never starts overlapping cycles', async () => {
    const { collector: target, runtime } = collector({
      depths: { intervalMs: 1_000, timeoutMs: 30_000, concurrency: 1 },
    });
    let started = 0;
    target.startDepths(reader({
      names: () => [NAME_CANARY],
      read: () => {
        started += 1;
        return new Promise<QueueDepths>(() => {});
      },
    }));
    // Intervals fire while the first cycle is still racing its 30 s deadline.
    await runtime.advanceMs(5_000);
    expect(started).toBe(1);
  });

  it('clears every timer and retained depth on close and discards a late count', async () => {
    const { collector: target, runtime } = collector({ depths: DEPTHS });
    let release: (value: QueueDepths) => void = () => {};
    target.startDepths(reader({
      names: () => [NAME_CANARY],
      read: () => new Promise<QueueDepths>((resolve) => (release = resolve)),
    }));
    await settle();
    expect(runtime.timerCount).toBeGreaterThan(0);
    target.close();
    target.close();
    expect(runtime.timerCount).toBe(0);
    release({ ready: 1, processing: 0, dead: 0 });
    await settle();
    expect(target.read(0).depths).toEqual([]);
    target.startDepths(reader());
    expect(runtime.timerCount).toBe(0);
  });

  it('rotates its starting queue so no queue is starved under a small concurrency', async () => {
    const { collector: target, runtime } = collector({
      depths: { intervalMs: 1_000, timeoutMs: 100, concurrency: 1 },
    });
    const counting = reader({ names: () => [NAME_CANARY, 'image.resize', 'pdf.render'] });
    target.startDepths(counting);
    await settle();
    await runtime.advanceMs(1_000);
    expect(counting.calls.slice(0, 3)).toEqual([NAME_CANARY, 'image.resize', 'pdf.render']);
    expect(counting.calls[3]).toBe(NAME_CANARY);
  });
});

describe('readDepthResult', () => {
  it('accepts three non-negative safe integers and nothing else', () => {
    expect(readDepthResult({ ready: 0, processing: 2, dead: 5, extra: 'dropped' })).toEqual({
      ready: 0,
      processing: 2,
      dead: 5,
    });
    expect(readDepthResult(null)).toBeNull();
    expect(readDepthResult([1, 2, 3])).toBeNull();
    expect(readDepthResult({ ready: 1.5, processing: 0, dead: 0 })).toBeNull();
    expect(readDepthResult({ ready: 0, processing: '0', dead: 0 })).toBeNull();
    expect(readDepthResult({ ready: 0, processing: 0, dead: Number.POSITIVE_INFINITY }))
      .toBeNull();
    const hostile = {
      get ready(): number {
        throw new Error('getter');
      },
    };
    expect(readDepthResult(hostile)).toBeNull();
  });
});
