/**
 * Default loadContext bridge — exposes kernel DI and the authenticated user.
 *
 * @module
 * @since 0.1.0
 */

import type { IRequestContext, RouterLoadContext } from '../interfaces/index.ts';
import { servicesContext, userContext } from './context-keys.ts';

/**
 * Populates the per-request React Router context with the plugin's defaults.
 *
 * Sets {@linkcode servicesContext} to the kernel service registry, and
 * {@linkcode userContext} to the authenticated principal when one is attached.
 * An anonymous request leaves `userContext` unset, which resolves to the key's
 * `null` default rather than throwing.
 *
 * @param ctx - The kernel request context
 * @param context - The React Router context provider to populate
 * @since 0.2.0
 */
export function applyDefaultLoadContext(
  ctx: IRequestContext,
  context: RouterLoadContext,
): void {
  context.set(servicesContext, ctx.services);

  if (ctx.request.user != null) {
    context.set(userContext, ctx.request.user);
  }
}
