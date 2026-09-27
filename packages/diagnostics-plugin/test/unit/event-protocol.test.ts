/**
 * Unit tests for the event observation protocol (M98j): the source
 * snapshot validator, the connector's per-source read and aggregate state,
 * the response projection validator both sides of the wire run, and the
 * client's manifest-negotiated `events()` method.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  EventDiagnosticsRecord,
  EventDiagnosticsSnapshot,
  IEventDiagnosticsSource,
} from '@setu-ts/common';

import {
  collectionFailedEventSnapshot,
  isEventResponseProjection,
  projectEventSource,
  readEventSourceSnapshot,
} from '../../src/protocol/event-protocol.ts';
import { readTraceSourceBatch } from '../../src/protocol/trace-protocol.ts';

/** A valid, minimal source snapshot. */
function validSnapshot(
  overrides: Partial<EventDiagnosticsSnapshot> = {},
): EventDiagnosticsSnapshot {
  return {
    state: 'ready',
    alias: 'bus',
    coverage: 'owned-instance',
    records: [{
      alias: 'users',
      operation: 'publish',
      count: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      noSubscribers: 0,
      lastDurationMs: 2,
      ageMs: 1,
    }],
    dropped: 0,
    ...overrides,
  };
}

describe('readEventSourceSnapshot (M98j source validation)', () => {
  it('accepts and copies a well-formed snapshot field by field', () => {
    const copy = readEventSourceSnapshot(validSnapshot());
    expect(copy).not.toBeNull();
    expect(copy).toEqual(validSnapshot());
    expect(copy).not.toBe(validSnapshot());
  });

  it('refuses extra keys, missing keys, and a non-record', () => {
    expect(readEventSourceSnapshot({ ...validSnapshot(), extra: 1 })).toBeNull();
    const missing: Record<string, unknown> = { ...validSnapshot() };
    delete missing['dropped'];
    expect(readEventSourceSnapshot(missing)).toBeNull();
    expect(readEventSourceSnapshot(null)).toBeNull();
    expect(readEventSourceSnapshot([validSnapshot()])).toBeNull();
  });

  it('refuses a custom prototype and a hostile getter that throws', () => {
    const hostile = Object.create({ toString: () => 'x' }) as Record<string, unknown>;
    Object.assign(hostile, validSnapshot());
    expect(readEventSourceSnapshot(hostile)).toBeNull();
    const throwing = {
      get state(): string {
        throw new Error('getter bomb');
      },
    };
    expect(readEventSourceSnapshot(throwing)).toBeNull();
  });

  it('refuses a bad state, coverage, dropped count, or alias shape', () => {
    expect(readEventSourceSnapshot(validSnapshot({ state: 'nope' as never }))).toBeNull();
    expect(readEventSourceSnapshot(validSnapshot({ coverage: 'cluster' as never }))).toBeNull();
    expect(readEventSourceSnapshot(validSnapshot({ dropped: -1 }))).toBeNull();
    expect(readEventSourceSnapshot(validSnapshot({ dropped: 1.5 }))).toBeNull();
    expect(readEventSourceSnapshot(validSnapshot({ alias: 'bad\nalias' }))).toBeNull();
    expect(readEventSourceSnapshot(validSnapshot({ alias: null }))).toBeNull();
  });

  it('refuses a disabled or collection-failed snapshot carrying records', () => {
    expect(
      readEventSourceSnapshot(validSnapshot({ state: 'disabled', alias: null })),
    ).toBeNull();
    expect(readEventSourceSnapshot(validSnapshot({ state: 'collection-failed' }))).toBeNull();
    // The enabled-alias rule: a disabled source answers null, never a name.
    const disabled = { ...validSnapshot(), state: 'disabled' as const, alias: null };
    expect(readEventSourceSnapshot(disabled)).toBeNull();
  });

  it('refuses malformed records: bad enum, oversized alias, bad numbers, extra keys', () => {
    const record = validSnapshot().records[0]!;
    expect(
      readEventSourceSnapshot(
        validSnapshot({ records: [{ ...record, operation: 'replay' as never }] }),
      ),
    ).toBeNull();
    expect(
      readEventSourceSnapshot(validSnapshot({ records: [{ ...record, alias: 'a'.repeat(65) }] })),
    ).toBeNull();
    expect(
      readEventSourceSnapshot(validSnapshot({ records: [{ ...record, count: -1 }] })),
    ).toBeNull();
    expect(
      readEventSourceSnapshot(validSnapshot({ records: [{ ...record, lastDurationMs: -2 }] })),
    ).toBeNull();
    expect(
      readEventSourceSnapshot(validSnapshot({
        records: [{ ...record, extra: 1 } as unknown as EventDiagnosticsRecord],
      })),
    ).toBeNull();
  });

  it('refuses more than 64 records', () => {
    const record = validSnapshot().records[0]!;
    expect(
      readEventSourceSnapshot(validSnapshot({ records: Array.from({ length: 65 }, () => record) })),
    ).toBeNull();
  });
});

