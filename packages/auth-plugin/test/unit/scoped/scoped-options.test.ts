/**
 * `scopedRbac` validation (M110b plan §3.2, §3.13): every misconfiguration
 * refuses with `AuthPluginConfigurationError` when `AuthPlugin(...)` is called,
 * and every bound refuses `NaN`, fractions, zero and negatives.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin } from '../../../src/plugin/auth-plugin.ts';
import { AuthPluginConfigurationError } from '../../../src/errors.ts';
import { compileScopedRbac } from '../../../src/scoped/options.ts';
import type { ScopedRbacOptions } from '../../../src/interfaces/index.ts';
import { CATALOGUE } from '../../fixtures/scoped.ts';

const SOURCE = { kind: 'static', grants: [] } as const;

function compile(options: Partial<ScopedRbacOptions>, signIn = true) {
  return compileScopedRbac(
    { sources: [SOURCE], ...options } as ScopedRbacOptions,
    CATALOGUE,
    signIn,
  );
}

function refused(options: unknown, message: string | RegExp, signIn = true): void {
  expect(() => compileScopedRbac(options as ScopedRbacOptions, CATALOGUE, signIn)).toThrow(
    AuthPluginConfigurationError,
  );
  expect(() => compileScopedRbac(options as ScopedRbacOptions, CATALOGUE, signIn)).toThrow(message);
}

describe('compileScopedRbac — defaults', () => {
  it('applies every documented default', () => {
    const config = compile({});
    expect(config.timing).toEqual({ kind: 'request' });
    expect(config.tenantScopeType).toBe('tenant');
    expect(config.sourceTimeoutMs).toBe(2_000);
    expect(config.maxGrants).toBe(256);
    expect(config.maxScopeDepth).toBe(8);
    expect(config.maxScopeNodes).toBe(32);
    expect(config.maxCustomRoles).toBe(128);
    expect(config.maxPermissionsPerRole).toBe(256);
    expect(config.inheritsFrom).toBeUndefined();
    expect(config.customRoles).toBeUndefined();
  });

  it('builds the catalogue closure, and never makes the wildcard checkable', () => {
    const config = compile({ permissions: ['reports:read'] });
    expect([...config.permissions].sort()).toEqual([
      'invoices:approve',
      'invoices:read',
      'reports:read',
    ]);
    expect(config.roles.get('approver')?.permissions.has('invoices:read')).toBe(true);
    expect(config.roles.get('approver')?.inherits.has('viewer')).toBe(true);
    expect(config.roles.get('owner')?.permissions.has('*')).toBe(true);
    expect(config.roles.has('constructor')).toBe(false);
  });

  it('resolves a cyclic inheritance completely from every starting role', () => {
    const config = compileScopedRbac({ sources: [SOURCE] }, {
      roles: {
        a: { permissions: ['pa'], inherits: ['b'] },
        b: { permissions: ['pb'], inherits: ['a'] },
      },
    }, true);
    expect([...config.roles.get('a')!.permissions].sort()).toEqual(['pa', 'pb']);
    expect([...config.roles.get('b')!.permissions].sort()).toEqual(['pa', 'pb']);
  });

  it('ignores an inherited role that is not defined', () => {
    const config = compileScopedRbac({ sources: [SOURCE] }, {
      roles: { a: { permissions: ['pa'], inherits: ['ghost', 'toString'] } },
    }, true);
    expect([...config.roles.get('a')!.permissions]).toEqual(['pa']);
  });

  it("never inherits a role definition from the roles object's prototype", () => {
    // `Object.keys` skips the inherited `admin`, so it is not a role; the
    // closure must not reach it through `a`'s `inherits` either.
    const roles = Object.assign(Object.create({ admin: { permissions: ['everything'] } }), {
      a: { permissions: ['pa'], inherits: ['admin'] },
    });
    const config = compileScopedRbac({ sources: [SOURCE] }, { roles }, true);
    expect(config.roles.has('admin')).toBe(false);
    expect([...config.roles.get('a')!.permissions]).toEqual(['pa']);
  });

  it('compiles a cache timing, a limit and the custom-role source', () => {
    const roles = { name: 'r', rolesFor: () => Promise.resolve([]) };
    const config = compile({
      timing: { kind: 'cache', ttlMs: 5_000, maxEntries: 10 },
      grantableIn: { approver: { scopeTypes: ['tenant'], global: true } },
      customRoles: roles,
      tenantScopeType: 'account',
    });
    expect(config.timing).toEqual({ kind: 'cache', ttlMs: 5_000, maxEntries: 10 });
    expect(config.limits.get('approver')?.global).toBe(true);
    expect(config.limits.get('approver')?.scopeTypes.has('tenant')).toBe(true);
    expect(config.customRoles).toBe(roles);
    expect(config.tenantScopeType).toBe('account');
  });

  it('indexes static grants by subject', () => {
    const config = compile({
      sources: [{
        kind: 'static',
        grants: [
          { subject: 'u1', role: 'viewer', scope: null },
          { subject: 'u1', role: 'approver', scope: { type: 'tenant', id: 't1' } },
          { subject: 'u2', role: 'viewer', scope: null },
        ],
      }],
    });
    const source = config.sources[0];
    expect(source.kind).toBe('static');
    if (source.kind === 'static') {
      expect(source.bySubject.get('u1')?.length).toBe(2);
      expect(source.bySubject.get('u2')?.length).toBe(1);
    }
  });
});

describe('compileScopedRbac — refusals', () => {
  it('refuses scopedRbac without rbac', () => {
    expect(() => compileScopedRbac({ sources: [SOURCE] }, undefined, true)).toThrow(
      'scopedRbac requires rbac',
    );
  });

  it('refuses an empty catalogue', () => {
    expect(() => compileScopedRbac({ sources: [SOURCE] }, { roles: {} }, true)).toThrow(
      'the catalogue is empty',
    );
  });

  it('refuses a non-object option and an empty source list', () => {
    refused(null, 'must be an object');
    refused({ sources: [] }, 'at least one grant source');
    refused({}, 'at least one grant source');
  });

  it('refuses malformed sources by index', () => {
    refused({ sources: [null] }, 'sources[0] must be an object');
    refused(
      { sources: [{ kind: 'nope' }] },
      "sources[0].kind must be 'static', 'claims' or 'custom'",
    );
    refused({ sources: [{ kind: 'static' }] }, 'sources[0].grants must be an array');
    refused(
      { sources: [{ kind: 'static', grants: [{ role: 'viewer', scope: null }] }] },
      'sources[0].grants[0]',
    );
    refused(
      { sources: [{ kind: 'static', grants: [{ subject: 'u', role: '', scope: null }] }] },
      'grants[0]',
    );
    refused(
      {
        sources: [{
          kind: 'static',
          grants: [{ subject: 'u', role: 'r', scope: { type: 'T', id: 'x' } }],
        }],
      },
      'grants[0]',
    );
    refused({ sources: [{ kind: 'claims' }] }, 'sources[0].map must be a function');
    refused({ sources: [{ kind: 'custom', source: {} }] }, 'sources[0].source must be');
  });

  it('accepts a custom source given as a factory', () => {
    expect(() =>
      compile({
        sources: [{
          kind: 'custom',
          source: () => ({ name: 'x', grantsFor: () => Promise.resolve([]) }),
        }],
      })
    )
      .not.toThrow();
  });

  it('refuses a malformed permissions list, resolver, tenant type and role source', () => {
    refused({ sources: [SOURCE], permissions: 'p' }, 'permissions must be an array');
    refused({ sources: [SOURCE], permissions: [''] }, 'non-empty permission names');
    refused({ sources: [SOURCE], inheritsFrom: 'x' }, 'inheritsFrom must be a function');
    refused({ sources: [SOURCE], tenantScopeType: 'Tenant' }, 'tenantScopeType');
    refused({ sources: [SOURCE], customRoles: {} }, 'customRoles must be');
  });

  it('refuses malformed timing, and sign-in timing without signIn', () => {
    refused({ sources: [SOURCE], timing: 'nightly' }, 'timing must be');
    refused(
      { sources: [SOURCE], timing: { kind: 'cache', ttlMs: 5_000 } },
      'needs both ttlMs and maxEntries',
    );
    refused(
      { sources: [SOURCE], timing: { kind: 'cache', ttlMs: 999, maxEntries: 1 } },
      'timing.ttlMs',
    );
    refused(
      { sources: [SOURCE], timing: { kind: 'cache', ttlMs: 5_000, maxEntries: 0 } },
      'timing.maxEntries',
    );
    refused(
      { sources: [SOURCE], timing: 'sign-in' },
      "timing 'sign-in' requires the signIn option",
      false,
    );
    expect(() => compile({ timing: 'sign-in' }, true)).not.toThrow();
  });

  it('refuses a malformed grantableIn', () => {
    refused({ sources: [SOURCE], grantableIn: [] }, 'grantableIn must be an object');
    refused(
      { sources: [SOURCE], grantableIn: { ghost: { scopeTypes: ['tenant'] } } },
      '"ghost", which is not an rbac role',
    );
    refused(
      { sources: [SOURCE], grantableIn: { viewer: { scopeTypes: ['Bad'] } } },
      'scopeTypes must be',
    );
    refused({ sources: [SOURCE], grantableIn: { viewer: {} } }, 'scopeTypes must be');
    refused({
      sources: [SOURCE],
      grantableIn: { viewer: { scopeTypes: ['tenant'], global: 'yes' } },
    }, 'global must be a boolean');
    refused(
      { sources: [SOURCE], grantableIn: { viewer: { scopeTypes: [] } } },
      'grantable nowhere',
    );
    expect(() => compile({ grantableIn: { viewer: { scopeTypes: [], global: true } } })).not
      .toThrow();
  });

  const bounds: readonly (readonly [keyof ScopedRbacOptions, number, number])[] = [
    ['sourceTimeoutMs', 1, 60_000],
    ['maxGrantsPerPrincipal', 1, 10_000],
    ['maxScopeDepth', 1, 64],
    ['maxScopeNodes', 1, 1_024],
    ['maxCustomRoles', 1, 10_000],
    ['maxPermissionsPerRole', 1, 10_000],
  ];

  for (const [name, min, max] of bounds) {
    it(`refuses ${name} outside ${min}–${max}, NaN and fractions`, () => {
      for (
        const value of [min - 1, max + 1, Number.NaN, Number.POSITIVE_INFINITY, min + 0.5, '5']
      ) {
        refused({ sources: [SOURCE], [name]: value }, `${name} must be an integer`);
      }
      expect(() => compile({ [name]: min })).not.toThrow();
      expect(() => compile({ [name]: max })).not.toThrow();
    });
  }
});

describe('AuthPlugin — scopedRbac construction', () => {
  it('refuses scopedRbac without rbac when AuthPlugin(...) is called', () => {
    expect(() => AuthPlugin({ scopedRbac: { sources: [SOURCE] } })).toThrow(
      AuthPluginConfigurationError,
    );
  });

  it('refuses sign-in timing without signIn when AuthPlugin(...) is called', () => {
    expect(() =>
      AuthPlugin({ rbac: CATALOGUE, scopedRbac: { sources: [SOURCE], timing: 'sign-in' } })
    )
      .toThrow('requires the signIn option');
  });

  it('reserves the scoped-rbac policy name whether or not scopedRbac is set', () => {
    const policy = { name: 'scoped-rbac', abilities: { x: () => true } };
    expect(() => AuthPlugin({ policies: [policy] })).toThrow('is reserved for scoped RBAC');
  });
});
