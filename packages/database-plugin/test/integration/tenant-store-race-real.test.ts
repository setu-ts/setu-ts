import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Pool } from 'npm:pg@^8.0.0';
import { drizzle } from 'npm:drizzle-orm@0.45.2/node-postgres';
import { pgTable, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { createDrizzleDatabase, DatabaseService, DrizzleAdapter } from '../../src/index.ts';
import { DatabaseTenantDataStore } from '../../src/tenancy/database-tenant-data-store.ts';
const url = Deno.env.get('POSTGRES_URL');
describe('tenant conditional writes on real PostgreSQL', () => {
  it('a row recreated by tenant B refuses tenant A update and delete', {
    ignore: url === undefined,
  }, async () => {
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
  });
});
