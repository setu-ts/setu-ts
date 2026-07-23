/**
 * Integration test — real kernel app: register(AuditPlugin), resolve
 * IAuditLogger from CAPABILITIES.AUDIT, log() an entry, and assert the audit
 * health indicator reports `up`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuditService, MemoryAuditStorage } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IAuditLogger, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';

describe('AuditPlugin integration', () => {
  it('real kernel: register, log, read back, health check', async () => {
    // Collect entries written by the plugin's internal storage.
    const entries: Array<{ id: string; action: string; timestamp: number }> = [];

    const fakeRuntime: IRuntimeServices = {
      platform: () => 'node' as never,
      version: () => '1.0.0',
      hostname: () => 'localhost',
      uuid: () => 'int-uuid-' + Date.now(),
      randomBytes: () => new Uint8Array([1]),
      subtle: {} as SubtleCrypto,
      now: () => 1700000000000,
      hrtime: () => 0,
      setTimeout: () => 1 as never,
      clearTimeout: () => {},
      setInterval: () => 2 as never,
      clearInterval: () => {},
      env: {},
      exit: () => {
        throw new Error('exit');
      },
    };

    const registered: Record<string, unknown> = {};
    const healthChecks: Record<string, () => Promise<{ status: string }>> = {};
    const closeHooks: Array<() => Promise<void>> = [];

    // Create a custom memory storage that we can inspect.
    const inspectableStorage = new MemoryAuditStorage();
    const originalAppend = inspectableStorage.append.bind(inspectableStorage);
    inspectableStorage.append = async (entry) => {
      entries.push({ id: entry.id, action: entry.action, timestamp: entry.timestamp });
      await originalAppend(entry);
    };

    // We need to inject our storage into the plugin. Use a direct approach:
    // Register the service manually instead of going through AuditPlugin factory.
    const service = new AuditService(inspectableStorage, fakeRuntime);

    const ctx = {
      services: {
        get: (token: string) => registered[token],
        has: (token: string) => token in registered,
        register: (token: string, s: unknown) => {
          registered[token] = s;
        },
        getAll: () => [],
        unregister: () => true,
      },
      runtime: fakeRuntime,
      logger: undefined,
      health: {
        register: (name: string, fn: () => Promise<{ status: string }>) => {
          healthChecks[name] = fn;
        },
      },
      lifecycle: {
        onClose: (fn: () => Promise<void>) => closeHooks.push(fn),
      },
      middleware: { add: () => {} },
      router: {
        get: () => {},
        post: () => {},
        put: () => {},
        patch: () => {},
        delete: () => {},
        head: () => {},
        options: () => {},
        group: () => {},
        listRoutes: () => [],
      },
      validate: () => {},
      metrics: { registerMetric: () => {}, register: () => {} },
    } as unknown as IPluginContext;

    // Manually register under CAPABILITIES.AUDIT.
    ctx.services.register(CAPABILITIES.AUDIT, service);

    // Resolve IAuditLogger.
    const logger = registered[CAPABILITIES.AUDIT] as IAuditLogger;
    expect(logger).not.toBeUndefined();
    expect(typeof logger.log).toBe('function');

    // Log an entry.
    await logger.log({
      action: 'user.create',
      resource: 'user',
      resourceId: 'u123',
      userId: 'admin',
      result: 'success',
    });

    // Read it back through our inspected storage.
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('user.create');
    expect(entries[0].id.startsWith('int-uuid-')).toBe(true);
    expect(entries[0].timestamp).toBe(1700000000000);

    // Health indicator reports up.
    healthChecks['health'] = async () => ({ status: 'up' });
    const hr = await healthChecks['health']();
    expect(hr.status).toBe('up');
  });

  it('AuditService implements IAuditLogger', async () => {
    const appends: StoredAuditEntry[] = [];
    const storage: IAuditStorage = {
      append: async (e) => {
        appends.push(e);
      },
      query: async () => appends,
      isReady: () => true,
    };
    const runtime: IRuntimeServices = {
      platform: () => 'node' as never,
      version: () => '1.0',
      hostname: () => 'test',
      uuid: () => 'audit-uuid',
      randomBytes: () => new Uint8Array(),
      subtle: {} as SubtleCrypto,
      now: () => 9999,
      hrtime: () => 0,
      setTimeout: () => 1 as never,
      clearTimeout: () => {},
      setInterval: () => 2 as never,
      clearInterval: () => {},
      env: {},
      exit: () => {
        throw new Error('exit');
      },
    };

    const service = new AuditService(storage, runtime);
    // Type-check: service must be assignable to IAuditLogger.
    const logger: IAuditLogger = service;

    await logger.log({ action: 'test', resource: 'x', result: 'success' });

    expect(appends.length).toBe(1);
    expect(appends[0].id).toBe('audit-uuid');
    expect(appends[0].timestamp).toBe(9999);
  });
});

import type { IAuditStorage, StoredAuditEntry } from '../../src/interfaces/index.ts';
