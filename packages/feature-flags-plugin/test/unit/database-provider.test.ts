/**
 * Tests for `DatabaseProvider` — polled flag store with failure tracking.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger } from '@hono-enterprise/common';
import { DatabaseProvider } from '../../src/providers/database-provider.ts';
import type { FlagDefinition, IFlagStore } from '../../src/interfaces/index.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('DatabaseProvider', () => {
  describe('type', () => {
    it('is "database"', async () => {
      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => Promise.resolve({}),
      };
      const runtime = new FakeRuntimeServices();
      const provider = new DatabaseProvider({ store }, runtime);
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
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => {
          loadCalled = true;
          return Promise.resolve(flags);
        },
      };
      const runtime = new FakeRuntimeServices();
      const provider = new DatabaseProvider({ store }, runtime);
      await provider.start();
      expect(loadCalled).toBe(true);
      expect(provider.isEnabled('beta')).toBe(true);
      expect(provider.isEnabled('unknown')).toBe(false);
      await provider.stop();
    });
  });

  describe('poll timer', () => {
    it('arms a timer on start and calls setInterval with default interval', async () => {
      const runtime = new FakeRuntimeServices();

      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => Promise.resolve({}),
      };

      const provider = new DatabaseProvider({ store }, runtime);
      await provider.start();
      expect(runtime.calledWithMs).toBe(30000); // default
      await provider.stop();
    });

    it('uses explicit refreshIntervalMs', async () => {
      const runtime = new FakeRuntimeServices();

      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => Promise.resolve({}),
      };

      const provider = new DatabaseProvider({ store, refreshIntervalMs: 60000 }, runtime);
      await provider.start();
      expect(runtime.calledWithMs).toBe(60000);
      await provider.stop();
    });

    it('poll refresh swaps the snapshot when loadFlags resolves new data', async () => {
      // start() calls loadFlags twice: once directly, once via _poll().
      // Both return 'flag-a'. The driven poll call returns 'flag-b'.
      let callCount = 0;
      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => {
          callCount++;
          if (callCount <= 2) {
            // start() direct + start()._poll() → flag-a
            return Promise.resolve({ 'flag-a': { enabled: true } });
          }
          // driven poll → flag-b
          return Promise.resolve({ 'flag-b': { enabled: true } });
        },
      };

      const runtime = new FakeRuntimeServices();

      const provider = new DatabaseProvider({ store }, runtime);
      await provider.start();
      expect(callCount).toBe(2);
      expect(provider.isEnabled('flag-a')).toBe(true);

      // Drive the poll — this is callCount=3 → flag-b
      expect(runtime.capturedCallback).not.toBeNull();
      await runtime.capturedCallback!();

      expect(provider.isEnabled('flag-a')).toBe(false);
      expect(provider.isEnabled('flag-b')).toBe(true);
      await provider.stop();
    });
  });

  describe('poll failure handling', () => {
    it('rejection logs via logger, keeps old snapshot, flips status to unhealthy', async () => {
      let logMsg: string | null = null;
      const fakeLogger: ILogger = {
        level: 'debug' as const,
        fatal: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        error: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        warn: (msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {
          logMsg = msg;
        },
        info: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        debug: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        trace: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        child: (): ILogger => fakeLogger,
      };

      let callCount = 0;
      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ 'stable': { enabled: true } });
          }
          return Promise.reject(new Error('network error'));
        },
      };

      const runtime = new FakeRuntimeServices();

      const provider = new DatabaseProvider({ store }, runtime, fakeLogger);
      await provider.start();
      expect(provider.isEnabled('stable')).toBe(true);

      // Drive failing poll
      expect(runtime.capturedCallback).not.toBeNull();
      await runtime.capturedCallback!();

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
      // start() succeeds on first load (callCount=1), then _poll() fails (callCount=2).
      // Each subsequent driven poll fails until we flip to success.
      let callCount = 0;
      const fakeLogger: ILogger = {
        level: 'debug' as const,
        fatal: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        error: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        warn: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        info: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        debug: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        trace: (_msg: string, _meta?: import('@hono-enterprise/common').LogMetadata): void => {},
        child: (): ILogger => fakeLogger,
      };

      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => {
          callCount++;
          // Call 1: start() initial load → success (returns empty snapshot)
          // Calls 2+: _poll() inside start() + driven polls → fail, then eventually succeed
          if (callCount === 1) {
            return Promise.resolve({});
          }
          if (callCount <= 4) {
            // _poll from start + 2 driven polls fail
            return Promise.reject(new Error('fail'));
          }
          return Promise.resolve({ 'recovered': { enabled: true } });
        },
      };

      const runtime = new FakeRuntimeServices();

      const provider = new DatabaseProvider({ store }, runtime, fakeLogger);
      await provider.start();

      // start() already caused _poll to fail (callCount=2), so status is unhealthy
      expect(provider.status()?.healthy).toBe(false);
      expect(provider.isEnabled('recovered')).toBe(false); // no snapshot yet

      // First driven poll fails (callCount=3) — still unhealthy
      expect(runtime.capturedCallback).not.toBeNull();
      await runtime.capturedCallback!();
      expect(provider.status()?.healthy).toBe(false);

      // Second driven poll fails (callCount=4) — still unhealthy
      await runtime.capturedCallback!();
      expect(provider.status()?.healthy).toBe(false);

      // Third driven poll succeeds (callCount=5) — clears error
      await runtime.capturedCallback!();
      const st = provider.status();
      expect(st?.healthy).toBe(true);
      expect(provider.isEnabled('recovered')).toBe(true);

      await provider.stop();
    });
  });

  describe('stop', () => {
    it('calls clearInterval with the handle setInterval returned', async () => {
      const capturedHandle: unknown = 'handle-abc';
      let clearedHandle: unknown | null = null;
      const runtime = new FakeRuntimeServices();
      // Override to control the handle returned from setInterval
      runtime.setInterval = ((_: () => void, ms: number): unknown => {
        runtime.calledWithMs = ms;
        return capturedHandle;
      }).bind(runtime);
      runtime.clearInterval = ((handle: unknown): void => {
        clearedHandle = handle;
      }).bind(runtime);

      const store: IFlagStore = {
        loadFlags: (): Promise<Readonly<Record<string, FlagDefinition>>> => Promise.resolve({}),
      };

      const provider = new DatabaseProvider({ store }, runtime);
      await provider.start();
      await provider.stop();
      expect(clearedHandle).toBe(capturedHandle);
    });
  });
});
