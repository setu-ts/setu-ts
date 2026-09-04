/**
 * Barrel export verification — every symbol from §4 of the plan is present.
 */
import * as barrel from '../../src/index.ts';
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

/** The complete published VALUE surface. Types are excluded (erasable). */
const EXPECTED_VALUES = [
  'CAPABILITIES',
  'ColumnPerTenant',
  'DatabasePerTenant',
  'HeaderResolver',
  'JwtResolver',
  'MemoryTenantDataStore',
  'MultiTenancyPlugin',
  'PathResolver',
  'SchemaPerTenant',
  'SubdomainResolver',
  'TENANT_CACHE_PREFIX_STATE_KEY',
  'TenantNotResolvedError',
  'getTenantCachePrefix',
  'tenantMiddleware',
] as const;

describe('barrel exports', () => {
  it('exports exactly the documented values, and nothing else (M89a: unchanged surface)', () => {
    // The M56 defect class in reverse: this milestone changed internal
    // behaviour only, so the value surface must not have grown by a single
    // symbol.
    expect(Object.keys(barrel).sort()).toEqual([...EXPECTED_VALUES].sort());
  });

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
