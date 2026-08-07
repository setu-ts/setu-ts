/**
 * @module
 *
 * `@setu-ts/multi-tenancy-plugin` — multi-tenancy support for Setu-TS.
 */

// Re-export types from common for convenience.
export type {
  IMultiTenancyService,
  ITenant,
  ITenantRepository,
  ITenantResolver,
} from '@setu-ts/common';
export { CAPABILITIES } from '@setu-ts/common';

// Plugin factory.
export { MultiTenancyPlugin } from './plugin/multi-tenancy-plugin.ts';

// Middleware.
export {
  getTenantCachePrefix,
  TENANT_CACHE_PREFIX_STATE_KEY,
  tenantMiddleware,
} from './middleware/tenant-middleware.ts';

// Resolvers.
export { SubdomainResolver } from './resolvers/subdomain-resolver.ts';
export { HeaderResolver } from './resolvers/header-resolver.ts';
export { PathResolver } from './resolvers/path-resolver.ts';
export { JwtResolver } from './resolvers/jwt-resolver.ts';

// Strategies.
export { ColumnPerTenant } from './strategies/column-strategy.ts';
export { SchemaPerTenant } from './strategies/schema-strategy.ts';
export { DatabasePerTenant } from './strategies/database-strategy.ts';

// Store.
export { MemoryTenantDataStore } from './stores/memory-tenant-store.ts';

// Error.
export { TenantNotResolvedError } from './errors.ts';

// Internal interfaces (types only — exported for injection).
export type {
  DatabaseStrategyKind,
  HeaderResolverOptions,
  ITenantDataStore,
  ITenantIsolationStrategy,
  JwtResolverOptions,
  MemoryTenantDataStoreOptions,
  MultiTenancyPluginOptions,
  PathResolverOptions,
  ResolverConfig,
  SubdomainResolverOptions,
  TenantCacheOptions,
} from './interfaces/index.ts';
