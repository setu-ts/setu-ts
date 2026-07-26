/**
 * SchemaPerTenant strategy tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SchemaPerTenant } from '../../src/strategies/schema-strategy.ts';

describe('schema strategy', () => {
  it('SchemaPerTenant — kind is schema', () => {
    const s = new SchemaPerTenant();
    expect(s.kind).toEqual('schema');
  });

  it('SchemaPerTenant — default prefix', () => {
    const s = new SchemaPerTenant();
    expect(s.resolveSchema('acme')).toEqual('tenant_acme');
  });

  it('SchemaPerTenant — custom prefix', () => {
    const s = new SchemaPerTenant('db_');
    expect(s.resolveSchema('acme')).toEqual('db_acme');
  });
});
