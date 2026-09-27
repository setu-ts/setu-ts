/**
 * RBAC (Role-Based Access Control) service with role hierarchy.
 *
 * @module
 */

import type {
  AuthorizationDecisionReason,
  IAuthorizationService,
  IPrincipal,
  RbacConfig,
} from '@setu-ts/common';
import type { PermissionStepEval, RoleStepEval } from '../diagnostics/authorization-observer.ts';
import { authorizationObserverOf } from '../diagnostics/authorization-observer.ts';

/** Permission that grants every permission. */
const WILDCARD = '*';

/**
 * The first 16 evaluated steps a compound decision retains. The TRUE evaluated
 * count is reported separately, so a decision that evaluated more steps is
 * retained with `stepsTruncated: true` rather than dropped.
 */
const MAX_RETAINED_STEPS = 16;

/**
 * The outcome of one single-check evaluation: the authoritative boolean, the
 * fixed reason the evaluator used to reach it, and — when the check was
 * granted through a role — the granting role name. `viaRole` is `null` for a
 * direct grant, a not-held result, or a grant that is not role-mediated.
 */
interface SingleEval {
  readonly result: boolean;
  readonly reason: AuthorizationDecisionReason;
  readonly viaRole: string | null;
}

/**
 * RBAC service implementing IAuthorizationService.
 *
 * The public methods are the authoritative boolean evaluators. When an
 * authorization-observation collector is attached (M98h), each public method
 * ALSO emits one guarded decision describing the evaluation that produced the
 * returned boolean. The emission is a pure side observation: it is wrapped so
 * that any diagnostic failure is dropped, never propagated, and never changes
 * the boolean, the short-circuit order, or the caches.
 */
export class RbacService implements IAuthorizationService {
  private readonly roleDefinitions: Readonly<Record<string, RoleDefinition>>;
  private readonly resolvedPermissions: Map<string, Set<string>>;
  private readonly resolvedInheritance: Map<string, Set<string>>;

  constructor(config: RbacConfig) {
    this.roleDefinitions = config.roles;
    this.resolvedPermissions = new Map();
    this.resolvedInheritance = new Map();
    this.buildPermissionCache();
  }

  /**
   * Build the permission closure for every configured role up front, so a
   * request-time check is a map lookup (AI_GUIDELINES §14).
   */
  private buildPermissionCache(): void {
    for (const roleName of Object.keys(this.roleDefinitions)) {
      this.resolvedPermissions.set(roleName, this.computeClosure(roleName).permissions);
    }
  }

  /**
   * Computes a role's full transitive closure — every permission it grants and
   * every role it inherits — starting from that role.
   *
   * Each role is resolved from its OWN starting point with its own `seen` set.
   * The previous implementation threaded one `visited` set through the whole
   * recursion AND memoized whatever came back, so a role resolved as a
   * side-effect of another role's traversal could be cached with an INCOMPLETE
   * set: in a cyclic configuration (`a` inherits `b`, `b` inherits `a`), the
   * inner resolution of `b` hit `a` in `visited`, cut it to empty, and cached
   * `b` without `a`'s permissions — so the result depended on `Object.keys`
   * order. Under-granting fails closed, but it is still wrong.
   *
   * @param roleName - The role to resolve
   * @returns Its permission set and its inherited-role set
   */
  private computeClosure(roleName: string): {
    permissions: Set<string>;
    inherited: Set<string>;
  } {
    const permissions = new Set<string>();
    const inherited = new Set<string>();
    const seen = new Set<string>([roleName]);
    const stack: string[] = [roleName];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const definition = this.roleDefinitions[current];
      if (definition === undefined) {
        continue;
      }
      for (const permission of definition.permissions ?? []) {
        permissions.add(permission);
      }
      for (const parent of definition.inherits ?? []) {
        inherited.add(parent);
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }

    return { permissions, inherited };
  }

  /**
   * Returns every role a given role inherits, transitively.
   *
   * Memoized: this used to recompute the closure on every `hasRole` call, i.e.
   * per request per guard.
   *
   * @param roleName - The role to expand
   * @returns The transitive inherited-role set
   */
  private getInheritedRoles(roleName: string): Set<string> {
    const cached = this.resolvedInheritance.get(roleName);
    if (cached !== undefined) {
      return cached;
    }
    const { inherited } = this.computeClosure(roleName);
    this.resolvedInheritance.set(roleName, inherited);
    return inherited;
  }

  /**
   * Check if a role exists in the configuration.
   */
  private roleExists(roleName: string): boolean {
    return roleName in this.roleDefinitions;
  }

  /**
   * Check if a principal has a specific role (including inherited).
   */
  hasRole(principal: IPrincipal, role: string): boolean {
    const outcome = this.evaluateRole(principal, role);
    const observer = authorizationObserverOf(this);
    if (observer !== undefined) {
      this.#emit(() => observer.onRole(role, outcome.result, outcome.reason, outcome.viaRole));
    }
    return outcome.result;
  }

