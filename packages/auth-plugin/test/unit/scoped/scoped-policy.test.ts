/**
 * The built-in `scoped-rbac` policy (M110b plan §3.1, §3.8): its abilities,
 * and how a grant set answers a permission or role check in a scope.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { PolicyCheck, ScopedGrant, ScopeRef } from '@setu-ts/common';
import type { ScopedRbacOptions, StaticGrant } from '../../../src/interfaces/index.ts';
import { principal, scopedHarness } from '../../fixtures/scoped.ts';

const T1: ScopeRef = { type: 'tenant', id: 't1' };
const T2: ScopeRef = { type: 'tenant', id: 't2' };
const ORG: ScopeRef = { type: 'organisation', id: 'o1' };

function withGrants(grants: readonly StaticGrant[], extra: Partial<ScopedRbacOptions> = {}) {
  return scopedHarness({ sources: [{ kind: 'static', grants }], ...extra });
}

function check(
  harness: ReturnType<typeof withGrants>,
  ability: string,
  scope: ScopeRef | null,
  who = principal(),
): Promise<boolean> {
  const fn = harness.policy.abilities[ability] as PolicyCheck<unknown>;
  return Promise.resolve(fn(who, { scope }));
}

describe('scoped-rbac policy — abilities', () => {
  it('declares one ability per catalogue permission and role, never the wildcard', () => {
    const harness = withGrants([], { permissions: ['before'] });
    expect(harness.policy.name).toBe('scoped-rbac');
    expect(Object.keys(harness.policy.abilities).sort()).toEqual([
      'perm:before',
      'perm:invoices:approve',
      'perm:invoices:read',
      'role:approver',
      'role:owner',
      'role:viewer',
    ]);
  });
});

describe('scoped-rbac policy — evaluation', () => {
  const grants: StaticGrant[] = [
    { subject: 'u1', role: 'approver', scope: T1 },
    { subject: 'u2', role: 'owner', scope: T1 },
    { subject: 'u3', role: 'viewer', scope: null },
  ];

  it('allows a permission granted in the scope, directly and through inheritance', async () => {
    const harness = withGrants(grants);
    expect(await check(harness, 'perm:invoices:approve', T1)).toBe(true);
    expect(await check(harness, 'perm:invoices:read', T1)).toBe(true);
    expect(await check(harness, 'role:approver', T1)).toBe(true);
    expect(await check(harness, 'role:viewer', T1)).toBe(true);
  });

  it('denies the same permission in a scope it is not granted in', async () => {
    const harness = withGrants(grants);
    expect(await check(harness, 'perm:invoices:approve', T2)).toBe(false);
    expect(await check(harness, 'role:approver', T2)).toBe(false);
  });

  it('denies a role the granted role does not inherit', async () => {
    const harness = withGrants([{ subject: 'u1', role: 'viewer', scope: T1 }]);
    expect(await check(harness, 'role:approver', T1)).toBe(false);
    expect(await check(harness, 'perm:invoices:approve', T1)).toBe(false);
  });

  it('honours a wildcard role grant for every permission in its scope only', async () => {
    const harness = withGrants(grants);
    expect(await check(harness, 'perm:invoices:approve', T1, principal('u2'))).toBe(true);
    expect(await check(harness, 'perm:invoices:approve', T2, principal('u2'))).toBe(false);
  });

  it('applies a global grant in every scope, and alone for a null scope', async () => {
    const harness = withGrants(grants);
    expect(await check(harness, 'perm:invoices:read', T2, principal('u3'))).toBe(true);
    expect(await check(harness, 'perm:invoices:read', null, principal('u3'))).toBe(true);
    // A scoped grant does not answer a global-only check.
    expect(await check(harness, 'perm:invoices:approve', null, principal('u1'))).toBe(false);
  });

  it("treats the principal's own roles as global grants and its permissions as held", async () => {
    const harness = withGrants([]);
    expect(await check(harness, 'perm:invoices:read', T1, principal('x', { roles: ['viewer'] })))
      .toBe(
        true,
      );
    expect(
      await check(
        harness,
        'perm:invoices:approve',
        T1,
        principal('x', { permissions: ['invoices:approve'] }),
      ),
    ).toBe(true);
    expect(
      await check(harness, 'perm:invoices:approve', T1, principal('x', { permissions: ['*'] })),
    ).toBe(
      true,
    );
    expect(
      await check(harness, 'perm:invoices:approve', T1, principal('x', { permissions: ['other'] })),
    )
      .toBe(false);
  });

  it('never resolves a prototype member as a role', async () => {
    const harness = withGrants([
      { subject: 'u1', role: 'constructor', scope: T1 },
      { subject: 'u1', role: 'toString', scope: null },
    ]);
    expect(await check(harness, 'perm:invoices:read', T1)).toBe(false);
    expect(await check(harness, 'role:viewer', T1)).toBe(false);
  });

  it('ignores grants for another subject', async () => {
    const harness = withGrants(grants);
    expect(await check(harness, 'perm:invoices:approve', T1, principal('stranger'))).toBe(false);
  });
});

describe('scoped-rbac policy — grantableIn', () => {
  const limited = {
    grantableIn: { approver: { scopeTypes: ['tenant'] } },
  } satisfies Partial<ScopedRbacOptions>;

  it('ignores a limited role granted in a scope type it is not grantable in', async () => {
    const harness = withGrants([{ subject: 'u1', role: 'approver', scope: ORG }], limited);
    expect(await check(harness, 'perm:invoices:approve', ORG)).toBe(false);
    expect(await check(harness, 'role:approver', ORG)).toBe(false);
  });

  it('counts the same role in a permitted scope type', async () => {
    const harness = withGrants([{ subject: 'u1', role: 'approver', scope: T1 }], limited);
    expect(await check(harness, 'perm:invoices:approve', T1)).toBe(true);
  });

  it('ignores a global grant of a limited role unless global is allowed', async () => {
    const global: ScopedGrant = { role: 'approver', scope: null };
    const denied = withGrants([{ subject: 'u1', ...global }], limited);
    expect(await check(denied, 'perm:invoices:approve', T1)).toBe(false);
    expect(
      await check(denied, 'perm:invoices:approve', T1, principal('x', { roles: ['approver'] })),
    )
      .toBe(false);
    const allowed = withGrants([{ subject: 'u1', ...global }], {
      grantableIn: { approver: { scopeTypes: ['tenant'], global: true } },
    });
    expect(await check(allowed, 'perm:invoices:approve', T1)).toBe(true);
  });

  it('leaves an unlimited role valid everywhere', async () => {
    const harness = withGrants([{ subject: 'u1', role: 'viewer', scope: ORG }], limited);
    expect(await check(harness, 'perm:invoices:read', ORG)).toBe(true);
  });
});
