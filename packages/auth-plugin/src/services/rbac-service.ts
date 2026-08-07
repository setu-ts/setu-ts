/**
 * RBAC (Role-Based Access Control) service with role hierarchy.
 *
 * @module
 */

import type { IAuthorizationService, IPrincipal, RbacConfig } from '@setu-ts/common';

/** Permission that grants every permission. */
const WILDCARD = '*';

/**
 * RBAC service implementing IAuthorizationService.
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
    const principalRoles = principal.roles ?? [];

    // Check if principal has the role directly
    if (principalRoles.includes(role)) {
      return true;
    }

    // Check if any of the principal's roles inherits the target role
    for (const principalRole of principalRoles) {
      if (this.roleExists(principalRole)) {
        const inheritedRoles = this.getInheritedRoles(principalRole);
        if (inheritedRoles.has(role)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a principal has a specific permission (direct or via role hierarchy).
   * The wildcard permission `'*'` — held directly or granted by any of the
   * principal's (direct or inherited) roles — grants every permission.
   */
  hasPermission(principal: IPrincipal, permission: string): boolean {
    // Check direct permissions
    const principalPermissions = principal.permissions ?? [];
    if (principalPermissions.includes(permission) || principalPermissions.includes(WILDCARD)) {
      return true;
    }

    // Check permissions via role hierarchy
    const principalRoles = principal.roles ?? [];
    for (const roleName of principalRoles) {
      if (this.resolvedPermissions.has(roleName)) {
        const permissions = this.resolvedPermissions.get(roleName)!;
        if (permissions.has(permission) || permissions.has(WILDCARD)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a principal has any of the specified roles.
   */
  hasAnyRole(principal: IPrincipal, roles: readonly string[]): boolean {
    for (const role of roles) {
      if (this.hasRole(principal, role)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a principal has all of the specified permissions.
   */
  hasAllPermissions(principal: IPrincipal, permissions: readonly string[]): boolean {
    for (const permission of permissions) {
      if (!this.hasPermission(principal, permission)) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Internal type for role definition (matches common's RoleDefinition).
 */
interface RoleDefinition {
  readonly permissions?: readonly string[];
  readonly inherits?: readonly string[];
}
