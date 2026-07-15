/**
 * Authentication middleware.
 *
 * @module
 */

import type { IAuthService, IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

/**
 * Authentication middleware that runs passive strategies and populates ctx.request.user.
 * Always calls next() - it authenticates only, does not authorize.
 *
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.middleware.add(authMiddleware());
 * ```
 */
export function authMiddleware(): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const authService = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);

    try {
      const principal = await authService.authenticate(ctx.request);
      if (principal !== null) {
        ctx.request.user = principal;
      }
    } catch {
      // Authentication error - don't set user, but continue
      // Authorization guards will handle the 401
    }

    await next();
  };
}
