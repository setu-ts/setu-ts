/**
 * Authentication middleware.
 *
 * @module
 */

import type {
  IAuthService,
  IPrincipal,
  IRequestContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import { CAPABILITIES, replacePrincipal } from '@setu-ts/common';

/**
 * Authentication middleware that runs passive strategies and populates ctx.request.user.
 * Always calls next() - it authenticates only, does not authorize.
 *
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * // AuthPlugin registers this globally by default. Disable that registration
 * // only when attaching authentication to selected routes yourself.
 * app.register(AuthPlugin({ apiKey: { validate }, middleware: false }));
 * app.router.get('/private', { middleware: [authMiddleware()], handler });
 * ```
 */
export function authMiddleware(): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const authService = ctx.services.get<IAuthService>(CAPABILITIES.AUTH);

    // Typed explicitly: hoisting this out of the original `const` would
    // otherwise make it an evolving `any`, which drops the contract's
    // `IPrincipal | null` at the one place this middleware decides whether to
    // write an identity (AI_GUIDELINES §5.4).
    let principal: IPrincipal | null;
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
