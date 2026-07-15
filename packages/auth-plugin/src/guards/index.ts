/**
 * Authorization guard middleware factories.
 *
 * @module
 */

import type {
  IAuthorizationService,
  IRequestContext,
  MiddlewareFunction,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';

/**
 * Guard that requires authentication. Returns 401 if no principal.
 *
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.router.get('/protected', { middleware: [requireAuth()], handler });
 * ```
 */
export function requireAuth(): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      await ctx.response.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }
    await next();
  };
}

/**
 * Guard that requires a specific role. Returns 401 if no principal, 403 if insufficient role.
 *
 * @param role - Required role name
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.router.delete('/users/:id', { middleware: [requireRole('admin')], handler });
 * ```
 */
export function requireRole(role: string): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      await ctx.response.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const authService = ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
    if (!authService.hasRole(user, role)) {
      await ctx.response.status(403).json({
        error: 'Forbidden',
        message: `Role "${role}" is required`,
      });
      return;
    }

    await next();
  };
}

/**
 * Guard that requires a specific permission. Returns 401 if no principal, 403 if insufficient permission.
 *
 * @param permission - Required permission name
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.router.post('/users', { middleware: [requirePermission('users:create')], handler });
 * ```
 */
export function requirePermission(permission: string): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      await ctx.response.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const authService = ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
    if (!authService.hasPermission(user, permission)) {
      await ctx.response.status(403).json({
        error: 'Forbidden',
        message: `Permission "${permission}" is required`,
      });
      return;
    }

    await next();
  };
}

/**
 * Guard that requires any of the specified roles. Returns 401 if no principal, 403 if none match.
 *
 * @param roles - Array of role names (any match is sufficient)
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.router.get('/admin', { middleware: [requireAnyRole(['admin', 'manager'])], handler });
 * ```
 */
export function requireAnyRole(roles: readonly string[]): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      await ctx.response.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const authService = ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
    if (!authService.hasAnyRole(user, roles)) {
      await ctx.response.status(403).json({
        error: 'Forbidden',
        message: `One of these roles is required: ${roles.join(', ')}`,
      });
      return;
    }

    await next();
  };
}

/**
 * Guard that requires all of the specified permissions. Returns 401 if no principal, 403 if any missing.
 *
 * @param permissions - Array of permission names (all required)
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.router.post('/bulk', {
 *   middleware: [requireAllPermissions(['users:create', 'users:send-welcome'])],
 *   handler,
 * });
 * ```
 */
export function requireAllPermissions(permissions: readonly string[]): MiddlewareFunction {
  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      await ctx.response.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const authService = ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
    if (!authService.hasAllPermissions(user, permissions)) {
      await ctx.response.status(403).json({
        error: 'Forbidden',
        message: `All of these permissions are required: ${permissions.join(', ')}`,
      });
      return;
    }

    await next();
  };
}

/**
 * Guard that allows public access (always continues).
 * Useful for explicitly marking routes as public when auth middleware is global.
 *
 * Note: named `publicRoute` instead of `public` because `public` is a reserved
 * keyword in TypeScript/JavaScript strict mode (ES modules).
 *
 * @returns Middleware function that always calls next
 *
 * @example
 * ```typescript
 * app.router.get('/public', { middleware: [publicRoute()], handler });
 * ```
 */
export function publicRoute(): MiddlewareFunction {
  return async (_ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Always continue - this route is public
    await next();
  };
}
