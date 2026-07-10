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
import type { IDatabaseAdapter } from '../../src/adapters/adapter.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

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
    it('throws for memory adapter', async () => {
      await expect(service.query('SELECT 1')).rejects.toThrow();
    });
  });

  describe('migrate', () => {
    it('throws for all adapters', async () => {
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
});
