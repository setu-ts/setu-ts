/**
 * Session middleware — loads before the handler, commits after it.
 *
 * @module
 */
import type { IRequestContext, MiddlewareFunction, NextFunction } from '@hono-enterprise/common';

import { SESSION_STATE_KEY } from '../services/session-service.ts';
import type { SessionService } from '../services/session-service.ts';

/**
 * Builds the session middleware.
 *
 * Registered by the plugin at priority 260: after security headers (250) so a
 * rejected request never loads a session, and before authentication (300) so an
 * auth strategy can read one.
 *
 * The commit runs after `next()` returns. That works even though the handler has
 * already called a terminal response method, because the kernel's response
 * builder appends headers without consulting whether it ended, and hands the
 * adapter its live `Headers` rather than a clone — cloning would collapse
 * repeated `Set-Cookie` values into one comma-joined header.
 *
 * A request that throws is deliberately **not** committed: the error handler is
 * about to replace the response, and persisting a half-applied mutation from a
 * failed request is worse than dropping it.
 *
 * @param service - The session service to load and commit through
 * @returns The middleware function
 * @since 0.2.0
 */
export function sessionMiddleware(service: SessionService): MiddlewareFunction {
  return async (ctx: IRequestContext, next: NextFunction): Promise<void> => {
    const session = await service.load(ctx);
    ctx.state.set(SESSION_STATE_KEY, session);

    await next();

    await service.commit(ctx, session);
  };
}
