/**
 * The envelope is what makes a sub-60-second TTL correct on a platform whose
 * own expiry floor is 60 seconds, so its arithmetic and its miss cases are
 * pinned directly rather than only through the stores.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  decodeEnvelope,
  encodeEnvelope,
  KV_MIN_EXPIRATION_TTL_SECONDS,
  physicalTtlSeconds,
} from '../../../src/stores/kv-envelope.ts';

const NOW = 1_700_000_000_000;

describe('encodeEnvelope / decodeEnvelope', () => {
  it('round-trips a value with no expiry', () => {
    const raw = encodeEnvelope({ id: 7, name: 'ada' }, null);
    expect(decodeEnvelope<{ id: number; name: string }>(raw, NOW)).toEqual({
      kind: 'hit',
      value: { id: 7, name: 'ada' },
    });
  });

  it('round-trips a value whose deadline is still in the future', () => {
    const raw = encodeEnvelope('live', NOW + 1000);
    expect(decodeEnvelope<string>(raw, NOW)).toEqual({ kind: 'hit', value: 'live' });
  });

  it('reports expired — not a plain miss — once the deadline has passed', () => {
    const raw = encodeEnvelope('stale', NOW + 5000);
    expect(decodeEnvelope<string>(raw, NOW + 4999)).toEqual({ kind: 'hit', value: 'stale' });
    // `expired` is what licenses the caller to delete. A plain `miss` must not.
    expect(decodeEnvelope<string>(raw, NOW + 5000)).toEqual({ kind: 'expired' });
    expect(decodeEnvelope<string>(raw, NOW + 5001)).toEqual({ kind: 'expired' });
  });

  it('reads an absent key as a miss', () => {
    expect(decodeEnvelope<string>(null, NOW)).toEqual({ kind: 'miss' });
  });

  it('reads unparseable text as a miss rather than throwing', () => {
    expect(decodeEnvelope<string>('not json at all', NOW)).toEqual({ kind: 'miss' });
  });

  it('reads a non-object JSON document as a miss', () => {
    expect(decodeEnvelope<string>('"a bare string"', NOW)).toEqual({ kind: 'miss' });
    expect(decodeEnvelope<string>('null', NOW)).toEqual({ kind: 'miss' });
    expect(decodeEnvelope<string>('42', NOW)).toEqual({ kind: 'miss' });
  });

  it('reads a foreign object as a miss, NEVER as expired', () => {
    // The distinction is the whole point: `expired` licenses a delete, and a
    // key this store did not write must never be deleted by a read.
    for (const foreign of [{ some: 'other shape' }, { v: 'x', e: 'soon' }, { e: NOW - 1 }]) {
      expect(decodeEnvelope<string>(JSON.stringify(foreign), NOW)).toEqual({ kind: 'miss' });
    }
  });

  it('reports a deliberately stored null as a hit, not a miss', () => {
    // Negative caching: `null` is a value the caller stored on purpose. Calling
    // it a miss is what made an idempotent read delete the entry.
    const raw = encodeEnvelope(null, null);
    expect(JSON.parse(raw)).toEqual({ v: null, e: null });
    expect(decodeEnvelope<null>(raw, NOW)).toEqual({ kind: 'hit', value: null });
  });

  it('still reports a stored null as expired once its deadline passes', () => {
    const raw = encodeEnvelope(null, NOW + 1000);
    expect(decodeEnvelope<null>(raw, NOW + 2000)).toEqual({ kind: 'expired' });
  });
});

describe('physicalTtlSeconds', () => {
  it('floors a sub-minimum TTL to the platform minimum', () => {
    expect(physicalTtlSeconds(5)).toBe(KV_MIN_EXPIRATION_TTL_SECONDS);
    expect(physicalTtlSeconds(0)).toBe(KV_MIN_EXPIRATION_TTL_SECONDS);
    expect(physicalTtlSeconds(59)).toBe(KV_MIN_EXPIRATION_TTL_SECONDS);
    expect(physicalTtlSeconds(60)).toBe(60);
  });

  it('passes a TTL above the minimum through unchanged', () => {
    expect(physicalTtlSeconds(120)).toBe(120);
    expect(physicalTtlSeconds(86_400)).toBe(86_400);
  });

  it('rounds a fractional TTL up, so it never becomes a shorter one', () => {
    expect(physicalTtlSeconds(120.1)).toBe(121);
    expect(physicalTtlSeconds(0.5)).toBe(KV_MIN_EXPIRATION_TTL_SECONDS);
  });
});
