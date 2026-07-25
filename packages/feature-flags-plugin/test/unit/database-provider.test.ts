/**
 * Tests for `DatabaseProvider` — polled flag store with failure tracking.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DatabaseProvider } from '../../src/providers/database-provider.ts';
import type { FlagDefinition, IFlagStore } from '../../src/interfaces/index.ts';

describe('DatabaseProvider', () => {
  describe('type', () => {
    it('is "database"', async () => {
      const store: IFlagStore = {
        loadFlags: async () => ({}),
      };
      const provider = new DatabaseProvider({ store }, null as never);
      await provider.start();
      expect(provider.type).toBe('database');
      await provider.stop();
    });
  });

  describe('start / initial load', () => {
    it('loads initial snapshot via store.loadFlags()', async () => {
      const flags: Record<string, FlagDefinition> = {
        'beta': { enabled: true },
      };
      let loadCalled = false;
      const store: IFlagStore = {
        loadFlags: async () => {
          loadCalled = true;
          return flags;
        },
      };
      const provider = new DatabaseProvider({ store }, null as never);
      await provider.start();
      expect(loadCalled).toBe(true);
      expect(provider.isEnabled('beta')).toBe(true);
      expect(provider.isEnabled('unknown')).toBe(false);
      await provider.stop();
    });
  });

  describe('poll timer', () => {
    it('arms a timer on start and calls setInterval with default interval', async () => {
      let capturedMs: number | null = null;
      const fakeRuntime = {
        setInterval: (_fn: () => void, ms: number): unknown => {
          capturedMs = ms;
          return 'handle-1';
        },
        clearInterval: (_handle: unknown): void => {},
      } as any;

      const store: IFlagStore = {
        loadFlags: async () => ({}),
      };

      const provider = new DatabaseProvider({ store }, fakeRuntime);
      await provider.start();
      expect(capturedMs).toBe(30000); // default
      await provider.stop();
    });

    it('uses explicit refreshIntervalMs', async () => {
      let capturedMs: number | null = null;
      const fakeRuntime = {
        setInterval: (_fn: () => void, ms: number): unknown => {
          capturedMs = ms;
          return 'handle-1';
        },
        clearInterval: (): void => {},
      } as any;

      const store: IFlagStore = {
        loadFlags: async () => ({}),
      };

      const provider = new DatabaseProvider({ store, refreshIntervalMs: 60000 }, fakeRuntime);
      await provider.start();
      expect(capturedMs).toBe(60000);
      await provider.stop();
    });

    it('poll refresh swaps the snapshot when loadFlags resolves new data', async () => {
      let callCount = 0;
      const store: IFlagStore = {
        loadFlags: async () => {
          callCount++;
          if (callCount === 1) {
            return { 'flag-a': { enabled: true } };
          }
          return { 'flag-b': { enabled: true } };
        },
      };

      let capturedCallback: (() => void) | null = null;
      const fakeRuntime = {
        setInterval: (fn: () => void): unknown => {
          capturedCallback = fn;
          return 'handle-1';
        },
        clearInterval: (): void => {},
      } as any;

      const provider = new DatabaseProvider({ store }, fakeRuntime);
      await provider.start();
      expect(provider.isEnabled('flag-a')).toBe(true);

      // Drive the poll
      expect(capturedCallback).not.toBeNull();
      await capturedCallback!();

      expect(provider.isEnabled('flag-a')).toBe(false);
      expect(provider.isEnabled('flag-b')).toBe(true);
      await provider.stop();
    });
  });

  describe('poll failure handling', () => {
    it('rejection logs via logger, keeps old snapshot, flips status to unhealthy', async () => {
      let logMsg: string | null = null;
      const fakeLogger = {
        warn: (msg: string): void => { logMsg = msg; },
      } as any;

      let callCount = 0;
      const store: IFlagStore = {
        loadFlags: async () => {
          callCount++;
          if (callCount === 1) {
            return { 'stable': { enabled: true } };
          }
          throw new Error('network error');
        },
      };

      let capturedCallback: (() => void) | null = null;
      const fakeRuntime = {
        setInterval: (fn: () => void): unknown => {
          capturedCallback = fn;
          return 'handle-1';
        },
        clearInterval: (): void => {},
      } as any;

      const provider = new DatabaseProvider({ store }, fakeRuntime, fakeLogger);
      await provider.start();
      expect(provider.isEnabled('stable')).toBe(true);

      // Drive failing poll
      expect(capturedCallback).not.toBeNull();
      await capturedCallback!();

      // Old snapshot preserved
      expect(provider.isEnabled('stable')).toBe(true);
      // Logged
      expect(logMsg).toContain('DatabaseProvider poll failed');
      // Status degraded
      const st = provider.status();
      expect(st?.healthy).toBe(false);
      expect(st?.detail).toContain('network error');

      await provider.stop();
    });

    it('subsequent successful poll clears the recorded failure', async () => {
      let callCount = 0;
      const fakeLogger = { warn: (): void => {} } as any;

      const store: IFlagStore = {
        loadFlags: async () => {
          callCount++;
          if (callCount <= 2) {
            throw new Error('fail');
          }
          return { 'recovered': { enabled: true } };
        },
      };

      let capturedCallback: (() => void) | null = null;
      const fakeRuntime = {
        setInterval: (fn: () => void): unknown => {
          capturedCallback = fn;
          return 'handle-1';
        },
        clearInterval: (): void => {},
      } as any;

      const provider = new DatabaseProvider({ store }, fakeRuntime, fakeLogger);
      await provider.start();

      // First failing poll
      expect(capturedCallback).not.toBeNull();
      await capturedCallback!();
      expect(provider.status()?.healthy).toBe(false);

      // Second failing poll
      await capturedCallback!();
      expect(provider.status()?.healthy).toBe(false);

      // Successful poll
      await capturedCallback!();
      const st = provider.status();
      expect(st?.healthy).toBe(true);
      expect(provider.isEnabled('recovered')).toBe(true);

      await provider.stop();
    });
  });

  describe('stop', () => {
    it('calls clearInterval with the handle setInterval returned', async () => {
      let capturedHandle: unknown = 'handle-abc';
      let clearedHandle: unknown | null = null;
      const fakeRuntime = {
        setInterval: (): unknown => {
          return capturedHandle;
        },
        clearInterval: (handle: unknown): void => {
          clearedHandle = handle;
        },
      } as any;

      const store: IFlagStore = {
        loadFlags: async () => ({}),
      };

      const provider = new DatabaseProvider({ store }, fakeRuntime);
      await provider.start();
      await provider.stop();
      expect(clearedHandle).toBe(capturedHandle);
    });
  });
});
