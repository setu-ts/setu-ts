/**
 * SchemaPerTenant strategy tests.
 */
import { assertEquals } from 'jsr:@std/assert';
import { SchemaPerTenant } from '../../src/strategies/schema-strategy.ts';

Deno.test('SchemaPerTenant — kind is schema', () => {
  const s = new SchemaPerTenant();
  assertEquals(s.kind, 'schema');
});

Deno.test('SchemaPerTenant — default prefix', () => {
  const s = new SchemaPerTenant();
  assertEquals(s.resolveSchema('acme'), 'tenant_acme');
});

Deno.test('SchemaPerTenant — custom prefix', () => {
  const s = new SchemaPerTenant('db_');
  assertEquals(s.resolveSchema('acme'), 'db_acme');
});
