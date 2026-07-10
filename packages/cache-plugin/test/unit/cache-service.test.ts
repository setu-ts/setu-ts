// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CacheService } from '../../src/services/cache-service.ts';
import type { CacheStore } from '../../src/stores/cache-store.ts';

describe('CacheService', () => {
  function createFakeBackend(): {
    backend: CacheStore;
    calls: Array<{ method: string; args: unknown[] }>;
  } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const backend: CacheStore = {
      connect: async () => {
        calls.push({ method: 'connect', args: [] });
      },
      disconnect: async () => {
        calls.push({ method: 'disconnect', args: [] });
      },
      isReady: () => true,
      get: async (key: string) => {
        calls.push({ method: 'get', args: [key] });
        return null;
      },
      set: async (key: string, value: unknown, ttl?: number) => {
        calls.push({ method: 'set', args: [key, value, ttl] });
      },
      delete: async (key: string) => {
        calls.push({ method: 'delete', args: [key] });
        return true;
      },
      has: async (key: string) => {
        calls.push({ method: 'has', args: [key] });
        return false;
      },
      clear: async () => {
        calls.push({ method: 'clear', args: [] });
      },
    };
    return { backend, calls };
  }

  describe('key prefixing', () => {
    it('prepends prefix on get', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, 'app:');
      await svc.get<string>('user:1');
      expect(calls.at(-1)?.args[0]).toBe('app:user:1');
    });

    it('prepends prefix on set', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, 'app:');
      await svc.set('user:1', { name: 'A' });
      expect(calls.at(-1)?.args[0]).toBe('app:user:1');
    });

    it('prepends prefix on delete', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, 'app:');
      await svc.delete('user:1');
      expect(calls.at(-1)?.args[0]).toBe('app:user:1');
    });

    it('prepends prefix on has', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, 'app:');
      await svc.has('user:1');
      expect(calls.at(-1)?.args[0]).toBe('app:user:1');
    });

    it('does NOT prepend prefix on clear (delegates directly)', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, 'app:');
      await svc.clear();
      const clearCall = calls.at(-1);
      expect(clearCall?.method).toBe('clear');
      expect(clearCall?.args.length).toBe(0);
    });
  });

  describe('default TTL', () => {
    it('uses configured defaultTtl when set omits ttl', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, '', 300);
      await svc.set('k', 'v');
      expect(calls.at(-1)?.args[2]).toBe(300);
    });

    it('uses explicit ttlSeconds when provided', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, '', 300);
      await svc.set('k', 'v', 60);
      expect(calls.at(-1)?.args[2]).toBe(60);
    });

    it('passes undefined when no default and no explicit ttl', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, '');
      await svc.set('k', 'v');
      expect(calls.at(-1)?.args[2]).toBeUndefined();
    });
  });

  describe('empty prefix', () => {
    it('passes bare key when prefix is empty', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, '');
      await svc.get('bare-key');
      expect(calls.at(-1)?.args[0]).toBe('bare-key');
    });
  });
});
