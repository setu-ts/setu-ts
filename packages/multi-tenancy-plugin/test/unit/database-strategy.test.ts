/**
 * DatabasePerTenant strategy tests.
 */
import { assertEquals } from 'jsr:@std/assert';
import { DatabasePerTenant } from '../../src/strategies/database-strategy.ts';

Deno.test('DatabasePerTenant — kind is database', () => {
  const s = new DatabasePerTenant();
  assertEquals(s.kind, 'database');
});

Deno.test('DatabasePerTenant — default prefix', () => {
  const s = new DatabasePerTenant();
  assertEquals(s.resolveDatabase('acme'), 'tenant_acme');
});

Deno.test('DatabasePerTenant — custom prefix', () => {
  const s = new DatabasePerTenant('db_');
  assertEquals(s.resolveDatabase('acme'), 'db_acme');
});
