/**
 * Multi-tenancy service implementation.
 *
 * @module
 */
import type { IRequestContext, ITenant, ITenantRepository } from '@hono-enterprise/common';
import type { IMultiTenancyService } from '@hono-enterprise/common';
import type { ITenantDataStore } from '../interfaces/index.ts';
import { TenantNotResolvedError } from '../errors.ts';
import { TenantRepository } from '../repositories/tenant-repository.ts';

/**
 * Default cache-key separator.
 */
const DEFAULT_SEPARATOR = ':';

/**
 * Implements `IMultiTenancyService`: current-tenant lookup, repository
 * factory, and cache-key prefixing.
 */
export class MultiTenancyService implements IMultiTenancyService {
  private readonly store: ITenantDataStore;
  private readonly separator: string;

  constructor(options: { store: ITenantDataStore; separator?: string }) {
    this.store = options.store;
    this.separator = options.separator ?? DEFAULT_SEPARATOR;
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
    return new TenantRepository<Entity, Id>(this.store, tenant.id, entity);
  }

  /**
   * Build a cache key that includes the tenant id and separator.
   * Uses the separator configured at construction.
   */
  prefixCacheKey(tenantId: string, key: string): string {
    return `${tenantId}${this.separator}${key}`;
  }
}
