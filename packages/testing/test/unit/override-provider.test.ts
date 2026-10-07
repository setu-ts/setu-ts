import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IContainer, IPlugin, IPluginContext, Provider } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { overrideProvider } from '../../src/override-provider.ts';
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

/** A minimal container that refuses a second registration, like DiPlugin's. */
class FakeContainer implements IContainer {
  readonly values = new Map<string, unknown>();
  register<T>(token: string, provider: Provider<T>): void {
    if (this.values.has(token)) {
      throw new Error(`DI token '${token}' is already registered.`);
    }
    if (!('useValue' in provider)) {
      throw new Error('fake container takes useValue only');
    }
    this.values.set(token, provider.useValue);
  }
  resolve<T>(token: string): T {
    if (!this.values.has(token)) {
      throw new Error(`No provider registered for DI token '${token}'.`);
    }
    return this.values.get(token) as T;
  }
  has(token: string): boolean {
    return this.values.has(token);
  }
  createScope(): IContainer {
    return this;
  }
}

function containerPlugin(container: IContainer): IPlugin {
  return {
    name: 'fake-di',
    version: '1.0.0',
    provides: [CAPABILITIES.DI_CONTAINER],
    priority: PLUGIN_PRIORITY.NORMAL,
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.DI_CONTAINER, container);
    },
  };
}

/** Registers the REAL provider the way DecoratorPlugin does: skip when present. */
function realProvider(
  token: string,
  seen: unknown[],
  priority: number = PLUGIN_PRIORITY.LOW,
): IPlugin {
  return {
    name: 'real-provider',
    version: '1.0.0',
    priority,
    optionalDependencies: [CAPABILITIES.DI_CONTAINER],
    register(ctx: IPluginContext) {
      const container = ctx.container;
      if (container === undefined) return;
      if (!container.has(token)) {
        container.register(token, { useValue: { who: 'REAL' } });
      }
      seen.push(container.resolve(token));
    },
  };
}

describe('overrideProvider', () => {
  it('depends on the container and registers ahead of a LOW-priority provider', () => {
    const plugin = overrideProvider('svc', { useValue: {} });
    expect(plugin.name).toBe('test-provider-override.svc');
    expect(plugin.dependencies).toEqual([CAPABILITIES.DI_CONTAINER]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
    expect(plugin.provides).toBeUndefined();
  });

  it('replaces the provider before anything is constructed from it', async () => {
    const container = new FakeContainer();
    const seen: unknown[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        containerPlugin(container),
        realProvider('svc', seen),
        overrideProvider('svc', { useValue: { who: 'MOCK' } }),
      ],
    });
    await app.start();
    try {
      expect(seen).toEqual([{ who: 'MOCK' }]);
      expect(container.resolve('svc')).toEqual({ who: 'MOCK' });
    } finally {
      await app.stop();
    }
  });

  it('swallows the real registration and passes every other call through', async () => {
    const container = new FakeContainer();
    let published: IContainer | undefined;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        containerPlugin(container),
        overrideProvider('svc', { useValue: { who: 'MOCK' } }),
        {
          name: 'consumer',
          version: '1.0.0',
          priority: PLUGIN_PRIORITY.LOW,
          register(ctx: IPluginContext) {
            published = ctx.container;
            ctx.container?.register('svc', { useValue: { who: 'REAL' } });
            ctx.container?.register('other', { useValue: 1 });
          },
        },
      ],
    });
    await app.start();
    try {
      expect(published).not.toBe(container);
      expect(published?.resolve('svc')).toEqual({ who: 'MOCK' });
      expect(published?.resolve('other')).toBe(1);
      expect(published?.has('other')).toBe(true);
      expect(published?.createScope()).toBe(container);
    } finally {
      await app.stop();
    }
  });

  it('counts a resolve of the token as evidence the application uses it', async () => {
    const container = new FakeContainer();
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        containerPlugin(container),
        overrideProvider('svc', { useValue: 7 }),
        {
          name: 'consumer',
          version: '1.0.0',
          priority: PLUGIN_PRIORITY.LOW,
          register(ctx: IPluginContext) {
            ctx.container?.resolve('svc');
          },
        },
      ],
    });
    await app.start();
    await app.stop();
  });

  it('refuses a token nothing in the application registers or injects', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        containerPlugin(new FakeContainer()),
        overrideProvider('pricing-servce', { useValue: {} }),
      ],
    });
    await expect(app.start()).rejects.toThrow(/nothing in the application registers or injects/);
  });

  it('refuses when the real provider was registered first', async () => {
    const seen: unknown[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        containerPlugin(new FakeContainer()),
        realProvider('svc', seen, PLUGIN_PRIORITY.HIGH + 1),
        overrideProvider('svc', { useValue: {} }),
      ],
    });
    await expect(app.start()).rejects.toThrow(/registered on the container before the override/);
  });

  it('refuses an application without a DI container', async () => {
    const plugin = overrideProvider('svc', { useValue: {} });
    const ctx = { container: undefined } as unknown as IPluginContext;
    expect(() => plugin.register(ctx)).toThrow(/has no DI container/);
  });
});
