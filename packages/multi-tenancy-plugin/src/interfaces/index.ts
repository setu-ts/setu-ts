/**
 * Multi-tenancy plugin — internal type declarations.
 *
 * This module is **type-only** (no exported values), so it compiles to nothing
 * at runtime and does not appear in coverage reports.
 *
 * @module
 */

import type {
  ITenantDataStore,
  ITenantIsolationStrategy,
  ITenantResolver,
  PathPattern,
  RegistryFactory,
} from '@setu-ts/common';

// The two data-store ports are declared in `@setu-ts/common` (M101c, V8-8) so
// `database-plugin` can implement them by name without importing this plugin
// (AI_GUIDELINES §2.2). Re-exported here so every existing import keeps
// compiling — exactly one definition exists afterwards.
export type { ITenantDataStore, ITenantIsolationStrategy } from '@setu-ts/common';

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

/** Options for {@linkcode SubdomainResolver}. */
export interface SubdomainResolverOptions {
  /** When set, strip this suffix from the host before taking the first label. */
  baseDomain?: string;
}

/** Options for {@linkcode HeaderResolver}. */
export interface HeaderResolverOptions {
  /** HTTP header name to read (default `'x-tenant-id'`). */
  name?: string;
}

/** Options for {@linkcode PathResolver}. */
export interface PathResolverOptions {
  /** Segment index in `request.path` (default `0`). */
  segment?: number;
}

/** Options for {@linkcode JwtResolver}. */
export interface JwtResolverOptions {
  /** JWT claim name that holds the tenant id (default `'tenant_id'`). */
  claim?: string;
  /** Authorization header name (default `'authorization'`). */
  headerName?: string;
  /**
   * Custom JWT-decode function. When absent the plugin resolves
   * `IJwtService.decode` from the capability token in `register()`.
   */
  decode?: (token: string) => Record<string, unknown> | null;
}

/** Options for cache-prefix stamping. */
export interface TenantCacheOptions {
  /** When `true`, write the resolved prefix into `ctx.state`. */
  prefix?: boolean;
  /** Separator between tenant id and key (default `':'`). */
  separator?: string;
}

/** Options passed to the `MemoryTenantDataStore` constructor. */
export interface MemoryTenantDataStoreOptions {
  /**
   * Generate a unique identifier for new records when `data.id` is not a
   * `string` or `number`. Defaults to a monotonic counter (`'1'`, `'2'`, …).
   */
  generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

/**
 * A string discriminant that maps to an isolation-strategy class.
 */
export type DatabaseStrategyKind =
  | 'column-per-tenant'
  | 'schema-per-tenant'
  | 'database-per-tenant';

/**
 * Resolver configuration — one string name, a custom instance, or a chain.
 */
export type ResolverConfig =
  | 'subdomain'
  | 'header'
  | 'path'
  | 'jwt'
  | ITenantResolver
  | readonly ITenantResolver[];

/**
 * Top-level options for `MultiTenancyPlugin`.
 */
export interface MultiTenancyPluginOptions {
  /** Which resolver(s) to use for tenant resolution (required). */
  resolver: ResolverConfig;
  /** Options forwarded to {@linkcode SubdomainResolver}. */
  subdomain?: SubdomainResolverOptions;
  /** Options forwarded to {@linkcode HeaderResolver}. */
  header?: HeaderResolverOptions;
  /** Options forwarded to {@linkcode PathResolver}. */
  path?: PathResolverOptions;
  /**
   * Options forwarded to {@linkcode JwtResolver}.
   *
   * **Security note:** the resolver reads the tenant id from an UNVERIFIED JWT
   * claim — a client can mint a token naming any tenant. Acceptable only
   * alongside authentication middleware which separately verifies the token.
   * A `register()` warning fires when the resolved chain contains a
   * `JwtResolver`.
   */
  jwt?: JwtResolverOptions;
  /**
   * Database-isolation strategy: a discriminant string, or a custom
   * {@linkcode ITenantIsolationStrategy} instance.
   * Default: `'column-per-tenant'`.
   *
   * A strategy NAMES the isolation an {@linkcode ITenantDataStore} is expected
   * to implement; it does not by itself create schemas or databases. The
   * shipped `MemoryTenantDataStore` uses the strategy's label as a
   * partition-map key, so all three kinds isolate correctly on it. The
   * shipped `DatabaseTenantDataStore` bridge (from `@setu-ts/database-plugin`)
   * is told the strategy and implements `'column'`; it throws
   * `TenantStoreStrategyUnsupportedError` for `'schema'` and `'database'`.
   * A `register()` warning fires when a non-`'column-per-tenant'` strategy is
   * selected with no `dataStore`.
   */
  database?: DatabaseStrategyKind | ITenantIsolationStrategy;
  /**
   * An application-provided data store. When absent the plugin ships
   * a zero-dependency {@linkcode MemoryTenantDataStore}.
   *
   * Accepts a store instance (validated and used in `register()`) or a
   * {@linkcode RegistryFactory} (M101c, V8-8) resolved in `onInit` through
   * `resolveRegistryEntry` — the M70d arm for a store that must read a
   * capability, such as `createDatabaseTenantDataStore()` from
   * `@setu-ts/database-plugin`, which resolves `CAPABILITIES.DATABASE` from
   * the registry it is handed.
   */
  dataStore?: ITenantDataStore | RegistryFactory<ITenantDataStore>;
  /** Cache-prefix behaviour. */
  cache?: TenantCacheOptions;
  /**
   * When `true` and no resolver returns a tenant, short-circuit with an
   * error response. Default: `false`.
   */
  required?: boolean;
  /** HTTP status code returned when short-circuiting (default `400`). */
  rejectionStatus?: number;
  /** Priority passed to `ctx.middleware.add` (default `40`). */
  middlewarePriority?: number;
  /**
   * Paths that skip tenant resolution entirely — no resolver runs, no tenant
   * is stamped, and a `required` deployment does not reject them. Matched
   * against `ctx.request.path` by exact string equality or `RegExp.test`.
   *
   * Default when omitted: the operational probes the framework's own plugins
   * serve — `['/live', '/ready', '/health', '/metrics', '/openapi.json',
   * '/docs']`. A matching path goes straight to `next()`. Pass `[]` to restore
   * the previous behaviour (no path is exempt) for an application whose own
   * routes sit on those paths.
   */
  exclude?: readonly PathPattern[];
}

// The data-store port ({@linkcode ITenantDataStore}) and the isolation
// strategies ({@linkcode ITenantIsolationStrategy}) are declared in
// `@setu-ts/common` and re-exported at the top of this module (M101c, V8-8).
