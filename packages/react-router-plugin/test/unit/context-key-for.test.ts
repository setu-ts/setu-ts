/**
 * Tests for `contextKeyFor` — name-keyed context keys.
 *
 * The property under test is identity across module copies, which is what a
 * hand-written `{ defaultValue }` object cannot provide: a React Router server
 * build INLINES application modules, so a key declared in app code exists twice
 * — once in the bundle and once in the configuration module the runtime loads
 * from source — and the two never match. A test that only checked "returns an
 * object with the right default" would pass on the broken version, so these
 * assert sameness, and one drives the two-copies scenario directly.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { contextKeyFor } from '../../src/handler/context-keys.ts';

describe('contextKeyFor | identity', () => {
  it('returns the SAME object for the same name', () => {
    const first = contextKeyFor<string | null>('m36c.same', null);
    const second = contextKeyFor<string | null>('m36c.same', null);

    // Identity, not equality: two equal-looking keys are exactly the bug.
    expect(second).toBe(first);
  });

  it('returns different objects for different names', () => {
    expect(contextKeyFor('m36c.a', null)).not.toBe(contextKeyFor('m36c.b', null));
  });

  it('carries the default value given on first use', () => {
    const key = contextKeyFor<number>('m36c.default', 7);

    expect(key.defaultValue).toBe(7);
  });

  it('keeps the first default when a later call disagrees', () => {
    // A later default would silently change what every earlier holder reads
    // before the key is set, so the first registration wins.
    const first = contextKeyFor<string>('m36c.conflict', 'original');
    const second = contextKeyFor<string>('m36c.conflict', 'different');

    expect(second).toBe(first);
    expect(second.defaultValue).toBe('original');
  });
});

describe('contextKeyFor | the bundling scenario it exists for', () => {
  /**
   * A minimal stand-in for React Router's context provider: a Map keyed by the
   * key object, which is precisely why identity decides whether a read finds
   * what a write stored.
   */
  function createProvider() {
    const values = new Map<object, unknown>();
    return {
      set<T>(key: { defaultValue?: T }, value: T): void {
        values.set(key, value);
      },
      get<T>(key: { defaultValue?: T }): T {
        return values.has(key) ? values.get(key) as T : key.defaultValue as T;
      },
    };
  }

  it('a value set through one module copy is readable through another', () => {
    // Two modules that never import each other, each declaring "the" session
    // key by name — the config module and the bundled route module.
    const declaredInConfigModule = contextKeyFor<string | null>('m36c.session', null);
    const declaredInBundledRoute = contextKeyFor<string | null>('m36c.session', null);

    const context = createProvider();
    context.set(declaredInConfigModule, 'user-42');

    expect(context.get(declaredInBundledRoute)).toBe('user-42');
  });

  it('hand-written keys with identical shape do NOT interoperate', () => {
    // The defect this function removes, pinned so the reason cannot be lost.
    const inConfigModule = { defaultValue: null } as { defaultValue: string | null };
    const inBundledRoute = { defaultValue: null } as { defaultValue: string | null };

    const context = createProvider();
    context.set(inConfigModule, 'user-42');

    expect(context.get(inBundledRoute)).toBe(null);
  });
});
