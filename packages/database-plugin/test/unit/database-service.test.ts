// deno-lint-ignore-file require-await -- interface methods must be async
/**
 * Unit tests for DatabaseService.
 *
 * Tests cover:
 * - Constructor accepts IDatabaseAdapter + now()
 * - wrapDataSource logs when logQueries true (monotonic duration)
 * - wrapDataSource is silent when logQueries false
 * - query() delegates rawQuery
 * - migrate() throws uniform error
 * - transaction() builds UoW from scoped factory
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DatabaseService } from '../../src/services/database-service.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IDatabaseAdapter, NormalizedQuery, PageResult } from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import {
  createDrizzleDatabase,
  getDrizzleDatabase,
  getDrizzleTransaction,
} from '../../src/index.ts';
import {
  createFakeDrizzleInstance,
  createFakeDrizzleTable,
} from '../fixtures/fake-drizzle-instance.ts';

describe('DatabaseService', () => {
  let adapter: IDatabaseAdapter;
  let createDs: (entity: string) => DataSource;
  let logs: string[];
  let service: DatabaseService;
  let nowValue = 0;

  beforeEach(async () => {
    logs = [];
    nowValue = 0;
    adapter = new MemoryAdapter() as unknown as IDatabaseAdapter;
    await adapter.connect();
    createDs = (entity: string) => {
      const ma = adapter as MemoryAdapter;
      return {
        async findAll(query) {
          return ma.queryEntities(entity, query);
        },
        async findById(id) {
          return ma.findEntityById(entity, String(id));
        },
        async create(data) {
          return ma.insertEntity(entity, data);
        },
        async update(id, data) {
          return ma.updateEntity(entity, String(id), data);
        },
        async delete(id) {
          return ma.deleteEntity(entity, String(id));
        },
        async count(where) {
          return ma.countEntities(entity, where);
        },
      };
    };
    service = new DatabaseService(
      adapter,
      createDs,
      'memory',
      {},
      { debug: (msg: string) => logs.push(msg) },
      () => {
        nowValue += 10;
        return nowValue;
      },
    );
  });

  describe('getRepository', () => {
    it('returns a repository', () => {
      const repo = service.getRepository('User');
      expect(repo).toBeDefined();
    });

    it('throws when service is closed', async () => {
      await service.close();
      expect(() => service.getRepository('User')).toThrow();
    });
  });

  describe('isHealthy', () => {
    it('returns true when open', async () => {
      expect(await service.isHealthy()).toBe(true);
    });

    it('returns false after close', async () => {
      await service.close();
      expect(await service.isHealthy()).toBe(false);
    });
  });

  describe('close', () => {
    it('disconnects the adapter', async () => {
      await service.close();
      expect(adapter.isReady()).toBe(false);
    });

    it('does not throw when closing twice', async () => {
      await service.close();
      await service.close();
    });
  });

  describe('query', () => {
    it('rejects for memory adapter', async () => {
      await expect(service.query('SELECT 1')).rejects.toThrow();
    });
  });

  describe('migrate', () => {
    it('rejects for all adapters', async () => {
      await expect(service.migrate()).rejects.toThrow();
    });
  });

  describe('transaction', () => {
    it('commits on success', async () => {
      const result = await service.transaction(async (uow) => {
        const repo = uow.getRepository('User');
        await repo.create({ name: 'Alice' });
        return 'done';
      });
      expect(result).toBe('done');
    });

    it('rolls back on error', async () => {
      await expect(
        service.transaction(async (uow) => {
          const repo = uow.getRepository('User');
          await repo.create({ name: 'Alice' });
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    });

    it('throws when service is closed', async () => {
      await service.close();
      await expect(
        service.transaction(async () => 'no'),
      ).rejects.toThrow();
    });

    it('uses one Drizzle transaction for repositories and native access', async () => {
      const fakeDb = createFakeDrizzleInstance();
      const database = createDrizzleDatabase(
        fakeDb,
        (database, work) => database.transaction(work),
      );
      const drizzleAdapter = new DrizzleAdapter({
        drizzleInstance: database,
        drizzleTables: { User: createFakeDrizzleTable('user') },
      });
      await drizzleAdapter.connect();
      const drizzleService = new DatabaseService(
        drizzleAdapter,
        (entity) => drizzleAdapter.createDataSource(entity),
        'drizzle',
      );

      expect(getDrizzleDatabase(drizzleService, database)).toBe(fakeDb);
      await drizzleService.transaction(async (uow) => {
        expect(getDrizzleTransaction(uow, database)).toBe(fakeDb);
        await uow.getRepository('User').create({ id: 'u1', name: 'Ada' });
      });
      expect(await drizzleService.getRepository('User').findById('u1')).toEqual({
        id: 'u1',
        name: 'Ada',
      });
    });
  });

  describe('logging with logQueries', () => {
    it('logs entity + operation + duration when logQueries true', async () => {
      const loggingLogs: string[] = [];
      const loggingAdapter = new MemoryAdapter() as unknown as IDatabaseAdapter;
      await loggingAdapter.connect();
      const loggingCreateDs: (entity: string) => DataSource = (entity: string) => {
        const ma = loggingAdapter as MemoryAdapter;
        return {
          async findAll(query) {
            return ma.queryEntities(entity, query);
          },
          async findById(id) {
            return ma.findEntityById(entity, String(id));
          },
          async create(data) {
            return ma.insertEntity(entity, data);
          },
          async update(id, data) {
            return ma.updateEntity(entity, String(id), data);
          },
          async delete(id) {
            return ma.deleteEntity(entity, String(id));
          },
          async count(where) {
            return ma.countEntities(entity, where);
          },
        };
      };
      const loggingService = new DatabaseService(
        loggingAdapter,
        loggingCreateDs,
        'memory',
        { logQueries: true },
        { debug: (msg: string) => loggingLogs.push(msg) },
        () => 100,
      );

      const repo = loggingService.getRepository('User');
      await repo.create({ name: 'Alice' });
      await repo.findAll();
      expect(loggingLogs.length).toBeGreaterThanOrEqual(1);
      const logLine = loggingLogs.find((l) => l.includes('User') && l.includes('findAll'));
      expect(logLine).toBeDefined();
    });

    it('is silent when no logger provided', async () => {
      const silentAdapter = new MemoryAdapter() as unknown as IDatabaseAdapter;
      await silentAdapter.connect();
      const silentCreateDs: (entity: string) => DataSource = (entity: string) => {
        const ma = silentAdapter as MemoryAdapter;
        return {
          async findAll(query) {
            return ma.queryEntities(entity, query);
          },
          async findById(id) {
            return ma.findEntityById(entity, String(id));
          },
          async create(data) {
            return ma.insertEntity(entity, data);
          },
          async update(id, data) {
            return ma.updateEntity(entity, String(id), data);
          },
          async delete(id) {
            return ma.deleteEntity(entity, String(id));
          },
          async count(where) {
            return ma.countEntities(entity, where);
          },
        };
      };
      const silentService = new DatabaseService(
        silentAdapter,
        silentCreateDs,
        'memory',
        {},
      );

      const repo = silentService.getRepository('User');
      await repo.create({ name: 'Alice' });
      await repo.findAll();
    });
  });

  describe('now() injection', () => {
    it('uses injected now() for duration', async () => {
      const adapter2 = new MemoryAdapter() as unknown as IDatabaseAdapter;
      await adapter2.connect();
      const nowLogs: number[] = [];
      const createDs2: (entity: string) => DataSource = (entity: string) => {
        const ma = adapter2 as MemoryAdapter;
        return {
          async findAll(query) {
            return ma.queryEntities(entity, query);
          },
          async findById(id) {
            return ma.findEntityById(entity, String(id));
          },
          async create(data) {
            return ma.insertEntity(entity, data);
          },
          async update(id, data) {
            return ma.updateEntity(entity, String(id), data);
          },
          async delete(id) {
            return ma.deleteEntity(entity, String(id));
          },
          async count(where) {
            return ma.countEntities(entity, where);
          },
        };
      };
      const service2 = new DatabaseService(
        adapter2,
        createDs2,
        'memory',
        { logQueries: true },
        { debug: () => {} },
        () => {
          const t = Date.now();
          nowLogs.push(t);
          return t;
        },
      );

      const repo = service2.getRepository('User');
      await repo.create({ name: 'Alice' });
      expect(nowLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findPage forwarding through the logging wrapper', () => {
    /**
     * A data source whose members live on the PROTOTYPE — the shape a class
     * implementation of `IDataSource` has. The wrapper's `...ds` spread
     * carries only own enumerable members, so this member reaches the wrapped
     * source only through the wrapper's explicit forwarding.
     */
    class PrototypeDataSource {
      readonly #ma: MemoryAdapter;
      readonly #entity: string;

      constructor(ma: MemoryAdapter, entity: string) {
        this.#ma = ma;
        this.#entity = entity;
      }

      findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]> {
        return this.#ma.queryEntities(this.#entity, query);
      }

      findById(id: string | number): Promise<Record<string, unknown> | null> {
        return this.#ma.findEntityById(this.#entity, String(id));
      }

      create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>> {
        return this.#ma.insertEntity(this.#entity, data);
      }

      update(
        id: string | number,
        data: Partial<Record<string, unknown>>,
      ): Promise<Record<string, unknown>> {
        return this.#ma.updateEntity(this.#entity, String(id), data);
      }

      delete(id: string | number): Promise<boolean> {
        return this.#ma.deleteEntity(this.#entity, String(id));
      }

      count(where: Record<string, unknown>): Promise<number> {
        return this.#ma.countEntities(this.#entity, where);
      }

      /**
       * A minimal honest page over the store: evaluate the query as-is. The
       * cursor-walk CORRECTNESS is proven against the real adapters; this
       * member only needs to exist on the prototype so the forwarding (and
       * its logging) is observable through the wrapper.
       */
      async findPage(query: NormalizedQuery): Promise<PageResult> {
        const rows = await this.#ma.queryEntities(this.#entity, query);
        return { rows, nextCursor: null };
      }
    }

    it('forwards a prototype findPage — the wrapper does not lose the member', async () => {
      // A bare object spread drops prototype members, so before the explicit
      // forwarding this configuration made `BaseRepository.findPage` refuse by
      // name on an adapter that supports cursor pagination — exactly when
      // `logQueries` was on.
      const logs: string[] = [];
      const protoAdapter = new MemoryAdapter() as unknown as IDatabaseAdapter;
      await protoAdapter.connect();
      const protoService = new DatabaseService(
        protoAdapter,
        (entity) => new PrototypeDataSource(protoAdapter as MemoryAdapter, entity),
        'memory',
        { logQueries: true },
        { debug: (msg: string) => logs.push(msg) },
        () => 10,
      );

      const repo = protoService.getRepository<{ id: string; n: number }>('User');
      await repo.create({ id: 'u1', n: 1 });
      await repo.create({ id: 'u2', n: 2 });

      const page = await repo.findPage({ orderBy: { n: 'asc' }, limit: 5 });
      expect(page.rows.map((row) => row.id)).toEqual(['u1', 'u2']);
      expect(page.nextCursor).toBeNull();
      // The forwarded operation is logged like every other member.
      expect(logs).toContain('[User] findPage');
    });

    it('logs findPage for an own-member source too, through the same override', async () => {
      // The memory adapter's data source carries `findPage` as an own
      // property, so the spread alone forwards it — but only the explicit
      // override logs it. This is the one-capability-one-implementation rule:
      // both source shapes funnel through the single logged forward.
      const logs: string[] = [];
      const ownAdapter = new MemoryAdapter() as unknown as IDatabaseAdapter;
      await ownAdapter.connect();
      const ownService = new DatabaseService(
        ownAdapter,
        (entity) => (ownAdapter as MemoryAdapter).createDataSource(entity),
        'memory',
        { logQueries: true },
        { debug: (msg: string) => logs.push(msg) },
        () => 10,
      );

      const repo = ownService.getRepository<{ id: string; n: number }>('User');
      await repo.create({ id: 'u1', n: 1 });
      const page = await repo.findPage({ orderBy: { n: 'asc' }, limit: 5 });
      expect(page.rows.map((row) => row.id)).toEqual(['u1']);
      expect(logs).toContain('[User] findPage');
    });

    it('keeps absence as absence — a source without findPage still refuses by name', async () => {
      // §3.7: absence of the member means "this adapter cannot page by
      // cursor", never "there are no more rows". The wrapper must not
      // fabricate a `findPage` for a source that has none.
      const plainAdapter = new MemoryAdapter() as unknown as IDatabaseAdapter;
      await plainAdapter.connect();
      const plainService = new DatabaseService(
        plainAdapter,
        createDs,
        'memory',
        { logQueries: true },
        { debug: () => {} },
        () => 10,
      );

      const repo = plainService.getRepository<{ id: string; n: number }>('User');
      await repo.create({ id: 'u1', n: 1 });
      // Refusals reject — never a synchronous throw (§3.12).
      await expect(repo.findPage({ orderBy: { n: 'asc' } })).rejects.toThrow(
        UnsupportedQueryFeatureError,
      );
      await expect(repo.findPage({ orderBy: { n: 'asc' } })).rejects.toThrow(
        'no findPage member',
      );
    });
  });
});