  /**
   * Check if a principal has a specific permission (direct or via role hierarchy).
   * The wildcard permission `'*'` — held directly or granted by any of the
   * principal's (direct or inherited) roles — grants every permission.
   */
  hasPermission(principal: IPrincipal, permission: string): boolean {
    const outcome = this.evaluatePermission(principal, permission);
    const observer = authorizationObserverOf(this);
    if (observer !== undefined) {
      this.#emit(() =>
        observer.onPermission(permission, outcome.result, outcome.reason, outcome.viaRole)
      );
    }
    return outcome.result;
  }

  /**
   * Check if a principal has any of the specified roles.
   */
  hasAnyRole(principal: IPrincipal, roles: readonly string[]): boolean {
    // Loop the private evaluator directly — never the public `hasRole` — so a
    // compound decision does not nest a duplicate single-check record under
    // it, and the short-circuit order is preserved exactly. With no observer
    // attached, no step list is built and nothing is emitted.
    const observer = authorizationObserverOf(this);
    const evaluated: RoleStepEval[] = [];
    let evaluatedCount = 0;
    let result = false;
    for (const role of roles) {
      const outcome = this.evaluateRole(principal, role);
      evaluatedCount += 1;
      if (observer !== undefined && evaluated.length < MAX_RETAINED_STEPS) {
        evaluated.push({
          role,
          result: outcome.result,
          reason: outcome.reason,
          viaRole: outcome.viaRole,
        });
      }
      if (outcome.result) {
        result = true;
        break;
      }
    }
    if (observer !== undefined) {
      // The TRUE count, not the retained list's length: a grant past step 16
      // short-circuits with a full list, and the decision is retained with
      // stepsTruncated rather than dropped (plan §3.3).
      this.#emit(() => observer.onAnyRole(roles, evaluated, evaluatedCount, result));
    }
    return result;
  }

  /**
   * Check if a principal has all of the specified permissions.
   */
  hasAllPermissions(principal: IPrincipal, permissions: readonly string[]): boolean {
    // Loop the private evaluator directly — never the public `hasPermission` —
    // so a compound decision does not nest a duplicate single-check record
    // under it, and the short-circuit order is preserved exactly. With no
    // observer attached, no step list is built and nothing is emitted.
    const observer = authorizationObserverOf(this);
    const evaluated: PermissionStepEval[] = [];
    let evaluatedCount = 0;
    let result = true;
    for (const permission of permissions) {
      const outcome = this.evaluatePermission(principal, permission);
      evaluatedCount += 1;
      if (observer !== undefined && evaluated.length < MAX_RETAINED_STEPS) {
        evaluated.push({
          permission,
          result: outcome.result,
          reason: outcome.reason,
          viaRole: outcome.viaRole,
        });
      }
      if (!outcome.result) {
        result = false;
        break;
      }
    }
    if (observer !== undefined) {
      // The TRUE count, not the retained list's length: a failure past step
      // 16 short-circuits with a full list, and the decision is retained with
      // stepsTruncated rather than dropped (plan §3.3).
      this.#emit(() => observer.onAllPermissions(permissions, evaluated, evaluatedCount, result));
    }
    return result;
  }

  /**
   * The pure role evaluator: the authoritative boolean, the fixed reason it
   * used, and the granting role when the role was inherited.
   */
  private evaluateRole(principal: IPrincipal, role: string): SingleEval {
    const principalRoles = principal.roles ?? [];

    // Check if principal has the role directly
    if (principalRoles.includes(role)) {
      return { result: true, reason: 'direct-role', viaRole: null };
    }

    // Check if any of the principal's roles inherits the target role
    for (const principalRole of principalRoles) {
      if (this.roleExists(principalRole)) {
        const inheritedRoles = this.getInheritedRoles(principalRole);
        if (inheritedRoles.has(role)) {
          return { result: true, reason: 'inherited-role', viaRole: principalRole };
        }
      }
    }

    return { result: false, reason: 'not-held', viaRole: null };
  }

  /**
   * The pure permission evaluator: the authoritative boolean, the fixed
   * reason it used, and the granting role when the permission was granted
   * through one. The wildcard `'*'` — held directly or granted by any of the
   * principal's roles — grants every permission.
   */
  private evaluatePermission(principal: IPrincipal, permission: string): SingleEval {
    // Check direct permissions
    const principalPermissions = principal.permissions ?? [];
    if (principalPermissions.includes(permission)) {
      return { result: true, reason: 'direct-permission', viaRole: null };
    }
    if (principalPermissions.includes(WILDCARD)) {
      return { result: true, reason: 'direct-wildcard', viaRole: null };
    }

    // Check permissions via role hierarchy
    const principalRoles = principal.roles ?? [];
    for (const roleName of principalRoles) {
      if (this.resolvedPermissions.has(roleName)) {
        const permissions = this.resolvedPermissions.get(roleName)!;
        if (permissions.has(permission)) {
          return { result: true, reason: 'role-permission', viaRole: roleName };
        }
        if (permissions.has(WILDCARD)) {
          return { result: true, reason: 'role-wildcard', viaRole: roleName };
        }
      }
    }

    return { result: false, reason: 'not-held', viaRole: null };
  }

  /**
   * Runs a diagnostic emission, dropping any failure. The boolean decision is
   * already computed and returned by the caller regardless of what happens
   * here, so a diagnostic path can never permit, deny, throw, or alter the
   * guard's short-circuit order.
   */
  #emit(emission: () => void): void {
    try {
      emission();
    } catch {
      // A diagnostic failure drops the explanation, never the decision.
    }
  }
}

/**
 * Internal type for role definition (matches common's RoleDefinition).
 */
interface RoleDefinition {
  readonly permissions?: readonly string[];
  readonly inherits?: readonly string[];
}
