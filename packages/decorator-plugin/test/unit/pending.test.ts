import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  defer,
  resolveMetadataSymbol,
  takePending,
  takePendingFrom,
} from '../../src/metadata/pending.ts';
import type { Constructor } from '@setu-ts/common';

/**
 * The accumulator's defensive branches. Each guards a shape the decorator path
 * cannot produce but a direct caller — or a runtime without `Symbol.metadata` —
 * can, and none is reachable through a decorated class, so they are exercised
 * at the seam directly rather than left uncovered.
 */
describe('pending-write accumulator', () => {
  it('falls back to a registered symbol when the runtime defines no Symbol.metadata', () => {
    // Every runtime this package supports defines it, so this arm is only
    // reachable at the seam — and it is the arm deciding whether the package
    // throws at import time on one that does not.
    expect(resolveMetadataSymbol({})).toBe(Symbol.for('Symbol.metadata'));
    const real = Symbol('metadata');
    expect(resolveMetadataSymbol({ metadata: real })).toBe(real);
  });

  it('reports nothing for a class carrying no metadata at all', () => {
    class Undecorated {}
    expect(takePending(Undecorated as unknown as Constructor)).toEqual([]);
  });

  it('reports nothing for a carrier that is not an object', () => {
    expect(takePendingFrom(undefined)).toEqual([]);
    expect(takePendingFrom(null)).toEqual([]);
    expect(takePendingFrom('not-a-carrier')).toEqual([]);
  });

  it('reports nothing for a carrier holding no pending list', () => {
    expect(takePendingFrom({})).toEqual([]);
  });

  it('accumulates in order and drains exactly once', () => {
    const carrier: Record<PropertyKey, unknown> = {};
    const calls: string[] = [];
    defer(carrier, () => calls.push('first'));
    defer(carrier, () => calls.push('second'));

    const drained = takePendingFrom(carrier);
    expect(drained).toHaveLength(2);
    // A second drain finds nothing — a write must never be applied twice, no
    // matter how many class decorators or reads a class attracts.
    expect(takePendingFrom(carrier)).toEqual([]);

    const store = {} as never;
    const target = class {} as unknown as Constructor;
    for (const w of drained) {
      w(store, target);
    }
    expect(calls).toEqual(['first', 'second']);
  });
});
