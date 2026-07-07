import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@hono-enterprise/common';
import type { IContainer } from '@hono-enterprise/common';

import { DiPlugin } from '../../src/plugin/di-plugin.ts';
import type { DiPluginOptions } from '../../src/plugin/di-plugin.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

// --- Test doubles for autoRegister ---

class FakeLogger {
  readonly tag = 'fake-logger';
}

class FakeRepo {
  readonly tag = 'fake-repo';
}

class FakeService {
  constructor(readonly logger: unknown, readonly repo: unknown) {}
}

/** Resolves the container from the fake service map. */
function getContainer(services: Map<string, unknown>): IContainer {
  return services.get(CAPABILITIES.DI_CONTAINER) as IContainer;
}

describe('DiPlugin integration', () => {
  describe('plugin contract', () => {
    it('has the correct name', () => {
      expect(DiPlugin().name).toBe('di-plugin');
    });

    it('has version matching deno.json', () => {
      expect(DiPlugin().version).toBe('0.1.0');
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

    it('disables autoRegister by default', () => {
      const { ctx, services } = createFakeContext();
      // Pre-register a fake logger on the service registry
      ctx.services.register(CAPABILITIES.LOGGER, new FakeLogger());

      DiPlugin().register(ctx);

      const container = getContainer(services);
      // autoRegister is off, so resolving a service-registry-only token fails
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
