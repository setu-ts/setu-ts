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
  TenantDataStoreNotReadyError,
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
  'TenantDataStoreNotReadyError',
  'TenantNotResolvedError',
  'getTenantCachePrefix',
  'tenantMiddleware',
] as const;

describe('barrel exports', () => {
  it('exports exactly the documented values, and nothing else', () => {
    // The M56 defect class in reverse: the value surface must match the plan's
    // §4 exactly. M101c added exactly one value symbol —
    // `TenantDataStoreNotReadyError` (the factory arm's named refusal); the
    // two promoted ports are types and so stay out of this list.
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
    expect(TenantDataStoreNotReadyError.prototype instanceof Error).toEqual(true);
    expect(typeof CAPABILITIES.MULTI_TENANCY).toEqual('string');
    expect(CAPABILITIES.MULTI_TENANCY).toEqual('multi-tenancy');
  });

  it('the re-exported IMultiTenancyService carries the M89c ctx-free member (declared against the barrel)', () => {
    // Type-level: `getRepositoryFor` resolves through the BARREL's re-export
    // of the common interface with the committed signature. Compile-time only
    // — a member is invisible to every runtime assertion — plus a runtime
    // call through a minimal implementation so the file fails loudly too.
    const service: barrel.IMultiTenancyService = {
      getCurrentTenant: () => undefined,
      getRepository: () => {
        throw new Error('not used here');
      },
      getRepositoryFor: <Entity, Id = string>(
        tenantId: string,
      ): import('@setu-ts/common').ITenantRepository<Entity, Id> => ({
        findAll: () => Promise.resolve([] as readonly Entity[]),
        findById: () => Promise.resolve(null),
        find: () => Promise.resolve([] as readonly Entity[]),
        create: (data) =>
          Promise.resolve({ ...(data as Record<string, unknown>), tenantId } as unknown as Entity),
        update: () => Promise.resolve(null),
        delete: () => Promise.resolve(false),
      }),
      prefixCacheKey: (tenantId, key) => `${tenantId}:${key}`,
    };
    expect(typeof service.getRepositoryFor).toBe('function');
    expect(service.prefixCacheKey('a', 'k')).toBe('a:k');
  });
});
