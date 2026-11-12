/**
 * `getService` — a loader's one-line route to a kernel service bound to the
 * current request (M130). The plugin's bridge places a resolver closure in the
 * load context, never the kernel request context itself.
 *
 * @module
 * @since 0.12.0
 */

import type {
  CapabilityToken,
  CapabilityServices,
  StandardCapabilityToken,
  KeysServing,
  UnboundCapability,
  UnboundToken,
  ServiceToken,
  RequestServiceToken,
} from '@setu-ts/common';
import type { RouterContextKey } from '../interfaces/index.ts';
import { contextKeyFor } from './context-keys.ts';

/**
 * Resolves a service for the request the load context belongs to. Set by the
 * plugin's request bridge; a page test sets a fake one.
 *
 * @since 0.12.0
 */
export interface ServiceResolver {
  <K extends keyof CapabilityServices>(token: StandardCapabilityToken<K>): CapabilityServices[K];
  <T extends object>(token: StandardCapabilityToken<KeysServing<T>>): T;
  <T extends object>(token: StandardCapabilityToken<UnboundCapability>): T;
  <T extends object>(token: ServiceToken<T> | RequestServiceToken<T>): T;
  <T extends object>(token: UnboundToken): T;
}

/**
 * Key holding the current request's {@linkcode ServiceResolver}, or `null` when
 * the request was not served through `ReactRouterPlugin`'s bridge. Created with
 * {@linkcode contextKeyFor}, so its identity survives the separately bundled
 * SSR build.
 *
 * @example A page test with a fake resolver
 * ```typescript
 * const context = new RouterContextProvider();
 * context.set(serviceResolverContext, (token) => fakes[token]);
 * ```
 * @since 0.12.0
 */
export const serviceResolverContext: RouterContextKey<ServiceResolver | null> =
  contextKeyFor<ServiceResolver | null>('setu.react-router.service-resolver', null);

/**
 * Thrown by {@linkcode getService} when the load context carries no resolver:
 * the request was not served through `ReactRouterPlugin`, or a test did not
 * set {@linkcode serviceResolverContext}.
 *
 * @since 0.12.0
 */
export class ServiceResolverUnavailableError extends Error {
  /** Stable error discriminant. */
  override readonly name = 'ServiceResolverUnavailableError';

  /** Creates the error with its fixed explanation. */
  constructor() {
    super(
      'getService needs a request served by ReactRouterPlugin; in a test, set ' +
        'serviceResolverContext on the RouterContextProvider.',
    );
  }
}

/**
 * Resolves a kernel service for the current request from a loader, action or
 * `handleError`. A module's request-bound service is built once per request
 * and shared with kernel routes resolving the same token in that request.
 *
 * @typeParam T - The service type, inferred from a `ServiceToken`
 * @param context - React Router's `context` argument
 * @param token - The token the service is registered under
 * @returns The request's instance, or the registered singleton
 * @throws {ServiceResolverUnavailableError} If the context carries no resolver
 * @throws {RequestServiceUnavailableError} If nothing is registered under the token
 * @example
 * ```typescript
 * import { getService } from '@setu-ts/react-router-plugin';
 * import { PRODUCTS } from '~kernel/modules/products/products.token.ts';
 *
 * export async function loader({ context }: Route.LoaderArgs) {
 *   return { products: await getService(context, PRODUCTS).list() };
 * }
 * ```
 * @since 0.12.0
 */
export function getService<K extends keyof CapabilityServices>(
  context: { get<V>(key: RouterContextKey<V>): V },
  token: StandardCapabilityToken<K>,
): CapabilityServices[K];
export function getService<T extends object>(
  context: { get<V>(key: RouterContextKey<V>): V },
  token: StandardCapabilityToken<KeysServing<T>>,
): T;
export function getService<T extends object>(
  context: { get<V>(key: RouterContextKey<V>): V },
  token: StandardCapabilityToken<UnboundCapability>,
): T;
export function getService<T extends object>(
  context: { get<V>(key: RouterContextKey<V>): V },
  token: ServiceToken<T> | RequestServiceToken<T>,
): T;
export function getService<T extends object>(
  context: { get<V>(key: RouterContextKey<V>): V },
  token: UnboundToken,
): T;
export function getService(
  context: { get<V>(key: RouterContextKey<V>): V },
  token: CapabilityToken,
): object {
  const resolve = context.get(serviceResolverContext);
  if (resolve === null) throw new ServiceResolverUnavailableError();
  return resolve<object>(token);
}
