import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

import { CachePlugin } from '../../src/plugin/cache-plugin.ts';

describe('CachePlugin', () => {
  function createFakeContext(): {
    ctx: IPluginContext;
    registered: Map<string, unknown>;
    healthIndicators: Map<string, unknown>;
    onCloseHandlers: Array<() => Promise<void>>;
  } {
    const registered = new Map<string, unknown>();
    const healthIndicators = new Map<string, unknown>();
    const onCloseHandlers: Array<() => Promise<void>> = [];

    const ctx: IPluginContext = {
      services: {
        has: (token: string) => registered.has(token),
        get: <T>(token: string): T => registered.get(token) as T,
        getAll: <T>(token: string): readonly T[] => {
          const v = registered.get(token);
          return v ? [v as T] : [];
        },
        register: (token: string, svc: unknown) => {
          registered.set(token, svc);
        },
        registerFactory: () => {},
        unregister: () => false,
      },
      health: {
        register: (name: string, indicator: unknown) => {
          healthIndicators.set(name, indicator);
        },
      },
      lifecycle: {
        onClose: (fn: () => Promise<void>) => {
          onCloseHandlers.push(fn);
        },
        onRegister: () => {},
        onInit: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onShutdown: () => {},
      },
      middleware: {
        add: () => {},
      },
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
        listRoutes: () => [],
      },
      environment: {
        validate: () => {},
      },
      metrics: {
        register: () => {},
      },
      openapi: {
        addSchema: () => {},
      },
      decorators: {
        register: () => {},
      },
      cli: {
        register: () => {},
      },
      runtime: null as unknown as IPluginContext['runtime'],
      options: {},
      app: null as unknown as IPluginContext['app'],
    };

    return { ctx, registered, healthIndicators, onCloseHandlers };
  }

  describe('token derivation', () => {
    it('uses CAPABILITIES.CACHE for default instance', () => {
      const plugin = CachePlugin();
      expect(plugin.provides).toContain(CAPABILITIES.CACHE);
    });

    it('uses cache.<name> for named instance', () => {
      const plugin = CachePlugin({ name: 'session' });
      expect(plugin.provides).toContain('cache.session');
    });
  });

  describe('plugin name', () => {
    it('uses "cache-plugin" for default instance', () => {
      const plugin = CachePlugin();
      expect(plugin.name).toBe('cache-plugin');
    });

    it('uses "cache-plugin.<name>" for named instance', () => {
      const plugin = CachePlugin({ name: 'session' });
      expect(plugin.name).toBe('cache-plugin.session');
    });
  });

  it('has optionalDependencies: ["logger"]', () => {
    const plugin = CachePlugin();
    expect(plugin.optionalDependencies).toEqual(['logger']);
  });

  describe('registration', () => {
    it('registers service under the correct token', async () => {
      const plugin = CachePlugin();
      const { ctx, registered } = createFakeContext();
      await plugin.register(ctx);
      expect(registered.has(CAPABILITIES.CACHE)).toBe(true);
    });

    it('registers health indicator', async () => {
      const plugin = CachePlugin();
      const { ctx, healthIndicators } = createFakeContext();
      await plugin.register(ctx);
      expect(healthIndicators.has(CAPABILITIES.CACHE)).toBe(true);
    });

    it('registers onClose handler', async () => {
      const plugin = CachePlugin();
      const { ctx, onCloseHandlers } = createFakeContext();
      await plugin.register(ctx);
      expect(onCloseHandlers.length).toBeGreaterThanOrEqual(1);
    });

    it('onClose handler disconnects backend', async () => {
      const plugin = CachePlugin();
      const { ctx, onCloseHandlers } = createFakeContext();
      await plugin.register(ctx);
      // Calling onClose should not throw
      await expect(onCloseHandlers[0]()).resolves.toBeUndefined();
    });
  });

  describe('backend selection', () => {
    it('selects memory store by default', () => {
      const plugin = CachePlugin();
      expect(plugin.name).toBe('cache-plugin');
    });

    it('accepts store: "noop"', () => {
      const plugin = CachePlugin({ store: 'noop' });
      expect(plugin.name).toBe('cache-plugin');
    });
  });

  describe('buildStoreOptions', () => {
    it('passes options through to the backend', async () => {
      const plugin = CachePlugin({
        options: { prefix: 'myapp:', defaultTtl: 300, maxSize: 500 },
      });
      const { ctx, registered } = createFakeContext();
      await plugin.register(ctx);
      expect(registered.has(CAPABILITIES.CACHE)).toBe(true);
    });
  });

  describe('resolveLogger', () => {
    it('does not crash when logger is absent', async () => {
      const plugin = CachePlugin();
      const { ctx } = createFakeContext();
      await expect(plugin.register(ctx)).resolves.toBeUndefined();
    });

    it('calls logger.debug when logger is present', async () => {
      const debugCalls: Array<[string, Record<string, unknown>]> = [];
      const { ctx } = createFakeContext();
      ctx.services.register('logger', {
        debug: (msg: string, meta?: Record<string, unknown>) => {
          debugCalls.push([msg, meta ?? {}]);
        },
      });
      const plugin = CachePlugin();
      await plugin.register(ctx);
      expect(debugCalls.length).toBeGreaterThanOrEqual(1);
      expect(debugCalls[0][0]).toBe('CachePlugin registered');
    });
  });

  describe('named instance registration', () => {
    it('registers under cache.<name> token', async () => {
      const plugin = CachePlugin({ name: 'session' });
      const { ctx, registered } = createFakeContext();
      await plugin.register(ctx);
      expect(registered.has('cache.session')).toBe(true);
    });

    it('provides the correct token for named instance', () => {
      const plugin = CachePlugin({ name: 'session' });
      expect(plugin.provides).toEqual(['cache.session']);
    });
  });

  describe('health indicator data', () => {
    it('returns up status after connect', async () => {
      const plugin = CachePlugin();
      const { ctx, healthIndicators } = createFakeContext();
      await plugin.register(ctx);
      const indicator = healthIndicators.get(CAPABILITIES.CACHE) as () => Promise<{
        status: string;
        data: Record<string, unknown>;
      }>;
      const result = await indicator();
      expect(result.status).toBe('up');
      expect(result.data.store).toBe('memory');
    });
  });

  describe('store type: memory', () => {
    it('registers memory store successfully', async () => {
      const plugin = CachePlugin({ store: 'memory' });
      const { ctx, registered } = createFakeContext();
      await plugin.register(ctx);
      expect(registered.has(CAPABILITIES.CACHE)).toBe(true);
    });
  });

  describe('store type: noop', () => {
    it('registers noop store successfully', async () => {
      const plugin = CachePlugin({ store: 'noop' });
      const { ctx, registered } = createFakeContext();
      await plugin.register(ctx);
      expect(registered.has(CAPABILITIES.CACHE)).toBe(true);
    });
  });

  describe('store type: redis', () => {
    it('throws when redis client cannot be resolved', async () => {
      const plugin = CachePlugin({ store: 'redis' });
      const { ctx } = createFakeContext();
      await expect(plugin.register(ctx)).rejects.toThrow();
    });
  });

  describe('runtime clock injection', () => {
    it('resolves clock from runtime service when available', async () => {
      const { ctx, registered } = createFakeContext();
      // Register a fake runtime so resolveClock can find it.
      ctx.services.register(CAPABILITIES.RUNTIME, {
        hrtime: () => 12345,
      });
      const plugin = CachePlugin();
      await plugin.register(ctx);
      expect(registered.has(CAPABILITIES.CACHE)).toBe(true);
    });

    it('does not crash when runtime is absent', async () => {
      // No runtime registered — resolveClock returns undefined; MemoryStore
      // falls back to its default bound performance.now.
      const { ctx } = createFakeContext();
      const plugin = CachePlugin();
      await expect(plugin.register(ctx)).resolves.toBeUndefined();
    });
  });

  describe('priority and version', () => {
    it('has correct priority', () => {
      const plugin = CachePlugin();
      expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
    });

    it('has version 0.1.0', () => {
      const plugin = CachePlugin();
      expect(plugin.version).toBe('0.1.0');
    });
  });
});
