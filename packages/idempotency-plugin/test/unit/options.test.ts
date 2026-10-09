/**
 * Unit tests for option shape validation and resolution (plan §3.9, §3.13;
 * M109b §3.5, §3.13).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IdempotencyPluginOptions } from '../../src/interfaces/index.ts';
import {
  resolveDefaults,
  resolveIngressOptions,
  resolveRouteOptions,
  validateIngressOptionShape,
  validatePluginOptionShape,
  validateRouteOptionShape,
} from '../../src/core/options.ts';
import { IdempotencyConfigurationError } from '../../src/errors.ts';

/** Runs `fn` and returns the thrown configuration error's option path. */
function optionOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof IdempotencyConfigurationError) return error.option;
    throw error;
  }
  throw new Error('expected a throw');
}

const defaults = resolveDefaults(undefined);

describe('validateRouteOptionShape (M109a §3.13)', () => {
  it('accepts the empty option set', () => {
    expect(() => validateRouteOptionShape({})).not.toThrow();
  });

  it('refuses each numeric bound at limit+1', () => {
    expect(optionOf(() => validateRouteOptionShape({ leaseMs: 86_400_001 }))).toBe('leaseMs');
    expect(optionOf(() => validateRouteOptionShape({ ttlMs: 2_592_000_001 }))).toBe('ttlMs');
    expect(optionOf(() => validateRouteOptionShape({ maxResponseBytes: 16_777_217 }))).toBe(
      'maxResponseBytes',
    );
  });

  it('refuses NaN, Infinity and a fraction', () => {
    expect(optionOf(() => validateRouteOptionShape({ leaseMs: Number.NaN }))).toBe('leaseMs');
    expect(optionOf(() => validateRouteOptionShape({ leaseMs: Number.POSITIVE_INFINITY }))).toBe(
      'leaseMs',
    );
    expect(optionOf(() => validateRouteOptionShape({ leaseMs: 1.5 }))).toBe('leaseMs');
    expect(optionOf(() => validateRouteOptionShape({ maxResponseBytes: -1 }))).toBe(
      'maxResponseBytes',
    );
  });

  it('refuses bad scalar fields by name', () => {
    expect(optionOf(() => validateRouteOptionShape({ required: 'yes' as unknown as boolean })))
      .toBe('required');
    expect(
      optionOf(() => validateRouteOptionShape({ principal: 'sometimes' as unknown as 'required' })),
    ).toBe(
      'principal',
    );
    expect(optionOf(() => validateRouteOptionShape({ response: 'body' as unknown as 'full' })))
      .toBe('response');
    expect(optionOf(() => validateRouteOptionShape({ namespace: '' }))).toBe('namespace');
    expect(optionOf(() => validateRouteOptionShape({ namespace: 'a\u0000b' }))).toBe('namespace');
  });

  it('names the failing key field', () => {
    expect(optionOf(() => validateRouteOptionShape({ key: { header: '' } }))).toBe('key.header');
    expect(optionOf(() => validateRouteOptionShape({ key: { bodyField: '' } }))).toBe(
      'key.bodyField',
    );
    expect(optionOf(() => validateRouteOptionShape({ key: {} as unknown as { header: string } })))
      .toBe('key');
  });

  it('refuses a DENY-listed replay header, including content-language', () => {
    expect(optionOf(() => validateRouteOptionShape({ replayHeaders: ['set-cookie'] }))).toBe(
      'replayHeaders',
    );
    expect(optionOf(() => validateRouteOptionShape({ replayHeaders: ['content-language'] }))).toBe(
      'replayHeaders',
    );
    expect(optionOf(() => validateRouteOptionShape({ replayHeaders: ['bad name'] }))).toBe(
      'replayHeaders',
    );
    expect(() => validateRouteOptionShape({ replayHeaders: ['x-custom'] })).not.toThrow();
  });

  it('accepts a redaction policy object and refuses a non-object', () => {
    expect(() => validateRouteOptionShape({ redaction: { fields: {} } } as never)).not.toThrow();
    expect(optionOf(() => validateRouteOptionShape({ redaction: 'nope' as never }))).toBe(
      'redaction',
    );
  });

  it('does NOT check ttlMs >= leaseMs; resolution does', () => {
    expect(() => validateRouteOptionShape({ leaseMs: 1_000, ttlMs: 10 })).not.toThrow();
    expect(optionOf(() => resolveRouteOptions({ leaseMs: 1_000, ttlMs: 10 }, defaults))).toBe(
      'ttlMs',
    );
  });
});

