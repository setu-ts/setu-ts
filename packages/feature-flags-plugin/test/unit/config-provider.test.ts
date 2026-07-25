/**
 * Tests for `ConfigProvider` — immutable inline flags.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ConfigProvider } from '../../src/providers/config-provider.ts';
import type { FlagDefinition } from '../../src/interfaces/index.ts';

describe('ConfigProvider', () => {
  it('type is "config"', () => {
    const provider = new ConfigProvider({});
    expect(provider.type).toBe('config');
  });

  it('isEnabled reflects the inline map', () => {
    const flags: Record<string, FlagDefinition> = {
      'on-flag': { enabled: true },
      'off-flag': { enabled: false },
    };
    const provider = new ConfigProvider(flags);
    expect(provider.isEnabled('on-flag')).toBe(true);
    expect(provider.isEnabled('off-flag')).toBe(false);
  });

  it('unknown flag → false', () => {
    const provider = new ConfigProvider({});
    expect(provider.isEnabled('nonexistent')).toBe(false);
  });

  it('start resolves without effect', async () => {
    const provider = new ConfigProvider({});
    await expect(provider.start()).resolves.toBeUndefined();
  });

  it('stop resolves without effect', async () => {
    const provider = new ConfigProvider({});
    await expect(provider.stop()).resolves.toBeUndefined();
  });

  it('does not expose status()', () => {
    const provider = new ConfigProvider({});
    expect('status' in provider).toBe(false);
  });

  it('allowlist on enabled flag', () => {
    const flags: Record<string, FlagDefinition> = {
      'flag': { enabled: true, users: ['user1'], percentage: 50 },
    };
    const provider = new ConfigProvider(flags);
    expect(provider.isEnabled('flag', { userId: 'user1' })).toBe(true);
  });
});
