/**
 * ColumnPerTenant strategy tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ColumnPerTenant } from '../../src/strategies/column-strategy.ts';

describe('column strategy', () => {
  it('ColumnPerTenant — kind is column', () => {
    const s = new ColumnPerTenant();
    expect(s.kind).toEqual('column');
  });

  it('ColumnPerTenant — default column name', () => {
    const s = new ColumnPerTenant();
    expect(s.getTenantColumn()).toEqual('tenant_id');
  });

  it('ColumnPerTenant — custom column name', () => {
    const s = new ColumnPerTenant('org_id');
    expect(s.getTenantColumn()).toEqual('org_id');
  });
});