describe('projectEventSource and isEventResponseProjection (M98j wire validation)', () => {
  it('projects an entry and validates the response both sides produce', () => {
    const projected = {
      version: 1,
      instanceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      state: 'ready',
      sources: [projectEventSource('e1', validSnapshot())],
    };
    expect(isEventResponseProjection(projected)).toBe(true);
  });

  it('refuses key drift, a bad version, a bad state, or a hostile sourceId', () => {
    const base = {
      version: 1,
      instanceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      state: 'ready',
      sources: [],
    };
    expect(isEventResponseProjection({ ...base, extra: 1 })).toBe(false);
    expect(isEventResponseProjection({ ...base, version: 2 })).toBe(false);
    expect(isEventResponseProjection({ ...base, state: 'nope' })).toBe(false);
    expect(isEventResponseProjection({ ...base, instanceId: '' })).toBe(false);
    expect(isEventResponseProjection({
      ...base,
      sources: [projectEventSource('q1', validSnapshot())],
    })).toBe(false);
    expect(isEventResponseProjection({
      ...base,
      sources: [projectEventSource('e99999999999999999', validSnapshot())],
    })).toBe(false);
    expect(isEventResponseProjection(null)).toBe(false);
  });

  it('refuses more than 16 sources and a record that fails its own validation', () => {
    const base = {
      version: 1,
      instanceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      state: 'ready',
    };
    const sources = Array.from(
      { length: 17 },
      (_, index) => projectEventSource(`e${index + 1}`, validSnapshot()),
    );
    expect(isEventResponseProjection({ ...base, sources })).toBe(false);
    const bad = projectEventSource('e1', validSnapshot());
    (bad.snapshot as Record<string, unknown>)['records'] = [
      { ...validSnapshot().records[0]!, count: 'many' },
    ];
    expect(isEventResponseProjection({ ...base, sources: [bad] })).toBe(false);
  });

  it('accepts the empty unsupported response the no-source connector answers', () => {
    expect(isEventResponseProjection({
      version: 1,
      instanceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      state: 'unsupported',
      sources: [],
    })).toBe(true);
  });
});

describe('connector-side values', () => {
  it('builds a value-free collection-failed snapshot that passes validation', () => {
    const failed = collectionFailedEventSnapshot();
    expect(readEventSourceSnapshot(failed)).toEqual(failed);
    expect(failed).toEqual({
      state: 'collection-failed',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });

  it('does not disturb the neighboring protocols (trace validator owns its own DTO)', () => {
    expect(readTraceSourceBatch(null, 'instance', 0, 1)).toBeNull();
  });
});

describe('source contract shape', () => {
  it('a source is exactly snapshot()', () => {
    const source: IEventDiagnosticsSource = {
      snapshot: () => validSnapshot(),
    };
    expect(source.snapshot().state).toBe('ready');
  });
});
