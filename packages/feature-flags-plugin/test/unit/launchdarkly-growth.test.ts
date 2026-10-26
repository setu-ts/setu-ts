import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IFeatureFlags } from '@setu-ts/common';
import { FeatureFlagsPlugin, LaunchDarklyProvider } from '../../src/index.ts';
import { FakeLaunchDarklyClient } from '../fixtures/fake-launchdarkly.ts';

describe('bounded LaunchDarkly snapshots', () => {
  it('caps 20,000 distinct contexts at 1,000 through the plugin option', async () => {
    const client = new FakeLaunchDarklyClient({ values: { '*': { beta: true } } });
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        FeatureFlagsPlugin({
          provider: 'launchdarkly',
          options: { client },
          maxCachedContexts: 1_000,
        }),
      ],
    });
    const set = vi.spyOn(Map.prototype, 'set');
    try {
      await app.start();
      const snapshots = set.mock.contexts.find(
        (map): map is Map<unknown, unknown> => map instanceof Map && map.has('__anonymous__'),
      );
      const flags = app.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
      for (let i = 0; i < 20_000; i++) {
        expect(flags.isEnabled('beta', { userId: String(i) })).toBe(false);
        await Promise.resolve();
      }
      expect(snapshots).toBeDefined();
      expect(snapshots?.size).toBe(1_000);
      expect(flags.isEnabled('beta', { userId: '19999' })).toBe(true);
      expect(flags.isEnabled('beta', { userId: '0' })).toBe(false);
      await Promise.resolve();
      expect(flags.isEnabled('beta', { userId: '0' })).toBe(true);
    } finally {
      await app.stop();
      set.mockRestore();
    }
  });

  it('refreshes recency on hits and uses a default cap of 10,000', async () => {
    const client = new FakeLaunchDarklyClient({ values: { '*': { beta: true } } });
    const provider = new LaunchDarklyProvider({ client }, undefined, 2);
    await provider.start();
    try {
      provider.isEnabled('beta', { userId: 'a' });
      await Promise.resolve();
      provider.isEnabled('beta', { userId: 'b' });
      await Promise.resolve();
      expect(provider.isEnabled('beta', { userId: 'a' })).toBe(true);
      provider.isEnabled('beta', { userId: 'c' });
      await Promise.resolve();
      expect(provider.isEnabled('beta', { userId: 'a' })).toBe(true);
      expect(provider.isEnabled('beta', { userId: 'b' })).toBe(false);
      await Promise.resolve();
    } finally {
      await provider.stop();
    }
    const defaults = new LaunchDarklyProvider({ client });
    await defaults.start();
    try {
      for (let i = 0; i < 10_001; i++) {
        defaults.isEnabled('beta', { userId: String(i) });
        await Promise.resolve();
      }
      expect(defaults.isEnabled('beta', { userId: '0' })).toBe(false);
      await Promise.resolve();
      expect(defaults.isEnabled('beta', { userId: '0' })).toBe(true);
    } finally {
      await defaults.stop();
    }
  });

  it('refuses invalid cache limits at construction with a named option error', () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity, '2', null]) {
      expect(() => new LaunchDarklyProvider({}, undefined, limit as number)).toThrow(
        /maxCachedContexts/,
      );
    }
  });
});
