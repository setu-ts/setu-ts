/**
 * Unit tests for MemoryAdapter.
 *
 * Tests cover:
 * - connect/disconnect lifecycle
 * - CRUD operations (insert, find, update, delete, query, count)
 * - per-transaction overlay isolation (creates, update shadows, delete tombstones)
 * - commit applies overlay; rollback discards
 * - update-in-tx isolation — uncommitted update invisible outside
 * - delete-in-tx isolation — uncommitted delete invisible outside
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IAdapterTransaction } from '../../src/adapters/adapter.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

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
    it('creates a store lazily', async () => {
      await adapter.connect();
      const store = adapter.getStore('User');
      expect(store.records).toBeDefined();
    });

    it('returns the same store for the same entity', async () => {
      await adapter.connect();
      const a = adapter.getStore('User');
      const b = adapter.getStore('User');
      expect(a).toBe(b);
    });
  });

  describe('insertEntity', () => {
    it('inserts and returns the entity', async () => {
      await adapter.connect();
      const entity = await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      expect(entity.name).toBe('Alice');
    });

    it('generates an id when absent', async () => {
      await adapter.connect();
      const entity = await adapter.insertEntity('User', { name: 'Alice' });
      expect(entity.id).toBeDefined();
    });
  });

  describe('findEntityById', () => {
    it('returns the entity when found', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const found = await adapter.findEntityById('User', '1');
      expect(found?.name).toBe('Alice');
    });

    it('returns null when not found', async () => {
      await adapter.connect();
      const found = await adapter.findEntityById('User', '999');
      expect(found).toBeNull();
    });
  });

  describe('updateEntity', () => {
    it('updates and returns the entity', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Bob' });
      expect(updated.name).toBe('Bob');
    });

    it('preserves unchanged fields', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice', email: 'a@b.c' });
      const updated = await adapter.updateEntity('User', '1', { name: 'Bob' });
      expect(updated.email).toBe('a@b.c');
    });

    it('throws when entity not found', async () => {
      await adapter.connect();
      await expect(adapter.updateEntity('User', '999', { name: 'X' })).rejects.toThrow();
    });
  });

  describe('deleteEntity', () => {
    it('returns true when deleted', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const result = await adapter.deleteEntity('User', '1');
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      await adapter.connect();
      const result = await adapter.deleteEntity('User', '999');
      expect(result).toBe(false);
    });
  });

  describe('queryEntities', () => {
    it('returns all entities when no filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob' });
      const results = await adapter.queryEntities('User', {
        where: {},
        orderBy: {},
        limit: -1,
        offset: 0,
        select: [],
      });
      expect(results.length).toBe(2);
    });
  });

  describe('countEntities', () => {
    it('returns total count when no filter', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.insertEntity('User', { id: '2', name: 'Bob' });
      const count = await adapter.countEntities('User', {});
      expect(count).toBe(2);
    });
  });

  describe('beginTransaction — overlay isolation', () => {
    it('commits successfully', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
    });

    it('rollbacks successfully', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
    });

    it('create in tx visible inside tx', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      const created = await ds.create({ id: 'tx-1', name: 'TxUser' });
      const found = await ds.findById(created.id as string);
      expect(found?.name).toBe('TxUser');
      await txn.commit();
    });

    it('update shadow in tx invisible after rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      await ds.update('1', { name: 'Updated' });
      // Inside tx — updated
      const inside = await ds.findById('1');
      expect(inside?.name).toBe('Updated');
      // Rollback
      await txn.rollback();
      // Outside — original
      const outside = await adapter.findEntityById('User', '1');
      expect(outside?.name).toBe('Alice');
    });

    it('delete tombstone in tx invisible after rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      await ds.delete('1');
      // Inside tx — gone
      const inside = await ds.findById('1');
      expect(inside).toBeNull();
      // Rollback
      await txn.rollback();
      // Outside — still there
      const outside = await adapter.findEntityById('User', '1');
      expect(outside?.name).toBe('Alice');
    });

    it('commit applies overlay to committed store', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      await ds.update('1', { name: 'Committed' });
      await txn.commit();
      // After commit — persisted
      const outside = await adapter.findEntityById('User', '1');
      expect(outside?.name).toBe('Committed');
    });
  });

  describe('disconnect clears stores', () => {
    it('clears all data after disconnect', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: '1', name: 'Alice' });
      await adapter.disconnect();
      const found = await adapter.findEntityById('User', '1');
      expect(found).toBeNull();
    });
  });
});
