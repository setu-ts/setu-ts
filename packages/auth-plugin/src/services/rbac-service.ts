/**
 * RBAC (Role-Based Access Control) service with role hierarchy.
 *
 * @module
 */

import type { IAuthorizationService, IPrincipal, RbacConfig } from '@hono-enterprise/common';

/** Permission that grants every permission. */
const WILDCARD = '*';

/**
 * RBAC service implementing IAuthorizationService.
 */
export class RbacService implements IAuthorizationService {
  private readonly roleDefinitions: Readonly<Record<string, RoleDefinition>>;
  private readonly resolvedPermissions: Map<string, Set<string>>;

  constructor(config: RbacConfig) {
    this.roleDefinitions = config.roles;
    this.resolvedPermissions = new Map();
    this.buildPermissionCache();
  }

  /**
   * Build a cache of all permissions for each role (including inherited).
   */
  private buildPermissionCache(): void {
    for (const roleName of Object.keys(this.roleDefinitions)) {
      this.resolveRolePermissions(roleName, new Set());
    }
  }

  /**
   * Recursively resolve permissions for a role (with cycle detection).
   */
  private resolveRolePermissions(roleName: string, visited: Set<string>): Set<string> {
    if (this.resolvedPermissions.has(roleName)) {
      return this.resolvedPermissions.get(roleName)!;
    }

    if (visited.has(roleName)) {
      // Cycle detected, return empty set to avoid infinite loop
      return new Set();
    }

    visited.add(roleName);

    const roleDef = this.roleDefinitions[roleName];
    if (!roleDef) {
      return new Set();
    }

    const permissions = new Set<string>(roleDef.permissions ?? []);

    // Add permissions from inherited roles
    for (const inheritedRole of roleDef.inherits ?? []) {
      const inheritedPermissions = this.resolveRolePermissions(inheritedRole, visited);
      for (const perm of inheritedPermissions) {
        permissions.add(perm);
      }
    }

    this.resolvedPermissions.set(roleName, permissions);
    return permissions;
  }

  /**
   * Get all roles that a given role inherits (transitively).
   */
  private getInheritedRoles(roleName: string, visited: Set<string> = new Set()): Set<string> {
    if (visited.has(roleName)) {
      return new Set();
    }

    visited.add(roleName);

    const roleDef = this.roleDefinitions[roleName];
    if (!roleDef || !roleDef.inherits) {
      return new Set();
    }

    const allInherited = new Set<string>();
    for (const inheritedRole of roleDef.inherits) {
      allInherited.add(inheritedRole);
      const nestedInherited = this.getInheritedRoles(inheritedRole, visited);
      for (const role of nestedInherited) {
        allInherited.add(role);
      }
    }

    return allInherited;
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
