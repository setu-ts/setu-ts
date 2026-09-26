import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRuntimeServices } from '@setu-ts/common';

import {
  type RetainedSpanCandidate,
  SpanObservationCollector,
  TRACE_COLLECTOR_ERRORS,
  TRACE_COLLECTOR_LIMITS,
} from '../../src/diagnostics/span-observation-collector.ts';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);
const PARENT = 'c'.repeat(16);

/** A controllable monotonic clock. */
function fakeClock() {
  let now = 0;
  return {
    hrtime: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function collectorFor(clock: { hrtime(): number }) {
  const availability = {
    coverage: 'completed-sampled-spans' as const,
    instrumentation: () => ['http'] as const,
    sampler: { kind: 'always-on' as const },
  };
  return new SpanObservationCollector(
    availability,
    clock as unknown as Pick<IRuntimeServices, 'hrtime'>,
  );
}

function candidate(overrides: Partial<RetainedSpanCandidate> = {}): RetainedSpanCandidate {
  return {
    serviceAlias: 'orders',
    operationAlias: 'create-order',
    traceId: TRACE,
    spanId: SPAN,
    links: [],
    kind: 'server',
    outcome: 'ok',
    durationMs: 12.5,
    parentVisibility: 'root',
    ...overrides,
  };
}

describe('SpanObservationCollector — retention and projection', () => {
  it('retains a candidate and projects the exact field set', () => {
    const clock = fakeClock();
    const collector = collectorFor(clock);
    collector.retain(candidate());
    clock.advance(30);
    const batch = collector.read('instance-1', 0);
    expect(batch.state).toBe('ready');
    expect(batch.coverage).toBe('completed-sampled-spans');
    expect(batch.sampler).toEqual({ kind: 'always-on' });
    expect(batch.instrumentation).toEqual(['http']);
    expect(batch.records.length).toBe(1);
    const record = batch.records[0]!;
    // The exact field set — and no application data anywhere in it.
    expect(record).toEqual({
      sequence: 1,
      serviceAlias: 'orders',
      operationAlias: 'create-order',
      traceId: TRACE,
      spanId: SPAN,
      links: [],
      kind: 'server',
      outcome: 'ok',
      durationMs: 12.5,
      ageMs: 30,
      parentVisibility: 'root',
    });
    expect(JSON.stringify(batch).includes('POST /orders')).toBe(false);
  });

  it('returns frozen batches a reader cannot mutate', () => {
    const collector = collectorFor(fakeClock());
    collector.retain(candidate());
    const batch = collector.read('instance-1', 0);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.records)).toBe(true);
    expect(Object.isFrozen(batch.records[0])).toBe(true);
    expect(Object.isFrozen(batch.instrumentation)).toBe(true);
  });

  it('carries a parent span id exactly when the visibility is meaningful', () => {
    const collector = collectorFor(fakeClock());
    collector.retain(candidate({
      parentSpanId: PARENT,
      parentVisibility: 'remote-or-unobserved',
    }));
    const record = collector.read('i', 0).records[0]!;
    expect(record.parentSpanId).toBe(PARENT);
    expect(record.parentVisibility).toBe('remote-or-unobserved');
  });
});

