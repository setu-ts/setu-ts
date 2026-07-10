// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { RedisStore, validateClient } from '../../src/stores/redis-store.ts';
import type { IRedisClient } from '../../src/interfaces/index.ts';
import { createFakeIoredis } from '../fixtures/fake-ioredis-client.ts';

describe('RedisStore', () => {
  describe('validateClient', () => {
    it('returns true for a structurally valid client', () => {
      const { client } = createFakeIoredis();
      expect(validateClient(client)).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateClient(null)).toBe(false);
    });

    it('returns false for plain object missing methods', () => {
      expect(validateClient({})).toBe(false);
    });

    it('returns false when a required method is missing', () => {
      const partial: Partial<IRedisClient> = {
        get: async () => null,
        set: async () => null,
        del: async () => 0,
        exists: async () => 0,
        scan: async () => ['0', []],
      };
      expect(validateClient(partial)).toBe(false); // missing quit
    });
  });

  describe('with injected fake client', () => {
    it('resolves injected client (options.client)', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('m11:', { client });
      await store.connect();
      expect(store.isReady()).toBe(true);
    });

    it('rejects invalid injected client at connect time', async () => {
      const store = new RedisStore('', {
        client: { invalid: true } as unknown as IRedisClient,
      });
      await expect(store.connect()).rejects.toThrow();
    });

    it('get returns null when key missing', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      expect(await store.get<string>('missing')).toBeNull();
    });

    it('set/get round-trip serializes via JSON', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      await store.set('k', { a: 1 });
      const result = await store.get('k');
      expect(result).toEqual({ a: 1 });
    });

    it('SET emits EX only when ttl > 0', async () => {
      const { client, calls } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      await store.set('ttl-k', 'val', 30);
      const ttlCall = calls.find((c) => c.method === 'set' && c.args[2] === 'EX');
      expect(ttlCall).toBeDefined();
      expect(ttlCall?.args[3]).toBe(30);
    });

    it('SET omits EX when ttlSeconds is 0 or undefined', async () => {
      const { client, calls } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      await store.set('no-ttl', 'val');
      const setCall = calls.find((c) => c.method === 'set');
      expect(setCall?.args[2]).toBeUndefined();
    });

    it('delete returns true when key removed', async () => {
      const { client } = createFakeIoredis({
        initialData: { k: 'v' },
      });
      const store = new RedisStore('', { client });
      await store.connect();
      expect(await store.delete('k')).toBe(true);
    });

    it('delete returns false when key absent', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      expect(await store.delete('missing')).toBe(false);
    });

    it('has returns true when key exists', async () => {
      const { client } = createFakeIoredis({
        initialData: { k: 'v' },
      });
      const store = new RedisStore('', { client });
      await store.connect();
      expect(await store.has('k')).toBe(true);
    });

    it('has returns false when key absent', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      expect(await store.has('missing')).toBe(false);
    });

    it('clear() uses SCAN+DEL with prefix pattern', async () => {
      const { client, calls } = createFakeIoredis({
        initialData: { 'm11:foo': 1, 'm11:bar': 2, 'other:baz': 3 },
      });
      const store = new RedisStore('m11:', { client });
      await store.connect();
      await store.clear();
      const scanCall = calls.find((c) => c.method === 'scan');
      expect(scanCall?.args[2]).toBe('m11:*');
      const delCall = calls.find((c) => c.method === 'del');
      // Only m11: keys deleted, not other:baz
      expect(delCall?.args).toContain('m11:foo');
      expect(delCall?.args).toContain('m11:bar');
      expect(delCall?.args).not.toContain('other:baz');
    });

    it('clear() with empty prefix scans *', async () => {
      const { client, calls } = createFakeIoredis({
        initialData: { a: 1, b: 2 },
      });
      const store = new RedisStore('', { client });
      await store.connect();
      await store.clear();
      const scanCall = calls.find((c) => c.method === 'scan');
      expect(scanCall?.args[2]).toBe('*');
    });

    it('disconnect calls quit', async () => {
      const { client, calls } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await store.connect();
      await store.disconnect();
      expect(store.isReady()).toBe(false);
      expect(calls.some((c) => c.method === 'quit')).toBe(true);
    });

    it('operations return safe defaults when not connected', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      // Do NOT call connect
      expect(await store.get<string>('k')).toBeNull();
      expect(await store.delete('k')).toBe(false);
      expect(await store.has('k')).toBe(false);
    });

    it('set throws when not connected', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await expect(store.set('k', 'v')).rejects.toThrow('not connected');
    });

    it('clear returns silently when not connected', async () => {
      const { client } = createFakeIoredis();
      const store = new RedisStore('', { client });
      await expect(store.clear()).resolves.toBeUndefined();
    });
  });

  describe('REAL ioredis import (guarded)', () => {
    // This test only runs when ioredis is actually available on the system.
    // Skip gracefully when the import fails.
    it('can lazy-import ioredis when available', async () => {
      let RedisCtor: unknown;
      try {
        const mod = await import('npm:ioredis@5.x');
        RedisCtor = mod.Redis;
      } catch {
        // ioredis not available — skip this test
        return;
      }
      expect(RedisCtor).toBeDefined();
      expect(typeof RedisCtor).toBe('function');
    });
  });
});
