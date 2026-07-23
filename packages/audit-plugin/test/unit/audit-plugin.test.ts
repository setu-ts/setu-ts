/**
 * Tests for AuditPlugin factory + createStorage.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuditPlugin, createStorage } from '../../src/plugin/audit-plugin.ts';
import { MemoryAuditStorage } from '../../src/storage/memory-audit.ts';
import { LogAuditStorage } from '../../src/storage/log-audit.ts';
import { DatabaseAuditStorage } from '../../src/storage/database-audit.ts';
import { FileAuditStorage } from '../../src/storage/file-audit.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IPluginContext } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { IAuditDbClient } from '../../src/interfaces/index.ts';

describe('createStorage', () => {
  const fakeContext = {
    services: {
      get: () => ({}),
      has: () => false,
    },
    runtime: {
      fs: undefined,
      env: {},
    } as unknown as IRuntimeServices,
    logger: undefined,
    health: { register: () => {} },
    lifecycle: { onClose: () => {} },
  } as unknown as IPluginContext;

  it('memory type builds MemoryAuditStorage', () => {
    const storage = createStorage('memory', {}, fakeContext);
    expect(storage instanceof MemoryAuditStorage).toBe(true);
  });

  it('log type builds LogAuditStorage with injected logger', () => {
    const fakeLogger = {
      level: 'info' as const,
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => fakeLogger,
    };
    const storage = createStorage('log', { logger: fakeLogger }, fakeContext);
    expect(storage instanceof LogAuditStorage).toBe(true);
  });

  it('database type builds DatabaseAuditStorage', () => {
    const fakeClient: IAuditDbClient = {
      insert: () => Promise.resolve(),
      select: () => Promise.resolve([]),
    };
    const storage = createStorage('database', { client: fakeClient }, fakeContext);
    expect(storage instanceof DatabaseAuditStorage).toBe(true);
  });

  it('file type builds FileAuditStorage with fs', () => {
    const fakeFs = {
      readFile: () => Promise.resolve(new Uint8Array()),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ isFile: false, isDirectory: false, size: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };
    const ctx = {
      ...fakeContext,
      runtime: { ...fakeContext.runtime, fs: fakeFs },
    } as unknown as IPluginContext;
    const storage = createStorage('file', { path: './test.log' }, ctx);
    expect(storage instanceof FileAuditStorage).toBe(true);
  });

  it('unknown type throws', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing unknown storage type
    expect(() => createStorage('bogus' as never, {}, fakeContext)).toThrow();
  });

  it('default is memory', () => {
    const storage = createStorage('memory', {}, fakeContext);
    expect(storage instanceof MemoryAuditStorage).toBe(true);
  });

  it('log without logger throws', () => {
    expect(() => createStorage('log', {}, fakeContext)).toThrow(
      'LogAuditStorage requires the logger capability',
    );
  });

  it('file without fs throws', () => {
    expect(() => createStorage('file', {}, fakeContext)).toThrow(
      'FileAuditStorage requires runtime.fs',
    );
  });
});

describe('AuditPlugin', () => {
  it('returns plugin descriptor with correct properties', () => {
    const plugin = AuditPlugin();
    expect(plugin.name).toBe('audit-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toEqual([CAPABILITIES.AUDIT]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
    expect(plugin.optionalDependencies).toEqual(['logger']);
  });

  it('register() resolves IAuditLogger under CAPABILITIES.AUDIT', async () => {
    const registeredServices: Record<string, unknown> = {};
    const healthIndicators: Record<string, () => Promise<{ status: string }>> = {};
    const closeHooks: Array<() => Promise<void>> = [];
    const fakeRuntime: IRuntimeServices = {
      platform: () => 'node' as never,
      version: () => '1.0.0',
      hostname: () => 'localhost',
      uuid: () => 'test-uuid',
      randomBytes: () => new Uint8Array(),
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
    const services = {
      get: (token: string) => registeredServices[token],
      has: (token: string) => token in registeredServices,
      register: (token: string, service: unknown) => {
        registeredServices[token] = service;
      },
    };
    const ctx = {
      services,
      runtime: fakeRuntime,
      health: {
        register: (name: string, indicator: () => Promise<{ status: string }>) => {
          healthIndicators[name] = indicator;
        },
      },
      lifecycle: {
        onClose: (fn: () => Promise<void>) => closeHooks.push(fn),
      },
    } as unknown as IPluginContext;

    const plugin = AuditPlugin();
    await plugin.register!(ctx);

    // Check service registration.
    const auditService = registeredServices[CAPABILITIES.AUDIT];
    expect(auditService).not.toBeUndefined();
    expect(typeof (auditService as { log?: () => unknown }).log).toBe('function');

    // Check health indicator.
    const healthResult = await healthIndicators['audit']!();
    expect(healthResult.status).toBe('up');

    // Check lifecycle hook.
    expect(closeHooks.length).toBe(1);
  });
});
