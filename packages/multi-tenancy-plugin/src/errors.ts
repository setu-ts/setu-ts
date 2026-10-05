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

/**
 * Thrown by {@linkcode IMultiTenancyService.getRepository} and
 * {@linkcode IMultiTenancyService.getRepositoryFor} when the plugin's
 * `dataStore` option is a `RegistryFactory` that has not been resolved yet —
 * i.e. the repository is requested before the plugin's `onInit` hook ran
 * (M101c, V8-8).
 *
 * Unreachable on the HTTP path: every `register()` phase completes before any
 * `onInit`, and the tenant middleware runs per request. Reachable only from a
 * `register()`-time repository call, which is a misuse worth naming.
 *
 * @since 0.9.0
 */
export class TenantDataStoreNotReadyError extends Error {
  /**
   * Records a repository request made before the store was bound.
   *
   * @param message - The refusal, naming `onInit` and the factory arm
   */
  constructor(
    message = 'MultiTenancyPlugin: the dataStore factory is resolved in onInit; a repository ' +
      'request before onInit has no store to delegate to',
  ) {
    super(message);
    this.name = 'TenantDataStoreNotReadyError';
  }
}
