/**
 * Authentication middleware.
 *
 * @module
 */

import type { IAuthService, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

/**
 * Authentication middleware that runs passive strategies and populates ctx.request.user.
 * Always calls next() - it authenticates only, does not authorize.
 *
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * // Priority 300 is the band ARCHITECTURE.md §10 reserves for authentication;
 * // a bare add() would take the kernel default of 500 and run after it.
 * app.middleware.add(authMiddleware(), { priority: 300 });
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
