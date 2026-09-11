import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { overrideCapability } from '../../src/override-capability.ts';
import { createMockPlugin } from '../../src/mock-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const runtime = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

function realDatabase(priority?: number): IPlugin {
  const plugin: IPlugin = {
    name: 'database',
    version: '1.0.0',
    provides: [CAPABILITIES.DATABASE],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.DATABASE, { who: 'REAL' });
    },
  };
  return priority === undefined ? plugin : { ...plugin, priority };
}

describe('overrideCapability', () => {
  it('declares no provides, so it cannot collide with the plugin it replaces', () => {
    const plugin = overrideCapability(CAPABILITIES.DATABASE, { who: 'MOCK' });

    // `provides: [token]` is exactly what makes createMockPlugin unusable here:
    // buildProviderIndex refuses two declarations of one token before any
    // plugin runs.
    expect(plugin.provides).toBeUndefined();
    expect(plugin.name).toBe(`test-override.${CAPABILITIES.DATABASE}`);
  });

  it('runs after every first-party priority band', () => {
    const plugin = overrideCapability(CAPABILITIES.DATABASE, { who: 'MOCK' });

    expect(plugin.priority).toBeGreaterThan(PLUGIN_PRIORITY.LOWEST);
  });

  it('replaces the service a real plugin registered', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        realDatabase(),
        overrideCapability(CAPABILITIES.DATABASE, { who: 'MOCK' }),
      ],
    });
    await app.start();

    expect(app.services.get<{ who: string }>(CAPABILITIES.DATABASE).who).toBe('MOCK');
  });

  it('wins against a provider in the LOW band, which a default-priority plugin would not', async () => {
    // A default-priority (500) override placed against a LOW (900) provider
    // runs FIRST, and the real plugin's plain register() then throws
    // "already registered" — an error naming the real plugin, which reads as
    // the real plugin's bug. The sentinel priority is what avoids that.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        realDatabase(PLUGIN_PRIORITY.LOW),
        overrideCapability(CAPABILITIES.DATABASE, { who: 'MOCK' }),
      ],
    });
    await app.start();

    expect(app.services.get<{ who: string }>(CAPABILITIES.DATABASE).who).toBe('MOCK');
  });

  it('refuses a token nothing provides, naming it', async () => {
    // Without this, `{ override: true }` on an absent token succeeds silently:
    // the double registers under a nonsense token, the real service keeps
    // serving, and the test passes against the real dependency.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        realDatabase(),
        overrideCapability('databse', { who: 'MOCK' }),
      ],
    });

    await expect(app.start()).rejects.toThrow(
      /Cannot override capability 'databse': nothing provides it/,
    );
  });

  it('names createMockPlugin as the way to provide a capability the app lacks', async () => {
    const app = createApplication({
      plugins: [runtimePlugin(), realDatabase(), overrideCapability('absent', {})],
    });

    await expect(app.start()).rejects.toThrow(/use createMockPlugin\(\) to provide one it lacks/);
  });

  it('refuses two overrides of one token on the plugin name', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        realDatabase(),
        overrideCapability(CAPABILITIES.DATABASE, { who: 'A' }),
        overrideCapability(CAPABILITIES.DATABASE, { who: 'B' }),
      ],
    });

    // Two doubles for one token is a mistake, and a duplicate plugin name is
    // the loudest available way to say so.
    await expect(app.start()).rejects.toThrow(/Duplicate plugin name/);
  });
});

describe('createMockPlugin boundary (pinned, not a defect)', () => {
  it('cannot replace a capability a real plugin already provides', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        realDatabase(),
        createMockPlugin({
          name: 'database-mock',
          provides: CAPABILITIES.DATABASE,
          service: { who: 'MOCK' },
        }),
      ],
    });

    // Pinned so a later "symmetry" fix fails a test that names why: the
    // `provides` declaration is what satisfies a dependent plugin's
    // `dependencies` check on the arm this function does serve.
    await expect(app.start()).rejects.toThrow(
      /Capability 'database' is provided by both 'database' and 'database-mock'/,
    );
  });

  it('still provides a capability the application lacks', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        createMockPlugin({
          name: 'database',
          provides: CAPABILITIES.DATABASE,
          service: { who: 'MOCK' },
        }),
      ],
    });
    await app.start();

    expect(app.services.get<{ who: string }>(CAPABILITIES.DATABASE).who).toBe('MOCK');
  });
});
