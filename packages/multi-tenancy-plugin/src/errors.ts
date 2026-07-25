/**
 * Multi-tenancy plugin — error classes.
 *
 * @module
 */

/**
 * Thrown by {@linkcode IMultiTenancyService.getRepository} when no tenant
 * is resolved in the request context.
 *
 * @since 0.1.0
 */
export class TenantNotResolvedError extends Error {
  constructor(message = 'Tenant not resolved') {
    super(message);
    this.name = 'TenantNotResolvedError';
  }
}
