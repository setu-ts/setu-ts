/**
 * Default loadContext bridge — exposes kernel DI and the authenticated user.
 *
 * @module
 * @since 0.1.0
 */

import { resolveRequestService } from '@setu-ts/common';
import type { IRequestContext, RouterLoadContext } from '../interfaces/index.ts';
import { servicesContext, userContext } from './context-keys.ts';
import { serviceResolverContext } from './get-service.ts';
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

/**
 * Populates the per-request React Router context with the plugin's defaults.
 *
 * Sets {@linkcode servicesContext} to the kernel service registry,
 * {@linkcode serviceResolverContext} to a resolver closure over this request
 * (the closure, never `ctx`, is what a page can reach), and
 * {@linkcode userContext} to the authenticated principal when one is attached.
 * An anonymous request leaves `userContext` unset, which resolves to the key's
 * `null` default rather than throwing.
 *
 * @param ctx - The kernel request context
 * @param context - The React Router context provider to populate
 * @since 0.2.0
 */
export function applyDefaultLoadContext(ctx: IRequestContext, context: RouterLoadContext): void {
  context.set(servicesContext, ctx.services);
  function resolver<K extends keyof CapabilityServices>(
    token: StandardCapabilityToken<K>,
  ): CapabilityServices[K];
  function resolver<T extends object>(token: StandardCapabilityToken<KeysServing<T>>): T;
  function resolver<T extends object>(token: StandardCapabilityToken<UnboundCapability>): T;
  function resolver<T extends object>(token: ServiceToken<T> | RequestServiceToken<T>): T;
  function resolver<T extends object>(token: UnboundToken): T;
  function resolver(token: CapabilityToken): object {
    return resolveRequestService<object>(ctx, token);
  }
  context.set(serviceResolverContext, resolver);

  if (ctx.request.user != null) {
    context.set(userContext, ctx.request.user);
  }
}
