/**
 * Inbox option validation (M108 §3.11): defaults, every range, `NaN` and
 * fractions refused by name, and the store form.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { InboxOptions } from '../../../src/index.ts';
import { resolveInboxOptions } from '../../../src/inbox/options.ts';
import { FakeInboxStore } from '../../fixtures/inbox.ts';

const store = new FakeInboxStore();

describe('resolveInboxOptions', () => {
  it('applies the defaults', () => {
    expect(resolveInboxOptions({ store })).toEqual({
      store,
      maxAttempts: undefined,
      retainMs: 7 * 24 * 60 * 60 * 1000,
      storeTimeoutMs: 5000,
      maxParkedEnvelopeBytes: 262_144,
      schedule: true,
      purgeIntervalMs: 60_000,
      purgeBatch: 100,
    });
  });

  it('keeps every supplied value, and accepts a registry factory as the store', () => {
    const factory = () => store;
    const resolved = resolveInboxOptions({
      store: factory,
      maxAttempts: 3,
      retainMs: 60_000,
      storeTimeoutMs: 1,
      maxParkedEnvelopeBytes: 0,
      purge: { schedule: false, intervalMs: 10, batch: 5 },
    });
    expect(resolved).toMatchObject({
      store: factory,
      maxAttempts: 3,
      retainMs: 60_000,
      storeTimeoutMs: 1,
      maxParkedEnvelopeBytes: 0,
      schedule: false,
      purgeIntervalMs: 10,
      purgeBatch: 5,
    });
  });

  const refusals: [string, Partial<InboxOptions>][] = [
    ['maxAttempts', { maxAttempts: 0 }],
    ['maxAttempts', { maxAttempts: 1001 }],
    ['maxAttempts', { maxAttempts: Number.NaN }],
    ['maxAttempts', { maxAttempts: 1.5 }],
    ['retainMs', { retainMs: 59_999 }],
    ['storeTimeoutMs', { storeTimeoutMs: 0 }],
    ['storeTimeoutMs', { storeTimeoutMs: 2_147_483_648 }],
    ['maxParkedEnvelopeBytes', { maxParkedEnvelopeBytes: -1 }],
    ['purge.intervalMs', { purge: { intervalMs: 0 } }],
    ['purge.batch', { purge: { batch: 100_001 } }],
  ];
  for (const [name, bad] of refusals) {
    it(`refuses ${name} = ${JSON.stringify(Object.values(bad)[0])}`, () => {
      expect(() => resolveInboxOptions({ store, ...bad })).toThrow(`inbox: ${name} must be`);
    });
  }

  it('refuses a malformed store and a non-boolean purge.schedule', () => {
    expect(() => resolveInboxOptions({ store: null as never })).toThrow(TypeError);
    expect(() => resolveInboxOptions({ store: 'x' as never })).toThrow(TypeError);
    expect(() => resolveInboxOptions({ store, purge: { schedule: 'yes' as never } })).toThrow(
      'purge.schedule must be a boolean',
    );
  });
});
