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
