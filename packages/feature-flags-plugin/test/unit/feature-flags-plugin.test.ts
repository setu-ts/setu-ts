/**
 * Tests for `FeatureFlagsPlugin` factory + `createProvider`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { FeatureFlagsPlugin, createProvider } from '../../src/plugin/feature-flags-plugin.ts';
import { ConfigProvider } from '../../src/providers/config-provider.ts';
import { MemoryProvider } from '../../src/providers/memory-provider.ts';
import { DatabaseProvider } from '../../src/providers/database-provider.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { FlagProvider } from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

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
    const store = { loadFlags: async () => ({}) };
    const provider = createProvider(
      { provider: 'database', options: { store } },
      ctx.ctx,
    );
    expect(provider).toBeInstanceOf(DatabaseProvider);
  });

  it('createProvider returns custom instance for "custom" arm', () => {
    const ctx = createFakeContext();
    const customInstance: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: async () => {},
      stop: async () => {},
    };
    const provider = createProvider(
      { provider: 'custom', options: { instance: customInstance } },
      ctx.ctx,
    );
    expect(provider).toBe(customInstance);
  });

  it('createProvider throws on unknown arm', () => {
    const ctx = createFakeContext();
    expect(() =>
      createProvider({ provider: 'nonexistent' as any, options: {} } as any, ctx.ctx)
    ).toThrow('Unrecognized feature flags provider');
  });

  it('register awaits service.start() and registers under FEATURE_FLAGS', async () => {
    const ctx = createFakeContext();
    const startCalled = { value: false };
    const customInstance: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: async () => { startCalled.value = true; },
      stop: async () => {},
    };
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: customInstance },
    });

    await (plugin.register as Function)(ctx.ctx);

    expect(startCalled.value).toBe(true);
    const resolved = ctx.ctx.services.get(CAPABILITIES.FEATURE_FLAGS);
    expect(resolved).not.toBeNull();
  });

  it('health indicator returns "up" for a provider with no status()', async () => {
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({ provider: 'config', options: { flags: {} } });
    await (plugin.register as Function)(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    expect(indicator).toBeDefined();
    const result = await indicator!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ provider: 'config' });
  });

  it('health indicator returns "up" for a healthy provider', async () => {
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: async () => {},
      stop: async () => {},
      status: () => ({ healthy: true }),
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await (plugin.register as Function)(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    const result = await indicator!();
    expect(result.status).toBe('up');
  });

  it('health indicator returns "degraded" for an unhealthy provider', async () => {
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: async () => {},
      stop: async () => {},
      status: () => ({ healthy: false, detail: 'poll failed' }),
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await (plugin.register as Function)(ctx.ctx);

    const indicator = ctx.healthIndicators.get('feature-flags');
    const result = await indicator!();
    expect(result.status).toBe('degraded');
    expect((result.data as any)?.detail).toBe('poll failed');
  });

  it('onClose calls service.stop()', async () => {
    let stopped = false;
    const fakeProvider: FlagProvider = {
      type: 'config',
      isEnabled: () => false,
      start: async () => {},
      stop: async () => { stopped = true; },
    };
    const ctx = createFakeContext();
    const plugin = FeatureFlagsPlugin({
      provider: 'custom',
      options: { instance: fakeProvider },
    });
    await (plugin.register as Function)(ctx.ctx);

    // Run all onClose handlers
    for (const handler of ctx.onCloseHandlers) {
      await handler();
    }

    expect(stopped).toBe(true);
  });
});
