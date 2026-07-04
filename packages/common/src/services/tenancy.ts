/**
 * Multi-tenancy contracts, consumed by the MultiTenancyPlugin.
 *
 * @module
 */
import type { IRequest } from '../http.ts';
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
