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

  it('reports nothing when the carrier owns the key but not an array', () => {
    // Reachable because the accumulator key is a REGISTERED symbol (so two
    // copies of this package agree on it), which also makes it writable by
    // anything else sharing the process.
    const key = Symbol.for('@setu-ts/decorator-plugin:pending-writes');
    const carrier: Record<PropertyKey, unknown> = { [key]: 'not-an-array' };
    expect(takePendingFrom(carrier)).toEqual([]);

    // …and a later defer replaces the junk rather than trying to push onto it.
    const write = () => {};
    defer(carrier, write);
    expect(takePendingFrom(carrier)).toEqual([write]);
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

describe('pending writes are owned by their own carrier', () => {
  /**
   * The TC39 proposal links a subclass's `context.metadata` to its superclass's
   * by prototype, and the runtimes disagree: Deno 2.9.5 gives a subclass carrier
   * a `null` prototype, while Node v24 under `tsx` links it to the parent. The
   * chain is therefore built by hand here — a Deno-only suite cannot otherwise
   * reach the case, which is exactly why it could ship green.
   */
  it('never appends a child write onto an inherited parent list', () => {
    const parent: Record<PropertyKey, unknown> = {};
    const parentWrite = () => {};
    defer(parent, parentWrite);

    const child: Record<PropertyKey, unknown> = Object.create(parent);
    const childWrite = () => {};
    defer(child, childWrite);

    // Draining the child must not consume the parent's write...
    expect(takePendingFrom(child)).toEqual([childWrite]);
    // ...and the parent's own write must still be there afterwards.
    expect(takePendingFrom(parent)).toEqual([parentWrite]);
  });

  it('reports no writes for a carrier whose only list is inherited', () => {
    const parent: Record<PropertyKey, unknown> = {};
    defer(parent, () => {});
    const child: Record<PropertyKey, unknown> = Object.create(parent);

    expect(takePendingFrom(child)).toEqual([]);
    // The parent keeps its write: the child's drain consumed nothing.
    expect(takePendingFrom(parent)).toHaveLength(1);
  });
});
