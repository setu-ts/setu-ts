/**
 * Authentication middleware.
 *
 * @module
 */

import type { IAuthService, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { CAPABILITIES, replacePrincipal } from '@setu-ts/common';

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

    let principal;
    try {
      principal = await authService.authenticate(ctx.request);
    } catch {
      // Authentication error - don't set user, but continue
      // Authorization guards will handle the 401
      await next();
      return;
    }

    if (principal !== null) {
      replacePrincipal(ctx.request, principal);
    }

    await next();
  };
}
