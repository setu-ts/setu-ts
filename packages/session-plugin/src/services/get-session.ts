/**
 * Free-function access to the current request's session.
 *
 * This is the single entry point application code uses, and the same one the
 * CSRF helpers and any framework bridge use, so a session obtained in a React
 * Router loader is byte-for-byte the session the handler sees.
 *
 * @module
 */
import type { IRequestContext, ISession, ISessionService } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

/**
 * Returns the session the middleware loaded for this request.
 *
 * @param ctx - The request context
 * @returns The session for this request
 * @throws {Error} If `SessionPlugin` is not registered
 * @throws {SessionMiddlewareMissingError} If the session middleware did not run
 * @example
 * ```typescript
 * app.router.post('/cart', (ctx) => {
 *   const session = getSession(ctx);
 *   session.set('cartId', 'c-123');
 *   return ctx.response.json({ ok: true });
 * });
 * ```
 * @example
 * ```typescript
 * // Reaching the session from a React Router loader (Milestone 44):
 * ReactRouterPlugin({
 *   build,
 *   populateLoadContext: (ctx, context) => {
 *     context.set(sessionContext, getSession(ctx));
 *   },
 * });
 * ```
 * @since 0.2.0
 */
export function getSession(ctx: IRequestContext): ISession {
  return ctx.services.get<ISessionService>(CAPABILITIES.SESSION).from(ctx);
}
