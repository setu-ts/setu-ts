/**
 * The scoped RBAC route guards: `requireScopedRole` and
 * `requireScopedPermission` (M110b plan §3.9, §3.10).
 *
 * They are NOT built through `requirePolicy`, which needs the policy object
 * when the guard is built — and AuthPlugin defines the built-in `scoped-rbac`
 * policy later, in `register()`. Each is ONE middleware that resolves its
 * scope once and evaluates every ability it names through the registered
 * `IAuthorizationPolicyService`, in the order `requirePolicy` uses.
 *
 * @module
 */
import {
  CAPABILITIES,
  respondWithAuthorizationFailure,
  SCOPED_RBAC_POLICY,
  scopedPermissionAbility,
  scopedRoleAbility,
  scopeFromTenant,
  withSecurityMetadata,
} from '@setu-ts/common';
import type {
  IAuthorizationPolicyService,
  IRequestContext,
  MiddlewareFunction,
  ScopedRbacTarget,
  ScopeRef,
  ScopeSource,
} from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import { brandPolicyGuard } from '../policies/policy-guard.ts';
import { readName, readScopeRef } from './model.ts';

/**
 * Options of a scoped guard.
 *
 * @since 0.9.0
 */
export interface ScopedGuardOptions {
  /**
   * Where the check's scope comes from. Defaults to `scopeFromTenant()` — the
   * resolved request tenant. `null` checks global grants only. A function
   * answering `undefined` leaves the scope unresolved, and the guard denies.
   */
  readonly scope?: ScopeSource;
}

/** How several abilities combine. */
type Combine = 'any' | 'all';

/** Validates the names a guard is built with. */
function readNames(value: unknown, guard: string): string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: ${guard} needs a name or a non-empty array of names`,
    );
  }
  return list.map((entry: unknown) => {
    const name = readName(entry);
    if (name === undefined) {
      throw new AuthPluginConfigurationError(
        `auth-plugin: ${guard} names must be non-empty strings of at most 256 characters`,
      );
    }
    return name;
  });
}

/** Validates the scope option, defaulting to the request tenant. */
function readSource(options: ScopedGuardOptions | undefined, guard: string): ScopeSource {
  if (options === undefined || !Object.hasOwn(options, 'scope') || options.scope === undefined) {
    return scopeFromTenant();
  }
  const scope = options.scope;
  if (scope === null || typeof scope === 'function') {
    return scope;
  }
  const ref = readScopeRef(scope);
  if (ref === undefined) {
    throw new AuthPluginConfigurationError(
      `auth-plugin: ${guard} scope must be a ScopeRef, null, or a function returning one`,
    );
  }
  return ref;
}

/** Resolves the scope for one request. A source's throw propagates. */
async function resolveScope(
  source: ScopeSource,
  ctx: IRequestContext,
): Promise<ScopeRef | null | undefined> {
  return typeof source === 'function' ? await source(ctx) : source;
}

function scopedGuard(
  abilities: readonly string[],
  combine: Combine,
  source: ScopeSource,
): MiddlewareFunction {
  const guard = async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    if (!ctx.services.has(CAPABILITIES.AUTHORIZATION_POLICIES)) {
      respondWithAuthorizationFailure(ctx, 'not-configured');
      return;
    }
    const user = ctx.request.user ?? null;
    const service = ctx.services.get<IAuthorizationPolicyService>(
      CAPABILITIES.AUTHORIZATION_POLICIES,
    );
    // Decide from the REGISTERED policy, never from this guard's arguments
    // (the M110a G1 rule): an ability the registry does not know rejects
    // through `can()` here, before the scope source runs.
    let anonymousAllowed = true;
    for (const ability of abilities) {
      const registered = service.describe(SCOPED_RBAC_POLICY, ability);
      if (registered === undefined) {
        await service.can(user, SCOPED_RBAC_POLICY, ability, undefined);
        respondWithAuthorizationFailure(
          ctx,
          user === null ? 'authentication-required' : 'insufficient-privileges',
        );
        return;
      }
      anonymousAllowed &&= registered.anonymous === true;
    }
    // An anonymous request is refused BEFORE the scope source runs, so it can
    // neither cost a lookup nor learn anything from one (the M110a F1 rule).
    if (user === null && !anonymousAllowed) {
      respondWithAuthorizationFailure(ctx, 'authentication-required');
      return;
    }
    const scope = await resolveScope(source, ctx);
    const target = { scope, context: ctx } as ScopedRbacTarget;
    let allowed = combine === 'all';
    for (const ability of abilities) {
      const granted = await service.can(user, SCOPED_RBAC_POLICY, ability, target);
      if (combine === 'any' && granted) {
        allowed = true;
        break;
      }
      if (combine === 'all' && !granted) {
        allowed = false;
        break;
      }
    }
    if (!allowed) {
      respondWithAuthorizationFailure(
        ctx,
        user === null ? 'authentication-required' : 'insufficient-privileges',
      );
      return;
    }
    await next();
  };
  brandPolicyGuard(guard, { policy: SCOPED_RBAC_POLICY, abilities, anonymous: false });
  return withSecurityMetadata(guard, { authenticated: true });
}

/**
 * Guard requiring a catalogue role held in the request's scope. An array is
 * ANY-of. Returns `501` when no authorization policy service is registered,
 * `401` for an anonymous request (before the scope source runs), `403` when
 * the role is not held in the scope; otherwise calls `next()`.
 *
 * Only `rbac` catalogue roles can be named: a role a tenant defines at
 * runtime cannot be checked at startup, so per-scope custom roles are checked
 * through the permissions they bundle. A name outside the catalogue fails
 * `start()`.
 *
 * @param role - The role, or roles of which any one suffices
 * @param options - Where the scope comes from (default: the request tenant)
 * @returns The guard middleware
 * @throws {AuthPluginConfigurationError} When no role is named, or the scope
 *   option is malformed
 * @example
 * ```typescript
 * app.router.post('/invoices/:id/approve', {
 *   middleware: [requireScopedRole(['approver', 'admin'])],
 *   handler,
 * });
 * ```
 * @since 0.9.0
 */
export function requireScopedRole(
  role: string | readonly string[],
  options?: ScopedGuardOptions,
): MiddlewareFunction {
  const roles = readNames(role, 'requireScopedRole');
  return scopedGuard(roles.map(scopedRoleAbility), 'any', readSource(options, 'requireScopedRole'));
}

/**
 * Guard requiring a catalogue permission held in the request's scope — through
 * a catalogue role, a per-scope custom role, or the principal's own
 * permissions. An array is ALL-of. Returns `501`/`401`/`403` as
 * {@linkcode requireScopedRole} does.
 *
 * @param permission - The permission, or permissions all of which are required
 * @param options - Where the scope comes from (default: the request tenant)
 * @returns The guard middleware
 * @throws {AuthPluginConfigurationError} When no permission is named, or the
 *   scope option is malformed
 * @example
 * ```typescript
 * app.router.get('/orgs/:orgId/reports', {
 *   middleware: [
 *     requireScopedPermission('reports:read', {
 *       scope: scopeFromParam('orgId', 'organisation'),
 *     }),
 *   ],
 *   handler,
 * });
 * ```
 * @since 0.9.0
 */
export function requireScopedPermission(
  permission: string | readonly string[],
  options?: ScopedGuardOptions,
): MiddlewareFunction {
  const permissions = readNames(permission, 'requireScopedPermission');
  return scopedGuard(
    permissions.map(scopedPermissionAbility),
    'all',
    readSource(options, 'requireScopedPermission'),
  );
}
