/**
 * Drizzle adapter — per-entity primaryKey override and composite-key support.
 *
 * T5 extends the X4-9 suite: an unconfigured entity still refuses a missing
 * `id` by name (the prior default path), while a composite-key table now
 * yields a working repository when `primaryKey` is configured — it previously
 * threw.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drizzle } from 'npm:drizzle-orm@0.45.2/pg-proxy';
import { pgTable, primaryKey, text } from 'npm:drizzle-orm@0.45.2/pg-core';
import type { DrizzleAdapterOptions } from '../../src/interfaces/index.ts';
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

function buildAdapter(
  tables: Record<string, unknown>,
  extra?: Partial<DrizzleAdapterOptions>,
) {
  const seen: string[] = [];
  const database = drizzle((sql) => {
    seen.push(sql);
    return Promise.resolve({ rows: [] });
  });
  const configured = createDrizzleDatabase(
    database,
    (instance, work) => instance.transaction(work),
  );
  const adapter = new DrizzleAdapter({
    drizzleInstance: configured,
    drizzleTables: tables,
    ...extra,
  });
  return { adapter, configured, seen };
}

describe('DrizzleAdapter table registry', () => {
  it('connects with a composite-key table in the registry', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, TenantFlag: tenantFlags });
    await adapter.connect();
    expect(adapter.isReady()).toBe(true);
  });

  it('refuses a repository for the composite-key table by name when unconfigured', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, TenantFlag: tenantFlags });
    await adapter.connect();
    // Default primaryKey is ['id']; the composite object is handed to keyValues
    // which names the missing required column instead of columnFor throwing.
    await expect(adapter.createDataSource('TenantFlag').findById({ tenantId: 't1', flag: 'x' }))
      .rejects.toThrow(/missing required column 'id'/);
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

describe('DrizzleAdapter per-entity primaryKey override', () => {
  it('configures key columns to replace the hardcoded id for a composite-key table', async () => {
    const { adapter, seen } = buildAdapter(
      { Tenant: tenants, TenantFlag: tenantFlags },
      { entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } } },
    );
    await adapter.connect();
    const ds = adapter.createDataSource('TenantFlag');
    await ds.findById({ tenantId: 't1', flag: 'active' });
    // A multi-column WHERE is emitted: both columns appear.
    expect(seen[0]).toContain('"tenant_id"');
    expect(seen[0]).toContain('"flag"');
  });

  it('rejects a scalar against a composite-key target, by name and via Promise', async () => {
    const { adapter } = buildAdapter(
      { Tenant: tenants, TenantFlag: tenantFlags },
      { entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } } },
    );
    await adapter.connect();
    await expect(adapter.createDataSource('TenantFlag').findById('scalar-wrong'))
      .rejects.toThrow(/entity key must be a composite record for multi-column target/);
  });

  it('rejects a composite record missing a required column, by name and via Promise', async () => {
    const { adapter } = buildAdapter(
      { Tenant: tenants, TenantFlag: tenantFlags },
      { entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } } },
    );
    await adapter.connect();
    await expect(
      adapter.createDataSource('TenantFlag').findById({ tenantId: 't1' as unknown as string }),
    )
      .rejects.toThrow(/composite key is missing required column 'flag'/);
  });

  it('keeps the default ["id"] for an unconfigured entity', async () => {
    const { adapter, seen } = buildAdapter({ Tenant: tenants });
    await adapter.connect();
    const ds = adapter.createDataSource('Tenant');
    await ds.findById('t1');
    expect(seen[0]).toContain('"tenants"');
    expect(seen[0]).toContain('"id"');
  });

  it('unconfigured entity still refuses a missing id by name', async () => {
    const { adapter } = buildAdapter({ Tenant: tenants, TenantFlag: tenantFlags });
    await adapter.connect();
    await expect(adapter.createDataSource('TenantFlag').findById('t1'))
      .rejects.toThrow(
        "Drizzle table 'TenantFlag' has no 'id' column required by the database repository.",
      );
  });

  it('builds a compound WHERE for update using the configured key', async () => {
    const { adapter, seen } = buildAdapter(
      { TenantFlag: tenantFlags },
      { entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } } },
    );
    await adapter.connect();
    const ds = adapter.createDataSource('TenantFlag');
    // Provide a row so returningRows returns something non-empty.
    // The proxy records SQL but returns empty rows; update will throw
    // "returned no row" — we only care that the WHERE is multi-column.
    try {
      await ds.update({ tenantId: 't1', flag: 'active' }, { value: 'new' });
    } catch {
      // Expected: proxy returns [], so oneReturnedRow throws.
    }
    // The recorded statement carries both key columns in the WHERE.
    expect(seen[0]).toContain('and');
    expect(seen[0]).toContain('"tenant_id"');
    expect(seen[0]).toContain('"flag"');
  });

  it('builds a compound WHERE for delete using the configured key', async () => {
    const { adapter, seen } = buildAdapter(
      { TenantFlag: tenantFlags },
      { entities: { TenantFlag: { primaryKey: ['tenantId', 'flag'] } } },
    );
    await adapter.connect();
    const ds = adapter.createDataSource('TenantFlag');
    try {
      await ds.delete({ tenantId: 't1', flag: 'active' });
    } catch {
      // Expected: proxy returns [].
    }
    expect(seen[0]).toContain('"tenant_id"');
    expect(seen[0]).toContain('"flag"');
  });
});
