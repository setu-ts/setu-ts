import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import {
  createDrizzleDatabase,
  DatabaseService,
  DrizzleAdapter,
  updateVersioned,
  VersionConflictError,
} from '../../src/index.ts';
import type { ITenantRepository } from '@setu-ts/common';
import { DatabaseTenantDataStore } from '../../src/tenancy/database-tenant-data-store.ts';
const url = process.env['POSTGRES_URL'];
describe('tenant conditional writes on real PostgreSQL', () => {
  it(
    'a row recreated by tenant B refuses tenant A update and delete',
    {
      skip: url === undefined,
    },
    async () => {
      const tableName = `m105_tenant_${crypto.randomUUID().replaceAll('-', '')}`;
      const table = pgTable(tableName, {
        id: text('id').primaryKey(),
        tenant_id: text('tenant_id'),
        name: text('name'),
      });
      const pool = new Pool({ connectionString: url });
      const adapter = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
        drizzleTables: { Row: table },
      });
      await pool.query(
        `CREATE TABLE "${tableName}" (id text primary key, tenant_id text, name text)`,
      );
      await adapter.connect();
      try {
        const service = new DatabaseService(
          adapter,
          (entity) => adapter.createDataSource(entity),
          'drizzle',
        );
        const repo = service.getRepository('Row');
        await repo.create({ id: 'key', tenant_id: 'a', name: 'old' });
        await repo.delete('key');
        await repo.create({ id: 'key', tenant_id: 'b', name: 'secret' });
        const store = new DatabaseTenantDataStore(service);
        expect(await store.update('a', 'Row', 'key', { name: 'bad' })).toBeNull();
        expect(await store.delete('a', 'Row', 'key')).toBe(false);
        expect(await repo.findById('key')).toEqual({ id: 'key', tenant_id: 'b', name: 'secret' });
      } finally {
        await adapter.disconnect();
        await pool.query(`DROP TABLE "${tableName}"`);
        await pool.end();
      }
    },
  );

  it(
    'M128: two concurrent versioned updates through the tenant path — exactly one applies',
    { skip: url === undefined },
    async () => {
      const tableName = `m128_versioned_${crypto.randomUUID().replaceAll('-', '')}`;
      const table = pgTable(tableName, {
        id: text('id').primaryKey(),
        tenant_id: text('tenant_id'),
        name: text('name'),
        version: integer('version').notNull(),
      });
      const pool = new Pool({ connectionString: url, max: 4 });
      const adapter = new DrizzleAdapter({
        drizzleInstance: createDrizzleDatabase(drizzle(pool), (db, work) => db.transaction(work)),
        drizzleTables: { Row: table },
      });
      await pool.query(
        `CREATE TABLE "${tableName}" (id text primary key, tenant_id text, name text, version integer not null)`,
      );
      await adapter.connect();
      try {
        const service = new DatabaseService(
          adapter,
          (entity) => adapter.createDataSource(entity),
          'drizzle',
        );
        const store = new DatabaseTenantDataStore(service);
        type Row = { id: string; name: string; version: number; tenant_id?: string };
        const repo: ITenantRepository<Row, string> = {
          findAll: () => store.findAll<Row>('a', 'Row'),
          findById: (id) => store.findById<Row, string>('a', 'Row', id),
          find: (filter) => store.find<Row>('a', 'Row', filter),
          create: (data) => store.create<Row>('a', 'Row', data),
          update: (id, data) => store.update<Row, string>('a', 'Row', id, data),
          delete: (id) => store.delete('a', 'Row', id),
          updateWhere: (id, where, data) =>
            store.updateWhere<Row, string>('a', 'Row', id, where, data),
        };
        await repo.create({ id: 'key', name: 'draft', version: 1 });
        const outcomes = await Promise.allSettled(
          ['first', 'second', 'third', 'fourth'].map((name) =>
            updateVersioned(repo, 'key', 1, { name }),
          ),
        );
        const applied = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
        expect(applied).toHaveLength(1);
        expect(refused).toHaveLength(3);
        for (const outcome of refused) {
          expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);
        }
        const stored = (await pool.query(`SELECT name, version FROM "${tableName}"`)).rows;
        expect(stored).toEqual([
          { name: (applied[0] as PromiseFulfilledResult<Row>).value.name, version: 2 },
        ]);
      } finally {
        await adapter.disconnect();
        await pool.query(`DROP TABLE "${tableName}"`);
        await pool.end();
      }
    },
  );
});
