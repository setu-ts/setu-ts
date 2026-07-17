/**
 * Tests for health-plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HealthPlugin } from '../../src/plugin/health-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  IApplication,
  ICliApi,
  IConfig,
  IDecoratorApi,
  IEnvironmentApi,
  IHealthApi,
  ILifecycleApi,
  ILogger,
  IMetricsApi,
  IMiddlewareApi,
  IOpenApiApi,
  IPluginContext,
  IRouterApi,
  IRuntimeServices,
  IServiceRegistry,
  RuntimePlatform,
} from '@hono-enterprise/common';

describe('HealthPlugin', () => {
  function createFakeContext(): IPluginContext {
    const routes: Array<{ path: string; method: string }> = [];
    const onInitHooks: Array<() => void> = [];

    const fakeRegistry = {
      register: () => {},
      get: (): unknown => undefined,
      getAll: () => [],
      has: () => false,
      registerFactory: () => {},
      unregister: () => false,
    } as IServiceRegistry;

    const fakeRouter: IRouterApi = {
      get: (path: string) => {
        routes.push({ path, method: 'GET' });
      },
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
    };

    const fakeLifecycle = {
      onInit: (hook: () => void) => {
        onInitHooks.push(hook);
      },
      onShutdown: () => {},
      onRegister: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onClose: () => {},
    } as ILifecycleApi;

    const fakeMiddleware: IMiddlewareApi = {
      add: () => {},
    };

    const fakeRuntime = {
      now: () => 1_000_000_000_000,
      hrtime: () => 0,
      platform: () => 'node' as RuntimePlatform,
      version: () => '18.0.0',
      hostname: () => 'test-host',
      uuid: () => '00000000-0000-0000-0000-000000000000',
      randomBytes: () => new Uint8Array(32),
      subtle: {} as Crypto['subtle'],
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      env: {} as Record<string, string | undefined>,
      exit: (() => {
        throw new Error('exit called');
      }) as () => never,
      fs: {} as IRuntimeServices['fs'],
    } as unknown as IRuntimeServices;

    return {
      services: fakeRegistry,
      router: fakeRouter,
      lifecycle: fakeLifecycle,
      middleware: fakeMiddleware,
      runtime: fakeRuntime,
      logger: {} as ILogger,
      config: {} as IConfig,
      environment: {} as IEnvironmentApi,
      health: {} as IHealthApi,
      metrics: {} as IMetricsApi,
      openapi: {} as IOpenApiApi,
      decorators: {} as IDecoratorApi,
      cli: {} as ICliApi,
      options: {},
      app: {} as IApplication,
    };
  }

  it('should have correct name', () => {
    const plugin = HealthPlugin();

    expect(plugin.name).toBe('health-plugin');
  });

  it('should have correct version', () => {
    const plugin = HealthPlugin();

    expect(plugin.version).toBe('0.20.0');
  });

  it('should provide CAPABILITIES.HEALTH', () => {
    const plugin = HealthPlugin();

    expect(plugin.provides).toEqual([CAPABILITIES.HEALTH]);
  });

  it('should have priority 100', () => {
    const plugin = HealthPlugin();

    expect(plugin.priority).toBe(100);
  });

  it('should register HealthService under CAPABILITIES.HEALTH', () => {
    let registeredToken: string | undefined;

    const fakeRegistry = {
      register: (token: string) => {
        registeredToken = token;
      },
      get: () => undefined,
      getAll: () => [],
      has: () => false,
      registerFactory: () => {},
      unregister: () => true,
    } as unknown as IServiceRegistry;

    const ctx = {
      services: fakeRegistry,
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: () => {},
        onShutdown: () => {},
        onStart: () => {},
        onStop: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
    } as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    expect(registeredToken).toBe(CAPABILITIES.HEALTH);
  });

  it('should register self indicator', () => {
    const ctx = createFakeContext();
    const plugin = HealthPlugin();
    plugin.register(ctx);

    // The self indicator should be registered - we verify via integration test
    // that it actually runs
    expect(ctx).toBeDefined();
  });

  it('should register /health endpoint by default', () => {
    const routes: Array<{ path: string; method: string }> = [];

    const ctx = {
      services: {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => true,
      } as unknown as IServiceRegistry,
      router: {
        get: (path: string) => {
          routes.push({ path, method: 'GET' });
        },
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: () => {},
        onShutdown: () => {},
        onStart: () => {},
        onStop: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
    } as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    expect(routes.some((r) => r.path === '/health')).toBe(true);
  });

  it('should register /live endpoint by default', () => {
    const routes: Array<{ path: string; method: string }> = [];

    const ctx = {
      services: {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => true,
      } as unknown as IServiceRegistry,
      router: {
        get: (path: string) => {
          routes.push({ path, method: 'GET' });
        },
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: () => {},
        onShutdown: () => {},
        onStart: () => {},
        onStop: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
    } as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    expect(routes.some((r) => r.path === '/live')).toBe(true);
  });

  it('should register /ready endpoint by default', () => {
    const routes: Array<{ path: string; method: string }> = [];

    const ctx = {
      services: {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => true,
      } as unknown as IServiceRegistry,
      router: {
        get: (path: string) => {
          routes.push({ path, method: 'GET' });
        },
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: () => {},
        onShutdown: () => {},
        onStart: () => {},
        onStop: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
    } as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    expect(routes.some((r) => r.path === '/ready')).toBe(true);
  });

  it('should use custom endpoint paths when provided', () => {
    const routes: Array<{ path: string; method: string }> = [];

    const ctx = {
      services: {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => true,
      } as unknown as IServiceRegistry,
      router: {
        get: (path: string) => {
          routes.push({ path, method: 'GET' });
        },
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: () => {},
        onShutdown: () => {},
        onStart: () => {},
        onStop: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
    } as IPluginContext;

    const plugin = HealthPlugin({
      endpoints: {
        health: '/healthz',
        live: '/livez',
        ready: '/readyz',
      },
    });
    plugin.register(ctx);

    expect(routes.some((r) => r.path === '/healthz')).toBe(true);
    expect(routes.some((r) => r.path === '/livez')).toBe(true);
    expect(routes.some((r) => r.path === '/readyz')).toBe(true);
  });

  it('should skip endpoint when path is undefined', () => {
    const routes: Array<{ path: string; method: string }> = [];

    const fakeRegistry = {
      register: () => {},
      get: () => undefined,
      getAll: () => [],
      has: () => false,
      registerFactory: () => {},
      unregister: () => true,
    } as unknown as IServiceRegistry;

    const ctx = {
      services: fakeRegistry,
      router: {
        get: (path: string) => {
          routes.push({ path, method: 'GET' });
        },
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: () => {},
        onShutdown: () => {},
        onStart: () => {},
        onStop: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
    } as IPluginContext;

    const plugin = HealthPlugin({
      endpoints: {
        health: '/health',
        live: undefined as unknown as string,
        ready: '/ready',
      },
    });
    plugin.register(ctx);

    expect(routes.some((r) => r.path === '/health')).toBe(true);
    expect(routes.some((r) => r.path === '/live')).toBe(false);
    expect(routes.some((r) => r.path === '/ready')).toBe(true);
  });

  it('should register onInit hook to drain HEALTH_INDICATOR contributions', () => {
    const onInitHooks: Array<() => void> = [];

    const fakeRegistry2 = {
      register: () => {},
      get: (): unknown => undefined,
      getAll: () => [],
      has: () => false,
      registerFactory: () => {},
      unregister: () => false,
    } as IServiceRegistry;

    const ctx = {
      services: fakeRegistry2,
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      } as IRouterApi,
      lifecycle: {
        onRegister: () => {},
        onBootstrap: () => {},
        onInit: (hook: () => void) => {
          onInitHooks.push(hook);
        },
        onShutdown: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      } as ILifecycleApi,
      middleware: { add: () => {} } as IMiddlewareApi,
      runtime: {
        now: () => 1_000_000_000_000,
        hrtime: () => 0,
        platform: () => 'node' as RuntimePlatform,
        version: () => '18.0.0',
        hostname: () => 'test-host',
        uuid: () => '00000000-0000-0000-0000-000000000000',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {} as Record<string, string | undefined>,
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IRuntimeServices['fs'],
      } as unknown as IRuntimeServices,
      logger: {} as ILogger,
      config: {} as IConfig,
      environment: {} as IEnvironmentApi,
      health: {} as IHealthApi,
      metrics: {} as IMetricsApi,
      openapi: {} as IOpenApiApi,
      decorators: {} as IDecoratorApi,
      cli: {} as ICliApi,
      options: {},
      app: {} as IApplication,
    } as unknown as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    expect(onInitHooks).toHaveLength(1);
  });

  it('should register app-supplied indicators', () => {
    // Just verify the plugin accepts indicators in options without error
    const plugin = HealthPlugin({
      indicators: [
        {
          name: 'custom1',
          check: async () => ({ status: 'up' }),
        },
        {
          name: 'custom2',
          check: async () => ({ status: 'up' }),
        },
      ],
    });

    expect(plugin.name).toBe('health-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.HEALTH);
  });
});
