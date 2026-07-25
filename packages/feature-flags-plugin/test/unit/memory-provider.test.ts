/**
 * Tests for `MemoryProvider` — mutable in-process store.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import type { FlagDefinition } from '../../src/interfaces/index.ts';

describe('MemoryProvider', () => {
  it('type is "memory"', () => {
    const provider = new MemoryProvider();
    expect(provider.type).toBe('memory');
  });

  it('starts empty', () => {
    const provider = new MemoryProvider();
    expect(provider.isEnabled('any')).toBe(false);
  });

  it('setFlag / isEnabled reflects change', () => {
    const provider = new MemoryProvider();
    provider.setFlag('beta', { enabled: true });
    expect(provider.isEnabled('beta')).toBe(true);
  });

  it('removeFlag makes it unknown (false)', () => {
    const provider = new MemoryProvider({ 'beta': { enabled: true } });
    expect(provider.isEnabled('beta')).toBe(true);
    provider.removeFlag('beta');
    expect(provider.isEnabled('beta')).toBe(false);
  });

  it('replaceFlags mutates the full store', () => {
    const provider = new MemoryProvider({ 'a': { enabled: true } });
    expect(provider.isEnabled('a')).toBe(true);
    expect(provider.isEnabled('b')).toBe(false);
    provider.replaceFlags({ 'b': { enabled: true } });
    expect(provider.isEnabled('a')).toBe(false);
    expect(provider.isEnabled('b')).toBe(true);
  });

  it('write → read-back through isEnabled covers evaluateFlag path', () => {
    const provider = new MemoryProvider();
    const def: FlagDefinition = {
      enabled: false,
      users: ['user1'],
      percentage: 50,
    };
    provider.setFlag('targeted', def);
    // user1 is in the allowlist, so overridden to true
    expect(provider.isEnabled('targeted', { userId: 'user1' })).toBe(true);
    // "other" has bucket("targeted", "other") = 69 (pinned from flag-evaluator),
    // which is >= 50% threshold → false.
    expect(provider.isEnabled('targeted', { userId: 'other' })).toBe(false);
  });

  it('start / stop no-op', async () => {
    const provider = new MemoryProvider();
    await expect(provider.start()).resolves.toBeUndefined();
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  it('does not expose status()', () => {
    const provider = new MemoryProvider();
    expect('status' in provider).toBe(false);
  });
});
