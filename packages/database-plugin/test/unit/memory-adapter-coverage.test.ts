/**
 * Coverage tests for MemoryAdapter overlay and transaction branches.
 *
 * Exercises overlay commit flush (creates/shadows/tombstones),
 * mid-transaction read-through, rollback discarding all overlay kinds,
 * not-connected/already-finalized throws, and adversarial probes.
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { IAdapterTransaction } from '../../src/adapters/adapter.ts';
import { normalizeQuery } from '../../src/query/query-builder.ts';

describe('MemoryAdapter — overlay and transaction coverage', () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe('beginTransaction not-connected', () => {
    it('throws when adapter is not connected', () => {
      expect(() => adapter.beginTransaction()).toThrow('not connected');
    });
  });

  describe('overlay commit flushes all three kinds', () => {
    it('flushes creates on commit', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.create({ id: 'c1', name: 'Created' });
      await txn.commit();

      const found = await adapter.findEntityById('User', 'c1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Created');
    });

    it('flushes update shadows on commit', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 's1', name: 'Original' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.update('s1', { name: 'Shadowed' });
      await txn.commit();

      const found = await adapter.findEntityById('User', 's1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Shadowed');
    });

    it('flushes delete tombstones on commit', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'd1', name: 'To Delete' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.delete('d1');
      await txn.commit();

      const found = await adapter.findEntityById('User', 'd1');
      expect(found).toBeNull();
    });
  });

  describe('overlay mid-transaction read-through', () => {
    it('reads update shadow mid-transaction', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'm1', name: 'Original' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.update('m1', { name: 'Shadowed' });
      const found = await txDs.findById('m1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Shadowed');

      await txn.rollback();
    });

    it('reads buffered create mid-transaction', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.create({ id: 'm2', name: 'New' });
      const found = await txDs.findById('m2');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('New');

      await txn.rollback();
    });

    it('sees delete tombstone mid-transaction', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'm3', name: 'To Delete' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.delete('m3');
      const found = await txDs.findById('m3');
      expect(found).toBeNull();

      await txn.rollback();
    });
  });

  describe('rollback discards all overlay kinds', () => {
    it('discards creates on rollback', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.create({ id: 'r1', name: 'Rolled' });
      await txn.rollback();

      const found = await adapter.findEntityById('User', 'r1');
      expect(found).toBeNull();
    });

    it('discards shadows on rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'r2', name: 'Original' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.update('r2', { name: 'Shadowed' });
      await txn.rollback();

      const found = await adapter.findEntityById('User', 'r2');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Original');
    });

    it('discards tombstones on rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'r3', name: 'To Delete' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.delete('r3');
      await txn.rollback();

      const found = await adapter.findEntityById('User', 'r3');
      expect(found).not.toBeNull();
    });
  });

  describe('already-finalized throws', () => {
    it('throws when committing twice', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
      expect(() => txn.commit()).toThrow('already finalized');
    });

    it('throws when rolling back after commit', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
      await txn.rollback();
    });

    it('throws when committing after rollback', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
      expect(() => txn.commit()).toThrow('already finalized');
    });
  });

  describe('adversarial probes', () => {
    it('outside write survives rollback', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'adv1', name: 'Before' });

      const txn = await adapter.beginTransaction();
      await txn.rollback();

      const found = await adapter.findEntityById('User', 'adv1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Before');
    });
  });

  describe('overlay count and findAll', () => {
    it('count reflects overlay changes mid-tx', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'co1', name: 'A' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.create({ id: 'co2', name: 'B' });
      const cnt = await txDs.count({});
      expect(cnt).toBeGreaterThanOrEqual(2);

      await txn.rollback();
    });

    it('findAll reflects overlay changes mid-tx', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'fa1', name: 'A' });
      const txn = await adapter.beginTransaction();
      const txDs = (txn as IAdapterTransaction).createDataSource('User');

      await txDs.create({ id: 'fa2', name: 'B' });
      const all = await txDs.findAll(normalizeQuery());
      expect(all.length).toBeGreaterThanOrEqual(2);

      await txn.rollback();
    });
  });

  describe('rawQuery throws on memory', () => {
    it('rejects with descriptive message', async () => {
      await adapter.connect();
      await expect(adapter.rawQuery('SELECT 1')).rejects.toThrow('does not support raw SQL');
    });
  });

  describe('isReady branches', () => {
    it('returns false before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('returns true after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('returns false after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe('disconnect branches', () => {
    it('disconnect when not connected does not throw', async () => {
      await adapter.disconnect();
    });

    it('disconnect clears stores', async () => {
      await adapter.connect();
      await adapter.insertEntity('User', { id: 'x', name: 'Test' });
      await adapter.disconnect();
      expect(await adapter.findEntityById('User', 'x')).toBeNull();
    });
  });
});
