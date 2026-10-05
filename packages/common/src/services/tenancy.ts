/**
 * Multi-tenancy contracts, consumed by the MultiTenancyPlugin.
 *
 * @module
 */
import type { IRequest, IRequestContext } from '../http.ts';
import type { Option } from '../option.ts';

/**
 * A resolved tenant.
 *
 * @since 0.1.0
 */
export interface ITenant {
  /** Stable tenant identifier. */
  readonly id: string;
  /** Display name. */
  readonly name?: string;
  /** Tenant-specific configuration. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Tenant-scoped repository — delegates CRUD to the data store the
 * multi-tenancy plugin was configured with (`ITenantDataStore`, declared in
 * that plugin), while threading the resolved tenant id.
 *
 * @since 0.1.0
 */
export interface ITenantRepository<Entity, Id = string> {
  /** Retrieve all records. */
  findAll(): Promise<readonly Entity[]>;
  /** Find a single record by its identifier. */
  findById(id: Id): Promise<Entity | null>;
  /** Find records matching a filter. */
  find(filter: Readonly<Record<string, unknown>>): Promise<readonly Entity[]>;
  /** Create a new record. */
  create(data: Readonly<Record<string, unknown>>): Promise<Entity>;
  /** Update an existing record by its identifier. */
  update(id: Id, data: Readonly<Record<string, unknown>>): Promise<Entity | null>;
  /** Delete a record by its identifier. Returns `true` if a record was deleted. */
  delete(id: Id): Promise<boolean>;
}

/**
 * Multi-tenancy service — exposes tenant context, repository creation,
 * and cache-key helpers.
 *
 * @since 0.1.0
 */
export interface IMultiTenancyService {
  /** Return the tenant resolved for this request context, or `undefined`. */
  getCurrentTenant(ctx: IRequestContext): ITenant | undefined;
  /**
   * Create a tenant-scoped repository for the given entity type.
   * Throws {@linkcode TenantNotResolvedError} if no tenant is resolved.
   *
   * @param ctx - The current request context
   * @param entity - Entity name for scoping
   * @returns A tenant-scoped repository
   */
  getRepository<Entity, Id = string>(
    ctx: IRequestContext,
    entity: string,
  ): ITenantRepository<Entity, Id>;
  /**
   * Create a tenant-scoped repository for the given entity type, scoped to
   * the tenant id GIVEN — no `IRequestContext` required. This is the entry
   * point for non-HTTP work (an ingress behaviour, a queue processor, a
   * scheduled job), where no request exists to resolve a tenant from; the
   * caller reads the tenant id from the work item's own payload. Modelled on
   * {@linkcode prefixCacheKey} — this interface's other ctx-free, id-taking
   * member.
   *
   * The id is TRUSTED INPUT: nothing resolves it, so a caller passing a
   * user-controlled value bypasses the resolved tenant. On the HTTP path use
   * {@linkcode getRepository}, which reads the middleware-resolved
   * `ctx.request.tenant`.
   *
   * @param tenantId - The tenant id to scope the repository to (trusted input)
   * @param entity - Entity name for scoping
   * @returns A tenant-scoped repository
   * @since 0.4.0
   */
  getRepositoryFor<Entity, Id = string>(
    tenantId: string,
    entity: string,
  ): ITenantRepository<Entity, Id>;
  /**
   * Build a cache key that includes the tenant id, joined by the separator
   * the plugin was configured with (`cache.separator`, default `':'`). The
   * separator is deliberately NOT a per-call argument: this method is the
   * single home for separator resolution, so the middleware's `ctx.state`
   * prefix and a caller's key can never disagree.
   *
   * @param tenantId - The resolved tenant id
   * @param key - The base cache key
   * @returns The prefixed cache key
   */
  prefixCacheKey(tenantId: string, key: string): string;
}

/**
 * Resolves the tenant for an incoming request (by subdomain, header, path,
 * or JWT claim, depending on the implementation).
 *
 * @example
 * ```typescript
 * const resolver: ITenantResolver = {
 *   async resolve(request) {
 *     const header = request.headers.get('x-tenant-id');
 *     return header ? some({ id: header }) : none();
 *   },
 * };
 * ```
 * @since 0.1.0
 */
export interface ITenantResolver {
  /**
   * Resolves the request's tenant.
   *
   * @param request - The incoming request
   * @returns `Some` with the tenant, or `None` when unresolvable
   */
  resolve(request: IRequest): Promise<Option<ITenant>>;
}

/**
 * Tenant-scoped data-store port.
 *
 * Implemented by the multi-tenancy plugin's shipped `MemoryTenantDataStore`
 * (zero-dependency default), by `database-plugin`'s `DatabaseTenantDataStore`
 * (the bridge over `IDatabaseService`, M101c V8-8), and by application-
 * provided backends that consume real databases.
 *
 * Promoted from `@setu-ts/multi-tenancy-plugin` to `common` so a package that
 * implements a store (`database-plugin`) can name the port without importing
 * the plugin that declares its consumer (AI_GUIDELINES §2.2); the plugin
 * re-exports the type so existing imports keep compiling.
 *
 * @since 0.9.0
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

/**
 * Pluggable database-isolation strategy.
 *
 * The plugin hands the resolved strategy to the data store via
 * {@linkcode ITenantDataStore.useIsolation} so the store can derive its
 * partition scope. Narrow on `kind` to reach an arm's method; a standalone
 * kind alias is deliberately not exported, since
 * `ITenantIsolationStrategy['kind']` already names it without a second
 * symbol to keep in sync.
 *
 * Promoted from `@setu-ts/multi-tenancy-plugin` to `common` alongside
 * {@linkcode ITenantDataStore} (M101c V8-8); the plugin re-exports the type
 * so existing imports keep compiling.
 *
 * @since 0.9.0
 */
export type ITenantIsolationStrategy =
  | { readonly kind: 'column'; getTenantColumn(): string }
  | { readonly kind: 'schema'; resolveSchema(tenantId: string): string }
  | { readonly kind: 'database'; resolveDatabase(tenantId: string): string };
