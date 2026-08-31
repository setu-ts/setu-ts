// deno-lint-ignore-file require-await -- interface methods must be async (IPlugin)
/**
 * Integration test for DatabasePlugin registration flow.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { drizzle as sqliteDrizzle } from 'npm:drizzle-orm@0.45.2/sqlite-proxy';
import { primaryKey, sqliteTable, text as sqliteText } from 'npm:drizzle-orm@0.45.2/sqlite-core';
import { DatabasePlugin } from '../../src/plugin/database-plugin.ts';
import { createDrizzleDatabase } from '../../src/index.ts';
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
  IPlugin,
  IPluginContext,
  IRouterApi,
} from '@setu-ts/common';
import type { IConfig, IRuntimeServices, IServiceRegistry, TimerHandle } from '@setu-ts/common';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

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
    onStopping: () => {},
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
    listRoutes: () => [],
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

/**
 * A runtime-provider test plugin, the `test/e2e/database-application.test.ts`
 * pattern, that also registers a capturing logger under `CAPABILITIES.LOGGER`
 * so `logQueries: true` runs have an observable sink.
 */
function createTestRuntimePlugin(logs: string[]): IPlugin {
  const runtime = createFakeRuntime();
  return {
    name: 'test-runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME, CAPABILITIES.LOGGER],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
      ctx.services.register(CAPABILITIES.LOGGER, {
        debug: (msg: string) => logs.push(msg),
      });
    },
  };
}

/** The composite-key table the Drizzle arm drives over real SQLite. */
const enrollments = sqliteTable('enrollments', {
  tenantId: sqliteText('tenant_id').notNull(),
  userId: sqliteText('user_id').notNull(),
  course: sqliteText('course').notNull(),
}, (table) => [
  // ONE composite primary key. Calling `.primaryKey()` on each column declares
  // two separate single-column keys, which is a different schema from the one
  // the adapter is configured for — and SQLite would reject its DDL.
  primaryKey({ columns: [table.tenantId, table.userId] }),
]);

