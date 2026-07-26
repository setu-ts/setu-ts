/**
 * Barrel export verification — every symbol from §4 of the plan is present.
 */
import {
  CAPABILITIES,
  ColumnPerTenant,
  DatabasePerTenant,
  getTenantCachePrefix,
  HeaderResolver,
  JwtResolver,
  MemoryTenantDataStore,
  MultiTenancyPlugin,
  PathResolver,
  SchemaPerTenant,
  SubdomainResolver,
  TENANT_CACHE_PREFIX_STATE_KEY,
  tenantMiddleware,
  TenantNotResolvedError,
} from '../../src/index.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

describe('barrel exports', () => {
  it('barrel — all §4 exports are present', () => {
    expect(typeof MultiTenancyPlugin).toEqual('function');
    expect(typeof tenantMiddleware).toEqual('function');
    expect(typeof getTenantCachePrefix).toEqual('function');
    expect(typeof TENANT_CACHE_PREFIX_STATE_KEY).toEqual('string');
    expect(typeof SubdomainResolver.prototype.resolve).toEqual('function');
    expect(typeof HeaderResolver.prototype.resolve).toEqual('function');
    expect(typeof PathResolver.prototype.resolve).toEqual('function');
    expect(typeof JwtResolver.prototype.resolve).toEqual('function');
    expect(typeof ColumnPerTenant.prototype.getTenantColumn).toEqual('function');
    expect(typeof SchemaPerTenant.prototype.resolveSchema).toEqual('function');
    expect(typeof DatabasePerTenant.prototype.resolveDatabase).toEqual('function');
    expect(typeof MemoryTenantDataStore.prototype.create).toEqual('function');
    expect(TenantNotResolvedError.prototype instanceof Error).toEqual(true);
    expect(typeof CAPABILITIES.MULTI_TENANCY).toEqual('string');
    expect(CAPABILITIES.MULTI_TENANCY).toEqual('multi-tenancy');
  });
});