describe('resolveRouteOptions (M109a §3.2, §3.9)', () => {
  it('applies the documented defaults', () => {
    const resolved = resolveRouteOptions(undefined, defaults);
    expect(resolved.key).toEqual({ header: 'Idempotency-Key' });
    expect(resolved.required).toBe(true);
    expect(resolved.principal).toBe('required');
    expect(resolved.fingerprint).toBe('request');
    expect(resolved.response).toBe('full');
    expect(resolved.leaseMs).toBe(60_000);
    expect(resolved.ttlMs).toBe(86_400_000);
    expect(resolved.maxResponseBytes).toBe(262_144);
    expect(resolved.replayHeaders).toEqual([]);
    expect(resolved.redaction).toBeUndefined();
  });

  it('lower-cases replayHeaders', () => {
    const resolved = resolveRouteOptions({ replayHeaders: ['X-Custom'] }, defaults);
    expect(resolved.replayHeaders).toEqual(['x-custom']);
  });
});

describe('ingress options (M109a §3.7, §3.13)', () => {
  it('refuses an empty topics list with no jobNames', () => {
    expect(() => validateIngressOptionShape({ topics: [] })).toThrow(IdempotencyConfigurationError);
  });

  it('refuses an over-long or non-string entry and too many entries', () => {
    expect(optionOf(() => validateIngressOptionShape({ topics: ['a'.repeat(513)] }))).toBe(
      'topics',
    );
    expect(optionOf(() => validateIngressOptionShape({ topics: [1 as unknown as string] }))).toBe(
      'topics',
    );
    expect(
      optionOf(() =>
        validateIngressOptionShape({ topics: Array.from({ length: 1_001 }, () => 't') })
      ),
    ).toBe(
      'topics',
    );
  });

  it('refuses a bad key/fingerprint/scope', () => {
    expect(optionOf(() => validateIngressOptionShape({ topics: ['t'], key: 'bogus' as never })))
      .toBe('key');
    expect(
      optionOf(() => validateIngressOptionShape({ topics: ['t'], fingerprint: 'raw' as never })),
    ).toBe(
      'fingerprint',
    );
    expect(optionOf(() => validateIngressOptionShape({ topics: ['t'], scope: 'x' as never }))).toBe(
      'scope',
    );
  });

  it('defaults the ingress lease to 30,000 and the allow-list to []', () => {
    const resolved = resolveIngressOptions({ topics: ['t'] }, defaults);
    expect(resolved.leaseMs).toBe(30_000);
    expect(resolved.key).toBe('auto');
    expect(resolved.fingerprint).toBe('payload');
    expect(resolved.jobNames).toEqual([]);
    expect(resolved.scope).toBeUndefined();
  });

  it('checks the ingress ttlMs >= leaseMs cross-field rule', () => {
    expect(
      optionOf(() =>
        resolveIngressOptions({ jobNames: ['j'], leaseMs: 1_000, ttlMs: 10 }, defaults)
      ),
    ).toBe(
      'ttlMs',
    );
  });
});

