import { describe, expect, it, vi } from 'vitest';

import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IContainer, IRuntimeServices } from '@setu-ts/common';

import { DiPlugin } from '../../src/plugin/di-plugin.ts';
import type { DiPluginOptions } from '../../src/plugin/di-plugin.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import manifest from '../../deno.json' with { type: 'json' };
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

// --- Test doubles for autoRegister ---

class FakeLogger {
  readonly tag = 'fake-logger';
}

class FakeRepo {
  readonly tag = 'fake-repo';
}

class FakeService {
  constructor(
    readonly logger: unknown,
    readonly repo: unknown,
  ) {}
}

/** Resolves the container from the fake service map. */
function getContainer(services: Map<string, unknown>): IContainer {
  return services.get(CAPABILITIES.DI_CONTAINER) as IContainer;
}

describe('DiPlugin integration', () => {
  it('bounds hung singleton disposal on runtime timers and reaches later close hooks', async () => {
    vi.useFakeTimers();
    let expire: (() => void) | undefined;
    const setTimer = vi.fn((fn: () => void, ms: number) => {
      expect(ms).toBe(5000);
      expire = fn;
      return 19;
    });
    const clearTimer = vi.fn();
    const order: string[] = [];
    let release = (): void => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        {
          name: 'injected-timers',
          version: '1.0.0',
          dependencies: [CAPABILITIES.RUNTIME],
          priority: PLUGIN_PRIORITY.HIGH,
          register(ctx) {
            const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
            vi.spyOn(runtime, 'setTimeout').mockImplementation(setTimer);
            vi.spyOn(runtime, 'clearTimeout').mockImplementation(clearTimer);
          },
        },
        DiPlugin(),
        {
          name: 'disposable-singletons',
          version: '1.0.0',
          dependencies: [CAPABILITIES.DI_CONTAINER],
          register(ctx) {
            ctx.container!.register(
              'first',
              { useValue: {} },
              { dispose: () => void order.push('first') },
            );
            ctx.container!.register('hung-singleton', { useValue: {} }, { dispose: () => hung });
            ctx.lifecycle.onClose(() => {
              order.push('later-close');
            });
          },
        },
      ],
    });
    let stop: Promise<void> | undefined;
    let outcome: unknown;
    try {
      await app.start();
      const root = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
      root.resolve('first');
      root.resolve('hung-singleton');
      stop = app.stop().then(
        () => {
          outcome = 'unexpected success';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(setTimer).toHaveBeenCalledOnce();
      expect(outcome).toBeUndefined();
      expect(order).toEqual([]);
      expire!();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBeInstanceOf(AggregateError);
      await stop;
      expect((outcome as AggregateError).errors).toEqual([
        new Error('DI disposal of hung-singleton timed out after 5000 ms'),
      ]);
      expect(order).toEqual(['first', 'later-close']);
      expect(clearTimer).toHaveBeenCalledExactlyOnceWith(19);
    } finally {
      release();
      await stop;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it('accepts a later plugin bootstrap registration in the real kernel and disposes on stop', async () => {
    const dispose = vi.fn();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiPlugin(),
        {
          name: 'bootstrap-provider',
          version: '1.0.0',
          dependencies: [CAPABILITIES.DI_CONTAINER],
          register(ctx) {
            ctx.lifecycle.onBootstrap(() => {
              ctx.container!.register('late-boot', { useValue: 42 }, { dispose });
            });
          },
        },
      ],
    });
    await app.start();
    try {
      const c = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
      expect(c.resolve('late-boot')).toBe(42);
      expect(() => c.register('after-start', { useValue: 0 })).toThrow(/closed/);
    } finally {
      await app.stop();
    }
    expect(dispose).toHaveBeenCalledExactlyOnceWith(42);
  });
  it('closes after bootstrap registrations, logs opaque tokens once, and disposes on close', async () => {
    const { ctx, services } = createFakeContext();
    const bootstrap: (() => void | Promise<void>)[] = [];
    const close: (() => void | Promise<void>)[] = [];
    ctx.lifecycle.onBootstrap = (fn) => {
      bootstrap.push(fn);
    };
    ctx.lifecycle.onClose = (fn) => {
      close.push(fn);
    };
    const debug = vi.fn();
    Object.defineProperty(ctx, 'logger', { value: { debug } });
    DiPlugin().register(ctx);
    const container = getContainer(services);
    const dispose = vi.fn();
    bootstrap.push(() => {
      container.register('boot', { useValue: {} }, { dispose });
    });
    bootstrap.push(() => {
      container.register('opaque', { useFactory: () => 1 });
    });
    for (const hook of bootstrap) await hook();
    expect(container.resolve('boot')).toEqual({});
    expect(() => container.register('late', { useValue: 0 })).toThrow(/closed/);
    expect(debug).toHaveBeenCalledExactlyOnceWith('DI factories without inject are unchecked', {
      tokens: ['opaque'],
    });
    for (const hook of close) await hook();
    expect(dispose).toHaveBeenCalledOnce();
  });
  describe('plugin contract', () => {
    it('has the correct name', () => {
      expect(DiPlugin().name).toBe('di-plugin');
    });

    it('has version matching deno.json', () => {
      expect(DiPlugin().version).toBe(manifest.version);
    });

    it('provides CAPABILITIES.DI_CONTAINER', () => {
      expect(DiPlugin().provides).toContain(CAPABILITIES.DI_CONTAINER);
    });

    it('registers the container under CAPABILITIES.DI_CONTAINER', () => {
      const { ctx, services } = createFakeContext();
      DiPlugin().register(ctx);

      expect(services.has(CAPABILITIES.DI_CONTAINER)).toBe(true);
      const container = getContainer(services);
      expect(container).toBeDefined();
      expect(typeof container.resolve).toBe('function');
      expect(typeof container.register).toBe('function');
    });

    it('registers without a runtime and still bounds a hung disposal on default timers', async () => {
      vi.useFakeTimers();
      try {
        const { ctx, services } = createFakeContext();
        services.delete(CAPABILITIES.RUNTIME);
        DiPlugin().register(ctx);
        const container = getContainer(services);
        const order: string[] = [];
        container.register(
          'first',
          { useValue: 'first' },
          { dispose: () => void order.push('first') },
        );
        container.register(
          'hung',
          { useValue: 'hung' },
          { dispose: () => new Promise<void>(() => {}) },
        );
        const scope = container.createScope();
        scope.register(
          'scoped-first',
          { useValue: 1 },
          { dispose: () => void order.push('scoped') },
        );
        scope.register(
          'scoped-hung',
          { useValue: 2 },
          { dispose: () => new Promise<void>(() => {}) },
        );
        scope.resolve('scoped-first');
        scope.resolve('scoped-hung');
        const settled = Promise.resolve(scope.dispose()).then(
          () => 'resolved',
          (error: unknown) => (error instanceof AggregateError ? error.errors.length : 'other'),
        );
        await vi.advanceTimersByTimeAsync(5000);
        await expect(settled).resolves.toBe(1);
        expect(order).toEqual(['scoped']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('default options', () => {
    it('uses singleton as the default scope', () => {
      const { ctx, services } = createFakeContext();
      DiPlugin().register(ctx);

      const container = getContainer(services);
      container.register('svc', { useFactory: () => ({ n: Math.random() }) });

      // Same instance returned twice = singleton
      expect(container.resolve('svc')).toBe(container.resolve('svc'));
    });

    it('enables autoRegister by default', () => {
      const { ctx, services } = createFakeContext();
      const logger = new FakeLogger();
      ctx.services.register(CAPABILITIES.LOGGER, logger);

      DiPlugin().register(ctx);

      // The container falls back to the kernel registry with no option set.
      expect(getContainer(services).resolve(CAPABILITIES.LOGGER)).toBe(logger);
    });

    it('confines resolution to the container when autoRegister is false', () => {
      const { ctx, services } = createFakeContext();
      ctx.services.register(CAPABILITIES.LOGGER, new FakeLogger());

      DiPlugin({ autoRegister: false }).register(ctx);

      const container = getContainer(services);
      expect(() => container.resolve(CAPABILITIES.LOGGER)).toThrow(/No provider registered/);
    });
  });

  describe('defaultScope option', () => {
    it('honors a non-default scope', () => {
      const { ctx, services } = createFakeContext();
      const opts: DiPluginOptions = { defaultScope: 'transient' };
      DiPlugin(opts).register(ctx);

      const container = getContainer(services);
      container.register('svc', { useFactory: () => ({ n: Math.random() }) });

      expect(container.resolve('svc')).not.toBe(container.resolve('svc'));
    });
  });

  describe('autoRegister option', () => {
    it('falls back to the service registry for unregistered tokens', () => {
      const { ctx, services } = createFakeContext();

      // Simulate another plugin having registered services
      ctx.services.register(CAPABILITIES.LOGGER, new FakeLogger());
      ctx.services.register('repo', new FakeRepo());

      DiPlugin({ autoRegister: true }).register(ctx);

      const container = getContainer(services);
      const logger = container.resolve<FakeLogger>(CAPABILITIES.LOGGER);
      expect(logger).toBeInstanceOf(FakeLogger);

      const repo = container.resolve<FakeRepo>('repo');
      expect(repo).toBeInstanceOf(FakeRepo);
    });

    it('caches the auto-registered instance', () => {
      const { ctx, services } = createFakeContext();
      ctx.services.register(CAPABILITIES.LOGGER, new FakeLogger());

      DiPlugin({ autoRegister: true }).register(ctx);

      const container = getContainer(services);
      const a = container.resolve<FakeLogger>(CAPABILITIES.LOGGER);
      const b = container.resolve<FakeLogger>(CAPABILITIES.LOGGER);

      expect(a).toBe(b);
    });

    it('explicit DI registration takes precedence over service registry', () => {
      const { ctx, services } = createFakeContext();
      ctx.services.register('tok', new FakeLogger());

      DiPlugin({ autoRegister: true }).register(ctx);

      const container = getContainer(services);
      const custom = { custom: true };
      container.register('tok', { useValue: custom });

      expect(container.resolve('tok')).toBe(custom);
    });

    it('ClassProvider inject deps resolve from the service registry', () => {
      const { ctx, services } = createFakeContext();
      const logger = new FakeLogger();
      const repo = new FakeRepo();
      ctx.services.register(CAPABILITIES.LOGGER, logger);
      ctx.services.register('repo', repo);

      DiPlugin({ autoRegister: true }).register(ctx);

      const container = getContainer(services);
      container.register('svc', {
        useClass: FakeService,
        inject: [CAPABILITIES.LOGGER, 'repo'],
      });

      const svc = container.resolve<FakeService>('svc');
      expect(svc.logger).toBe(logger);
      expect(svc.repo).toBe(repo);
    });

    it('has() reports tokens available via autoRegister', () => {
      const { ctx, services } = createFakeContext();
      ctx.services.register(CAPABILITIES.LOGGER, new FakeLogger());

      DiPlugin({ autoRegister: true }).register(ctx);

      const container = getContainer(services);
      expect(container.has(CAPABILITIES.LOGGER)).toBe(true);
      expect(container.has('nonexistent')).toBe(false);
    });
  });

  describe('createScope from registered container', () => {
    it('produces child containers that share singletons', () => {
      const { ctx, services } = createFakeContext();
      DiPlugin().register(ctx);

      const root = getContainer(services);
      root.register('svc', { useFactory: () => ({ id: Math.random() }) });

      const child = root.createScope();
      expect(root.resolve('svc')).toBe(child.resolve('svc'));
    });
  });
});
