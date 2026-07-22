/**
 * Default loadContext bridge — exposes kernel DI and the authenticated user.
 *
 * @module
 * @since 0.1.0
 */

import type { IRequestContext, LoadContextFunction } from '../interfaces/index.ts';

/**
 * Creates the default `loadContext` function for React Router.
 *
 * Returns `{ services, user }` — with `user` omitted (not set to `undefined`)
 * when no principal is attached, honoring `exactOptionalPropertyTypes`.
 *
 * @param ctx - The kernel request context
 * @returns A `Record<string, unknown>` suitable as RR's `loadContext`
 * @since 0.1.0
 */
export function createDefaultLoadContext(
  ctx: IRequestContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    services: ctx.services,
  };

  // Omit `user` entirely when absent — never assign `undefined` to an optional
  // property under `exactOptionalPropertyTypes`.
  if (ctx.request.user != null) {
    result.user = ctx.request.user;
  }

  return result;
}
