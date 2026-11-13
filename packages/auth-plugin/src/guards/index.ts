/**
 * Authorization guard middleware factories.
 *
 * @module
 */

import type { IAuthorizationService, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import {
  CAPABILITIES,
  CREDENTIAL_SOURCE_STATE_KEY,
  respondWithAuthorizationFailure,
  withSecurityMetadata,
} from '@setu-ts/common';
import type { IPrincipal, RouteSecurityMetadata } from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import type { RequireAuthOptions } from '../interfaces/index.ts';
import { RETURN_TO_QUERY_PARAM, safeReturnTo } from '../sign-in/return-to.ts';
import { isScopeToken } from '../resource-server/claims.ts';
import { REQUIRED_SCOPES_STATE_KEY } from '@setu-ts/common';

/**
 * Brand for a guard that requires an authenticated principal. Shared and
 * frozen: `RouteSecurityMetadata` declares its member `readonly`, so one
 * instance per meaning is consistent with the published type rather than a
 * mutable object a consumer could legitimately write to.
 */
const AUTHENTICATED: RouteSecurityMetadata = Object.freeze({ authenticated: true });

/**
 * Brand for a guard that can also refuse an authenticated caller with `403`.
 * Kept apart from {@linkcode AUTHENTICATED} so `requireAuth()` documents no
 * `403` (M137b §3.1).
 */
const AUTHENTICATED_FORBIDS: RouteSecurityMetadata = Object.freeze({
  authenticated: true,
  forbids: true,
});

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
 * @throws {AuthPluginConfigurationError} When it is not a same-origin absolute path,
 *   or when the URL parser would normalize it to a different one
 */
function compileSignInPage(signInPage: unknown): URL {
  /** Throws the one refusal every invalid page gets. */
  const refuse = (): never => {
    throw new AuthPluginConfigurationError(
      `auth-plugin: requireAuth signInPage must be a same-origin absolute path, got '${String(
        signInPage,
      )}'`,
    );
  };
  // The empty fallback cannot equal a non-empty page, so only a value
  // safeReturnTo keeps unchanged passes; '' is refused on its own, since it
  // would equal that fallback.
  if (
    typeof signInPage !== 'string' ||
    signInPage === '' ||
    safeReturnTo(signInPage, '') !== signInPage
  ) {
    return refuse();
  }
  // The redirect is built from the PARSED page, so the parser must give back
  // exactly the string that was checked: dot segments ('/x/..//evil.test',
  // '/%2e%2e//evil.test') pass safeReturnTo but normalize to a
  // protocol-relative `//evil.test` (M124 audit F2).
  const page = new URL(signInPage, URL_BASE);
  if (page.origin !== URL_BASE || page.pathname + page.search + page.hash !== signInPage) {
    return refuse();
  }
  return page;
}

/** The accepted `requireAuth({ delegation })` values. */
const DELEGATION_MODES: ReadonlySet<string> = new Set(['allow', 'forbid', 'require']);

/** Whether the configured delegation policy refuses a principal. */
function delegationRefuses(
  mode: NonNullable<RequireAuthOptions['delegation']>,
  user: IPrincipal,
): boolean {
  if (mode === 'forbid') {
    return user.actor !== undefined;
  }
  if (mode === 'require') {
    return user.actor === undefined;
  }
  return false;
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
 * With `delegation`, a signed-in principal whose token is delegated (it carries
 * an `actor`, RFC 8693 `act`) can be refused (`'forbid'`) or required
 * (`'require'`) with `403`.
 *
 * Credential restrictions read CREDENTIAL_SOURCE_STATE_KEY and treat a mismatch
 * or missing source as unauthenticated, before the delegation check.
 *
 * @param options - Optional sign-in page and delegation policy
 * @returns Middleware function
 * @throws {AuthPluginConfigurationError} When `signInPage` is not a same-origin
 *   absolute path, credentials is unknown, or delegation is unknown
 *
 * @example
 * ```typescript
 * app.router.get('/protected', { middleware: [requireAuth()], handler });
 * app.router.get('/account', { middleware: [requireAuth({ signInPage: '/login' })], handler });
 * app.router.post('/billing', {
 *   middleware: [requireAuth({ delegation: 'forbid' })],
 *   handler,
 * });
 * ```
 */
export function requireAuth(options?: RequireAuthOptions): MiddlewareFunction {
  const credentials = options?.credentials === undefined ? 'any' : options.credentials;
  if (credentials !== 'any' && credentials !== 'cookie' && credentials !== 'header') {
    throw new AuthPluginConfigurationError(
      "auth-plugin: requireAuth credentials must be 'any', 'cookie' or 'header'",
    );
  }
  const matchesCredential = (ctx: IRequestContext): boolean =>
    credentials === 'any' || ctx.state.get(CREDENTIAL_SOURCE_STATE_KEY) === credentials;
  const delegation = options?.delegation ?? 'allow';
  if (!DELEGATION_MODES.has(delegation)) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: requireAuth delegation must be 'allow', 'forbid' or 'require', got '${String(
        delegation,
      )}'`,
    );
  }
  // Only a delegation rule can make requireAuth answer 403.
  const authBrand = delegation === 'allow' ? AUTHENTICATED : AUTHENTICATED_FORBIDS;
  const signInPage = options?.signInPage;
  if (signInPage === undefined) {
    const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
      const user = ctx.request.user;
      if (!user || !matchesCredential(ctx)) {
        respondWithAuthorizationFailure(ctx, 'authentication-required');
        return;
      }
      if (delegationRefuses(delegation, user)) {
        respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
        return;
      }
      await next();
    };
    return withSecurityMetadata(guard, authBrand);
  }

  const page = compileSignInPage(signInPage);
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (user && matchesCredential(ctx)) {
      if (delegationRefuses(delegation, user)) {
        respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
        return;
      }
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
  return withSecurityMetadata(guard, authBrand);
}

