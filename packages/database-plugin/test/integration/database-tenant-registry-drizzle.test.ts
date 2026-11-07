/**
 * `createDatabaseTenantRegistry` (M127 §3.8) on Drizzle over a REAL SQLite
 * engine (`node:sqlite` behind `drizzle-orm/sqlite-proxy`) — the same table of
 * cases as the memory-adapter unit test, so the `findOne({ where })` it issues
 * is proven against SQL rather than an in-memory filter.
 *
 * The plugin-composition case (a factory registry inside `MultiTenancyPlugin`
 * with `DatabasePlugin` registered after it) lives in the multi-tenancy
 * plugin's `database-registry.test.ts`: this package may not depend on that
 * plugin, which already depends on this one.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { IServiceRegistry, ITenantRegistry } from '@setu-ts/common';
import {
  createDatabaseTenantRegistry,
  createDrizzleDatabase,
  type DatabaseTenantRegistryOptions,
  DrizzleAdapter,
} from '../../src/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';

const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name'),
  active: integer('active').notNull(),
  apiKey: text('api_key'),
});

interface ArrayReturningStatement {
  run(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown[][];
  setReturnArrays(enabled: boolean): void;
}

function executeSqlite(
  engine: DatabaseSync,
  statement: string,
  params: readonly SQLInputValue[],
  method: 'run' | 'all' | 'values' | 'get',
): Promise<{ rows: unknown[] }> {
  const prepared = engine.prepare(statement) as unknown as ArrayReturningStatement;
  if (method === 'run') {
    prepared.run(...params);
    return Promise.resolve({ rows: [] });
  }
  prepared.setReturnArrays(true);
  return Promise.resolve({ rows: prepared.all(...params) });
}

async function registryOver(options?: DatabaseTenantRegistryOptions): Promise<ITenantRegistry> {
  const engine = new DatabaseSync(':memory:');
  engine.exec(
    'CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT, active INTEGER NOT NULL, api_key TEXT)',
  );
  engine.exec(
    "INSERT INTO tenants VALUES ('t1', 'acme', 'Acme', 1, 'sk-secret'), ('t2', 'globex', 'Globex', 0, NULL), ('t3', '', NULL, 1, NULL)",
  );
  const drizzleDb = drizzle((statement, params, method) =>
    executeSqlite(engine, statement, params, method),
  );
  const database = createDrizzleDatabase(drizzleDb, (configured, work) =>
    configured.transaction(work),
  );
  const adapter = new DrizzleAdapter({
    drizzleInstance: database,
    drizzleTables: { Tenant: tenants },
  });
  await adapter.connect();
  const service = new DatabaseService(adapter, (e) => adapter.createDataSource(e), 'drizzle');
  const services = { get: () => service } as unknown as IServiceRegistry;
  return createDatabaseTenantRegistry(options)(services);
}

describe('createDatabaseTenantRegistry — Drizzle over node:sqlite', () => {
  it('a hit by primary key carries id and name, never the secret column', async () => {
    const registry = await registryOver();
    const hit = await registry.lookup('t1');
    expect(hit.present && hit.value).toEqual({ id: 't1', name: 'Acme' });
    expect(JSON.stringify(hit)).not.toContain('sk-secret');
  });

  it('a miss is none()', async () => {
    expect((await (await registryOver()).lookup('initech')).present).toBe(false);
  });

  it('a slug idField answers the slug as the canonical id; activeField refuses a suspended row', async () => {
    const registry = await registryOver({ idField: 'slug', activeField: 'active' });
    const hit = await registry.lookup('acme');
    expect(hit.present && hit.value).toEqual({ id: 'acme', name: 'Acme' });
    expect((await registry.lookup('globex')).present).toBe(false);
  });

  it('toMetadata maps the row; a null name is omitted', async () => {
    const registry = await registryOver({
      toMetadata: (row) => ({ active: row.active === 1 }),
    });
    const hit = await registry.lookup('t1');
    expect(hit.present && hit.value).toEqual({
      id: 't1',
      name: 'Acme',
      metadata: { active: true },
    });
    const bare = await (await registryOver()).lookup('t3');
    expect(bare.present && bare.value).toEqual({ id: 't3' });
  });

  it('a row with an empty idField value throws a TypeError', async () => {
    const registry = await registryOver({ idField: 'slug' });
    await expect(registry.lookup('')).rejects.toThrow(TypeError);
  });
});
