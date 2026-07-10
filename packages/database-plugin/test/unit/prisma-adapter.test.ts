/**
 * Unit tests for PrismaAdapter using a fake Prisma client.
 *
 * Tests cover:
 * - connect/disconnect lifecycle
 * - injected-client structural validation
 * - two-deferred transaction bridge (commit + rollback)
 * - $queryRawUnsafe delegation
 * - rawQuery delegation
 * - no $use / enableQueryLogging (deleted from real Prisma v7)
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';
import type { IAdapterTransaction } from '../../src/adapters/adapter.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

describe('PrismaAdapter', () => {
  let fakeClient: ReturnType<typeof createFakePrismaClient>;
  let adapter: PrismaAdapter;

  beforeEach(() => {
    fakeClient = createFakePrismaClient();
    adapter = new PrismaAdapter({ prismaClient: fakeClient });
  });

  describe('connect / disconnect / isReady', () => {
    it('is not ready before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('is ready after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
      expect(fakeClient.connected).toBe(true);
    });

    it('is not ready after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
      expect(fakeClient.disconnected).toBe(true);
    });
  });

  describe('injected-client structural validation', () => {
    it('accepts injected prismaClient with required methods', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('rejects missing prismaClient with import error', async () => {
      const noClientAdapter = new PrismaAdapter({ url: 'postgresql://localhost/test' });
      await expect(noClientAdapter.connect()).rejects.toThrow('Failed to load Prisma');
    });

    it('uses the fake client (not unused)', async () => {
      await adapter.connect();
      expect(fakeClient.connected).toBe(true);
    });
  });

  describe('beginTransaction — two-deferred bridge', () => {
    it('throws when not connected', async () => {
      await expect(adapter.beginTransaction()).rejects.toThrow('not connected');
    });

    it('returns transaction handle when connected', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      expect(txn).toBeDefined();
      expect(typeof txn.commit).toBe('function');
      expect(typeof txn.rollback).toBe('function');
      // IAdapterTransaction has createDataSource
      const adapterTxn = txn as IAdapterTransaction;
      expect(typeof adapterTxn.createDataSource).toBe('function');
    });

    it('commit resolves', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
    });

    it('rollback resolves', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
    });

    it('createDataSource returns a DataSource', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      const adapterTxn = txn as IAdapterTransaction;
      const ds: DataSource = adapterTxn.createDataSource('User');
      expect(ds).toBeDefined();
      await txn.commit();
    });
  });

  describe('rawQuery delegates $queryRawUnsafe', () => {
    it('calls $queryRawUnsafe with sql and params', async () => {
      await adapter.connect();
      await adapter.rawQuery('SELECT 1', []);
      const call = fakeClient.recordedCalls.find(
        (c) => c.action === 'execute' && c.args.sql === 'SELECT 1',
      );
      expect(call).toBeDefined();
    });
  });
});
