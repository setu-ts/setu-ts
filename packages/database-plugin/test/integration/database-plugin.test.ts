// deno-lint-ignore-file require-await -- interface methods must be async (IPlugin)
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

  it('registers named connection under database.<name> (dot notation)', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({ name: 'analytics' });
    await plugin.register!(ctx);
    expect(ctx.services.has('database.analytics')).toBe(true);
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

  it('registers shutdown hook via lifecycle.onClose', async () => {
    const closeFns: Array<() => Promise<void>> = [];
    const lifecycle: ILifecycleApi = {
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
      onClose: (fn: () => Promise<void>) => closeFns.push(fn),
    };
    const ctx: IPluginContext = {
      ...createFakeContext(),
      lifecycle,
    };
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    expect(closeFns.length).toBe(1);
  });

  it('registers health indicator', async () => {
    const healthChecks: Map<string, () => Promise<unknown>> = new Map();
    const health: IHealthApi = {
      register: (name: string, fn: () => Promise<unknown>) => healthChecks.set(name, fn),
    };
    const ctx: IPluginContext = {
      ...createFakeContext(),
      health,
    };
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    expect(healthChecks.has('database')).toBe(true);
  });

  it('health indicator reports up when healthy', async () => {
    const healthChecks: Map<string, () => Promise<unknown>> = new Map();
    const health: IHealthApi = {
      register: (name: string, fn: () => Promise<unknown>) => healthChecks.set(name, fn),
    };
    const ctx: IPluginContext = {
      ...createFakeContext(),
      health,
    };
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const result = await healthChecks.get('database')!();
    expect((result as { status: string }).status).toBe('up');
  });

  it('memory adapter query throws unsupported error', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await expect(db.query('SELECT 1')).rejects.toThrow('memory adapter does not support');
  });

  it('memory adapter migrate throws unsupported error', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await expect(db.migrate()).rejects.toThrow('Programmatic migrations are not supported');
  });

  it('getRepository returns a working repository', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const repo = db.getRepository<{ id: string; name: string }>('User');
    const created = await repo.create({ name: 'Alice' });
    expect(created.name).toBe('Alice');
    const found = await repo.findById(created.id);
    expect(found?.name).toBe('Alice');
  });

  it('transaction commits successfully', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const result = await db.transaction(async (uow) => {
      const repo = uow.getRepository<{ name: string }>('Order');
      await repo.create({ name: 'order-1' });
      return 'committed';
    });
    expect(result).toBe('committed');
  });

  it('transaction rolls back on error', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await expect(
      db.transaction(async () => {
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
  });

  it('registers with prisma adapter type', async () => {
    const fakePrisma = {
      $connect: async () => {},
      $disconnect: async () => {},
      $transaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(null as unknown),
      $queryRawUnsafe: async () => [],
    };
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({
      type: 'prisma',
      options: { prismaClient: fakePrisma as never },
    });
    await plugin.register!(ctx);
    expect(ctx.services.has(CAPABILITIES.DATABASE)).toBe(true);
  });

  it('prisma adapter getRepository returns a repository', async () => {
    const fakePrisma = {
      $connect: async () => {},
      $disconnect: async () => {},
      $transaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(null as unknown),
      $queryRawUnsafe: async () => [],
      user: {
        findUnique: async () => null,
        findMany: async () => [],
        create: async (args: { data: Record<string, unknown> }) => args.data,
        update: async () => ({}),
        delete: async () => ({}),
        count: async () => 0,
      },
    };
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({
      type: 'prisma',
      options: { prismaClient: fakePrisma as never },
    });
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const repo = db.getRepository<{ name: string }>('User');
    expect(repo).toBeDefined();
  });

  it('registers with drizzle adapter type', async () => {
    const fakeDrizzle = {
      select: () => ({ from: async () => [] }),
      insert: () => ({ values: () => ({ execute: async () => [] }) }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
      delete: () => ({ where: async () => {} }),
      execute: async () => ({ rows: [] }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDrizzle),
    };
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({
      type: 'drizzle',
      options: { drizzleInstance: fakeDrizzle as never },
    });
    await plugin.register!(ctx);
    expect(ctx.services.has(CAPABILITIES.DATABASE)).toBe(true);
  });

  it('drizzle adapter getRepository returns a repository', async () => {
    const fakeDrizzle = {
      select: () => ({ from: async () => [] }),
      insert: () => ({ values: () => ({ execute: async () => [] }) }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
      delete: () => ({ where: async () => {} }),
      execute: async () => ({ rows: [] }),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDrizzle),
    };
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({
      type: 'drizzle',
      options: {
        drizzleInstance: fakeDrizzle as never,
        drizzleTables: { users: {} },
      },
    });
    await plugin.register!(ctx);
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const repo = db.getRepository<{ name: string }>('users');
    expect(repo).toBeDefined();
  });

  it('resolves logger when available', async () => {
    const healthChecks: Map<string, () => Promise<unknown>> = new Map();
    const closeFns: Array<() => Promise<void>> = [];
    const fakeLogger: import('@hono-enterprise/common').ILogger = {
      level: 'info',
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => fakeLogger,
    };
    const services: IServiceRegistry = {
      ...createFakeServiceRegistry(),
      has: (token: string) =>
        token === CAPABILITIES.LOGGER || createFakeServiceRegistry().has(token),
      get: <T>(token: string) => {
        if (token === CAPABILITIES.LOGGER) return fakeLogger as T;
        return createFakeServiceRegistry().get(token);
      },
    };
    const ctx: IPluginContext = {
      ...createFakeContext(),
      services,
      health: {
        register: (name: string, fn: () => Promise<unknown>) => healthChecks.set(name, fn),
      },
      lifecycle: {
        ...createFakeLifecycle(),
        onClose: (fn: () => Promise<void>) => closeFns.push(fn),
      },
    };
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    expect(healthChecks.has('database')).toBe(true);
  });

  it('health indicator reports down when unhealthy', async () => {
    const healthChecks: Map<string, () => Promise<unknown>> = new Map();
    const health: IHealthApi = {
      register: (name: string, fn: () => Promise<unknown>) => healthChecks.set(name, fn),
    };
    const ctx: IPluginContext = {
      ...createFakeContext(),
      health,
    };
    const plugin = DatabasePlugin();
    await plugin.register!(ctx);
    // Close service to make it unhealthy
    const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    await db.close();
    const result = await healthChecks.get('database')!();
    expect((result as { status: string }).status).toBe('down');
  });

  it('buildAdapterOptions passes logQueries option', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({ options: { logQueries: true } });
    await plugin.register!(ctx);
    expect(ctx.services.has(CAPABILITIES.DATABASE)).toBe(true);
  });

  it('buildAdapterOptions passes url option', async () => {
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({ options: { url: 'sqlite::memory:' } });
    await plugin.register!(ctx);
    expect(ctx.services.has(CAPABILITIES.DATABASE)).toBe(true);
  });
});