describe('plugin options (M109a §3.13, §4.1)', () => {
  it('accepts the empty option set and each store arm', () => {
    expect(() => validatePluginOptionShape({})).not.toThrow();
    expect(() => validatePluginOptionShape({ store: { type: 'memory' } })).not.toThrow();
    expect(() =>
      validatePluginOptionShape({ store: { type: 'redis', namespace: 'shop', url: 'redis://x' } })
    )
      .not.toThrow();
    expect(() => validatePluginOptionShape({ store: { type: 'custom', store: storeStub() } })).not
      .toThrow();
  });

  it('refuses bad plugin scalars and an over-range default', () => {
    expect(optionOf(() => validatePluginOptionShape({ leaseMs: 0 }))).toBe('leaseMs');
    expect(optionOf(() => validatePluginOptionShape({ ingressLeaseMs: 0 }))).toBe('ingressLeaseMs');
    expect(optionOf(() => validatePluginOptionShape({ ttlMs: 0 }))).toBe('ttlMs');
    expect(optionOf(() => validatePluginOptionShape({ maxResponseBytes: -1 }))).toBe(
      'maxResponseBytes',
    );
    expect(optionOf(() => validatePluginOptionShape({ store: null as never }))).toBe('store');
  });

  it('refuses memory bounds and the per-scope > maxEntries rule', () => {
    expect(optionOf(() => validatePluginOptionShape({ store: { type: 'memory', maxEntries: 0 } })))
      .toBe(
        'store.maxEntries',
      );
    expect(optionOf(() => validatePluginOptionShape({ store: { type: 'memory', maxBytes: 10 } })))
      .toBe(
        'store.maxBytes',
      );
    expect(
      optionOf(() =>
        validatePluginOptionShape({
          store: { type: 'memory', maxEntries: 5, maxEntriesPerScope: 6 },
        })
      ),
    ).toBe('store.maxEntriesPerScope');
  });

  it('refuses a bad redis namespace, url, prefix and timeout', () => {
    expect(
      optionOf(() =>
        validatePluginOptionShape({ store: { type: 'redis', namespace: 'Bad', url: 'x' } })
      ),
    ).toBe(
      'store.namespace',
    );
    expect(
      optionOf(() =>
        validatePluginOptionShape({ store: { type: 'redis', namespace: 'ok', url: '' } })
      ),
    ).toBe('store.url');
    expect(
      optionOf(() =>
        validatePluginOptionShape({
          store: { type: 'redis', namespace: 'ok', url: 'x', keyPrefix: '' },
        })
      ),
    ).toBe('store.keyPrefix');
    expect(
      optionOf(() =>
        validatePluginOptionShape({
          store: { type: 'redis', namespace: 'ok', url: 'x', commandTimeoutMs: -1 },
        })
      ),
    ).toBe('store.commandTimeoutMs');
  });

  it('refuses an injected client missing call', () => {
    expect(
      optionOf(() =>
        validatePluginOptionShape({
          store: {
            type: 'redis',
            namespace: 'ok',
            client: { eval: () => {}, ping: () => {}, quit: () => {} } as never,
          },
        })
      ),
    ).toBe('store.client');
  });

  it('refuses a custom store missing a member', () => {
    expect(
      optionOf(() => validatePluginOptionShape({ store: { type: 'custom', store: {} as never } })),
    ).toBe(
      'store.store',
    );
  });

  it('resolveDefaults refuses ttlMs below a lease', () => {
    const options: IdempotencyPluginOptions = { leaseMs: 5_000, ttlMs: 1_000 };
    expect(optionOf(() => resolveDefaults(options))).toBe('ttlMs');
  });
});

/** A store shape only `validatePluginOptionShape` inspects (typeof functions). */
const TRANSACTIONAL_STORE = {
  find: () => Promise.resolve(undefined),
  run: () => Promise.resolve(1),
  purge: () => Promise.resolve(0),
  verify: () => Promise.resolve(),
};

/** A plugin option set carrying an untrusted `transactional` value. */
function withTransactional(transactional: unknown): IdempotencyPluginOptions {
  return { transactional } as IdempotencyPluginOptions;
}

