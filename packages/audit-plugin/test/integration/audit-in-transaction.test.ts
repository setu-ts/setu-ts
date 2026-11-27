import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuditLogger } from '@setu-ts/common';
import { AuditPlugin } from '../../src/index.ts';

describe('audit in the caller transaction', () => {
  it('rolls back scoped rows, commits exactly one, and redacts scoped and ordinary writes', async () => {
    const ordinary: Record<string, unknown>[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        AuditPlugin({
          storage: 'database',
          options: {
            table: 'trail',
            client: {
              insert: (_table, row) => {
                ordinary.push(row);
                return Promise.resolve();
              },
              select: () => Promise.resolve(ordinary),
            },
          },
          redaction: { fields: { password: 'secret' } },
        }),
      ],
    });
    await app.start();
    try {
      const audit = app.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const entry = {
        action: 'update',
        resource: 'account',
        result: 'success',
        before: { password: 'private-secret', name: 'before' },
      } as const;
      const stop = new Error('roll back');
      await expect(
        db.transaction(async (scope) => {
          await audit.log(entry, { scope });
          throw stop;
        }),
      ).rejects.toBe(stop);
      expect(await db.getRepository('trail').findAll()).toEqual([]);
      expect(ordinary).toEqual([]);
      await db.transaction((scope) => audit.log(entry, { scope }));
      const rows = await db.getRepository<Record<string, unknown>>('trail').findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'update',
        before: JSON.stringify({ password: '[Redacted]', name: 'before' }),
      });
      expect(rows[0]?.id).toEqual(expect.any(String));
      expect(rows[0]?.timestamp).toEqual(expect.any(Number));
      await audit.log(entry);
      expect(ordinary).toHaveLength(1);
      expect(ordinary[0]?.before).toEqual(rows[0]?.before);
      expect(JSON.stringify([rows, ordinary])).not.toContain('private-secret');
      expect(entry.before.password).toBe('private-secret');
    } finally {
      await app.stop();
    }
  });
});

it(
  'audit PostgreSQL writes share commit/rollback and redaction on both paths',
  { skip: !process.env['POSTGRES_URL'] },
  async () => {
    const { Pool, drizzle, pgTable, text, bigint } =
      await import('../../../database-plugin/test/fixtures/postgres-client.ts');
    const { createDrizzleDatabase } = await import('@setu-ts/database-plugin');
    const pool = new Pool({ connectionString: process.env['POSTGRES_URL']! });
    const name = `audit_scope_${crypto.randomUUID().replaceAll('-', '')}`;
    const table = pgTable(name, {
      id: text('id').primaryKey(),
      timestamp: bigint('timestamp', { mode: 'number' }),
      action: text('action'),
      resource: text('resource'),
      resource_id: text('resource_id'),
      user_id: text('user_id'),
      result: text('result'),
      before: text('before'),
      after: text('after'),
      metadata: text('metadata'),
    });
    let db: IDatabaseService;
    const native = drizzle(pool);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({
          type: 'drizzle',
          options: {
            drizzleInstance: createDrizzleDatabase(native, (database, work) =>
              database.transaction(work),
            ),
            drizzleTables: { trail: table },
          },
        }),
        AuditPlugin({
          storage: 'database',
          options: {
            table: 'trail',
            client: {
              insert: async (entity, row) => {
                await db.getRepository(entity).create(row);
              },
              select: () => Promise.resolve([]),
            },
          },
          redaction: { fields: { password: 'secret' } },
        }),
      ],
    });
    try {
      await pool.query(
        `CREATE TABLE "${name}" (id text PRIMARY KEY, timestamp bigint, action text, resource text, resource_id text, user_id text, result text, before text, after text, metadata text)`,
      );
      await app.start();
      db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const audit = app.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
      const entry = {
        action: 'update',
        resource: 'account',
        result: 'success',
        before: { password: 'private-audit-secret' },
      } as const;
      const stop = new Error('rollback');
      await expect(
        db.transaction(async (scope) => {
          await audit.log(entry, { scope });
          throw stop;
        }),
      ).rejects.toBe(stop);
      expect(await db.getRepository('trail').count()).toBe(0);
      await db.transaction((scope) => audit.log(entry, { scope }));
      expect(await db.getRepository('trail').count()).toBe(1);
      await audit.log(entry);
      const rows = await db.getRepository<Record<string, unknown>>('trail').findAll();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => JSON.parse(String(row.before)))).toEqual([
        { password: '[Redacted]' },
        { password: '[Redacted]' },
      ]);
      expect(JSON.stringify(rows)).not.toContain('private-audit-secret');
    } finally {
      await app.stop();
      await pool.query(`DROP TABLE IF EXISTS "${name}"`);
      await pool.end();
    }
  },
);
