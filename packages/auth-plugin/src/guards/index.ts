/**
 * Authorization guard middleware factories.
 *
 * @module
 */

import type { IAuthorizationService, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import {
  CAPABILITIES,
  respondWithAuthorizationFailure,
  withSecurityMetadata,
} from '@setu-ts/common';
import type { RouteSecurityMetadata } from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import type { RequireAuthOptions } from '../interfaces/index.ts';
import { RETURN_TO_QUERY_PARAM, safeReturnTo } from '../sign-in/return-to.ts';

/**
 * Brand for a guard that requires an authenticated principal. Shared and
 * frozen: `RouteSecurityMetadata` declares its member `readonly`, so one
 * instance per meaning is consistent with the published type rather than a
 * mutable object a consumer could legitimately write to.
 */
const AUTHENTICATED: RouteSecurityMetadata = Object.freeze({ authenticated: true });

/** Brand for a guard that explicitly marks a route public. */
const PUBLIC: RouteSecurityMetadata = Object.freeze({ authenticated: false });

/**
 * Resolves the authorization service, or answers `501` when none is registered.
 *
 * `AuthPluginOptions.rbac` is optional (M68): a JWT-only registration provides
 * `jwt` and `authentication` and deliberately registers no authorization
 * service. Before M89b the four authorization guards resolved the capability
 * with `services.get`, whose throw for an unregistered token escaped into the
 * pipeline — so a principal that genuinely HELD the required role was refused
 * with a masked `500 Internal Server Error` while `/health`, `/ready` and
 * `/live` all reported `up` (X18-2).
 *
 * The status is `501`, not `403`: nothing is wrong with the caller's
 * credentials, and nothing about the request is malformed. The deployment
 * cannot evaluate the policy at all, permanently, which is what `501` states —
 * and it is the same status `@setu-ts/database-plugin`'s query-shape refusals
 * answer, so one condition has one answer across the framework. A genuine
 * policy refusal keeps its existing `403`; that path is untouched.
 *
 * The guards still fail CLOSED — the property X18-2 confirmed and this must
 * not regress. What changes is that the refusal is deliberate and legible
 * rather than an escaped registry error.
 *
 * @param ctx - The request context, used to resolve and to answer
 * @returns The service, or `null` when none is registered (a response was written)
 */
function resolveAuthorization(ctx: IRequestContext): IAuthorizationService | null {
  if (!ctx.services.has(CAPABILITIES.AUTHORIZATION)) {
    respondWithAuthorizationFailure(ctx, 'not-configured');
    return null;
  }
  return ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION);
}

/**
 * The request headers the sign-in redirect decision reads. Appended to `Vary`
 * on both unauthenticated answers, so a shared cache cannot hand one client's
 * redirect to another's API call.
 */
const NAVIGATION_VARY = ['Accept', 'Sec-Fetch-Mode', 'X-Requested-With'] as const;

/** A base for parsing the request URL, which an injected request may give as a path. */
const URL_BASE = 'http://localhost';

/**
 * Whether a request is a browser page navigation (M124 §3.2).
 *
 * Only `GET` and `HEAD`: a redirect would turn a form `POST` into a `GET` and
 * drop its body. An `X-Requested-With: XMLHttpRequest` request is script, never
 * a navigation (ASP.NET Core, Spring). `Sec-Fetch-Mode` decides when present —
 * a browser sends `navigate` for a page load and something else for `fetch()`.
 * Without it, `Accept` must NAME `text/html` or `application/xhtml+xml`; the bare
 * any-type wildcard is not enough, because `curl` and most HTTP clients send
 * only that (Spring).
 *
 * @param method - The request method
 * @param headers - The request headers
 * @returns `true` for a navigation
 */
function isNavigation(method: string, headers: Headers): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  if (headers.get('x-requested-with')?.trim().toLowerCase() === 'xmlhttprequest') {
    return false;
  }
  const mode = headers.get('sec-fetch-mode');
  if (mode !== null) {
    return mode.trim().toLowerCase() === 'navigate';
  }
  const accept = headers.get('accept');
  if (accept === null) {
    return false;
  }
  return accept.split(',').some((range) => {
    const type = (range.split(';')[0] ?? '').trim().toLowerCase();
    return type === 'text/html' || type === 'application/xhtml+xml';
  });
}

/**
 * Validates `signInPage` once, when the guard is built.
 *
 * @param signInPage - The configured page
 * @returns The page parsed against a placeholder origin
 * @throws {AuthPluginConfigurationError} When it is not a same-origin absolute path
 */
function compileSignInPage(signInPage: unknown): URL {
  // The empty fallback cannot equal a non-empty page, so only a value
  // safeReturnTo keeps unchanged passes; '' is refused on its own, since it
  // would equal that fallback.
  if (
    typeof signInPage !== 'string' ||
    signInPage === '' ||
    safeReturnTo(signInPage, '') !== signInPage
  ) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: requireAuth signInPage must be a same-origin absolute path, got '${String(
        signInPage,
      )}'`,
    );
  }
  return new URL(signInPage, URL_BASE);
}

