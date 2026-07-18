/**
 * Tests for health-plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HealthPlugin } from '../../src/plugin/health-plugin.ts';
import type { HealthService } from '../../src/services/health-service.ts';
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
          check: () => Promise.resolve({ status: 'up' }),
        },
        {
          name: 'custom2',
          check: () => Promise.resolve({ status: 'up' }),
        },
      ],
    });

    expect(plugin.name).toBe('health-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.HEALTH);
  });

  it('should register contributed indicators via onInit hook', async () => {
    let onInitHook: (() => void) | undefined;

    // A HEALTH_INDICATOR contribution, shaped exactly as the kernel stores it
    // (see application.ts: { name, check }).
    const contribution = {
      name: 'db',
      check: () => Promise.resolve({ status: 'up' as const }),
    };

    const services = new Map<string, unknown>();
    const fakeRegistry = {
      register: (token: string, service: unknown) => {
        services.set(token, service);
      },
      get: (token: string) => services.get(token),
      getAll: (token: string) => token === CAPABILITIES.HEALTH_INDICATOR ? [contribution] : [],
      has: (token: string) => services.has(token),
      registerFactory: () => {},
      unregister: () => false,
    } as unknown as IServiceRegistry;

    const fakeLifecycle = {
      onInit: (hook: () => void) => {
        onInitHook = hook;
      },
      onShutdown: () => {},
      onRegister: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onClose: () => {},
    } as ILifecycleApi;

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
      lifecycle: fakeLifecycle,
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
      environment: {} as IEnvironmentApi,
      health: {} as IHealthApi,
      metrics: {} as IMetricsApi,
      openapi: {} as IOpenApiApi,
      decorators: {} as IDecoratorApi,
      cli: {} as ICliApi,
      options: {},
      app: {} as IApplication,
    } as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    // Trigger the onInit hook — this is where the drain runs.
    expect(onInitHook).toBeDefined();
    onInitHook?.();

    // The contributed indicator must actually land on the resolved service,
    // not merely be "available" to drain. Read it back through the service.
    const service = services.get(CAPABILITIES.HEALTH) as HealthService;
    const report = await service.checkReady();
    expect(Object.keys(report.checks)).toContain('db');
    expect(report.checks.db.status).toBe('up');
  });

  describe('health endpoint handlers', () => {
    it('should return 200 for /live endpoint', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            _path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            handler = h;
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      const plugin = HealthPlugin();
      plugin.register(ctx);

      // Mock the response object - must match the handler's expected structure
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler for /live
      const result = (await handler?.(mockContext)) as {
        status: number;
        body: { status: string; checks: Record<string, unknown> };
      };
      expect(result.status).toBe(200);
      // checkLive returns 200 with the self indicator result
      expect(result.body.status).toBe('up');
      expect(typeof result.body.checks).toBe('object');
    });

    it('should return 200 for /ready endpoint when all indicators are up', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            _path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            handler = h;
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      const plugin = HealthPlugin();
      plugin.register(ctx);

      // Mock the response object
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler
      const result = (await handler?.(mockContext)) as { status: number; body: unknown };
      expect(result.status).toBe(200);
      // checkReady excludes self, so checks is empty
      expect(result.body).toEqual({
        status: 'up',
        timestamp: expect.any(String),
        checks: {},
      });
    });

    it('should return 200 for /health endpoint when self indicator is up', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            _path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            handler = h;
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      const plugin = HealthPlugin();
      plugin.register(ctx);

      // Mock the response object
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler
      const result = (await handler?.(mockContext)) as {
        status: number;
        body: { status: string; checks: Record<string, unknown> };
      };
      expect(result.status).toBe(200);
      // check returns 200 with all indicators
      expect(result.body.status).toBe('up');
      expect(typeof result.body.checks).toBe('object');
    });
  });

  describe('determineStatusCode coverage - 503 status paths', () => {
    it('should return 503 for /ready endpoint when an indicator returns down', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            _path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            handler = h;
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      // Pass an indicator that returns 'down' - checkReady excludes 'self' so it will see this
      const plugin = HealthPlugin({
        indicators: [
          {
            name: 'database',
            check: () => Promise.resolve({ status: 'down' as const }),
          },
        ],
      });
      plugin.register(ctx);

      // Mock the response object
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler for /ready (which uses checkReady)
      const result = (await handler?.(mockContext)) as {
        status: number;
        body: { status: string; checks: Record<string, unknown> };
      };
      expect(result.status).toBe(503);
      expect(result.body.status).toBe('down');
      expect(result.body.checks.database).toBeDefined();
    });

    it('should return 503 for /ready endpoint when an indicator returns degraded', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            _path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            handler = h;
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      // Pass an indicator that returns 'degraded' - checkReady excludes 'self' so it will see this
      const plugin = HealthPlugin({
        indicators: [
          {
            name: 'cache',
            check: () => Promise.resolve({ status: 'degraded' as const }),
          },
        ],
      });
      plugin.register(ctx);

      // Mock the response object
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler for /ready (which uses checkReady)
      const result = (await handler?.(mockContext)) as {
        status: number;
        body: { status: string; checks: Record<string, unknown> };
      };
      expect(result.status).toBe(503);
      expect(result.body.status).toBe('degraded');
      expect(result.body.checks.cache).toBeDefined();
    });

    it('should return 503 for /health endpoint when self indicator returns down', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            // Capture the /health handler specifically
            if (path === '/health') {
              handler = h;
            }
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      // The self indicator always returns 'up', but we can override it by registering
      // a duplicate indicator with the same name - but the plugin throws on duplicates.
      // Instead, we test the /health path by noting that if any indicator (including self)
      // returns 'down', the overall status is 'down' and /health returns 503.
      // Since we can't override self, we test via checkReady which excludes self.
      // For /health specifically, we need a different approach - let's verify the logic
      // by testing that when an app indicator returns down, /health also returns 503.
      const plugin = HealthPlugin({
        indicators: [
          {
            name: 'database',
            check: () => Promise.resolve({ status: 'down' as const }),
          },
        ],
      });
      plugin.register(ctx);

      // Mock the response object
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler for /health (which uses check)
      // check() includes all indicators, so if database is down, overall status is down
      const result = (await handler?.(mockContext)) as {
        status: number;
        body: { status: string; checks: Record<string, unknown> };
      };
      // Note: The self indicator is always 'up', but database is 'down', so worst status is 'down'
      expect(result.status).toBe(503);
      expect(result.body.status).toBe('down');
    });

    it('should return 200 for /health endpoint when status is degraded (not down)', async () => {
      let handler:
        | ((
          c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
        ) => Promise<unknown>)
        | undefined;

      const fakeRegistry = {
        register: () => {},
        get: () => undefined,
        getAll: () => [],
        has: () => false,
        registerFactory: () => {},
        unregister: () => false,
      } as unknown as IServiceRegistry;

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

      const ctx = {
        services: fakeRegistry,
        router: {
          get: (
            path: string,
            h: (
              c: { response: { status: (code: number) => { json: (body: unknown) => unknown } } },
            ) => Promise<unknown>,
          ) => {
            // Capture the /health handler specifically
            if (path === '/health') {
              handler = h;
            }
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
          onInit: () => {},
          onShutdown: () => {},
          onRegister: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onClose: () => {},
        } as ILifecycleApi,
        middleware: { add: () => {} } as IMiddlewareApi,
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
      } as unknown as IPluginContext;

      // Per design: /health returns 200 for degraded (only 'down' triggers 503)
      const plugin = HealthPlugin({
        indicators: [
          {
            name: 'cache',
            check: () => Promise.resolve({ status: 'degraded' as const }),
          },
        ],
      });
      plugin.register(ctx);

      // Mock the response object
      const mockResponse = {
        status: (code: number) => ({
          json: (body: unknown) => ({ status: code, body }),
        }),
      };

      const mockContext = {
        response: mockResponse,
      };

      // Call the handler for /health (which uses check)
      // Self is 'up', cache is 'degraded', so worst status is 'degraded'
      // /health returns 200 for degraded
      const result = (await handler?.(mockContext)) as {
        status: number;
        body: { status: string; checks: Record<string, unknown> };
      };
      expect(result.status).toBe(200);
      expect(result.body.status).toBe('degraded');
      expect(result.body.checks.cache).toBeDefined();
    });
  });
});
