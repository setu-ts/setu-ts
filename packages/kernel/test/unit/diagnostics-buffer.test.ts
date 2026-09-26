import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { DiagnosticsEvent } from '@setu-ts/common';

import {
  DiagnosticsEventRing,
  encodedEventByteLength,
  MAX_EVENT_BYTES,
  validateReadCursor,
} from '../../src/diagnostics/buffer.ts';

function event(sequence: number, pad = ''): DiagnosticsEvent {
  return {
    sequence,
    operationId: `op${sequence}`,
    parentOperationId: null,
    kind: 'lifecycle',
    stage: 'init',
    nodeId: null,
    outcome: 'ok',
    atMs: null,
    durationMs: null,
    ...(pad !== undefined && pad.length > 0 ? { traceId: pad } : {}),
  };
}

describe('validateReadCursor', () => {
  it('normalizes the default limit of 128', () => {
    expect(validateReadCursor(0, undefined, 5)).toEqual({ after: 0, limit: 128 });
    expect(validateReadCursor(3, 7, 5)).toEqual({ after: 3, limit: 7 });
  });

  it('refuses a negative, fractional, or non-number cursor with a fixed message', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        validateReadCursor(bad, undefined, 5);
        throw new Error('unreachable');
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error).message).toBe(
          'Invalid diagnostics cursor: expected a non-negative safe integer.',
        );
      }
    }
  });

  it('refuses an out-of-range limit without echoing the value', () => {
    for (const bad of [0, -3, 129, 1.5]) {
      try {
        validateReadCursor(0, bad, 5);
        throw new Error('unreachable');
      } catch (error) {
        expect((error as Error).message).toBe(
          'Invalid diagnostics read limit: expected an integer from 1 to 128.',
        );
      }
    }
  });

  it('refuses a cursor beyond the current sequence without echoing the value', () => {
    try {
      validateReadCursor(12, undefined, 11);
      throw new Error('unreachable');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Invalid diagnostics cursor: beyond the current sequence.',
      );
    }
    // At the boundary (equal to last) is legal and yields an empty page.
    expect(validateReadCursor(11, undefined, 11).after).toBe(11);
  });
});

describe('encodedEventByteLength', () => {
  it('is the exact UTF-8 length of the compact JSON encoding', () => {
    const one = event(1);
    expect(encodedEventByteLength(one)).toBe(new TextEncoder().encode(JSON.stringify(one)).length);
  });

  it('exceeds the 1,024-byte cap only for genuinely large records', () => {
    expect(encodedEventByteLength(event(1))).toBeLessThan(MAX_EVENT_BYTES);
    const padded = event(1, 'x'.repeat(MAX_EVENT_BYTES));
    expect(encodedEventByteLength(padded)).toBeGreaterThan(MAX_EVENT_BYTES);
  });
});

describe('DiagnosticsEventRing', () => {
  it('stores with dense sequences and reads back by sequence', () => {
    const ring = new DiagnosticsEventRing();
    for (let i = 1; i <= 5; i++) {
      ring.store(i, event(i));
    }
    expect(ring.lastSequence).toBe(5);
    expect(ring.firstSequence).toBe(1);
    expect(ring.at(3)?.operationId).toBe('op3');
    expect(ring.at(6)).toBeUndefined();
    expect(ring.at(0)).toBeUndefined();
  });

  it('evicts oldest first and moves the retained window', () => {
    const ring = new DiagnosticsEventRing();
    const capacity = 1024;
    for (let i = 1; i <= capacity + 10; i++) {
      ring.store(i, event(i));
    }
    expect(ring.lastSequence).toBe(capacity + 10);
    expect(ring.firstSequence).toBe(11);
    expect(ring.at(10)).toBeUndefined();
    expect(ring.at(11)?.sequence).toBe(11);
    expect(ring.at(capacity + 10)?.sequence).toBe(capacity + 10);
  });

  it('allocates saturating sequences', () => {
    const ring = new DiagnosticsEventRing();
    expect(ring.allocateSequence()).toBe(1);
  });

  it('close() stops writes but keeps the tail readable', () => {
    const ring = new DiagnosticsEventRing();
    ring.store(1, event(1));
    ring.close();
    expect(ring.closed).toBe(true);
    expect(ring.at(1)?.sequence).toBe(1);
  });

  it('clear() discards every retained event but never reuses a sequence number', () => {
    const ring = new DiagnosticsEventRing();
    for (let i = 1; i <= 10; i++) {
      ring.store(i, event(i));
    }
    ring.clear();
    // Discarded like an eviction: nothing is readable, the counter stands.
    expect(ring.lastSequence).toBe(10);
    expect(ring.firstSequence).toBe(11);
    for (let i = 1; i <= 10; i++) {
      expect(ring.at(i)).toBeUndefined();
    }
    // The next event continues the numbering rather than restarting at 1.
    expect(ring.allocateSequence()).toBe(11);
    ring.store(11, event(11));
    expect(ring.at(11)?.sequence).toBe(11);
    expect(ring.at(1)).toBeUndefined();
    expect(ring.firstSequence).toBe(11);
  });

  it('clear() on an empty ring leaves it empty and starting at 1', () => {
    const ring = new DiagnosticsEventRing();
    ring.clear();
    expect(ring.lastSequence).toBe(0);
    expect(ring.firstSequence).toBe(1);
    expect(ring.allocateSequence()).toBe(1);
  });
});
