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

  describe('getOrSet', () => {
    it('coalesces concurrent cache misses into one factory call and stores the result', async () => {
      const { backend, calls } = createFakeBackend();
      const svc = new CacheService(backend, 'app:', 300);
      let callsToFactory = 0;
      let release: (() => void) | undefined;
      const pending = new Promise<string>((resolve) => {
        release = (): void => resolve('loaded');
      });
      const factory = async (): Promise<string> => {
        callsToFactory++;
        return await pending;
      };

      const first = svc.getOrSet('key', factory);
      const second = svc.getOrSet('key', factory);
      await Promise.resolve();
      await Promise.resolve();
      expect(callsToFactory).toBe(1);

      release?.();
      await expect(first).resolves.toBe('loaded');
      await expect(second).resolves.toBe('loaded');
      expect(calls.filter((call) => call.method === 'set')).toHaveLength(1);
      expect(calls.at(-1)?.args).toEqual(['app:key', 'loaded', 300]);
    });

    it('uses the cached value without calling the factory', async () => {
      const { backend } = createFakeBackend();
      backend.get = async <T>(): Promise<T | null> => 'cached' as T;
      const svc = new CacheService(backend, '');
      let callsToFactory = 0;

      await expect(svc.getOrSet('key', async (): Promise<string> => {
        callsToFactory++;
        return 'loaded';
      })).resolves.toBe('cached');
      expect(callsToFactory).toBe(0);
    });

    it('clears a rejected load so a later caller can retry', async () => {
      const { backend } = createFakeBackend();
      const svc = new CacheService(backend, '');
      let callsToFactory = 0;

      await expect(svc.getOrSet('key', async (): Promise<string> => {
        callsToFactory++;
        throw new Error('origin unavailable');
      })).rejects.toThrow('origin unavailable');

      await expect(svc.getOrSet('key', async (): Promise<string> => {
        callsToFactory++;
        return 'recovered';
      })).resolves.toBe('recovered');
      expect(callsToFactory).toBe(2);
    });

    it('coalesces services that share a backend and a fully-prefixed key', async () => {
      const { backend } = createFakeBackend();
      const first = new CacheService(backend, 'app:');
      const second = new CacheService(backend, 'app:');
      let callsToFactory = 0;
      let release: (() => void) | undefined;
      const pending = new Promise<string>((resolve) => {
        release = (): void => resolve('loaded');
      });

      const one = first.getOrSet('key', async () => {
        callsToFactory++;
        return await pending;
      });
      const two = second.getOrSet('key', async () => {
        callsToFactory++;
        return await pending;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(callsToFactory).toBe(1);
      release?.();
      await expect(Promise.all([one, two])).resolves.toEqual(['loaded', 'loaded']);
    });
  });
});
