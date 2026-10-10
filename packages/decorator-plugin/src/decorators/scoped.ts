/**
 * Scoped RBAC decorators (M110b) — `@ScopedRoles` and `@ScopedPermissions`,
 * the class form of AuthPlugin's `requireScopedRole` and
 * `requireScopedPermission`.
 *
 * They check AuthPlugin's built-in `scoped-rbac` policy through
 * `CAPABILITIES.AUTHORIZATION_POLICIES`, so they need
 * `AuthPlugin({ rbac, scopedRbac })`; a route using them with no such policy
 * registered fails `register()` naming it. Always enforced — like
 * `@RequirePolicy`, they have no inert history to preserve, so
 * `enforceRoles: false` does not switch them off.
 *
 * @module
 */
import type { ScopeSource } from '@setu-ts/common';
import { classOrMethodDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassOrMethodDecorator } from '../metadata/context-bridge.ts';
import type { ScopedRequirement } from '../metadata/metadata-store.ts';

/** Validates the names and builds the requirement, refusing at decoration time. */
function requirement(
  decorator: 'ScopedRoles' | 'ScopedPermissions',
  names: readonly string[],
  scope: ScopeSource | undefined,
): ScopedRequirement {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`@${decorator}() requires a non-empty array of names.`);
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`@${decorator}() names must be non-empty strings.`);
    }
  }
  return scope === undefined ? { names: [...names] } : { names: [...names], scope };
}

/**
 * Requires the principal to hold ANY of the given catalogue roles in the
 * request's scope. May be applied at the class level (default for all routes)
 * or method level (overrides the class default).
 *
 * The route answers `401` without a principal (before the scope source runs),
 * `403` when no role is held in the scope, `501` with no authorization policy
 * service registered. Only `rbac` catalogue roles can be named: a role a
 * tenant defines at runtime is checked through the permissions it bundles.
 *
 * @param roles - The roles, any one of which suffices
 * @param scope - Where the scope comes from (default: the request tenant)
 * @returns A class or method decorator
 * @throws {Error} When `roles` is empty or holds a non-string
 * @example
 * ```typescript
 * @Post('/invoices/:id/approve')
 * @ScopedRoles(['approver', 'admin'])
 * approve() { … }
 * ```
 * @since 0.9.0
 */
export function ScopedRoles(
  roles: readonly string[],
  scope?: ScopeSource,
): SetuClassOrMethodDecorator {
  const required = requirement('ScopedRoles', roles, scope);
  return classOrMethodDecorator(
    (store, target) => {
      store.mergeController(target, { scopedRoles: required });
    },
    (store, target, handler) => {
      store.mutateMethod(target, handler, (meta) => {
        meta.scopedRoles = required;
      });
    },
  );
}

/**
 * Requires the principal to hold ALL of the given catalogue permissions in the
 * request's scope — through a catalogue role, a per-scope custom role, or its
 * own permissions. May be applied at the class or method level (method
 * overrides class). Answers `501`/`401`/`403` as {@linkcode ScopedRoles} does.
 *
 * @param permissions - The permissions, all of which are required
 * @param scope - Where the scope comes from (default: the request tenant)
 * @returns A class or method decorator
 * @throws {Error} When `permissions` is empty or holds a non-string
 * @example
 * ```typescript
 * @Get('/orgs/:orgId/reports')
 * @ScopedPermissions(['reports:read'], scopeFromParam('orgId', 'organisation'))
 * reports() { … }
 * ```
 * @since 0.9.0
 */
export function ScopedPermissions(
  permissions: readonly string[],
  scope?: ScopeSource,
): SetuClassOrMethodDecorator {
  const required = requirement('ScopedPermissions', permissions, scope);
  return classOrMethodDecorator(
    (store, target) => {
      store.mergeController(target, { scopedPermissions: required });
    },
    (store, target, handler) => {
      store.mutateMethod(target, handler, (meta) => {
        meta.scopedPermissions = required;
      });
    },
  );
}