describe('validatePluginOptionShape transactional (M109b §3.5, §3.13)', () => {
  it('accepts a store instance, a factory, and the range endpoints', () => {
    expect(() => validatePluginOptionShape(withTransactional({ store: TRANSACTIONAL_STORE })))
      .not.toThrow();
    expect(() => validatePluginOptionShape(withTransactional({ store: () => TRANSACTIONAL_STORE })))
      .not.toThrow();
    expect(() =>
      validatePluginOptionShape(withTransactional({
        store: TRANSACTIONAL_STORE,
        ttlMs: 60_000,
        storeTimeoutMs: 1,
        maxResultBytes: 2,
        purge: { schedule: true, intervalMs: 1, batch: 1 },
      }))
    ).not.toThrow();
    expect(() =>
      validatePluginOptionShape(withTransactional({
        store: TRANSACTIONAL_STORE,
        ttlMs: 2_592_000_000,
        storeTimeoutMs: 2_147_483_647,
        maxResultBytes: 262_144,
        purge: { batch: 100_000 },
      }))
    ).not.toThrow();
  });

  it('refuses a non-object transactional, and a missing or unusable store', () => {
    expect(optionOf(() => validatePluginOptionShape(withTransactional(1)))).toBe('transactional');
    expect(optionOf(() => validatePluginOptionShape(withTransactional({})))).toBe(
      'transactional.store',
    );
    expect(optionOf(() => validatePluginOptionShape(withTransactional({ store: null })))).toBe(
      'transactional.store',
    );
    expect(
      optionOf(() =>
        validatePluginOptionShape(withTransactional({
          store: { find: () => Promise.resolve(), run: () => Promise.resolve() },
        }))
      ),
    ).toBe('transactional.store');
  });

  it('refuses every out-of-range transactional number', () => {
    const cases: readonly (readonly [string, number, string])[] = [
      ['ttlMs', 59_999, 'transactional.ttlMs'],
      ['ttlMs', 2_592_000_001, 'transactional.ttlMs'],
      ['ttlMs', Number.NaN, 'transactional.ttlMs'],
      ['storeTimeoutMs', 0, 'transactional.storeTimeoutMs'],
      ['storeTimeoutMs', 2_147_483_648, 'transactional.storeTimeoutMs'],
      ['maxResultBytes', 1, 'transactional.maxResultBytes'],
      ['maxResultBytes', 262_145, 'transactional.maxResultBytes'],
    ];
    for (const [field, value, option] of cases) {
      expect(
        optionOf(() =>
          validatePluginOptionShape(
            withTransactional({ store: TRANSACTIONAL_STORE, [field]: value }),
          )
        ),
      ).toBe(option);
    }
  });

  it('refuses a malformed purge', () => {
    const withPurge = (purge: unknown) => () =>
      validatePluginOptionShape(withTransactional({ store: TRANSACTIONAL_STORE, purge }));
    expect(optionOf(withPurge(1))).toBe('transactional.purge');
    expect(optionOf(withPurge({ schedule: 'yes' }))).toBe('transactional.purge.schedule');
    expect(optionOf(withPurge({ intervalMs: 0 }))).toBe('transactional.purge.intervalMs');
    expect(optionOf(withPurge({ intervalMs: 2_147_483_648 }))).toBe(
      'transactional.purge.intervalMs',
    );
    expect(optionOf(withPurge({ batch: 0 }))).toBe('transactional.purge.batch');
    expect(optionOf(withPurge({ batch: 100_001 }))).toBe('transactional.purge.batch');
  });
});

/** A minimal conforming store stub for validation tests. */
function storeStub() {
  return {
    name: 'stub',
    connect: () => Promise.resolve(),
    claim: () => Promise.resolve({ outcome: 'claimed' as const, takeover: false }),
    complete: () => Promise.resolve('settled' as const),
    release: () => Promise.resolve('lost' as const),
  };
}
