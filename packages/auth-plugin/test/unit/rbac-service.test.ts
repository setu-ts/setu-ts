/**
 * Tests for RbacService.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RbacService } from '../../src/services/rbac-service.ts';
import type { IPrincipal, RbacConfig } from '@hono-enterprise/common';

describe('RbacService', () => {
  describe('hasRole', () => {
    it('returns true for a direct role match', () => {
      const config: RbacConfig = {
        roles: {
          user: { permissions: ['users:read'] },
          admin: { permissions: ['*'], inherits: ['user'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['user'] };
      expect(rbac.hasRole(principal, 'user')).toBe(true);
    });

    it('returns false when principal lacks the role', () => {
      const config: RbacConfig = {
        roles: {
          user: { permissions: ['users:read'] },
          admin: { permissions: ['*'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['user'] };
      expect(rbac.hasRole(principal, 'admin')).toBe(false);
    });

    it('returns true for an inherited role (one level)', () => {
      const config: RbacConfig = {
        roles: {
          user: { permissions: ['users:read'] },
          admin: { permissions: ['*'], inherits: ['user'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasRole(principal, 'user')).toBe(true);
    });

    it('returns true for an inherited role (multi-level)', () => {
      const config: RbacConfig = {
        roles: {
          guest: { permissions: ['public:read'] },
          user: { permissions: ['users:read'], inherits: ['guest'] },
          manager: { permissions: ['users:write'], inherits: ['user'] },
          admin: { permissions: ['*'], inherits: ['manager'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasRole(principal, 'guest')).toBe(true);
      expect(rbac.hasRole(principal, 'user')).toBe(true);
      expect(rbac.hasRole(principal, 'manager')).toBe(true);
      expect(rbac.hasRole(principal, 'admin')).toBe(true);
    });

    it('returns true when principal has the role directly even if not in config', () => {
      const config: RbacConfig = { roles: {} };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['custom-role'] };
      expect(rbac.hasRole(principal, 'custom-role')).toBe(true);
    });

    it('handles a principal with no roles', () => {
      const config: RbacConfig = {
        roles: { user: { permissions: ['users:read'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1' };
      expect(rbac.hasRole(principal, 'user')).toBe(false);
    });
  });

  describe('hasPermission', () => {
    it('returns true for a direct permission', () => {
      const config: RbacConfig = {
        roles: { user: { permissions: ['users:read'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['user'] };
      expect(rbac.hasPermission(principal, 'users:read')).toBe(true);
    });

    it('returns true for a permission directly on principal', () => {
      const config: RbacConfig = { roles: {} };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', permissions: ['custom:perm'] };
      expect(rbac.hasPermission(principal, 'custom:perm')).toBe(true);
    });

    it('returns false when permission is not granted', () => {
      const config: RbacConfig = {
        roles: { user: { permissions: ['users:read'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['user'] };
      expect(rbac.hasPermission(principal, 'users:write')).toBe(false);
    });

    it('returns true for permission inherited through role hierarchy', () => {
      const config: RbacConfig = {
        roles: {
          user: { permissions: ['users:read'] },
          admin: { permissions: ['*'], inherits: ['user'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasPermission(principal, 'users:read')).toBe(true);
    });

    it('returns true for permission from multi-level inheritance', () => {
      const config: RbacConfig = {
        roles: {
          guest: { permissions: ['public:read'] },
          user: { permissions: ['users:read'], inherits: ['guest'] },
          admin: { permissions: ['*'], inherits: ['user'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasPermission(principal, 'public:read')).toBe(true);
    });
  });

  describe('hasAnyRole', () => {
    it('returns true when principal has one of the roles', () => {
      const config: RbacConfig = {
        roles: { admin: { permissions: ['*'] }, manager: { permissions: ['manage'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasAnyRole(principal, ['admin', 'manager'])).toBe(true);
    });

    it('returns false when principal has none of the roles', () => {
      const config: RbacConfig = {
        roles: { admin: { permissions: ['*'] }, manager: { permissions: ['manage'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['user'] };
      expect(rbac.hasAnyRole(principal, ['admin', 'manager'])).toBe(false);
    });

    it('returns false for empty roles list', () => {
      const config: RbacConfig = { roles: { admin: { permissions: ['*'] } } };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasAnyRole(principal, [])).toBe(false);
    });
  });

  describe('hasAllPermissions', () => {
    it('returns true when principal has all permissions', () => {
      const config: RbacConfig = {
        roles: { admin: { permissions: ['users:read', 'users:write'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasAllPermissions(principal, ['users:read', 'users:write'])).toBe(true);
    });

    it('returns false when principal is missing one permission', () => {
      const config: RbacConfig = {
        roles: { user: { permissions: ['users:read'] } },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['user'] };
      expect(rbac.hasAllPermissions(principal, ['users:read', 'users:write'])).toBe(false);
    });

    it('returns true for empty permissions list', () => {
      const config: RbacConfig = { roles: {} };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1' };
      expect(rbac.hasAllPermissions(principal, [])).toBe(true);
    });
  });

  describe('wildcard permission', () => {
    const config: RbacConfig = {
      roles: {
        user: { permissions: ['users:read'] },
        admin: { permissions: ['*'], inherits: ['user'] },
      },
    };

    it('grants any permission to a role holding "*"', () => {
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasPermission(principal, 'users:delete')).toBe(true);
      expect(rbac.hasPermission(principal, 'anything:else')).toBe(true);
    });

    it('grants any permission to a principal with a direct "*" permission', () => {
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', permissions: ['*'] };
      expect(rbac.hasPermission(principal, 'users:delete')).toBe(true);
    });

    it('grants a wildcard inherited through the role hierarchy', () => {
      const rbac = new RbacService({
        roles: {
          root: { permissions: ['*'] },
          superadmin: { inherits: ['root'] },
        },
      });
      const principal: IPrincipal = { id: '1', roles: ['superadmin'] };
      expect(rbac.hasPermission(principal, 'users:delete')).toBe(true);
    });

    it('satisfies hasAllPermissions via the wildcard', () => {
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['admin'] };
      expect(rbac.hasAllPermissions(principal, ['users:read', 'audit:write'])).toBe(true);
    });
  });

  describe('cyclic inherits', () => {
    it('does not hang on cyclic inheritance and resolves the acyclic part', () => {
      const config: RbacConfig = {
        roles: {
          a: { permissions: ['perm:a'], inherits: ['b'] },
          b: { permissions: ['perm:b'], inherits: ['a'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['a'] };
      // Should not hang and should resolve permissions
      expect(rbac.hasPermission(principal, 'perm:a')).toBe(true);
      expect(rbac.hasPermission(principal, 'perm:b')).toBe(true);
      expect(rbac.hasRole(principal, 'a')).toBe(true);
      expect(rbac.hasRole(principal, 'b')).toBe(true);
    });

    it('handles self-referencing inherits', () => {
      const config: RbacConfig = {
        roles: {
          a: { permissions: ['perm:a'], inherits: ['a'] },
        },
      };
      const rbac = new RbacService(config);
      const principal: IPrincipal = { id: '1', roles: ['a'] };
      expect(rbac.hasPermission(principal, 'perm:a')).toBe(true);
      expect(rbac.hasRole(principal, 'a')).toBe(true);
    });
  });
});
