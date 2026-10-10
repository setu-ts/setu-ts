/**
 * The scoped RBAC contract's pure members: the reserved policy name, the two
 * ability encoders and the scope-type grammar.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isScopeType,
  MAX_SCOPE_ID_LENGTH,
  SCOPED_RBAC_POLICY,
  scopedPermissionAbility,
  scopedRoleAbility,
} from '../../src/services/scoped-authorization.ts';

describe('scoped RBAC contract', () => {
  it('reserves the built-in policy name', () => {
    expect(SCOPED_RBAC_POLICY).toBe('scoped-rbac');
  });

  it('encodes permissions and roles into separate namespaces', () => {
    expect(scopedPermissionAbility('invoices:approve')).toBe('perm:invoices:approve');
    expect(scopedRoleAbility('approver')).toBe('role:approver');
    // A permission and a role sharing a name never share an ability.
    expect(scopedPermissionAbility('admin')).not.toBe(scopedRoleAbility('admin'));
    // `before` is the one reserved ability key; encoding keeps it legal.
    expect(scopedPermissionAbility('before')).toBe('perm:before');
  });

  it('caps scope ids at 256 code units', () => {
    expect(MAX_SCOPE_ID_LENGTH).toBe(256);
  });

  const accepted = ['tenant', 'organisation', 'team-2', 'a'];
  const refused: readonly unknown[] = [
    '',
    'Tenant',
    '2tenant',
    'tenant.child',
    'tenant:x',
    '-tenant',
    'ten ant',
    7,
    null,
    undefined,
    {},
  ];

  for (const value of accepted) {
    it(`accepts the scope type ${JSON.stringify(value)}`, () => {
      expect(isScopeType(value)).toBe(true);
    });
  }

  for (const value of refused) {
    it(`refuses the scope type ${String(JSON.stringify(value))}`, () => {
      expect(isScopeType(value)).toBe(false);
    });
  }
});
