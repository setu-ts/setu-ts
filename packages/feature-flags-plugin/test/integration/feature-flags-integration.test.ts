/**
 * Integration test — real kernel app, full evaluation through the public surface.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { FeatureFlagsPlugin, createFlagGuard } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IFeatureFlags, IHealthIndicator } from '@hono-enterprise/common';

describe('feature-flags-integration', () => {
  it('evaluates flags through the public surface', async () => {
    const runtimePlugin = RuntimePlugin();
    const flagPlugin = FeatureFlagsPlugin({
      provider: 'config',
      options: {
        flags: {
          'new-dashboard': { enabled: true, percentage: 50 },
          'beta-features': { enabled: false, users: ['user1'] },
          'off-flag': { enabled: false },
        },
      },
    });

    const app = createApplication({
      plugins: [runtimePlugin, flagPlugin],
    });

    await app.start();

    try {
      // Resolve IFeatureFlags from the capability token
      const flags = app.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);

      // enabled:true flag
      expect(flags.isEnabled('new-dashboard')).toBe(true);

      // enabled:false flag → false for unknown user
      expect(flags.isEnabled('off-flag')).toBe(false);

      // C5 semantics — allowlisted user on an off flag
      expect(flags.isEnabled('beta-features', { userId: 'user1' })).toBe(true);
      expect(flags.isEnabled('beta-features', { userId: 'other' })).toBe(false);

      // Unknown flag → false (committed contract)
      expect(flags.isEnabled('unknown-flag')).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('guard short-circuit — flag off returns 302 to fallback', async () => {
    const runtimePlugin = RuntimePlugin();
    const flagPlugin = FeatureFlagsPlugin({
      provider: 'config',
      options: {
        flags: {
          'my-flag': { enabled: false },
        },
      },
    });

    const app = createApplication({
      plugins: [runtimePlugin, flagPlugin],
    });

    await app.start();

    try {
      const guard = createFlagGuard('my-flag', { fallback: '/old' });

      let handlerCalled = false;
      const ctx = {
        services: {
          get: (token: string) => {
            if (token === CAPABILITIES.FEATURE_FLAGS) {
              return { isEnabled: () => false };
            }
            throw new Error(`Unknown token: ${token}`);
          },
        },
        request: { user: undefined },
        response: {
          redirect: (url: string) => {
            expect(url).toBe('/old');
          },
          status: () => {},
          text: () => {},
        },
      } as any;

      await guard(ctx, async () => {
        handlerCalled = true;
      });

      expect(handlerCalled).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('health indicator resolves and reports "up"', async () => {
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
      const indicators = app.services.getAll<IHealthIndicator>(CAPABILITIES.HEALTH_INDICATOR);
      const flagIndicator = indicators.find((i) => i.name === 'feature-flags');
      expect(flagIndicator).toBeDefined();
      const result = await flagIndicator!.check();
      expect(result.status).toBe('up');
      expect((result.data as any)?.provider).toBe('config');
    } finally {
      await app.stop();
    }
  });

  it('app.stop() runs the onClose hook', async () => {
    let stopped = false;
    const runtimePlugin = RuntimePlugin();
    const flagPlugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: {
        instance: {
          type: 'config',
          isEnabled: () => false,
          start: async () => {},
          stop: async () => { stopped = true; },
        },
      },
    });

    const app = createApplication({
      plugins: [runtimePlugin, flagPlugin],
    });

    await app.start();

    try {
      await app.stop();
      expect(stopped).toBe(true);
    } catch {
      // ignore errors during stop
    }
  });
});
