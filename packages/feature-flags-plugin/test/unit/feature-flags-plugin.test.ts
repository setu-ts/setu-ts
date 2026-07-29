/**
 * Tests for `FeatureFlagsPlugin` factory + `createProvider`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createProvider, FeatureFlagsPlugin } from '../../src/plugin/feature-flags-plugin.ts';
import { ConfigProvider } from '../../src/providers/config-provider.ts';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import { DatabaseProvider } from '../../src/providers/database-provider.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { FeatureFlagsPluginOptions, FlagProvider } from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { LaunchDarklyProvider } from '../../src/providers/launchdarkly-provider.ts';
import { FakeLaunchDarklyClient } from '../fixtures/fake-launchdarkly.ts';
import type { IFeatureFlags } from '@hono-enterprise/common';

describe('FeatureFlagsPlugin', () => {
  it('has correct name, provides, priority, optionalDependencies', () => {
    const plugin = FeatureFlagsPlugin({ provider: 'config', options: { flags: {} } });
    expect(plugin.name).toBe('feature-flags-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.FEATURE_FLAGS);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
    expect(plugin.optionalDependencies).toContain(CAPABILITIES.LOGGER);
  });

  it('createProvider returns ConfigProvider for "config" arm', () => {
    const ctx = createFakeContext();
    const provider = createProvider({ provider: 'config', options: { flags: {} } }, ctx.ctx);
    expect(provider).toBeInstanceOf(ConfigProvider);
  });

  it('createProvider returns MemoryProvider for "memory" arm', () => {
    const ctx = createFakeContext();
    const provider = createProvider({ provider: 'memory', options: {} }, ctx.ctx);
    expect(provider).toBeInstanceOf(MemoryProvider);
  });

  it('createProvider returns DatabaseProvider for "database" arm', () => {
    const ctx = createFakeContext({}, true);
    const store = {
      loadFlags: (): Promise<
        Readonly<Record<string, import('../../src/interfaces/index.ts').FlagDefinition>>
      > => Promise.resolve({}),
    };
    const provider = createProvider(
      { provider: 'database', options: { store } },
      ctx.ctx,
    );
    expect(provider).toBeInstanceOf(DatabaseProvider);
  });

  it('createProvider returns custom instance for "custom" arm', () => {
    const ctx = createFakeContext();
    const customInstance: FlagProvider = {
      type: 'custom',
      isEnabled: (): boolean => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
    };
    const provider = createProvider(
      { provider: 'custom', options: { instance: customInstance } },
      ctx.ctx,
    );
    expect(provider).toBe(customInstance);
  });

  it('createProvider throws on unknown arm', () => {
    const ctx = createFakeContext();
    // Cast the full discriminated union through a narrow object that violates the discriminant
    const bogusOptions = Object.freeze({ provider: 'nonexistent', options: {} });
    // We only need to call createProvider with invalid options to trigger the throw
    expect(() => createProvider(bogusOptions as unknown as FeatureFlagsPluginOptions, ctx.ctx))
      .toThrow('Unrecognized feature flags provider');
  });

  it('register awaits service.start() and registers under FEATURE_FLAGS', async () => {
    const ctx = createFakeContext();
    const startCalled = { value: false };
    const customInstance: FlagProvider = {
      type: 'custom',
      isEnabled: (): boolean => false,
      start: (): Promise<void> => {
        startCalled.value = true;
        return Promise.resolve();
      },
      stop: (): Promise<void> => Promise.resolve(),
    };
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: customInstance },
    });

    await plugin.register(ctx.ctx);

    expect(startCalled.value).toBe(true);
    const resolved = ctx.ctx.services.get(CAPABILITIES.FEATURE_FLAGS);
    expect(resolved).not.toBeNull();
  });

  it('health indicator returns "up" for a provider with no status()', async () => {
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({ provider: 'config', options: { flags: {} } });
    await plugin.register(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    expect(indicator).toBeDefined();
    const result = await indicator!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ provider: 'config' });
  });

  it('health indicator returns "up" for a healthy provider', async () => {
    const fakeProvider: FlagProvider = {
      type: 'custom',
      isEnabled: (): boolean => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      status: (): import('../../src/interfaces/index.ts').FlagProviderStatus => ({ healthy: true }),
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await plugin.register(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    const result = await indicator!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ provider: 'custom' });
  });

  it('health indicator returns "degraded" for an unhealthy provider', async () => {
    const fakeProvider: FlagProvider = {
      type: 'custom',
      isEnabled: (): boolean => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      status: (): import('../../src/interfaces/index.ts').FlagProviderStatus => ({
        healthy: false,
        detail: 'poll failed',
      }),
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await plugin.register(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    const result = await indicator!();
    expect(result.status).toBe('degraded');
    expect(result.data).toEqual({ provider: 'custom', detail: 'poll failed' });
  });

  it('health indicator omits detail when an unhealthy provider reports none', async () => {
    const fakeProvider: FlagProvider = {
      type: 'custom',
      isEnabled: (): boolean => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => Promise.resolve(),
      status: (): import('../../src/interfaces/index.ts').FlagProviderStatus => ({
        healthy: false,
      }),
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await plugin.register(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    const result = await indicator!();
    expect(result.status).toBe('degraded');
    // `detail` must be ABSENT, not present-and-undefined (exactOptionalPropertyTypes).
    expect(result.data).toEqual({ provider: 'custom' });
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(['provider']);
  });

  it('onClose calls service.stop()', async () => {
    let stopped = false;
    const fakeProvider: FlagProvider = {
      type: 'custom',
      isEnabled: (): boolean => false,
      start: (): Promise<void> => Promise.resolve(),
      stop: (): Promise<void> => {
        stopped = true;
        return Promise.resolve();
      },
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await plugin.register(ctx.ctx);

    // Run all onClose handlers
    for (const handler of ctx.onCloseHandlers) {
      await handler();
    }

    expect(stopped).toBe(true);
  });
});

describe('createProvider — launchdarkly arm', () => {
  it('returns a LaunchDarklyProvider for the "launchdarkly" arm', () => {
    const ctx = createFakeContext();
    const provider = createProvider({
      provider: 'launchdarkly',
      options: { client: new FakeLaunchDarklyClient() },
    }, ctx.ctx);
    expect(provider).toBeInstanceOf(LaunchDarklyProvider);
    expect(provider.type).toBe('launchdarkly');
  });

  it('registers the service and starts the provider through the plugin', async () => {
    const client = new FakeLaunchDarklyClient({ values: { __anonymous__: { beta: true } } });
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'launchdarkly',
      options: { client },
    });

    await plugin.register(ctx.ctx);

    const service = ctx.registered.get(CAPABILITIES.FEATURE_FLAGS) as IFeatureFlags;
    expect(service).toBeDefined();
    // Prewarmed during register, so this is real LaunchDarkly state.
    expect(service.isEnabled('beta')).toBe(true);
  });

  it('fails registration when the arm has neither client nor sdkKey', async () => {
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({ provider: 'launchdarkly', options: {} });
    await expect(plugin.register(ctx.ctx)).rejects.toThrow('requires options.sdkKey');
  });
});
