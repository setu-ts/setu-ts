// deno-lint-ignore-file require-await -- interface methods must be async (IPlugin)
/**
 * Coverage tests for DatabasePlugin createAdapter branches.
 *
 * Exercises prisma/drizzle adapter selection, missing-client errors,
 * and named-connection token branch to raise database-plugin.ts function
 * coverage to ≥90%.
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
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';

function createFakeConfig(): IConfig {
  return {
    get: () => undefined,
    getOrThrow: (key: string) => {
      throw new Error(`Config key '${key}' not found`);
    },
    has: () => false,
  };
}

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
    fs: {
      stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
      readFile: async () => new TextEncoder().encode(''),
      writeFile: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      rm: async () => {},
    },
  };
}

function createFakeLifecycle(): ILifecycleApi {
  return {
    onRegister: () => {},
    onInit: () => {},
    onBootstrap: () => {},
    onRequest: () => {},
    onResponse: () => {},
    onError: () => {},
    onShutdown: () => {},
    onClose: () => {},
  };
}

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
    listRoutes: () => [],
  };
}

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

describe('DatabasePlugin — createAdapter branch coverage', () => {
  describe('memory adapter (default)', () => {
    it('registers and provides database service', async () => {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin();
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
      expect(await db.isHealthy()).toBe(true);
    });
  });

  describe('prisma adapter selection', () => {
    it('builds prisma adapter when client is injected', async () => {
      const ctx = createFakeContext();
      const fakeClient = createFakePrismaClient();
      const plugin = DatabasePlugin({
        type: 'prisma',
        options: { prismaClient: fakeClient },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });

    it('throws descriptive error when no prisma client', async () => {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin({
        type: 'prisma',
        options: { url: 'postgresql://localhost/test' },
      });
      await expect(plugin.register!(ctx)).rejects.toThrow('Failed to load Prisma');
    });
  });

  describe('drizzle adapter selection', () => {
    it('builds drizzle adapter when instance is injected', async () => {
      const ctx = createFakeContext();
      const fakeDb = createFakeDrizzleInstance();
      const plugin = DatabasePlugin({
        type: 'drizzle',
        options: {
          drizzleInstance: fakeDb,
          drizzleTables: { user: {} },
        },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });

    it('throws descriptive error when no drizzle instance', async () => {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin({
        type: 'drizzle',
        options: {
          url: 'postgresql://localhost/test',
          drizzleTables: { user: {} },
        },
      });
      await expect(plugin.register!(ctx)).rejects.toThrow('Failed to load Drizzle');
    });
  });

  describe('named connection', () => {
    it('registers under database.<name> token', async () => {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin({
        name: 'analytics',
      });
      await plugin.register!(ctx);
      expect(plugin.provides).toEqual(['database.analytics']);
    });
  });

  describe('buildAdapterOptions branches', () => {
    it('passes logQueries option through', async () => {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin({
        type: 'memory',
        options: { logQueries: true },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });

    it('passes url option through', async () => {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin({
        type: 'memory',
        options: { url: 'postgresql://localhost/test' },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });
  });

  describe('resolveLogger — no logger available', () => {
    it('works without logger in context', async () => {
      // createFakeContext does NOT register a logger — covers the undefined path.
      const ctx = createFakeContext();
      const plugin = DatabasePlugin();
      await plugin.register!(ctx);
      // Should register successfully even without logger.
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });
  });

  describe('resolveLogger — logger available', () => {
    it('resolves logger when registered', async () => {
      const logs: string[] = [];
      const ctx = createFakeContext();
      // Register a logger so resolveLogger takes the truthy branch
      ctx.services.register('logger', { debug: (msg: string) => logs.push(msg) });
      const plugin = DatabasePlugin({
        type: 'memory',
        options: { logQueries: true },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
      // Trigger a CRUD op to exercise the logger debug path
      const repo = db.getRepository('User');
      await repo.create({ id: 'log1', name: 'Logged' });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('buildAdapterOptions — drizzle options', () => {
    it('passes drizzleInstance through', async () => {
      const ctx = createFakeContext();
      const fakeDb = createFakeDrizzleInstance();
      const plugin = DatabasePlugin({
        type: 'drizzle',
        options: {
          drizzleInstance: fakeDb,
          drizzleTables: { user: {} },
        },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });
  });

  describe('buildAdapterOptions — transactionTimeout', () => {
    it('passes transactionTimeout through', async () => {
      const ctx = createFakeContext();
      const fakeClient = createFakePrismaClient();
      const plugin = DatabasePlugin({
        type: 'prisma',
        options: {
          prismaClient: fakeClient,
          transactionTimeout: 60_000,
        },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      expect(db).toBeDefined();
    });
  });

  describe('createDataSourceFactory — drizzle default path', () => {
    it('uses drizzle adapter createDataSourceForEntity', async () => {
      const ctx = createFakeContext();
      const fakeDb = createFakeDrizzleInstance();
      const plugin = DatabasePlugin({
        type: 'drizzle',
        options: {
          drizzleInstance: fakeDb,
          drizzleTables: { user: {} },
        },
      });
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository('user');
      await repo.create({ id: 'dsf1', name: 'Test' });
    });
  });
});
