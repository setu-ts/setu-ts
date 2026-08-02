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
    expect(decodeEnvelope<{ id: number; name: string }>(raw, NOW)).toEqual({ id: 7, name: 'ada' });
  });

  it('round-trips a value whose deadline is still in the future', () => {
    const raw = encodeEnvelope('live', NOW + 1000);
    expect(decodeEnvelope<string>(raw, NOW)).toBe('live');
  });

  it('reads as a miss once the deadline has passed', () => {
    const raw = encodeEnvelope('stale', NOW + 5000);
    expect(decodeEnvelope<string>(raw, NOW + 4999)).toBe('stale');
    expect(decodeEnvelope<string>(raw, NOW + 5000)).toBeNull();
    expect(decodeEnvelope<string>(raw, NOW + 5001)).toBeNull();
  });

  it('reads an absent key as a miss', () => {
    expect(decodeEnvelope<string>(null, NOW)).toBeNull();
  });

  it('reads unparseable text as a miss rather than throwing', () => {
    expect(decodeEnvelope<string>('not json at all', NOW)).toBeNull();
  });

  it('reads a non-object JSON document as a miss', () => {
    expect(decodeEnvelope<string>('"a bare string"', NOW)).toBeNull();
    expect(decodeEnvelope<string>('null', NOW)).toBeNull();
    expect(decodeEnvelope<string>('42', NOW)).toBeNull();
  });

  it('reads a foreign object sharing the namespace as a miss', () => {
    // Written by something other than this store: no `e` field at all.
    expect(decodeEnvelope<string>(JSON.stringify({ some: 'other shape' }), NOW)).toBeNull();
    // Present but not a number, so the deadline cannot be evaluated.
    expect(decodeEnvelope<string>(JSON.stringify({ v: 'x', e: 'soon' }), NOW)).toBeNull();
  });

  it('preserves a stored null value, distinguishing it from a miss', () => {
    // `v: null` is a value the caller stored; the envelope still parses.
    const raw = encodeEnvelope(null, null);
    expect(decodeEnvelope<null>(raw, NOW)).toBeNull();
    // The stores treat that as a miss, which is the documented ICacheStore
    // behaviour: `get` returns null for "absent", and null is not cacheable
    // as a distinguishable value.
    expect(JSON.parse(raw)).toEqual({ v: null, e: null });
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
