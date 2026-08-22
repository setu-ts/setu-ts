/**
 * X4-9 — the Drizzle table registry validates `id` lazily.
 *
 * `IRepository.findById`/`update`/`delete` are single-key by contract, so a
 * composite-key table genuinely cannot have a repository. The registry was
 * enforcing that repository precondition on EVERY registered table, including
 * ones only the typed query builder reads, which made the registry
 * all-or-nothing and locked ordinary join and per-tenant tables out of the
 * whole schema.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/pg-proxy';
import { pgTable, primaryKey, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import { DrizzleAdapter } from '../../src/adapters/drizzle/drizzle-adapter.ts';
import { createDrizzleDatabase, getDrizzleDatabase } from '../../src/index.ts';
import { DatabaseService } from '../../src/services/database-service.ts';

const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

/** The shape X4-9 was reported against: `primary key (tenant_id, flag)`. */
const tenantFlags = pgTable('tenant_flags', {
  tenantId: text('tenant_id').notNull(),
  flag: text('flag').notNull(),
  value: text('value').notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.flag] })]);

function buildAdapter(tables: Record<string, unknown>) {
  const seen: string[] = [];
  const database = drizzle((sql) => {
    seen.push(sql);
    return Promise.resolve({ rows: [] });
  });
  const configured = createDrizzleDatabase(
    database,
    (instance, work) => instance.transaction(work),
  );
  const adapter = new DrizzleAdapter({ drizzleInstance: configured, drizzleTables: tables });
  return { adapter, configured, seen };
}

describe('DrizzleAdapter table registry', () => {
  it('connects with a composite-key table in the registry', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, TenantFlag: tenantFlags });
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });

  it('refuses a repository for the composite-key table, by name', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, TenantFlag: tenantFlags });
    await adapter.connect();
    expect(() => adapter.createDataSource('TenantFlag')).toThrow(
      "Drizzle table 'TenantFlag' has no 'id' column required by the database repository.",
    );
  });

  it('still serves a repository for the single-key table beside it', async () => {
    const { adapter, seen } = buildAdapter({ Tenant: tenants, TenantFlag: tenantFlags });
    await adapter.connect();
    await adapter.createDataSource('Tenant').findById('t1');
    expect(seen[0]).toContain('"tenants"');
  });

  it('lets the typed query builder reach the composite-key table', async () => {
    const { adapter, configured, seen } = buildAdapter({
      Tenant: tenants,
      TenantFlag: tenantFlags,
    });
    await adapter.connect();
    const service = new DatabaseService(
      adapter,
      (entity) => adapter.createDataSource(entity),
      'drizzle',
    );
    // The same opaque configuration the adapter was built with, read back
    // through the public accessor so this exercises the real seam.
    await getDrizzleDatabase(service, configured).select().from(tenantFlags);
    expect(seen.at(-1)).toContain('"tenant_flags"');
  });

  it('still refuses a registry entry that is not a table definition', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, Broken: 'not-a-table' });
    await expect(adapter.connect()).rejects.toThrow(
      "Drizzle table 'Broken' must be a table definition",
    );
  });

  it('still refuses a null registry entry', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, Broken: null });
    await expect(adapter.connect()).rejects.toThrow(
      "Drizzle table 'Broken' must be a table definition",
    );
  });
});
