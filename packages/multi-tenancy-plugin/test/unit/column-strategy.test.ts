/**
 * ColumnPerTenant strategy tests.
 */
import { assertEquals } from 'jsr:@std/assert';
import { ColumnPerTenant } from '../../src/strategies/column-strategy.ts';

Deno.test('ColumnPerTenant — kind is column', () => {
  const s = new ColumnPerTenant();
  assertEquals(s.kind, 'column');
});

Deno.test('ColumnPerTenant — default column name', () => {
  const s = new ColumnPerTenant();
  assertEquals(s.getTenantColumn(), 'tenant_id');
});

Deno.test('ColumnPerTenant — custom column name', () => {
  const s = new ColumnPerTenant('org_id');
  assertEquals(s.getTenantColumn(), 'org_id');
});
