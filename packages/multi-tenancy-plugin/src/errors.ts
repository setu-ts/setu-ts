/**
 * Multi-tenancy plugin — error classes.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * Title of the `503` a registry fault answers — written by the tenant
 * middleware and carried by {@linkcode TenantRegistryUnavailableError}'s status
 * hint, so both entry points answer identically. Internal (not exported from
 * `src/index.ts`).
 */
export const REGISTRY_UNAVAILABLE_TITLE = 'Tenant Registry Unavailable';

/** Caller-facing detail of the registry-fault `503`; never names the tenant. */
export const REGISTRY_UNAVAILABLE_DETAIL = 'The tenant could not be checked; try again later';

/**
 * Thrown by the tenant registry check when the configured `tenants` registry
 * could not answer: its `lookup` threw (the original is the `cause`), it
 * returned a malformed answer, or a factory registry is consulted before the
 * plugin's `onInit` bound it. Surfaced by
 * {@linkcode IMultiTenancyService.lookupTenant}, so a queue job retries rather
 * than proceeding; the tenant middleware answers it with a `503`.
 *
 * Branded with a `503` HTTP status hint carrying the middleware's own title and
 * detail, so a handler that lets it escape answers the same `503` through
 * `errorHandler` rather than a masked `500`. The message never contains the
 * requested tenant id.
 *
 * @since 0.12.0
 */
export class TenantRegistryUnavailableError extends Error {
  /**
   * Records a registry fault.
   *
   * @param message - The operator-facing reason (never the requested id)
   * @param options - `cause`: the registry's own error, when there was one
   */
  constructor(
    message: string = 'The tenant registry could not be consulted',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TenantRegistryUnavailableError';
    withHttpStatusHint(this, {
      status: 503,
      title: REGISTRY_UNAVAILABLE_TITLE,
      detail: REGISTRY_UNAVAILABLE_DETAIL,
    });
  }
}

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
    message: string = 'MultiTenancyPlugin: the dataStore factory is resolved in onInit; a repository ' +
      'request before onInit has no store to delegate to',
  ) {
    super(message);
    this.name = 'TenantDataStoreNotReadyError';
  }
}
