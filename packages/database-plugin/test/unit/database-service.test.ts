// deno-lint-ignore-file require-await -- test fixtures must be async to satisfy interfaces
/**
 * Unit tests for DatabaseService.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DatabaseService } from '../../src/services/database-service.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';

describe('DatabaseService', () => {
  let adapter: MemoryAdapter;
  let service: DatabaseService;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.connect();
    service = new DatabaseService(adapter);
  });

  afterEach(async () => {
    await service.close();
  });

  describe('getRepository', () => {
    it('returns a repository', () => {
      const repo = service.getRepository('User');
      expect(repo).toBeDefined();
    });

    it('throws when service is closed', () => {
      service.close();
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
    it('returns empty array for memory adapter', async () => {
      const results = await service.query('SELECT * FROM users');
      expect(results).toEqual([]);
    });
  });

  describe('migrate', () => {
    it('does not throw for memory adapter', async () => {
      await service.migrate();
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
});
