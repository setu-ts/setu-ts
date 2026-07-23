/**
 * Tests for LogAuditStorage.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { LogAuditStorage } from '../../src/storage/log-audit.ts';
import type { ILogger } from '@hono-enterprise/common';
import type { StoredAuditEntry } from '../../src/interfaces/index.ts';

describe('LogAuditStorage', () => {
  function makeFakeLogger(): {
    logger: ILogger;
    records: Array<{ level: string; message: string }>;
  } {
    const records: Array<{ level: string; message: string }> = [];
    const logger: ILogger = {
      level: 'info',
      fatal: (msg) => records.push({ level: 'fatal', message: msg }),
      error: (msg) => records.push({ level: 'error', message: msg }),
      warn: (msg) => records.push({ level: 'warn', message: msg }),
      info: (msg) => records.push({ level: 'info', message: msg }),
      debug: (msg) => records.push({ level: 'debug', message: msg }),
      trace: (msg) => records.push({ level: 'trace', message: msg }),
      child: () => logger,
    };
    return { logger, records };
  }

  it('append calls logger.info with record', async () => {
    const { logger, records } = makeFakeLogger();
    const storage = new LogAuditStorage({ logger });
    const entry: StoredAuditEntry = {
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    };
    await storage.append(entry);

    expect(records.length).toBe(1);
    expect(records[0].level).toBe('info');
    expect(records[0].message).toBe('audit');
  });

  it('level option routes to correct method', async () => {
    const { logger, records } = makeFakeLogger();
    const storage = new LogAuditStorage({ logger, level: 'warn' });
    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });

    expect(records.length).toBe(1);
    expect(records[0].level).toBe('warn');
  });

  it('setContextLogger registers ctx.logger', async () => {
    const { logger, records } = makeFakeLogger();
    const storage = new LogAuditStorage();
    expect(storage.isReady()).toBe(false);
    storage.setContextLogger(logger);
    expect(storage.isReady()).toBe(true);
    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });
    expect(records.length).toBe(1);
  });

  it('constructing without logger is not ready', () => {
    const storage = new LogAuditStorage();
    expect(storage.isReady()).toBe(false);
  });

  it('query() always returns []', async () => {
    const storage = new LogAuditStorage();
    const results = await storage.query();
    expect(results).toEqual([]);
  });

  it('close() resolves (no-op)', async () => {
    const storage = new LogAuditStorage();
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it('setLogLevel changes emission level', async () => {
    const { logger, records } = makeFakeLogger();
    const storage = new LogAuditStorage({ logger });
    expect(storage.isReady()).toBe(true);

    // Initially defaults to 'info'
    await storage.append({
      id: '1',
      timestamp: 100,
      action: 'a',
      resource: 'r',
      result: 'success',
    });
    expect(records.length).toBe(1);
    expect(records[0].level).toBe('info');

    // Change level via setLogLevel
    storage.setLogLevel('error');
    await storage.append({
      id: '2',
      timestamp: 200,
      action: 'b',
      resource: 'r',
      result: 'failure',
    });
    expect(records.length).toBe(2);
    expect(records[1].level).toBe('error');
  });
});
