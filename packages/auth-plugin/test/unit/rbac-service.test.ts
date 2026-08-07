/**
 * Tests for RbacService.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RbacService } from '../../src/services/rbac-service.ts';
import type { IPrincipal, RbacConfig } from '@setu-ts/common';

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

  // Retro review (Part 6): one `visited` set was threaded through the whole
  // recursion AND whatever came back was memoized, so a role resolved as a
  // side-effect of another role's traversal could be cached INCOMPLETE — the
  // result depended on `Object.keys` order.
  describe('closure completeness', () => {
    it('resolves mutually-inheriting roles completely, in either key order', () => {
      const forward = new RbacService({
        roles: {
          a: { permissions: ['pa'], inherits: ['b'] },
          b: { permissions: ['pb'], inherits: ['a'] },
        },
      });
      const reverse = new RbacService({
        roles: {
          b: { permissions: ['pb'], inherits: ['a'] },
          a: { permissions: ['pa'], inherits: ['b'] },
        },
      });

      for (const svc of [forward, reverse]) {
        for (const role of ['a', 'b']) {
          const principal = { id: 'u', roles: [role] };
          expect(svc.hasPermission(principal, 'pa')).toBe(true);
          expect(svc.hasPermission(principal, 'pb')).toBe(true);
        }
      }
    });

    it('resolves a diamond hierarchy for every role', () => {
      const svc = new RbacService({
        roles: {
          admin: { inherits: ['editor', 'moderator'] },
          editor: { permissions: ['write'], inherits: ['viewer'] },
          moderator: { permissions: ['ban'], inherits: ['viewer'] },
          viewer: { permissions: ['read'] },
        },
      });

      const admin = { id: 'u', roles: ['admin'] };
      expect(svc.hasPermission(admin, 'read')).toBe(true);
      expect(svc.hasPermission(admin, 'write')).toBe(true);
      expect(svc.hasPermission(admin, 'ban')).toBe(true);
      expect(svc.hasRole(admin, 'viewer')).toBe(true);

      const moderator = { id: 'm', roles: ['moderator'] };
      expect(svc.hasPermission(moderator, 'read')).toBe(true);
      expect(svc.hasPermission(moderator, 'write')).toBe(false);
    });

    it('ignores an inherited role that is not configured', () => {
      const svc = new RbacService({
        roles: { editor: { permissions: ['write'], inherits: ['ghost'] } },
      });
      const principal = { id: 'u', roles: ['editor'] };
      // The undefined parent contributes nothing and must not abort the walk.
      expect(svc.hasPermission(principal, 'write')).toBe(true);
      expect(svc.hasRole(principal, 'ghost')).toBe(true);
      expect(svc.hasPermission(principal, 'anything-else')).toBe(false);
    });

    it('terminates on a self-inheriting role', () => {
      const svc = new RbacService({
        roles: { loop: { permissions: ['p'], inherits: ['loop'] } },
      });
      const principal = { id: 'u', roles: ['loop'] };
      expect(svc.hasPermission(principal, 'p')).toBe(true);
      expect(svc.hasRole(principal, 'loop')).toBe(true);
    });
  });
});