/**
 * Guard that requires every listed OAuth 2.0 scope.
 *
 * ALL-of, not any-of: a token carries every scope a call needs, so a route
 * naming two requires both. These are OAuth scopes (`scope`/`scp` claims), NOT
 * the tenant or organisation grants M110b's `requireScopedRole` calls "scopes".
 * The scopes are read from `principal.scopes`; no authorization service is
 * resolved.
 *
 * An anonymous request is answered `401`. A signed-in principal missing any
 * scope is answered `403`, and the required list is recorded so the
 * `bearer-challenge` middleware can put it in `WWW-Authenticate`.
 *
 * @param first - The first required scope
 * @param rest - Any further required scopes
 * @returns Middleware function
 * @throws {AuthPluginConfigurationError} When a scope is not an RFC 6749 §3.3
 *   `scope-token`, or the same scope is listed twice
 *
 * @example
 * ```typescript
 * app.router.get('/tools', {
 *   middleware: [requireScopes('tools:read', 'tools:list')],
 *   handler,
 * });
 * ```
 * @since 0.12.0
 */
export function requireScopes(first: string, ...rest: string[]): MiddlewareFunction {
  const required: string[] = [];
  const seen = new Set<string>();
  for (const scope of [first, ...rest]) {
    if (typeof scope !== 'string' || !isScopeToken(scope)) {
      throw new AuthPluginConfigurationError(
        `auth-plugin: requireScopes scope '${String(scope)}' is not an RFC 6749 scope token`,
      );
    }
    if (seen.has(scope)) {
      throw new AuthPluginConfigurationError(
        `auth-plugin: requireScopes lists the scope '${scope}' more than once`,
      );
    }
    seen.add(scope);
    required.push(scope);
  }
  const scopes: readonly string[] = Object.freeze(required);
  const brand: RouteSecurityMetadata = Object.freeze({
    authenticated: true,
    scopes,
    forbids: true,
  });
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    const user = ctx.request.user;
    if (!user) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }
    // A non-array `scopes` (an application mapper that copied the raw claim
    // string) is treated as ABSENT: `includes` on a string would match a
    // substring, so `'xtools:readx'` would satisfy `tools:read`.
    const held = Array.isArray(user.scopes) ? user.scopes : [];
    if (scopes.some((scope) => !held.includes(scope))) {
      ctx.state.set(REQUIRED_SCOPES_STATE_KEY, scopes);
      respondWithAuthorizationFailure(ctx, 'insufficient-privileges');
      return;
    }
    await next();
  };
  return withSecurityMetadata(guard, brand);
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
  return withSecurityMetadata(guard, AUTHENTICATED_FORBIDS);
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
  return withSecurityMetadata(guard, AUTHENTICATED_FORBIDS);
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
  return withSecurityMetadata(guard, AUTHENTICATED_FORBIDS);
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
  return withSecurityMetadata(guard, AUTHENTICATED_FORBIDS);
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
  return withSecurityMetadata(guard, AUTHENTICATED_FORBIDS);
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
