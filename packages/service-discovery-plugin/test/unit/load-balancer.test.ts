/**
 * Unit tests for the three load-balancing strategies.
 *
 * Randomness is driven through the fake runtime's `randomBytes`, so every
 * selection here is deterministic without stubbing `Math.random`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createLoadBalancer } from '../../src/balancer/load-balancer.ts';
import { createFakeRuntime, instance } from '../fixtures/fakes.ts';

/** Four bytes producing the given float in `[0, 1)` when read big-endian. */
function bytesFor(fraction: number): Uint8Array<ArrayBuffer> {
  const value = Math.min(Math.floor(fraction * 2 ** 32), 0xffffffff);
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

const a = instance({ id: 'a', host: '10.0.0.1' });
const b = instance({ id: 'b', host: '10.0.0.2' });
const c = instance({ id: 'c', host: '10.0.0.3' });

describe('createLoadBalancer — round-robin', () => {
  it('advances the cursor and wraps', () => {
    const balancer = createLoadBalancer('round-robin', createFakeRuntime());
    const picks = [
      balancer.pick('billing', [a, b, c]),
      balancer.pick('billing', [a, b, c]),
      balancer.pick('billing', [a, b, c]),
      balancer.pick('billing', [a, b, c]),
    ];
    expect(picks.map((p) => p?.id)).toEqual(['a', 'b', 'c', 'a']);
  });

  it('keeps a separate cursor per service', () => {
    const balancer = createLoadBalancer('round-robin', createFakeRuntime());
    expect(balancer.pick('billing', [a, b])?.id).toBe('a');
    expect(balancer.pick('orders', [a, b])?.id).toBe('a');
    expect(balancer.pick('billing', [a, b])?.id).toBe('b');
  });

  it('stays in range when the list shrinks between picks', () => {
    const balancer = createLoadBalancer('round-robin', createFakeRuntime());
    balancer.pick('billing', [a, b, c]);
    balancer.pick('billing', [a, b, c]);
    // Cursor is 2; the list is now length 1, so 2 % 1 === 0 rather than a
    // read past the end.
    expect(balancer.pick('billing', [c])?.id).toBe('c');
  });
});

describe('createLoadBalancer — random', () => {
  it('selects the first instance at the bottom of the range', () => {
    const runtime = createFakeRuntime();
    runtime.setRandomBytes(bytesFor(0));
    const balancer = createLoadBalancer('random', runtime);
    expect(balancer.pick('billing', [a, b, c])?.id).toBe('a');
  });

  it('selects the last instance at the top of the range', () => {
    const runtime = createFakeRuntime();
    runtime.setRandomBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    const balancer = createLoadBalancer('random', runtime);
    expect(balancer.pick('billing', [a, b, c])?.id).toBe('c');
  });

  it('honours a per-call override of the configured strategy', () => {
    const runtime = createFakeRuntime();
    runtime.setRandomBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    const balancer = createLoadBalancer('round-robin', runtime);
    expect(balancer.pick('billing', [a, b, c], 'random')?.id).toBe('c');
  });
});

describe('createLoadBalancer — weighted-random', () => {
  const heavy = instance({ id: 'heavy', weight: 9 });
  const light = instance({ id: 'light', weight: 1 });

  it('lands in the first bucket at the bottom of the range', () => {
    const runtime = createFakeRuntime();
    runtime.setRandomBytes(bytesFor(0));
    const balancer = createLoadBalancer('weighted-random', runtime);
    expect(balancer.pick('billing', [heavy, light])?.id).toBe('heavy');
  });

  it('lands in the last bucket at the top of the range', () => {
    const runtime = createFakeRuntime();
    runtime.setRandomBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    const balancer = createLoadBalancer('weighted-random', runtime);
    expect(balancer.pick('billing', [heavy, light])?.id).toBe('light');
  });

  it('treats an absent weight as 1', () => {
    const runtime = createFakeRuntime();
    // 0.6 of a total of 2 lands past the first bucket.
    runtime.setRandomBytes(bytesFor(0.6));
    const balancer = createLoadBalancer('weighted-random', runtime);
    expect(balancer.pick('billing', [a, b])?.id).toBe('b');
  });

  it('never selects a non-positive weight while a positive one exists', () => {
    const runtime = createFakeRuntime();
    const zero = instance({ id: 'zero', weight: 0 });
    const negative = instance({ id: 'negative', weight: -5 });
    const positive = instance({ id: 'positive', weight: 4 });
    const balancer = createLoadBalancer('weighted-random', runtime);

    for (const fraction of [0, 0.25, 0.5, 0.75, 0.999]) {
      runtime.setRandomBytes(bytesFor(fraction));
      expect(balancer.pick('billing', [zero, negative, positive])?.id).toBe('positive');
    }
  });

  it('falls back to uniform when every weight is non-positive', () => {
    const runtime = createFakeRuntime();
    const zeroA = instance({ id: 'zeroA', weight: 0 });
    const zeroB = instance({ id: 'zeroB', weight: 0 });
    const balancer = createLoadBalancer('weighted-random', runtime);

    runtime.setRandomBytes(bytesFor(0));
    expect(balancer.pick('billing', [zeroA, zeroB])?.id).toBe('zeroA');
    runtime.setRandomBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(balancer.pick('billing', [zeroA, zeroB])?.id).toBe('zeroB');
  });
});

describe('createLoadBalancer — empty list', () => {
  it('returns null for every strategy', () => {
    const runtime = createFakeRuntime();
    for (const strategy of ['round-robin', 'random', 'weighted-random'] as const) {
      const balancer = createLoadBalancer(strategy, runtime);
      expect(balancer.pick('billing', [])).toBeNull();
    }
  });
});
