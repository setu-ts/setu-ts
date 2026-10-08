/**
 * The outbox position and block key (M107 §3.2): fixed width, same-millisecond
 * order, a backwards wall-clock step that keeps one instance's positions
 * increasing, and a block key no tenant/key pair can collide through.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { blockKey, PositionClock } from '../../../src/outbox/position.ts';
import { outboxHarness, rows } from '../../fixtures/outbox.ts';

const ID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ID_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('PositionClock', () => {
  it('emits 15 ms digits then the 32-hex id, with no separator', () => {
    const position = new PositionClock().next(1_700_000_000_123, ID_A);
    expect(position).toBe('001700000000123' + '0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d');
    expect(position).toHaveLength(47);
  });

  it('keeps write order for two writes in one millisecond, even when the second id sorts lower', () => {
    const clock = new PositionClock();
    const first = clock.next(5000, ID_B);
    const second = clock.next(5000, ID_A);
    expect(first < second).toBe(true);
    expect(second.slice(0, 15)).toBe('000000000005001');
  });

  it('keeps positions increasing across a backwards wall-clock step', () => {
    const clock = new PositionClock();
    const before = clock.next(10_000, ID_A);
    const after = clock.next(9_000, ID_A);
    expect(after > before).toBe(true);
    expect(after.slice(0, 15)).toBe('000000000010001');
  });

  it('floors a fractional clock and lowercases an uppercase id', () => {
    const position = new PositionClock().next(7.9, ID_A.toUpperCase());
    expect(position).toBe('000000000000007' + '0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d');
  });

  it('refuses an invalid clock reading, an overflowing clock and a non-UUID id', () => {
    const clock = new PositionClock();
    expect(() => clock.next(Number.NaN, ID_A)).toThrow(TypeError);
    expect(() => clock.next(-1, ID_A)).toThrow(TypeError);
    expect(() => clock.next(1e15, ID_A)).toThrow('15 digits');
    expect(() => clock.next(1, 'fake-uuid-0')).toThrow('hex UUID');
  });
});

describe('blockKey', () => {
  it('cannot be made to collide by a separator inside a tenant or key', () => {
    expect(blockKey('a|b', 'c')).not.toBe(blockKey('a', 'b|c'));
    expect(blockKey('a","b', 'c')).not.toBe(blockKey('a', '","b","c'));
    expect(blockKey(undefined, 'k')).not.toBe(blockKey('null', 'k'));
  });

  it('separates the same key under two tenants and under no tenant', () => {
    const keys = new Set([blockKey('t1', 'k'), blockKey('t2', 'k'), blockKey(undefined, 'k')]);
    expect(keys.size).toBe(3);
  });
});

describe('write positions through the service', () => {
  it('keep write order across a backwards wall-clock step, so the relay publishes in write order', async () => {
    const h = await outboxHarness();
    await h.write({ key: 'k', n: 1 });
    h.clock.advanceWall(-60_000);
    await h.write({ key: 'k', n: 2 });
    const stored = await rows(h.db);
    expect(stored.map((r) => (JSON.parse(r.envelope as string).data.n))).toEqual([1, 2]);
    // The second row's createdAt is the real (stepped-back) time; only position is clamped.
    expect(stored[1]!.createdAt).toBe((stored[0]!.createdAt as number) - 60_000);
    // Until the wall clock passes the first row's availableAt it reads as in
    // backoff, which blocks its key — so the later row does not overtake it.
    await h.sweep();
    expect(h.broker.sequence()).toEqual([]);
    h.clock.advanceWall(60_000);
    await h.sweep(); // the previous lap was complete: a new one starts
    expect(h.broker.sequence()).toEqual([1, 2]);
  });
});
