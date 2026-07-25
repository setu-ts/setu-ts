/**
 * MemoryTenantDataStore tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { MemoryTenantDataStore } from '../../src/stores/memory-tenant-store.ts';
import { ColumnPerTenant, DatabasePerTenant, SchemaPerTenant } from '../../src/strategies/index.ts';

Deno.test('MemoryTenantDataStore — create and findAll', async () => {
  const store = new MemoryTenantDataStore();
  const result = await store.create('t1', 'User', { name: 'Ada' });
  assertEquals((result as Record<string, unknown>).name, 'Ada');
  const all = await store.findAll('t1', 'User');
  assertEquals(all.length, 1);
  assertEquals((all[0] as Record<string, unknown>).name, 'Ada');
});

Deno.test('MemoryTenantDataStore — findById', async () => {
  const store = new MemoryTenantDataStore();
  const created = await store.create('t1', 'User', { id: 'u1', name: 'Ada' });
  assertEquals((created as Record<string, unknown>).id, 'u1');
  const found = await store.findById('t1', 'User', 'u1');
  assert(found != null);
  assertEquals((found as Record<string, unknown>).name, 'Ada');
});

Deno.test('MemoryTenantDataStore — findById returns null for unknown id', async () => {
  const store = new MemoryTenantDataStore();
  const found = await store.findById('t1', 'User', 'unknown');
  assertEquals(found, null);
});

Deno.test('MemoryTenantDataStore — find with filter', async () => {
  const store = new MemoryTenantDataStore();
  await store.create('t1', 'User', { id: 'u1', role: 'admin' });
  await store.create('t1', 'User', { id: 'u2', role: 'user' });
  const results = await store.find('t1', 'User', { role: 'admin' });
  assertEquals(results.length, 1);
  assertEquals((results[0] as Record<string, unknown>).id, 'u1');
});

Deno.test('MemoryTenantDataStore — update returns updated entity', async () => {
  const store = new MemoryTenantDataStore();
  await store.create('t1', 'User', { id: 'u1', name: 'Ada' });
  const updated = await store.update('t1', 'User', 'u1', { name: 'Ada Updated' });
  assert(updated != null);
  assertEquals((updated as Record<string, unknown>).name, 'Ada Updated');
});

Deno.test('MemoryTenantDataStore — update returns null for unknown id', async () => {
  const store = new MemoryTenantDataStore();
  const updated = await store.update('t1', 'User', 'u99', { name: 'X' });
  assertEquals(updated, null);
});

Deno.test('MemoryTenantDataStore — delete returns true/false', async () => {
  const store = new MemoryTenantDataStore();
  await store.create('t1', 'User', { id: 'u1', name: 'Ada' });
  assertEquals(await store.delete('t1', 'User', 'u1'), true);
  assertEquals(await store.delete('t1', 'User', 'u1'), false);
});

Deno.test('MemoryTenantDataStore — close clears data', async () => {
  const store = new MemoryTenantDataStore();
  await store.create('t1', 'User', { id: 'u1' });
  await store.close();
  const all = await store.findAll('t1', 'User');
  assertEquals(all.length, 0);
});

Deno.test('MemoryTenantDataStore — cross-tenant isolation', async () => {
  const store = new MemoryTenantDataStore();
  await store.create('t1', 'User', { id: 'u1', tenant: 'A' });
  await store.create('t2', 'User', { id: 'u2', tenant: 'B' });
  const aUsers = await store.findAll('t1', 'User');
  const bUsers = await store.findAll('t2', 'User');
  assertEquals(aUsers.length, 1);
  assertEquals(bUsers.length, 1);
  assertEquals((aUsers[0] as Record<string, unknown>).tenant, 'A');
  assertEquals((bUsers[0] as Record<string, unknown>).tenant, 'B');
});

Deno.test('MemoryTenantDataStore — string id is preserved', async () => {
  const store = new MemoryTenantDataStore();
  const result = await store.create('t1', 'User', { id: 'custom-123', name: 'X' });
  assertEquals((result as Record<string, unknown>).id, 'custom-123');
});

Deno.test('MemoryTenantDataStore — number id is preserved', async () => {
  const store = new MemoryTenantDataStore();
  const result = await store.create('t1', 'User', { id: 42, name: 'X' });
  assertEquals((result as Record<string, unknown>).id, 42);
});

Deno.test('MemoryTenantDataStore — missing id uses default counter', async () => {
  const store = new MemoryTenantDataStore();
  const r1 = await store.create('t1', 'User', { name: 'A' });
  const r2 = await store.create('t1', 'User', { name: 'B' });
  assertEquals((r1 as Record<string, unknown>).id, '1');
  assertEquals((r2 as Record<string, unknown>).id, '2');
});

Deno.test('MemoryTenantDataStore — injected generateId', async () => {
  let counter = 100;
  const store = new MemoryTenantDataStore({
    generateId: () => `gen-${counter++}`,
  });
  const result = await store.create('t1', 'User', { name: 'X' });
  assertEquals((result as Record<string, unknown>).id, 'gen-100');
});

Deno.test('MemoryTenantDataStore — column strategy stamps tenant column', async () => {
  const store = new MemoryTenantDataStore();
  const strategy = new ColumnPerTenant('org_id');
  store.useIsolation(strategy);
  await store.create('t1', 'User', { name: 'Ada' });
  const results = await store.find('t1', 'User', { org_id: 't1' });
  assertEquals(results.length, 1);
});

Deno.test('MemoryTenantDataStore — schema strategy derives scope', async () => {
  const store = new MemoryTenantDataStore();
  const strategy = new SchemaPerTenant('schema_');
  store.useIsolation(strategy);
  // With schema strategy, deriveScope maps tenantId to schema name.
  // Creating via 't1' actually stores under 'schema_t1'.
  await store.create('t1', 'User', { id: 'u1' });
  // Reading back via 't1' also maps to 'schema_t1'.
  const all = await store.findAll('t1', 'User');
  assertEquals(all.length, 1);
  assertEquals((all[0] as any).id, 'u1');
});

Deno.test('MemoryTenantDataStore — database strategy derives scope', async () => {
  const store = new MemoryTenantDataStore();
  const strategy = new DatabasePerTenant('db_');
  store.useIsolation(strategy);
  await store.create('t1', 'User', { id: 'u1' });
  const all = await store.findAll('t1', 'User');
  assertEquals(all.length, 1);
});

Deno.test('MemoryTenantDataStore — strategy partitions differ by tenant', async () => {
  const store = new MemoryTenantDataStore();
  const schemaStrategy = new SchemaPerTenant('s_');
  store.useIsolation(schemaStrategy);
  // Tenant A stores under 's_a', tenant B under 's_b'
  await store.create('a', 'Item', { id: 'i-a' });
  await store.create('b', 'Item', { id: 'i-b' });
  // Both are accessible via their respective tenantIds
  const aItems = await store.findAll('a', 'Item');
  const bItems = await store.findAll('b', 'Item');
  assertEquals(aItems.length, 1);
  assertEquals(bItems.length, 1);
  assertEquals((aItems[0] as any).id, 'i-a');
  assertEquals((bItems[0] as any).id, 'i-b');
});
