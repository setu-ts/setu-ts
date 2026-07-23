/**
 * Integration test - real kernel app: createApplication(AuditPlugin), resolve
 * IAuditLogger from CAPABILITIES.AUDIT, log() an entry, and assert the audit
 * service was registered correctly.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { AuditPlugin } from '../../src/index.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IAuditLogger } from '@hono-enterprise/common';

describe('AuditPlugin integration (real kernel)', () => {
  it('register -> resolve IAuditLogger -> log', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), AuditPlugin()],
    });
    await app.start();

    // Resolve IAuditLogger via the real service registry.
    expect(app.services.has(CAPABILITIES.AUDIT)).toBe(true);
    const logger = app.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
    expect(logger).toBeDefined();
    expect(typeof logger.log).toBe('function');

    // Log an entry through the real service.
    await logger.log({
      action: 'user.create',
      resource: 'user',
      resourceId: 'u123',
      userId: 'admin',
      result: 'success',
    });

    // Verify the health indicator was registered by the plugin.
    const healthIndicators = app.services.getAll<
      { name: string; check: () => Promise<{ status: string }> }
    >(CAPABILITIES.HEALTH_INDICATOR);
    expect(healthIndicators.length).toBeGreaterThan(0);
    const auditHealth = healthIndicators.find((h) => h.name === 'audit');
    expect(auditHealth).toBeDefined();
    const healthResult = await auditHealth!.check();
    expect(healthResult.status).toBe('up');

    await app.stop();
  });

  it('resolves IAuditLogger with database storage backend', async () => {
    // Build a fake db client that accumulates rows.
    const rows: Record<string, unknown>[] = [];
    const fakeClient: {
      insert: (t: string, r: Record<string, unknown>) => Promise<void>;
      select: (t: string) => Promise<Record<string, unknown>[]>;
    } = {
      insert: (_table: string, row: Record<string, unknown>) => {
        rows.push(row);
        return Promise.resolve();
      },
      select: (table: string) => {
        if (table === 'audit_logs') return Promise.resolve(rows);
        return Promise.resolve([]);
      },
    };

    const dbApp = createApplication({
      plugins: [
        RuntimePlugin(),
        AuditPlugin({
          storage: 'database',
          options: { client: fakeClient as never, table: 'audit_logs' },
        }),
      ],
    });
    await dbApp.start();

    expect(dbApp.services.has(CAPABILITIES.AUDIT)).toBe(true);
    const logger = dbApp.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
    expect(typeof logger.log).toBe('function');

    await logger.log({
      action: 'db.insert',
      resource: 'order',
      resourceId: 'o456',
      result: 'success',
    });

    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('db.insert');

    await dbApp.stop();
  });

  it('resolves IAuditLogger with file storage backend', async () => {
    const fileApp = createApplication({
      plugins: [
        RuntimePlugin(),
        AuditPlugin({ storage: 'file', options: { path: './integration-test.log' } }),
      ],
    });
    await fileApp.start();

    expect(fileApp.services.has(CAPABILITIES.AUDIT)).toBe(true);
    const logger = fileApp.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
    expect(typeof logger.log).toBe('function');

    await logger.log({
      action: 'file.append',
      resource: 'log',
      result: 'success',
    });

    await fileApp.stop();
  });
});
