/**
 * DatabasePerTenant strategy tests.
 */
import { describe, expect, it } from 'vitest';
import { DatabasePerTenant } from '../../src/strategies/database-strategy.ts';

describe('database strategy', () => {
  it('DatabasePerTenant — kind is database', () => {
    const s = new DatabasePerTenant();
    expect(s.kind).toEqual('database');
  });

  it('DatabasePerTenant — default prefix', () => {
    const s = new DatabasePerTenant();
    expect(s.resolveDatabase('acme')).toEqual('tenant_acme');
  });

  it('DatabasePerTenant — custom prefix', () => {
    const s = new DatabasePerTenant('db_');
    expect(s.resolveDatabase('acme')).toEqual('db_acme');
  });
});
