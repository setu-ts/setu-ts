/**
 * Multi-tenancy plugin — internal type declarations.
 *
 * This module is **type-only** (no exported values), so it compiles to nothing
 * at runtime and does not appear in coverage reports.
 *
 * @module
 */

import type { ITenantResolver } from '@hono-enterprise/common';

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
  /** Options forwarded to {@linkcode JwtResolver}. */
  jwt?: JwtResolverOptions;
  /**
   * Database-isolation strategy: a discriminant string, or a custom
   * {@linkcode ITenantIsolationStrategy} instance.
   * Default: `'column-per-tenant'`.
   */
  database?: DatabaseStrategyKind | ITenantIsolationStrategy;
  /**
   * An application-provided data store. When absent the plugin ships
   * a zero-dependency {@linkcode MemoryTenantDataStore}.
   */
  dataStore?: ITenantDataStore;
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
}

// ---------------------------------------------------------------------------
// Data-store port
// ---------------------------------------------------------------------------

/**
 * Tenant-scoped data-store port.
 *
 * Implemented by the shipped `MemoryTenantDataStore` (zero-dependency default)
 * and by application-provided backends that consume real databases.
 */
export interface ITenantDataStore {
  /**
   * Receives the resolved isolation strategy once, during `register()`.
   * Optional so a store may ignore isolation metadata entirely.
   */
  useIsolation?(strategy: ITenantIsolationStrategy): void;

  /** Retrieve all records of an entity for a tenant. */
  findAll<E>(tenantId: string, entity: string): Promise<readonly E[]>;
  /** Find a single record by its identifier. */
  findById<E, Id>(tenantId: string, entity: string, id: Id): Promise<E | null>;
  /** Find records matching a filter. */
  find<E>(
    tenantId: string,
    entity: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly E[]>;
  /** Create a new record; returns the stored entity including its id. */
  create<E>(
    tenantId: string,
    entity: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E>;
  /** Update an existing record; returns `null` when the id is unknown. */
  update<E, Id>(
    tenantId: string,
    entity: string,
    id: Id,
    data: Readonly<Record<string, unknown>>,
  ): Promise<E | null>;
  /** Delete a record. Returns `true` if a record was deleted. */
  delete<Id>(tenantId: string, entity: string, id: Id): Promise<boolean>;
  /** Gracefully close any connections. */
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Isolation strategies (public — apps implement this)
// ---------------------------------------------------------------------------

/**
 * Pluggable database-isolation strategy.
 *
 * The plugin hands the resolved strategy to the data store via
 * {@linkcode ITenantDataStore.useIsolation} so the store can derive its
 * partition scope. Narrow on `kind` to reach an arm's method; a standalone
 * kind alias is deliberately not exported, since `ITenantIsolationStrategy['kind']`
 * already names it without a second symbol to keep in sync.
 */
export type ITenantIsolationStrategy =
  | { readonly kind: 'column'; getTenantColumn(): string }
  | { readonly kind: 'schema'; resolveSchema(tenantId: string): string }
  | { readonly kind: 'database'; resolveDatabase(tenantId: string): string };
