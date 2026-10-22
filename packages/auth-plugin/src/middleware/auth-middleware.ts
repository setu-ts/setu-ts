/**
 * Authentication middleware.
 *
 * @module
 */

import type {
  IAuthService,
  IPrincipal,
  IRequest,
  IRequestContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import { CAPABILITIES, CREDENTIAL_SOURCE_STATE_KEY, replacePrincipal } from '@setu-ts/common';

/**
 * The plugin's own `AuthService` exposes `authenticateWithSource`, the `IAuthService`
 * contract plus the credential source of the matching strategy. Checked structurally:
 * a replaced `IAuthService` without it keeps working through `authenticate` and
 * simply records no source, so its requests stay verified (fail closed).
 */
type AuthServiceWithSource = IAuthService & {
  authenticateWithSource: (
    request: IRequest,
  ) => Promise<{ principal: IPrincipal; credential: 'header' | 'cookie' } | null>;
};

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

    // Structural check (no `any`): the plugin's own `AuthService` also records
    // the credential source of the matching strategy, which form CSRF reads to
    // exempt only header-credential authentication. A replaced `IAuthService`
    // without the method keeps working through `authenticate` and records no
    // source, so its requests stay verified (fail closed).
    const withSource =
      typeof (authService as { authenticateWithSource?: unknown }).authenticateWithSource ===
      'function';

    // Typed explicitly: hoisting this out of the original `const` would
    // otherwise make it an evolving `any`, which drops the contract's
    // `IPrincipal | null` at the one place this middleware decides whether to
    // write an identity (AI_GUIDELINES §5.4).
    let principal: IPrincipal | null;
    let source: 'header' | 'cookie' | undefined;
    try {
      if (withSource) {
        const service = authService as AuthServiceWithSource;
        const result = await service.authenticateWithSource(ctx.request);
        if (result !== null) {
          principal = result.principal;
          source = result.credential;
        } else {
          principal = null;
        }
      } else {
        principal = await authService.authenticate(ctx.request);
      }
    } catch {
      // Authentication error - don't set user, but continue
      // Authorization guards will handle the 401
      await next();
      return;
    }

    if (principal !== null) {
      replacePrincipal(ctx.request, principal);
      if (source !== undefined) {
        ctx.state.set(CREDENTIAL_SOURCE_STATE_KEY, source);
      }
    }

    await next();
  };
}
