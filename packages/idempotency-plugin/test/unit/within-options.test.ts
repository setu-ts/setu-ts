/**
 * `within` option bounds (M109b §3.13): every numeric bound, the printable
 * ranges, the required `scope`, and the `key` normalization.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IdempotentWithinOptions } from '@setu-ts/common';
import { IdempotencyConfigurationError, IdempotencyWithinError } from '../../src/errors.ts';
import {
  resolveWithinOptions,
  validateWithinOptionShape,
} from '../../src/within/within-options.ts';

const DEFAULTS = { ttlMs: 86_400_000 };

/** A valid option set, with overrides. */
function options(overrides: Partial<IdempotentWithinOptions> = {}): IdempotentWithinOptions {
  return { key: 'k-1', namespace: 'orders.create', scope: 't1:u1', ...overrides };
}

describe('resolveWithinOptions key (M109b §3.13)', () => {
  it('accepts a usable key and normalizes a quoted one', () => {
    expect(resolveWithinOptions(options(), DEFAULTS).key).toBe('k-1');
    expect(resolveWithinOptions(options({ key: '"abc"' }), DEFAULTS).key).toBe('abc');
  });

  it('refuses every unusable key with key-invalid', () => {
    for (const key of ['', ' '.repeat(3), 'a'.repeat(256), 'a\nb', 'a"b', '\u00e9']) {
      const failure = (() => {
        try {
          resolveWithinOptions(options({ key }), DEFAULTS);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(IdempotencyWithinError);
      expect((failure as IdempotencyWithinError).reason).toBe('key-invalid');
    }
  });

  it('refuses a non-string key', () => {
    const failure = (() => {
      try {
        resolveWithinOptions(options({ key: 5 as unknown as string }), DEFAULTS);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect((failure as IdempotencyWithinError).reason).toBe('key-invalid');
  });
});

describe('validateWithinOptionShape (M109b §3.13)', () => {
  it('accepts the endpoints of every range', () => {
    expect(() => validateWithinOptionShape(options({ namespace: 'n' }))).not.toThrow();
    expect(() => validateWithinOptionShape(options({ namespace: 'n'.repeat(256) }))).not.toThrow();
    expect(() => validateWithinOptionShape(options({ scope: '' }))).not.toThrow();
    expect(() => validateWithinOptionShape(options({ scope: 's'.repeat(512) }))).not.toThrow();
    expect(() => validateWithinOptionShape(options({ ttlMs: 60_000 }))).not.toThrow();
    expect(() => validateWithinOptionShape(options({ ttlMs: 2_592_000_000 }))).not.toThrow();
  });

  it('refuses a namespace outside 1–256 printable characters', () => {
    for (const namespace of ['', 'n'.repeat(257), 'n\t', 'n\u007f', 'n\u00e9']) {
      expect(() => validateWithinOptionShape(options({ namespace }))).toThrow(
        IdempotencyConfigurationError,
      );
    }
  });

  it('refuses a scope outside 0–512 printable characters', () => {
    for (const scope of ['s'.repeat(513), 's\u0000', 's\u007f', 's\u00e9']) {
      expect(() => validateWithinOptionShape(options({ scope }))).toThrow(
        IdempotencyConfigurationError,
      );
    }
  });

  it('refuses a non-integer, negative or out-of-range ttlMs', () => {
    for (const ttlMs of [59_999, 2_592_000_001, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => validateWithinOptionShape(options({ ttlMs }))).toThrow(
        IdempotencyConfigurationError,
      );
    }
  });

  it('refuses a non-object option set', () => {
    expect(() => validateWithinOptionShape(undefined as unknown as IdempotentWithinOptions))
      .toThrow(IdempotencyConfigurationError);
  });
});

describe('resolveWithinOptions defaults and pass-through (M109b §3.13)', () => {
  it('applies the plugin tier-C TTL by default and keeps an explicit one', () => {
    expect(resolveWithinOptions(options(), DEFAULTS).ttlMs).toBe(86_400_000);
    expect(resolveWithinOptions(options({ ttlMs: 120_000 }), DEFAULTS).ttlMs).toBe(120_000);
  });

  it('carries the namespace, scope and fingerprint through', () => {
    const resolved = resolveWithinOptions(
      options({ fingerprint: { a: 1 } }),
      DEFAULTS,
    );
    expect(resolved.namespace).toBe('orders.create');
    expect(resolved.scope).toBe('t1:u1');
    expect(resolved.fingerprint).toEqual({ a: 1 });
  });
});
