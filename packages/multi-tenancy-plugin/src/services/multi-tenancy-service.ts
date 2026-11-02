/**
 * Multi-tenancy service implementation.
 *
 * @module
 */
import type { IRequestContext, ITenant, ITenantRepository, Option } from '@setu-ts/common';
import type { IMultiTenancyService, ITenantDataStore } from '@setu-ts/common';
import { TenantDataStoreNotReadyError, TenantNotResolvedError } from '../errors.ts';
import { TenantCheck } from '../registry/tenant-check.ts';
import { TenantRepository } from '../repositories/tenant-repository.ts';

/**
 * Default cache-key separator.
 */
const DEFAULT_SEPARATOR = ':';

/**
 * Implements `IMultiTenancyService`: current-tenant lookup, repository
 * factory, and cache-key prefixing.
 *
 * The store is late-bound (M101c, V8-8): when the plugin's `dataStore` option
 * is a `RegistryFactory`, the service is constructed with no store and the
 * resolved one is handed to {@linkcode bindStore} from the plugin's `onInit`
 * hook. A repository request before that point throws
 * {@linkcode TenantDataStoreNotReadyError} — unreachable on the HTTP path
 * (every `register()` phase completes before any `onInit`, and the tenant
 * middleware runs per request), reachable only from a `register()`-time call,
 * which is a misuse worth naming.
 */
export class MultiTenancyService implements IMultiTenancyService {
  private store: ITenantDataStore | null;
  private readonly separator: string;
  private readonly tenantCheck: TenantCheck;

  /**
   * @param options.store - The data store, unless a factory binds it later
   * @param options.separator - The cache-key separator (default `':'`)
   * @param options.check - The tenant check shared with the middleware;
   * omitted admits every id (no `tenants` registry)
   */
  constructor(options: { store?: ITenantDataStore; separator?: string; check?: TenantCheck }) {
    this.store = options.store ?? null;
    this.separator = options.separator ?? DEFAULT_SEPARATOR;
    this.tenantCheck = options.check ?? new TenantCheck({ configured: false });
  }

  /**
   * With no `tenants` registry, answers `some({ id })` — what the HTTP path
   * admits — so it is not validation without one. With a registry, runs the
   * SAME check as the tenant middleware.
   *
   * @throws {TenantRegistryUnavailableError} When the registry could not answer
   */
  lookupTenant(id: string): Promise<Option<ITenant>> {
    return this.tenantCheck.check(id);
  }

  /**
   * Hands the resolved store to the service, from the plugin's `onInit` hook
   * when the `dataStore` option was a factory (M101c, V8-8).
   */
  bindStore(store: ITenantDataStore): void {
    this.store = store;
  }

  /** The bound store; throws when it is not bound yet. */
  private requireStore(): ITenantDataStore {
    if (this.store === null) {
      throw new TenantDataStoreNotReadyError();
    }
    return this.store;
  }

  /** Return the tenant resolved for this request context, or `undefined`. */
  getCurrentTenant(ctx: IRequestContext): ITenant | undefined {
    return ctx.request.tenant;
  }

  /**
   * Create a tenant-scoped repository for the given entity type.
   * Throws `TenantNotResolvedError` if no tenant is resolved.
   */
  getRepository<Entity, Id = string>(
    ctx: IRequestContext,
    entity: string,
  ): ITenantRepository<Entity, Id> {
    const tenant = ctx.request.tenant;
    if (!tenant) {
      throw new TenantNotResolvedError(
        'Tenant not resolved: set ctx.request.tenant via middleware, or call getRepository only after resolution.',
      );
    }
    return new TenantRepository<Entity, Id>(this.requireStore(), tenant.id, entity);
  }

  /**
   * Create a tenant-scoped repository scoped to the tenant id GIVEN — the
   * ctx-free entry point for non-HTTP work (an ingress behaviour, a queue
   * processor, a scheduled job). The id is trusted input; on the HTTP path
   * use `getRepository`, which reads the middleware-resolved tenant.
   */
  getRepositoryFor<Entity, Id = string>(
    tenantId: string,
    entity: string,
  ): ITenantRepository<Entity, Id> {
    return new TenantRepository<Entity, Id>(this.requireStore(), tenantId, entity);
  }

  /**
   * Build a cache key that includes the tenant id and separator.
   * Uses the separator configured at construction.
   */
  prefixCacheKey(tenantId: string, key: string): string {
    return `${tenantId}${this.separator}${key}`;
  }
}
