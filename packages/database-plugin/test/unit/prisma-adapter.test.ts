/**
 * Unit tests for PrismaAdapter using a fake Prisma client.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { PrismaAdapter } from '../../src/adapters/prisma/prisma-adapter.ts';
import { createFakePrismaClient } from '../fixtures/fake-prisma-client.ts';

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

  describe('injected-client validation', () => {
    it('accepts injected prismaClient with required methods', async () => {
      // Should not throw when structural shape matches.
      await adapter.connect();
      expect(adapter.isReady()).toBe(true);
    });

    it('rejects missing prismaClient with import error', async () => {
      const noClientAdapter = new PrismaAdapter({ url: 'postgresql://localhost/test' });
      await expect(noClientAdapter.connect()).rejects.toThrow('Failed to load Prisma');
    });

    it('uses the fake client (not unused)', async () => {
      // Prove fakeClient is wired through: after connect, the fake should be connected.
      await adapter.connect();
      expect(fakeClient.connected).toBe(true);
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

  describe('query logging', () => {
    it('enables middleware when logQueries is true', async () => {
      const logs: string[] = [];
      const fakeLogger: import('@hono-enterprise/common').ILogger = {
        debug: (msg: string) => logs.push(msg),
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        trace: () => {},
        level: 'debug',
        child: (): import('@hono-enterprise/common').ILogger => fakeLogger,
      };
      const loggingAdapter = new PrismaAdapter(
        { prismaClient: fakeClient, logQueries: true },
        fakeLogger,
      );
      await loggingAdapter.connect();
      expect(fakeClient.middlewares.length).toBeGreaterThanOrEqual(1);
    });

    it('does not enable middleware when logQueries is false', async () => {
      const adapterNoLog = new PrismaAdapter({ prismaClient: fakeClient });
      await adapterNoLog.connect();
      expect(fakeClient.middlewares.length).toBe(0);
    });
  });

  describe('constructor options', () => {
    it('accepts no options', async () => {
      const noClientAdapter = new PrismaAdapter();
      // Without injected client, connect() fails loudly (import error).
      await expect(noClientAdapter.connect()).rejects.toThrow('Failed to load Prisma');
    });
  });

  describe('enableQueryLogging', () => {
    it('returns early when logger is absent', async () => {
      const noLoggerAdapter = new PrismaAdapter(
        { prismaClient: fakeClient, logQueries: true },
        // No logger provided
      );
      await noLoggerAdapter.connect();
      // No middleware registered because logger was absent.
      expect(fakeClient.middlewares.length).toBe(0);
    });

    it('executes middleware callback when query runs', async () => {
      const logs: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
      const fakeLogger: import('@hono-enterprise/common').ILogger = {
        debug: (msg: string, meta?: Record<string, unknown>) => {
          logs.push({ msg, meta });
        },
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        trace: () => {},
        level: 'debug',
        child: (): import('@hono-enterprise/common').ILogger => fakeLogger,
      };
      const loggingAdapter = new PrismaAdapter(
        { prismaClient: fakeClient, logQueries: true },
        fakeLogger,
      );
      await loggingAdapter.connect();
      // Middleware is registered but hasn't executed yet — trigger it manually.
      if (fakeClient.middlewares.length > 0) {
        await fakeClient.middlewares[0].query(
          { model: 'Post', action: 'findFirst', args: {} },
          () => Promise.resolve({ id: 1, title: 'test' }),
        );
        expect(logs.length).toBeGreaterThanOrEqual(1);
        expect(logs[0].msg).toContain('Post');
        expect(logs[0].meta?.model).toBe('Post');
      }
    });
  });
});