describe('SpanObservationCollector — bounds and loss', () => {
  it('evicts the oldest span past the ring bound and reports the exact gap once', () => {
    const clock = fakeClock();
    const collector = collectorFor(clock);
    const total = TRACE_COLLECTOR_LIMITS.retainedSpans + 2;
    for (let index = 0; index < total; index++) {
      collector.retain(candidate({ spanId: (index + 1).toString(16).padStart(16, '0') }));
      clock.advance(1);
    }
    // A cursor parked behind the eviction receives the oldest retained spans,
    // with the skipped sequences reported as `lost`.
    const batch = collector.read('i', 0);
    expect(batch.records.length).toBe(TRACE_COLLECTOR_LIMITS.readLimit);
    expect(batch.records[0]!.sequence).toBe(3);
    expect(batch.lost).toBe(2);
    // `lost` is PER BATCH, never cumulative: the next page reports none.
    const next = collector.read('i', batch.next);
    expect(next.lost).toBe(0);
    expect(next.records[0]!.sequence).toBe(batch.next + 1);
  });

  it('echoes the cursor on an empty page and refuses a beyond-sequence cursor', () => {
    const collector = collectorFor(fakeClock());
    const empty = collector.read('i', 0);
    expect(empty.records).toEqual([]);
    expect(empty.next).toBe(0);
    expect(empty.lost).toBe(0);
    expect(empty.state).toBe('no-data');
    // A beyond-sequence cursor is the one cursor that throws.
    expect(() => collector.read('i', 1)).toThrow(TRACE_COLLECTOR_ERRORS.badCursor);
  });

  it('counts dropped candidates from every refusal path', () => {
    const collector = collectorFor(fakeClock());
    collector.drop(); // an unapproved name, counted by the processor
    collector.retain(candidate({ traceId: '0'.repeat(32) }));
    collector.retain(candidate({ serviceAlias: '' }));
    collector.retain(
      candidate({
        kind: 'internal',
        parentVisibility: 'root',
        links: new Array(9).fill({ traceId: TRACE, spanId: SPAN }) as never,
      }),
    );
    collector.retain(candidate({ durationMs: Number.NaN }));
    collector.retain(candidate({ parentSpanId: PARENT, parentVisibility: 'root' }));
    collector.retain(candidate({ parentVisibility: 'observed' }));
    collector.retain(candidate({ outcome: 'nonsense' as never }));
    expect(collector.read('i', 0).droppedSpans).toBe(8);
    expect(collector.read('i', 0).records).toEqual([]);
  });

  it('keeps at most eight validated links per span', () => {
    const collector = collectorFor(fakeClock());
    const links = Array.from({ length: 8 }, (_, index) => ({
      traceId: (index + 1).toString(16).padStart(32, '0'),
      spanId: (index + 1).toString(16).padStart(16, '0'),
    }));
    collector.retain(candidate({ links }));
    const record = collector.read('i', 0).records[0]!;
    expect(record.links.length).toBe(8);
    expect(record.links[0]).toEqual(links[0]);
  });
});

describe('SpanObservationCollector — observed parents', () => {
  it('reports a retained parent as observed until it is evicted', () => {
    const collector = collectorFor(fakeClock());
    const own = candidate({ spanId: PARENT });
    collector.retain(own);
    expect(collector.observes(own.traceId, PARENT)).toBe(true);
    // Roll the parent out of the ring.
    for (let index = 0; index <= TRACE_COLLECTOR_LIMITS.retainedSpans; index++) {
      collector.retain(candidate({ spanId: (index + 1).toString(16).padStart(16, '0') }));
    }
    expect(collector.observes(own.traceId, PARENT)).toBe(false);
  });

  it('never treats the same span id in ANOTHER trace as observed evidence', () => {
    // Security audit F1: a remote caller controls `traceparent`, so a span id
    // retained in trace T1 can be named as the parent of a span in trace T2.
    const collector = collectorFor(fakeClock());
    const own = candidate({ spanId: PARENT });
    collector.retain(own);
    expect(collector.observes('f'.repeat(32), PARENT)).toBe(false);
  });

  it('keeps evidence while another retained span still carries the same pair', () => {
    const collector = collectorFor(fakeClock());
    const own = candidate({ spanId: PARENT });
    collector.retain(own);
    collector.retain(own);
    for (let index = 0; index < TRACE_COLLECTOR_LIMITS.retainedSpans - 1; index++) {
      collector.retain(candidate({ spanId: (index + 1).toString(16).padStart(16, '0') }));
    }
    // One copy evicted, one retained: still evidence.
    expect(collector.observes(own.traceId, PARENT)).toBe(true);
    collector.retain(candidate({ spanId: 'e'.repeat(16) }));
    expect(collector.observes(own.traceId, PARENT)).toBe(false);
  });
});

describe('SpanObservationCollector — close', () => {
  it('marks closed, clears retained records, and discards late retains', () => {
    const collector = collectorFor(fakeClock());
    collector.retain(candidate());
    collector.close();
    const batch = collector.read('i', 0);
    expect(batch.closed).toBe(true);
    expect(batch.records).toEqual([]);
    expect(batch.state).toBe('no-data');
    collector.retain(candidate());
    expect(collector.read('i', 0).records).toEqual([]);
    collector.close(); // idempotent
    expect(collector.read('i', 0).closed).toBe(true);
  });

  it('accepts a cursor up to the last sequence after close', () => {
    const collector = collectorFor(fakeClock());
    collector.retain(candidate());
    collector.close();
    expect(collector.read('i', 1).closed).toBe(true);
  });
});
