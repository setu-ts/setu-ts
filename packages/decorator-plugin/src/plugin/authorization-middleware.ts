/**
 * The enforcing authorization middleware `@Roles`/`@Permissions` produce.
 *
 * One middleware per restriction kind is appended to a decorated route's
 * chain — roles first, so a route carrying both restrictions is refused by
 * the one that actually failed. The middleware resolves
 * `CAPABILITIES.AUTHORIZATION` PER REQUEST (never captured at registration —
 * the same choice `requireRole` makes), so a provider registered after this
 * plugin's `register()` is honoured and the fail-closed refusal applies
 * exactly while no provider exists.
 *
 * Every refusal answers through the shared `@setu-ts/common` authorization
 * responder, so a decorated route and a `@UseGuards(requireRole(...))` route
 * refuse identically without either plugin importing the other.
 *
 * @module
 */
import type {
  IAuthorizationService,
  IPrincipal,
  IRequestContext,
  MiddlewareFunction,
  RouteSecurityMetadata,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  respondWithAuthorizationFailure,
  withSecurityMetadata,
} from '@setu-ts/common';

/**
 * Brand carried by every appended middleware, so M57's `deriveSecurity` sees
 * a decorated route's enforcement the same way it sees a guard's.
 */
const AUTHENTICATED: RouteSecurityMetadata = Object.freeze({ authenticated: true });

/**
 * Builds one enforcing middleware for one restriction kind: `401` without a
 * principal, `501` while no authorization capability is registered (fail
 * closed — the route is never served unguarded), `403` when the check fails.
 */
function authorizationMiddleware(
  holds: (authorization: IAuthorizationService, principal: IPrincipal) => boolean,
): MiddlewareFunction {
  const middleware = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }

    // Per-request resolution, exactly like the guards: a provider registered
    // after this plugin's register() is honoured, and the 501 below applies
    // exactly while none exists.
    if (!ctx.services.has(CAPABILITIES.AUTHORIZATION)) {
      respondWithAuthorizationFailure(ctx, 'not-configured');
      return;
    }
    const authorization = ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
    if (!holds(authorization, user)) {
      respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
      return;
    }

    await next();
  };
  return withSecurityMetadata(middleware, AUTHENTICATED);
}

/**
 * Middleware enforcing `@Roles(...)`: any of the declared roles, through
 * `IAuthorizationService.hasAnyRole` (which exists on the committed surface).
 *
 * @param roles - The role names the route declares
 * @returns The branded middleware
 */
export function createRolesMiddleware(roles: readonly string[]): MiddlewareFunction {
  return authorizationMiddleware((authorization, user) => authorization.hasAnyRole(user, roles));
}

/**
 * Middleware enforcing `@Permissions(...)`: any of the declared permissions.
 *
 * `IAuthorizationService` offers `hasPermission` (single) and
 * `hasAllPermissions` (all) but no `hasAnyPermission` — the decorator composes
 * the committed single-permission check rather than widening `common` with a
 * helper only this call site needs.
 *
 * @param permissions - The permission names the route declares
 * @returns The branded middleware
 */
export function createPermissionsMiddleware(permissions: readonly string[]): MiddlewareFunction {
  return authorizationMiddleware((authorization, user) =>
    permissions.some((p) => authorization.hasPermission(user, p))
  );
}