interface ArrayReturningStatement {
  run(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown[][];
  setReturnArrays(enabled: boolean): void;
}

/**
 * Bridge Drizzle's sqlite-proxy protocol onto a real `node:sqlite` engine —
 * the `drizzle-query-sqlite.test.ts` precedent. Local file, no network
 * database.
 */
function executeSqlite(
  engine: DatabaseSync,
  statement: string,
  params: readonly SQLInputValue[],
  method: 'run' | 'all' | 'values' | 'get',
): Promise<{ rows: unknown[] }> {
  // Deno's node:sqlite runtime exposes setReturnArrays(), but its Node type
  // snapshot does not yet declare the method.
  const prepared = engine.prepare(statement) as unknown as ArrayReturningStatement;
  if (method === 'run') {
    prepared.run(...params);
    return Promise.resolve({ rows: [] });
  }
  prepared.setReturnArrays(true);
  const rows = prepared.all(...params);
  return Promise.resolve({ rows });
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
      onStopping: () => {},
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
    expect(() => db.query('SELECT 1')).toThrow('memory adapter does not support');
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

  it('rejects a drizzle registration without its required table registry', async () => {
    const fakeDrizzle = createFakeDrizzleInstance();
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({
      type: 'drizzle',
      // @ts-expect-error M70j (D7): `drizzleTables` is now required by the
      // union, so this configuration no longer compiles. The runtime guard
      // stays and is asserted below, because a JavaScript caller and a caller
      // who suppresses the error both still reach it.
      options: {
        drizzleInstance: createDrizzleDatabase(
          fakeDrizzle,
          (database, work) => database.transaction(work),
        ),
      },
    });
    await expect(plugin.register!(ctx)).rejects.toThrow('requires options.drizzleTables');
    expect(ctx.services.has(CAPABILITIES.DATABASE)).toBe(false);
  });

  it('drizzle adapter getRepository returns a repository', async () => {
    const fakeDrizzle = createFakeDrizzleInstance();
    const ctx = createFakeContext();
    const plugin = DatabasePlugin({
      type: 'drizzle',
      options: {
        drizzleInstance: createDrizzleDatabase(
          fakeDrizzle,
          (database, work) => database.transaction(work),
        ),
        drizzleTables: { users: createFakeDrizzleTable('users') },
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
    const fakeLogger: import('@setu-ts/common').ILogger = {
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

  // Retro review (Part 4). `BaseRepository.findAll` re-applied where/orderBy/
  // offset/limit that the DataSource had already applied, so `offset` ran twice
  // and every page after the first came back EMPTY through this exact surface.
  describe('paginated reads through the repository', () => {
    async function seeded() {
      const ctx = createFakeContext();
      const plugin = DatabasePlugin();
      await plugin.register!(ctx);
      const db = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository<{ id: string; n: number }>('User');
      for (let i = 1; i <= 10; i++) {
        await repo.create({ id: `u${i}`, n: i });
      }
      return repo;
    }

    it('returns every page, not just the first', async () => {
      const repo = await seeded();
      const page = async (offset: number) =>
        (await repo.findAll({ orderBy: { n: 'asc' }, limit: 3, offset }))
          .map((r) => r.n);

      expect(await page(0)).toEqual([1, 2, 3]);
      expect(await page(3)).toEqual([4, 5, 6]);
      expect(await page(6)).toEqual([7, 8, 9]);
      expect(await page(9)).toEqual([10]);
      expect(await page(10)).toEqual([]);
    });

    it('applies select through the adapter, dropping unlisted fields', async () => {
      const repo = await seeded();
      const rows = await repo.findAll({ orderBy: { n: 'asc' }, limit: 2, select: ['n'] });
      expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('still filters and counts correctly', async () => {
      const repo = await seeded();
      expect(await repo.findAll({ where: { n: 7 } })).toEqual([{ id: 'u7', n: 7 }]);
      expect(await repo.count({ where: { n: 7 } })).toBe(1);
      expect(await repo.count()).toBe(10);
    });
  });

  // M79 T14 — the cursor-pagination surface wired through the repository and
  // service layers, proven through real kernel applications rather than a
  // fake plugin context.
  describe('cursor pagination through a real kernel application', () => {
    it('writes and reads back a composite-key repository (drizzle + node:sqlite)', async () => {
      // The composite key is configured through the PLUGIN options — the
      // per-entity `entities` bag — which is the only way a key mapping
      // reaches an adapter through `IDataSource.createDataSource(entity)`.
      // The table has NO `id` column, so if the bag were dropped at the
      // plugin boundary every query below would refuse by name instead.
      const engine = new DatabaseSync(':memory:');
      engine.exec(
        'CREATE TABLE enrollments (' +
          'tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, course TEXT NOT NULL, ' +
          'PRIMARY KEY (tenant_id, user_id))',
      );
      const drizzleDb = sqliteDrizzle((statement, params, method) =>
        executeSqlite(engine, statement, params, method)
      );
      const app = createApplication({
        plugins: [
          createTestRuntimePlugin([]),
          DatabasePlugin({
            type: 'drizzle',
            options: {
              drizzleInstance: createDrizzleDatabase(
                drizzleDb,
                (configured, work) => configured.transaction(work),
              ),
              drizzleTables: { Enrollment: enrollments },
              entities: { Enrollment: { primaryKey: ['tenantId', 'userId'] } },
            },
          }),
        ],
      });
      await app.start();

      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      type EnrollmentId = { tenantId: string; userId: string };
      const repo = db.getRepository<
        { tenantId: string; userId: string; course: string },
        EnrollmentId
      >('Enrollment');

      // Write.
      await repo.create({ tenantId: 'acme', userId: 'u1', course: 'algebra' });
      await repo.create({ tenantId: 'acme', userId: 'u2', course: 'biology' });

      // Read back through the composite key.
      const found = await repo.findById({ tenantId: 'acme', userId: 'u2' });
      expect(found?.course).toBe('biology');

      // Update through the composite key; the other key half is untouched.
      const updated = await repo.update({ tenantId: 'acme', userId: 'u2' }, {
        course: 'chemistry',
      });
      expect(updated.course).toBe('chemistry');
      expect((await repo.findById({ tenantId: 'acme', userId: 'u1' }))?.course).toBe('algebra');

      // Delete through the composite key.
      expect(await repo.delete({ tenantId: 'acme', userId: 'u1' })).toBe(true);
      expect(await repo.findById({ tenantId: 'acme', userId: 'u1' })).toBeNull();
      const survivor = await repo.findById({ tenantId: 'acme', userId: 'u2' });
      expect(survivor?.course).toBe('chemistry');

      await app.stop();
    });

    it('cursor walk over a seeded table with sort-key ties returns every row exactly once', async () => {
      // logQueries: true runs every read through the ONE query-logging
      // wrapper, so this walk also proves the wrapper forwards findPage
      // through a real application — without losing the member (the walk
      // would refuse by name) and while logging the operation.
      const logs: string[] = [];
      const app = createApplication({
        plugins: [
          createTestRuntimePlugin(logs),
          DatabasePlugin({ options: { logQueries: true } }),
        ],
      });
      await app.start();

      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const repo = db.getRepository<{ id: string; n: number }>('User');

      // Deliberate ties on the sort key (the P11 fixture shape): a naive walk
      // without the key tiebreaker silently loses the tied rows and reports
      // success.
      const seeded: ReadonlyArray<readonly [string, number]> = [
        ['u1', 10],
        ['u2', 10],
        ['u3', 20],
        ['u4', 20],
        ['u5', 30],
        ['u6', 40],
        ['u7', 40],
      ];
      for (const [id, n] of seeded) {
        await repo.create({ id, n });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (let page = 0; page < 10; page++) {
        const result = await repo.findPage({
          orderBy: { n: 'asc' },
          limit: 3,
          ...(cursor === null ? {} : { cursor }),
        });
        pages += 1;
        seen.push(...result.rows.map((row) => row.id));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      // Every row exactly once: no duplicates, none skipped.
      expect([...seen].sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
      expect(new Set(seen).size).toBe(7);
      // 7 rows at limit 3 = 3 pages; the last reports a null cursor.
      expect(pages).toBe(3);
      // The walk ran through the service's wrapped data source, so the
      // forwarded findPage operation is what the wrapper logged.
      expect(logs).toContain('[User] findPage');

      await app.stop();
    });
  });
});