/**
 * Guard that requires authentication.
 *
 * Without options an unauthenticated request is answered `401` Problem
 * Details. With `signInPage`, an unauthenticated browser navigation (see
 * {@linkcode RequireAuthOptions.signInPage}) is answered `302` to the sign-in
 * page instead, carrying the requested path and query as `returnTo` — validated
 * by {@linkcode safeReturnTo}, which the application's own login handler should
 * apply again before redirecting back. Every other unauthenticated request keeps
 * the `401`.
 *
 * @param options - Optional sign-in page for browser navigations
 * @returns Middleware function
 * @throws {AuthPluginConfigurationError} When `signInPage` is not a same-origin
 *   absolute path
 *
 * @example
 * ```typescript
 * app.router.get('/protected', { middleware: [requireAuth()], handler });
 * app.router.get('/account', { middleware: [requireAuth({ signInPage: '/login' })], handler });
 * ```
 */
export function requireAuth(options?: RequireAuthOptions): MiddlewareFunction {
  const signInPage = options?.signInPage;
  if (signInPage === undefined) {
    const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
      const user = ctx.request.user;
      if (!user) {
        respondWithAuthorizationFailure(ctx, 'authentication-required');
        return;
      }
      await next();
    };
    return withSecurityMetadata(guard, AUTHENTICATED);
  }

  const page = compileSignInPage(signInPage);
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    if (ctx.request.user) {
      await next();
      return;
    }
    for (const name of NAVIGATION_VARY) {
      ctx.response.appendHeader('Vary', name);
    }
    const requested = new URL(ctx.request.url, URL_BASE);
    // The sign-in page's own path is never redirected: a guarded sign-in page
    // would otherwise send the browser to itself forever.
    if (
      requested.pathname === page.pathname ||
      !isNavigation(ctx.request.method, ctx.request.headers)
    ) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }
    const target = new URL(page);
    target.searchParams.set(
      RETURN_TO_QUERY_PARAM,
      safeReturnTo(requested.pathname + requested.search),
    );
    ctx.response.redirect(target.pathname + target.search + target.hash, 302);
  };
  return withSecurityMetadata(guard, AUTHENTICATED);
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
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }

    const authService = resolveAuthorization(ctx);
    if (authService === null) {
      return;
    }
    if (!authService.hasRole(user, role)) {
      respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
      return;
    }

    await next();
  };
  return withSecurityMetadata(guard, AUTHENTICATED);
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
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }

    const authService = resolveAuthorization(ctx);
    if (authService === null) {
      return;
    }
    if (!authService.hasPermission(user, permission)) {
      respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
      return;
    }

    await next();
  };
  return withSecurityMetadata(guard, AUTHENTICATED);
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
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }

    const authService = resolveAuthorization(ctx);
    if (authService === null) {
      return;
    }
    if (!authService.hasAnyRole(user, roles)) {
      respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
      return;
    }

    await next();
  };
  return withSecurityMetadata(guard, AUTHENTICATED);
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
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }

    const authService = resolveAuthorization(ctx);
    if (authService === null) {
      return;
    }
    if (!authService.hasAllPermissions(user, permissions)) {
      respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
      return;
    }

    await next();
  };
  return withSecurityMetadata(guard, AUTHENTICATED);
}

/**
 * Guard that requires a second factor (MFA). Returns 401 if no principal,
 * 403 `second-factor-required` if the principal's `amr` holds none of
 * `otp`/`pop`.
 *
 * The `auth-session` strategy OVERWRITES `amr` from its own record, so a
 * session principal cannot smuggle one in. Every other strategy's claims come
 * from something the application controls: the JWT strategy copies claims from
 * tokens the application itself signed, and a trusted issuer's `toPrincipal`
 * decides what an outside issuer's claims become. So a self-issued JWT
 * carrying `amr: ['otp']` passes the guard — deliberately, and pinned by a
 * test.
 *
 * A non-array `amr` is treated as ABSENT, not coerced. `claims` is
 * `Record<string, unknown>`, so an outside issuer or an application-built
 * principal can carry `amr: 'otp'` (a bare string). Reading that as a string and
 * calling `.includes` on it would make `'sotp'` — or any string merely
 * CONTAINING the factor name — satisfy the guard.
 *
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * app.router.get('/sensitive', { middleware: [requireMfa()], handler });
 * ```
 * @since 0.8.0
 */
export function requireMfa(): MiddlewareFunction {
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }
    const raw = user.claims?.amr;
    const amr: readonly string[] = Array.isArray(raw) ? (raw as readonly string[]) : [];
    const hasSecondFactor = amr.includes('otp') || amr.includes('pop');
    if (!hasSecondFactor) {
      respondWithAuthorizationFailure(ctx, 'second-factor-required');
      return;
    }
    await next();
  };
  return withSecurityMetadata(guard, AUTHENTICATED);
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
  const guard = async (_ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Always continue - this route is public
    await next();
  };
  return withSecurityMetadata(guard, PUBLIC);
}
