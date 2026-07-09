// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy interfaces
/**
 * Unit tests for DatabaseService.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMemoryDataSource, DatabaseService } from '../../src/services/database-service.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';

describe('DatabaseService', () => {
  let adapter: MemoryAdapter;
  let service: DatabaseService;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.connect();
    service = new DatabaseService(
      adapter,
      (entity: string) => createMemoryDataSource(adapter, entity),
      'memory',
    );
  });

  afterEach(async () => {
    await service.close();
  });

  describe('getRepository', () => {
    it('returns a repository', () => {
      const repo = service.getRepository('User');
      expect(repo).toBeDefined();
    });

    it('throws when service is closed', async () => {
      await service.close();
      expect(() => service.getRepository('User')).toThrow('closed');
    });
  });

  describe('isHealthy', () => {
    it('returns true when adapter is ready', async () => {
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
      await expect(service.query('SELECT * FROM users')).rejects.toThrow(
        'The memory adapter does not support raw SQL queries.',
      );
    });

    it('logs query when logQueries is true', async () => {
      const logs: string[] = [];
      const logService = new DatabaseService(
        adapter,
        (entity: string) => createMemoryDataSource(adapter, entity),
        'memory',
        { logQueries: true },
        { debug: (msg: string) => logs.push(msg) },
      );
      try {
        await logService.query('SELECT 1');
      } catch {
        // Expected to throw
      }
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('migrate', () => {
    it('throws for memory adapter', async () => {
      await expect(service.migrate()).rejects.toThrow(
        'The memory adapter does not support migrations.',
      );
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
        service.transaction(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
    });

    it('throws when service is closed', async () => {
      await service.close();
      await expect(
        service.transaction(async () => 'x'),
      ).rejects.toThrow('closed');
    });
  });

  describe('repository operations via MemoryRepository', () => {
    it('findAll returns entities', async () => {
      const repo = service.getRepository<{ id: string; name: string }>('Item');
      await repo.create({ name: 'a' });
      await repo.create({ name: 'b' });
      const items = await repo.findAll();
      expect(items.length).toBe(2);
    });

    it('update returns updated entity', async () => {
      const repo = service.getRepository<{ id: string; name: string }>('Item');
      const created = await repo.create({ name: 'orig' });
      const updated = await repo.update(created.id, { name: 'changed' });
      expect(updated.name).toBe('changed');
    });

    it('delete removes entity', async () => {
      const repo = service.getRepository<{ id: string; name: string }>('Item');
      const created = await repo.create({ name: 'x' });
      const deleted = await repo.delete(created.id);
      expect(deleted).toBe(true);
    });

    it('count returns number of entities', async () => {
      const repo = service.getRepository<{ id: string; name: string }>('Item');
      await repo.create({ name: 'a' });
      await repo.create({ name: 'b' });
      const count = await repo.count();
      expect(count).toBe(2);
    });
  });
});
