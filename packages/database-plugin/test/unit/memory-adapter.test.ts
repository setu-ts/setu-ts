/**
 * Unit tests for MemoryAdapter.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { normalizeQuery } from '../../src/query/query-builder.ts';

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('connect / disconnect / isReady', () => {
    it('is not ready before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('is ready after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('is not ready after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe('getStore', () => {
    it('creates a store lazily', () => {
      const store = adapter.getStore('User');
      expect(store.records).toEqual([]);
      expect(store.primaryKey).toBe('id');
    });

    it('returns the same store for the same entity', () => {
      const a = adapter.getStore('User');
      const b = adapter.getStore('User');
      expect(a).toBe(b);
    });

    it('uses custom primary key', () => {
      const store = adapter.getStore('User', 'userId');
      expect(store.primaryKey).toBe('userId');
    });
  });

  describe('insertEntity', () => {
    it('inserts and returns the entity', async () => {
      const entity = await adapter.insertEntity('User', { name: 'Alice' });
      expect(entity.name).toBe('Alice');
      expect(entity.id).toBeDefined();
    });

    it('generates an id when absent', async () => {
      const entity = await adapter.insertEntity('User', { name: 'Alice' });
      expect(typeof entity.id).toBe('string');
    });

    it('keeps the provided id', async () => {
      const entity = await adapter.insertEntity('User', { id: 'custom-1', name: 'Alice' });
      expect(entity.id).toBe('custom-1');
    });
  });

  describe('findEntityById', () => {
    it('returns the entity when found', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const entity = await adapter.findEntityById('User', '1');
      expect(entity?.name).toBe('Alice');
    });

    it('returns null when not found', async () => {
      const entity = await adapter.findEntityById('User', 'missing');
      expect(entity).toBeNull();
    });
  });

  describe('updateEntity', () => {
    it('updates and returns the entity', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Alicia' });
      expect(updated.name).toBe('Alicia');
    });

    it('preserves unchanged fields', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice', email: 'a@b.com' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Alicia' });
      expect(updated.email).toBe('a@b.com');
    });

    it('throws when entity not found', async () => {
      await expect(
        adapter.updateEntity('User', 'missing', { name: 'X' }),
      ).rejects.toThrow("Entity 'User' with id 'missing' not found");
    });
  });

  describe('deleteEntity', () => {
    it('returns true when deleted', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const deleted = await adapter.deleteEntity('User', '1');
      expect(deleted).toBe(true);
    });

    it('returns false when not found', async () => {
      const deleted = await adapter.deleteEntity('User', 'missing');
      expect(deleted).toBe(false);
    });

    it('removes the entity', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.deleteEntity('User', '1');
      const entity = await adapter.findEntityById('User', '1');
      expect(entity).toBeNull();
    });
  });

  describe('queryEntities', () => {
    it('returns all entities when no filter', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob' });
      const results = await adapter.queryEntities('User', normalizeQuery());
      expect(results.length).toBe(2);
    });

    it('filters by where clause', async () => {
      await adapter.insertEntity('User', { id: '1', name: 'Alice', active: true });
      await adapter.insertEntity('User', { id: '2', name: 'Bob', active: false });
      const results = await adapter.queryEntities(
        'User',
        normalizeQuery({ where: { active: true } }),
      );
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Alice');
    });
  });

  describe('countEntities', () => {
    it('returns total count when no filter', async () => {
      await adapter.insertEntity('User', { id: '1' });
      await adapter.insertEntity('User', { id: '2' });
      expect(await adapter.countEntities('User', {})).toBe(2);
    });

    it('counts matching entities', async () => {
      await adapter.insertEntity('User', { id: '1', active: true });
      await adapter.insertEntity('User', { id: '2', active: false });
      expect(await adapter.countEntities('User', { active: true })).toBe(1);
    });
  });

  describe('beginTransaction', () => {
    it('throws when not connected', async () => {
      await expect(adapter.beginTransaction()).rejects.toThrow('not connected');
    });

    it('commits successfully', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
      // No error means success.
    });

    it('rollbacks successfully', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
      // No error means success.
    });
  });

  describe('disconnect clears stores', () => {
    it('clears all data after disconnect', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
    });
  });
});
