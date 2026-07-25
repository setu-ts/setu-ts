/**
 * E2E kernel integration — feature flags plugin evaluated through a real app.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { FeatureFlagsPlugin, createFlagGuard } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IFeatureFlags } from '@hono-enterprise/common';

describe('feature-flags-e2e', () => {
  it('kernel integration — flag evaluation end-to-end', async () => {
    const runtimePlugin = RuntimePlugin();
    const flagPlugin = FeatureFlagsPlugin({
      provider: 'config',
      options: {
        flags: {
          'e2e-flag': { enabled: true },
          'e2e-off': { enabled: false },
          'e2e-allowlist': { enabled: false, users: ['allowed-user'] },
        },
      },
    });

    const app = createApplication({
      plugins: [runtimePlugin, flagPlugin],
    });

    await app.start();

    try {
      const flags = app.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);

      // Direct evaluation through the service
      expect(flags.isEnabled('e2e-flag')).toBe(true);
      expect(flags.isEnabled('e2e-off')).toBe(false);
      expect(flags.isEnabled('e2e-allowlist', { userId: 'allowed-user' })).toBe(true);
      expect(flags.isEnabled('e2e-allowlist', { userId: 'denied-user' })).toBe(false);
      expect(flags.isEnabled('nonexistent')).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('createFlagGuard factory is accessible from barrel', async () => {
    const runtimePlugin = RuntimePlugin();
    const flagPlugin = FeatureFlagsPlugin({
      provider: 'config',
      options: {
        flags: { 'test': { enabled: true } },
      },
    });

    const app = createApplication({
      plugins: [runtimePlugin, flagPlugin],
    });

    await app.start();

    try {
      // Guard can be instantiated after app creation
      const guard = createFlagGuard('test');
      expect(guard).toBeDefined();
      expect(typeof guard).toBe('function');
    } finally {
      await app.stop();
    }
  });

  it('DatabaseProvider with fake store works end-to-end', async () => {
    const runtimePlugin = RuntimePlugin();

    let snapshot: Record<string, any> = { 'db-flag': { enabled: true } };
    const fakeStore = {
      loadFlags: async (): Promise<Record<string, any>> => snapshot,
    };

    const flagPlugin = FeatureFlagsPlugin({
      provider: 'database',
      options: { store: fakeStore as any, refreshIntervalMs: 60000 },
    });

    const app = createApplication({
      plugins: [runtimePlugin, flagPlugin],
    });

    await app.start();

    try {
      const flags = app.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
      expect(flags.isEnabled('db-flag')).toBe(true);
    } finally {
      await app.stop();
    }
  });
});
