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
import { assertEquals, assertType } from 'jsr:@std/assert';

Deno.test('barrel — all §4 exports are present', () => {
  assertEquals(typeof MultiTenancyPlugin, 'function');
  assertEquals(typeof tenantMiddleware, 'function');
  assertEquals(typeof getTenantCachePrefix, 'function');
  assertEquals(typeof TENANT_CACHE_PREFIX_STATE_KEY, 'string');
  assertEquals(typeof SubdomainResolver.prototype.resolve, 'function');
  assertEquals(typeof HeaderResolver.prototype.resolve, 'function');
  assertEquals(typeof PathResolver.prototype.resolve, 'function');
  assertEquals(typeof JwtResolver.prototype.resolve, 'function');
  assertEquals(typeof ColumnPerTenant.prototype.getTenantColumn, 'function');
  assertEquals(typeof SchemaPerTenant.prototype.resolveSchema, 'function');
  assertEquals(typeof DatabasePerTenant.prototype.resolveDatabase, 'function');
  assertEquals(typeof MemoryTenantDataStore.prototype.create, 'function');
  assertEquals(TenantNotResolvedError.prototype instanceof Error, true);
  assertEquals(typeof CAPABILITIES.MULTI_TENANCY, 'string');
  assertEquals(CAPABILITIES.MULTI_TENANCY, 'multi-tenancy');
});
