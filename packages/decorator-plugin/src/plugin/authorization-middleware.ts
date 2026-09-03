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
 * Every refusal answers through `respondWithError` with the same status,
 * title and detail strings `@setu-ts/auth-plugin`'s guards use, so a
 * decorated route and a `@UseGuards(requireRole(...))` route refuse
 * identically. §2.2 forbids importing the guards themselves, so the shared
 * implementation is the CAPABILITY, and the byte-identity is pinned by an
 * integration test rather than by construction.
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
import { CAPABILITIES, respondWithError, withSecurityMetadata } from '@setu-ts/common';

/**
 * Brand carried by every appended middleware, so M57's `deriveSecurity` sees
 * a decorated route's enforcement the same way it sees a guard's.
 */
const AUTHENTICATED: RouteSecurityMetadata = Object.freeze({ authenticated: true });

/** Detail for an absent principal — identical to the guards' string. */
const AUTHENTICATION_REQUIRED = 'Authentication required';

/** Detail for the fail-closed refusal when no authorization provider exists. */
const NOT_CONFIGURED_DETAIL = 'Authorization is not configured';

/**
 * The refusal detail for a failed check: `Role "x" is required` for one name,
 * `One of these roles is required: a, b` for several — the exact strings
 * `requireRole` and `requireAnyRole` answer with.
 */
function requirementDetail(kind: 'Role' | 'Permission', names: readonly string[]): string {
  return names.length === 1
    ? `${kind} "${names[0]}" is required`
    : `One of these ${kind.toLowerCase()}s is required: ${names.join(', ')}`;
}

/**
 * Builds one enforcing middleware for one restriction kind: `401` without a
 * principal, `501` while no authorization capability is registered (fail
 * closed — the route is never served unguarded), `403` when the check fails.
 */
function authorizationMiddleware(
  kind: 'Role' | 'Permission',
  names: readonly string[],
  holds: (authorization: IAuthorizationService, principal: IPrincipal) => boolean,
): MiddlewareFunction {
  const middleware = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithError(ctx, {
        status: 401,
        title: 'Unauthorized',
        detail: AUTHENTICATION_REQUIRED,
      });
      return;
    }

    // Per-request resolution, exactly like the guards: a provider registered
    // after this plugin's register() is honoured, and the 501 below applies
    // exactly while none exists.
    if (!ctx.services.has(CAPABILITIES.AUTHORIZATION)) {
      respondWithError(ctx, {
        status: 501,
        title: 'Not Implemented',
        detail: NOT_CONFIGURED_DETAIL,
      });
      return;
    }
    const authorization = ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
    if (!holds(authorization, user)) {
      respondWithError(ctx, {
        status: 403,
        title: 'Forbidden',
        detail: requirementDetail(kind, names),
      });
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
  return authorizationMiddleware(
    'Role',
    roles,
    (authorization, user) => authorization.hasAnyRole(user, roles),
  );
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
  return authorizationMiddleware(
    'Permission',
    permissions,
    (authorization, user) => permissions.some((p) => authorization.hasPermission(user, p)),
  );
}
