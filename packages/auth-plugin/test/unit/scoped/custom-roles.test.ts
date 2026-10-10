/**
 * Per-scope custom roles (M110b plan §3.11): a grant resolves against the
 * roles defined in ITS OWN scope only, in one batched call, with shadowing,
 * unknown permissions and bounds enforced.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IScopedRoleSource, ScopedRoleDefinition, ScopeRef } from '@setu-ts/common';
import type { ScopedRbacOptions, StaticGrant } from '../../../src/interfaces/index.ts';
import { principal, requestContext, scopedHarness } from '../../fixtures/scoped.ts';

const TX: ScopeRef = { type: 'tenant', id: 'x' };
const TY: ScopeRef = { type: 'tenant', id: 'y' };
const ORG: ScopeRef = { type: 'organisation', id: 'o1' };
const TEAM: ScopeRef = { type: 'team', id: 'tm1' };

function roleSource(
  definitions: readonly unknown[],
  calls: (readonly ScopeRef[])[] = [],
): IScopedRoleSource {
  return {
    name: 'tenant-roles',
    rolesFor: (scopes) => {
      calls.push(scopes);
      return Promise.resolve(definitions as readonly ScopedRoleDefinition[]);
    },
  };
}

function harness(
  grants: readonly StaticGrant[],
  roles: IScopedRoleSource,
  extra: Partial<ScopedRbacOptions> = {},
) {
  return scopedHarness({
    sources: [{ kind: 'static', grants }],
    customRoles: roles,
    ...extra,
  });
}

function allows(scoped: ReturnType<typeof harness>, permission: string, scope: ScopeRef) {
  return scoped.evaluator.allows(principal(), { scope, context: requestContext() }, {
    kind: 'permission',
    name: permission,
  });
}

const REGIONAL = { scope: TX, role: 'regional-approver', permissions: ['invoices:approve'] };

describe('custom roles', () => {
  it('grants a custom role’s permissions in its defining scope', async () => {
    const scoped = harness(
      [{ subject: 'u1', role: 'regional-approver', scope: TX }],
      roleSource([REGIONAL]),
    );
    expect(await allows(scoped, 'invoices:approve', TX)).toBe(true);
    expect(await allows(scoped, 'invoices:read', TX)).toBe(false);
  });

  it('does not apply a custom role defined in another tenant', async () => {
    const scoped = harness(
      [{ subject: 'u1', role: 'regional-approver', scope: TY }],
      roleSource([REGIONAL]),
    );
    expect(await allows(scoped, 'invoices:approve', TY)).toBe(false);
  });

  it('descends with its GRANT: a role defined on an organisation, granted there, applies on a team', async () => {
    const defined = { scope: ORG, role: 'lead', permissions: ['invoices:approve'] };
    const scoped = harness([{ subject: 'u1', role: 'lead', scope: ORG }], roleSource([defined]), {
      inheritsFrom: (scope) => scope.type === 'team' ? [ORG] : [],
    });
    expect(await allows(scoped, 'invoices:approve', TEAM)).toBe(true);
  });

  it('never resolves a grant against another chain scope defining the same name', async () => {
    // The team defines a narrow `lead`, the organisation a wide one. A grant of
    // `lead` made on the TEAM must read the team's definition only.
    const scoped = harness(
      [{ subject: 'u1', role: 'lead', scope: TEAM }],
      roleSource([
        { scope: TEAM, role: 'lead', permissions: ['invoices:read'] },
        { scope: ORG, role: 'lead', permissions: ['invoices:approve'] },
      ]),
      { inheritsFrom: (scope) => scope.type === 'team' ? [ORG] : [] },
    );
    expect(await allows(scoped, 'invoices:read', TEAM)).toBe(true);
    expect(await allows(scoped, 'invoices:approve', TEAM)).toBe(false);
  });

  it('asks once per check, batched, and only for scopes holding a non-catalogue grant', async () => {
    const calls: (readonly ScopeRef[])[] = [];
    const scoped = harness(
      [
        { subject: 'u1', role: 'regional-approver', scope: TX },
        { subject: 'u1', role: 'viewer', scope: ORG },
      ],
      roleSource([REGIONAL], calls),
      { inheritsFrom: (scope) => scope.type === 'tenant' ? [ORG] : [] },
    );
    expect(await allows(scoped, 'invoices:approve', TX)).toBe(true);
    expect(calls).toEqual([[TX]]);
  });

  it('makes no call when every grant is a catalogue role, or the catalogue already allows', async () => {
    const calls: (readonly ScopeRef[])[] = [];
    const scoped = harness(
      [{ subject: 'u1', role: 'approver', scope: TX }],
      roleSource([REGIONAL], calls),
    );
    expect(await allows(scoped, 'invoices:approve', TX)).toBe(true);
    expect(await allows(scoped, 'invoices:read', TY)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never lets a custom role shadow a catalogue role, and drops non-catalogue permissions', async () => {
    const scoped = harness(
      [
        { subject: 'u1', role: 'viewer', scope: TX },
        { subject: 'u1', role: 'custom', scope: TX },
      ],
      roleSource([
        { scope: TX, role: 'viewer', permissions: ['invoices:approve'] },
        { scope: TX, role: 'custom', permissions: ['rockets:launch', 'invoices:read'] },
      ]),
    );
    expect(await allows(scoped, 'invoices:approve', TX)).toBe(false);
    expect(await allows(scoped, 'invoices:read', TX)).toBe(true);
    expect(
      scoped.logger.records.some((r) =>
        r.message === 'Scoped authorization ignored invalid entries'
      ),
    )
      .toBe(true);
  });

  it('drops definitions for scopes nobody asked about, and malformed ones', async () => {
    const scoped = harness(
      [{ subject: 'u1', role: 'custom', scope: TX }],
      roleSource([
        { scope: TY, role: 'custom', permissions: ['invoices:approve'] },
        { scope: TX, role: '', permissions: [] },
        { scope: TX, role: 'custom', permissions: 'invoices:approve' },
        null,
        { scope: TX, role: 'custom', permissions: [7, 'invoices:read'] },
      ]),
    );
    expect(await allows(scoped, 'invoices:approve', TX)).toBe(false);
    expect(await allows(scoped, 'invoices:read', TX)).toBe(true);
  });

  it('denies a scope defining more than maxCustomRoles roles', async () => {
    const scoped = harness(
      [{ subject: 'u1', role: 'r1', scope: TX }],
      roleSource([
        { scope: TX, role: 'r1', permissions: ['invoices:read'] },
        { scope: TX, role: 'r2', permissions: ['invoices:read'] },
      ]),
      { maxCustomRoles: 1 },
    );
    expect(await allows(scoped, 'invoices:read', TX)).toBe(false);
    expect(scoped.logger.records.at(-1)?.fields).toMatchObject({ reason: 'custom-roles-limit' });
  });

  it('denies a custom role bundling more than maxPermissionsPerRole permissions', async () => {
    const scoped = harness(
      [{ subject: 'u1', role: 'r1', scope: TX }],
      roleSource([{ scope: TX, role: 'r1', permissions: ['invoices:read', 'invoices:approve'] }]),
      { maxPermissionsPerRole: 1 },
    );
    expect(await allows(scoped, 'invoices:read', TX)).toBe(false);
  });

  it('denies when the role source fails, answers a non-array, or times out', async () => {
    const failing = harness([{ subject: 'u1', role: 'r1', scope: TX }], {
      name: 'roles',
      rolesFor: () => Promise.reject(new Error('down')),
    });
    expect(await allows(failing, 'invoices:read', TX)).toBe(false);
    expect(failing.logger.records.at(-1)?.fields).toMatchObject({
      reason: 'custom-roles-failed',
      source: 'roles',
      errorName: 'Error',
    });

    const odd = harness([{ subject: 'u1', role: 'r1', scope: TX }], {
      name: '',
      rolesFor: () => Promise.resolve({} as never),
    });
    expect(await allows(odd, 'invoices:read', TX)).toBe(false);
    expect(odd.logger.records.at(-1)?.fields).toMatchObject({
      reason: 'custom-roles-failed',
      source: 'customRoles',
    });

    const hanging = harness([{ subject: 'u1', role: 'r1', scope: TX }], {
      name: 'slow',
      rolesFor: () => new Promise(() => {}),
    }, { sourceTimeoutMs: 10 });
    const pending = allows(hanging, 'invoices:read', TX);
    // Advance only once the deadline timer is armed: advancing earlier fires
    // nothing, and the check would hang forever.
    while (hanging.timing.pending() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    hanging.timing.advance(10);
    expect(await pending).toBe(false);
    expect(hanging.logger.records.at(-1)?.fields).toMatchObject({ reason: 'custom-roles-timeout' });
  });

  it('resolves a custom-role factory at bind, and refuses one without rolesFor', () => {
    const made = roleSource([]);
    const scoped = scopedHarness({
      sources: [{ kind: 'static', grants: [] }],
      customRoles: () => made,
    });
    expect(scoped.resolver).toBeDefined();
    expect(() =>
      scopedHarness({
        sources: [{ kind: 'static', grants: [] }],
        customRoles: () => ({}) as IScopedRoleSource,
      })
    ).toThrow('does not implement rolesFor');
  });
});
