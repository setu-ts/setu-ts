import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  isTraceBatchProjection,
  projectTraceBatch,
  readTraceSourceBatch,
} from '../../src/protocol/trace-protocol.ts';

const INSTANCE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);
const PARENT = 'c'.repeat(16);

/** A valid source batch carrying one root span at sequence `cursor + 1`. */
function sourceBatch(
  after: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    instanceId: INSTANCE,
    state: 'ready',
    coverage: 'completed-sampled-spans',
    instrumentation: ['http'],
    sampler: { kind: 'always-on' },
    records: [record(after + 1)],
    next: after + 1,
    lost: 0,
    closed: false,
    droppedSpans: 0,
    ...overrides,
  };
}

function record(
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence,
    serviceAlias: 'orders',
    operationAlias: 'create-order',
    traceId: TRACE,
    spanId: SPAN,
    links: [],
    kind: 'server',
    outcome: 'ok',
    durationMs: 4,
    ageMs: 6,
    parentVisibility: 'root',
    ...overrides,
  };
}

describe('readTraceSourceBatch — the exact source validator', () => {
  it('accepts a valid batch and copies it field by field', () => {
    const validated = readTraceSourceBatch(sourceBatch(0), INSTANCE, 0, 128);
    expect(validated).not.toBeNull();
    expect(validated!.records.length).toBe(1);
    expect(validated!.records[0]!.operationAlias).toBe('create-order');
    expect(validated!.coverage).toBe('completed-sampled-spans');
    expect(validated!.sampler).toEqual({ kind: 'always-on', ratio: null });
  });

  it('accepts a traceidratio sampler with its ratio and refuses others', () => {
    const ratio = sourceBatch(0, { sampler: { kind: 'traceidratio', ratio: 0.25 } });
    expect(readTraceSourceBatch(ratio, INSTANCE, 0, 128)!.sampler.ratio).toBe(0.25);
    const outOfRange = sourceBatch(0, { sampler: { kind: 'traceidratio', ratio: 1.5 } });
    expect(readTraceSourceBatch(outOfRange, INSTANCE, 0, 128)).toBeNull();
    const missingRatio = sourceBatch(0, { sampler: { kind: 'traceidratio' } });
    expect(readTraceSourceBatch(missingRatio, INSTANCE, 0, 128)).toBeNull();
    const extraRatio = sourceBatch(0, { sampler: { kind: 'always-on', ratio: 0.5 } });
    expect(readTraceSourceBatch(extraRatio, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses a foreign instance or version', () => {
    expect(readTraceSourceBatch(sourceBatch(0), 'other-instance', 0, 128)).toBeNull();
    const wrongVersion = sourceBatch(0);
    wrongVersion.version = 2;
    expect(readTraceSourceBatch(wrongVersion, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses records on disabled, unsupported, or closed batches', () => {
    expect(readTraceSourceBatch(sourceBatch(0, { state: 'disabled' }), INSTANCE, 0, 128))
      .toBeNull();
    expect(
      readTraceSourceBatch(sourceBatch(0, { state: 'unsupported' }), INSTANCE, 0, 128),
    ).toBeNull();
    expect(readTraceSourceBatch(sourceBatch(0, { closed: true }), INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses records past the requested limit', () => {
    const two = sourceBatch(0, {
      records: [record(1), record(2, { spanId: PARENT })],
      next: 2,
    });
    expect(readTraceSourceBatch(two, INSTANCE, 0, 128)).not.toBeNull();
    expect(readTraceSourceBatch(two, INSTANCE, 0, 1)).toBeNull();
  });

  it('enforces the cursor contract: increasing sequences past the cursor and exact next/lost', () => {
    expect(readTraceSourceBatch(sourceBatch(0), INSTANCE, 1, 128)).toBeNull();
    const gap = sourceBatch(0, { lost: 5 });
    expect(readTraceSourceBatch(gap, INSTANCE, 0, 128)).toBeNull();
    const echo = sourceBatch(0, { records: [], next: 4 });
    expect(readTraceSourceBatch(echo, INSTANCE, 0, 128)).toBeNull();
    // An empty page echoes the cursor exactly.
    expect(
      readTraceSourceBatch(sourceBatch(0, { records: [], next: 0 }), INSTANCE, 0, 128),
    ).not.toBeNull();
  });

  it('refuses malformed records', () => {
    const badId = sourceBatch(0, { records: [record(1, { spanId: 'ZZ' })] });
    expect(readTraceSourceBatch(badId, INSTANCE, 0, 128)).toBeNull();
    const zeroId = sourceBatch(0, { records: [record(1, { traceId: '0'.repeat(32) })] });
    expect(readTraceSourceBatch(zeroId, INSTANCE, 0, 128)).toBeNull();
    const badParent = sourceBatch(0, {
      records: [record(1, { parentSpanId: PARENT, parentVisibility: 'root' })],
    });
    expect(readTraceSourceBatch(badParent, INSTANCE, 0, 128)).toBeNull();
    const missingParent = sourceBatch(0, {
      records: [record(1, { parentVisibility: 'observed' })],
    });
    expect(readTraceSourceBatch(missingParent, INSTANCE, 0, 128)).toBeNull();
    const tooManyLinks = sourceBatch(0, {
      records: [
        record(1, { links: Array.from({ length: 9 }, () => ({ traceId: TRACE, spanId: SPAN })) }),
      ],
    });
    expect(readTraceSourceBatch(tooManyLinks, INSTANCE, 0, 128)).toBeNull();
    const controlAlias = sourceBatch(0, {
      records: [record(1, { operationAlias: 'bad\nalias' })],
    });
    expect(readTraceSourceBatch(controlAlias, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses any throw from a hostile record', () => {
    const hostile = sourceBatch(0);
    (hostile.records as unknown[])[0] = {
      get sequence(): number {
        throw new Error('hostile');
      },
    };
    expect(readTraceSourceBatch(hostile, INSTANCE, 0, 128)).toBeNull();
  });
});

describe('trace projection and the wire validator', () => {
  it('projects a validated batch and the projection passes the wire validator', () => {
    const validated = readTraceSourceBatch(
      sourceBatch(3, {
        records: [record(4, { parentSpanId: PARENT, parentVisibility: 'observed' })],
      }),
      INSTANCE,
      3,
      128,
    )!;
    const projected = projectTraceBatch(validated, INSTANCE);
    expect(isTraceBatchProjection(projected)).toBe(true);
    expect(projected.version).toBe(1);
    expect(projected.instanceId).toBe(INSTANCE);
    expect((projected.records as unknown[])[0]).toEqual({
      sequence: 4,
      serviceAlias: 'orders',
      operationAlias: 'create-order',
      traceId: TRACE,
      spanId: SPAN,
      parentSpanId: PARENT,
      links: [],
      kind: 'server',
      outcome: 'ok',
      durationMs: 4,
      ageMs: 6,
      parentVisibility: 'observed',
    });
    expect(Object.keys(projected.sampler as Record<string, unknown>)).toEqual(['kind']);
  });

  it('round-trips a projection through JSON without losing validity', () => {
    const validated = readTraceSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!;
    const projected = projectTraceBatch(validated, INSTANCE);
    const parsed = JSON.parse(JSON.stringify(projected));
    expect(isTraceBatchProjection(parsed)).toBe(true);
  });

  it('refuses projections with extra keys, bad vocabularies, or sequence inversions', () => {
    const validated = readTraceSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!;
    const projected = projectTraceBatch(validated, INSTANCE);
    const extra = { ...projected, surprise: true };
    expect(isTraceBatchProjection(extra)).toBe(false);
    const badState = { ...projected, state: 'meh' };
    expect(isTraceBatchProjection(badState)).toBe(false);
    const inverted = {
      ...projected,
      records: [record(2), record(1)],
      next: 1,
    };
    expect(isTraceBatchProjection(inverted)).toBe(false);
    const nextMismatch = {
      ...projected,
      records: [record(1)],
      next: 9,
    };
    expect(isTraceBatchProjection(nextMismatch)).toBe(false);
    const duplicateInstrumentation = {
      ...projected,
      instrumentation: ['http', 'http'],
    };
    expect(isTraceBatchProjection(duplicateInstrumentation)).toBe(false);
  });
});

describe('readTraceSourceBatch — remaining refusal arms', () => {
  it('refuses non-record input and non-record records', () => {
    expect(readTraceSourceBatch(null, INSTANCE, 0, 128)).toBeNull();
    expect(readTraceSourceBatch('nope', INSTANCE, 0, 128)).toBeNull();
    const badRecords = sourceBatch(0, { records: ['not-a-record'] });
    expect(readTraceSourceBatch(badRecords, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses malformed scalar fields', () => {
    const badNext = sourceBatch(0, { next: -1 });
    expect(readTraceSourceBatch(badNext, INSTANCE, 0, 128)).toBeNull();
    const badLost = sourceBatch(0, { lost: 1.5 });
    expect(readTraceSourceBatch(badLost, INSTANCE, 0, 128)).toBeNull();
    const badClosed = sourceBatch(0, { closed: 'yes' });
    expect(readTraceSourceBatch(badClosed, INSTANCE, 0, 128)).toBeNull();
    const badDropped = sourceBatch(0, { droppedSpans: -3 });
    expect(readTraceSourceBatch(badDropped, INSTANCE, 0, 128)).toBeNull();
    const badState = sourceBatch(0, { state: 'meh' });
    expect(readTraceSourceBatch(badState, INSTANCE, 0, 128)).toBeNull();
    const badCoverage = sourceBatch(0, { coverage: 'everything' });
    expect(readTraceSourceBatch(badCoverage, INSTANCE, 0, 128)).toBeNull();
  });

  it('refuses malformed instrumentation and sampler shapes', () => {
    const notArray = sourceBatch(0, { instrumentation: 'http' });
    expect(readTraceSourceBatch(notArray, INSTANCE, 0, 128)).toBeNull();
    const unknownKind = sourceBatch(0, { instrumentation: ['tracing'] });
    expect(readTraceSourceBatch(unknownKind, INSTANCE, 0, 128)).toBeNull();
    const badSampler = sourceBatch(0, { sampler: { kind: 'everything' } });
    expect(readTraceSourceBatch(badSampler, INSTANCE, 0, 128)).toBeNull();
    const samplerNotRecord = sourceBatch(0, { sampler: 'always-on' });
    expect(readTraceSourceBatch(samplerNotRecord, INSTANCE, 0, 128)).toBeNull();
    const extraSamplerKey = sourceBatch(0, { sampler: { kind: 'always-on', extra: 1 } });
    expect(readTraceSourceBatch(extraSamplerKey, INSTANCE, 0, 128)).toBeNull();
  });
});

describe('isTraceBatchProjection — sampler and instrumentation arms', () => {
  it('accepts a traceidratio sampler and refuses a malformed one', () => {
    const validated = readTraceSourceBatch(
      sourceBatch(0, { sampler: { kind: 'traceidratio', ratio: 0.5 } }),
      INSTANCE,
      0,
      128,
    )!;
    const projected = projectTraceBatch(validated, INSTANCE);
    expect(isTraceBatchProjection(projected)).toBe(true);
    expect((projected.sampler as Record<string, unknown>).ratio).toBe(0.5);
    const badRatio = {
      ...projected,
      sampler: { kind: 'traceidratio', ratio: 2 },
    };
    expect(isTraceBatchProjection(badRatio)).toBe(false);
    const missingRatio = {
      ...projected,
      sampler: { kind: 'traceidratio' },
    };
    expect(isTraceBatchProjection(missingRatio)).toBe(false);
  });

  it('refuses unknown instrumentation families and malformed link elements', () => {
    const validated = readTraceSourceBatch(sourceBatch(0), INSTANCE, 0, 128)!;
    const projected = projectTraceBatch(validated, INSTANCE);
    const badInstrumentation = { ...projected, instrumentation: ['gcp'] };
    expect(isTraceBatchProjection(badInstrumentation)).toBe(false);
    const nonArrayInstrumentation = { ...projected, instrumentation: 'http' };
    expect(isTraceBatchProjection(nonArrayInstrumentation)).toBe(false);
    const badLink = {
      ...projected,
      records: [record(1, { links: [{ traceId: 'zz', spanId: SPAN }] })],
    };
    expect(isTraceBatchProjection(badLink)).toBe(false);
    const badVisibility = {
      ...projected,
      records: [record(1, { parentVisibility: 'guessed' })],
    };
    expect(isTraceBatchProjection(badVisibility)).toBe(false);
    const badDuration = {
      ...projected,
      records: [record(1, { durationMs: -1 })],
    };
    expect(isTraceBatchProjection(badDuration)).toBe(false);
  });
});
