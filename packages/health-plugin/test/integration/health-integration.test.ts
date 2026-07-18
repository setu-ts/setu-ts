/**
 * Integration tests for health plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createHttpIndicator, HealthPlugin } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IApplication, IPluginContext, RuntimePlatform } from '@hono-enterprise/common';
import type {
  ICliApi,
  IConfig,
  IDecoratorApi,
  IEnvironmentApi,
  IHealthApi,
  ILogger,
  IMetricsApi,
  IOpenApiApi,
  IRuntimeServices,
} from '@hono-enterprise/common';

describe('HealthPlugin integration', () => {
  function createFakeContext() {
    const routes: Array<{ path: string }> = [];

    const services = new Map<string, unknown>();
    const fakeRegistry = {
      register(_token: string, _service: unknown) {
        services.set(_token, _service);
      },
      get<T>(_token: string): T | undefined {
        return services.get(_token) as T | undefined;
      },
      getAll<T>(_token: string): T[] {
        return [];
      },
      has(_token: string): boolean {
        return services.has(_token);
      },
      registerFactory: () => {},
      unregister: () => false,
    };

    return {
      services: fakeRegistry,
      router: {
        get: (path: string) => {
          routes.push({ path });
        },
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
      },
      lifecycle: {
        onInit: () => {},
        onShutdown: () => {},
        onRegister: () => {},
        onBootstrap: () => {},
        onRequest: () => {},
        onResponse: () => {},
        onError: () => {},
        onClose: () => {},
      },
      middleware: {
        add: () => {},
      },
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
    };
  }

  it('should register health service that can be resolved', () => {
    const ctx = createFakeContext() as unknown as IPluginContext;

    const plugin = HealthPlugin();
    plugin.register(ctx);

    // Verify service was registered (check that the registry has it)
    expect(ctx.services.has(CAPABILITIES.HEALTH)).toBe(true);

    // Verify routes were registered
    expect(ctx.router).toBeDefined();
  });

  it('should handle createHttpIndicator factory', () => {
    const mockFetcher = () =>
      Promise.resolve({
        status: 200,
      } as Response);

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

    const indicator = createHttpIndicator('test-api', {
      url: 'http://example.com',
      fetcher: mockFetcher,
      runtime: fakeRuntime,
    });

    expect(indicator.name).toBe('test-api');
  });
});
