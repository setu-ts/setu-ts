/**
 * Integration test for DatabasePlugin registration flow.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import type { IDatabaseService } from '../../src/interfaces/index.ts';
import type {
  ICliApi,
  IDecoratorApi,
  IEnvironmentApi,
  IHealthApi,
  ILifecycleApi,
  IMetricsApi,
  IMiddlewareApi,
  IOpenApiApi,
  IPluginContext,
  IRouterApi,
} from '@hono-enterprise/common';
import type {
  IConfig,
  IRuntimeServices,
  IServiceRegistry,
  TimerHandle,
} from '@hono-enterprise/common';

/** Minimal fake config. */
function createFakeConfig(): IConfig {
  return {
    get: () => undefined,
    getOrThrow: (key: string) => {
      throw new Error(`Config key '${key}' not found`);
    },
    has: () => false,
  };
}

/** Minimal fake runtime services. */
function createFakeRuntime(): IRuntimeServices {
  return {
    uuid: () => 'test-uuid',
    randomBytes: (n: number) => new Uint8Array(n),
    subtle: {} as SubtleCrypto,
    now: () => 0,
    hrtime: () => 0,
    setTimeout: () => 0 as TimerHandle,
    clearTimeout: () => {},
    setInterval: () => 0 as TimerHandle,
    clearInterval: () => {},
    env: {},
    platform: () => 'deno',
    version: () => '1.0.0',
    hostname: () => 'test-host',
    exit: () => {
      throw new Error('exit called');
    },
  };
}

/** Minimal fake lifecycle API. */
function createFakeLifecycle(): ILifecycleApi {
  const closeFns: Array<() => Promise<void>> = [];
  return {
    onRegister: () => {},
    onInit: () => {},
    onBootstrap: () => {},
    onRequest: () => {},
    onResponse: () => {},
    onError: () => {},
    onShutdown: () => {},
    onClose: (fn: () => Promise<void>): void => {
      closeFns.push(fn);
    },
  };
}

/** Minimal fake service registry. */
function createFakeServiceRegistry(): IServiceRegistry {
  const services = new Map<string, unknown>();
  return {
    register<T>(token: string, service: T): void {
      services.set(token, service);
    },
    get<T>(token: string): T {
      const val = services.get(token);
      if (val === undefined) throw new Error(`Service '${token}' not found`);
      return val as T;
    },
    has(token: string): boolean {
      return services.has(token);
    },
    getAll<T>(_token: string): T[] {
      return [];
    },
    unregister(_token: string): boolean {
      return false;
    },
    registerFactory<T>(_token: string, _factory: () => T): void {},
  };
}

/** Minimal fake router API. */
function createFakeRouter(): IRouterApi {
  return {
    get: () => {},
    post: () => {},
    put: () => {},
    patch: () => {},
    delete: () => {},
    head: () => {},
    options: () => {},
    group: () => {},
  };
}

/** Minimal fake plugin context for testing registration. */
function createFakeContext(): IPluginContext {
  return {
    services: createFakeServiceRegistry(),
    middleware: { add: () => {} } as IMiddlewareApi,
    router: createFakeRouter(),
    config: createFakeConfig(),
    environment: { validate: () => {} } as IEnvironmentApi,
    health: { register: () => {} } as IHealthApi,
    metrics: { register: () => {} } as IMetricsApi,
    openapi: { addSchema: () => {} } as IOpenApiApi,
    decorators: { register: () => {} } as IDecoratorApi,
    cli: { register: () => {} } as ICliApi,
    lifecycle: createFakeLifecycle(),
    runtime: createFakeRuntime(),
    options: {},
    app: {} as never,
  };
}

describe('DatabasePlugin integration', () => {
  it('registers IDatabaseService under CAPABILITIES.DATABASE', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    expect(ctx.services.has(CAPABILITIES.DATABASE)).toBe(true);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    expect(db).toBeDefined();
  });

  it('registers named connection under database:<name>', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({ name: 'analytics' });
    await plugin.register!(ctx);
    expect(ctx.services.has('database:analytics')).toBe(true);
  });

  it('service is healthy after registration', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    expect(await db.isHealthy()).toBe(true);
  });

  it('closes service and reports unhealthy', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);

    await db.close();
    expect(await db.isHealthy()).toBe(false);
  });
});
