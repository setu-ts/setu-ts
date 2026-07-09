/**
 * Unit tests for DrizzleAdapter using a fake Drizzle instance.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createFakeDrizzleInstance } from '../fixtures/fake-drizzle-instance.ts';

describe('DrizzleAdapter', () => {
  let fakeDb: ReturnType<typeof createFakeDrizzleInstance>;
  let adapter: DrizzleAdapter;

  beforeEach(() => {
    fakeDb = createFakeDrizzleInstance();
    adapter = new DrizzleAdapter({ drizzleInstance: fakeDb });
  });

  describe('connect / disconnect / isReady', () => {
    it('is not ready before connect', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('is ready after connect', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
      expect(fakeDb.connected).toBe(true);
    });

    it('is not ready after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      expect(adapter.isReady()).toBe(false);
      expect(fakeDb.ended).toBe(true);
    });
  });

  describe('injected-instance structural validation', () => {
    it('accepts injected drizzleInstance with required shape', async () => {
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('rejects missing drizzleInstance with import error', async () => {
      const noInstanceAdapter = new DrizzleAdapter({ url: 'postgresql://localhost/test' });
      await expect(noInstanceAdapter.connect()).rejects.toThrow('Failed to load Drizzle');
    });
  });

  describe('beginTransaction', () => {
    it('throws when not connected', async () => {
      await expect(adapter.beginTransaction()).rejects.toThrow('not connected');
    });

    it('returns transaction handle when connected', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      expect(txn).toBeDefined();
      expect(typeof txn.commit).toBe('function');
      expect(typeof txn.rollback).toBe('function');
    });

    it('commit resolves', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.commit();
      // No error means success.
    });

    it('rollback resolves', async () => {
      await adapter.connect();
      const txn = await adapter.beginTransaction();
      await txn.rollback();
      // No error means success.
    });
  });

  describe('constructor options', () => {
    it('accepts no options', async () => {
      const noInstanceAdapter = new DrizzleAdapter();
      // Without injected instance, connect() fails loudly (import error).
      await expect(noInstanceAdapter.connect()).rejects.toThrow('Failed to load Drizzle');
    });
  });
});
