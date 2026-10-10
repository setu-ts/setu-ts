/**
 * The complete deny list (M110b plan §3.14), and what may reach a log.
 *
 * Every row plants canaries — in the scope id, the principal id and a
 * source's error message — and asserts the check denies, logs exactly one
 * record with the row's reason, and that no canary appears anywhere in any
 * record. The check never throws.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, ScopeRef } from '@setu-ts/common';
import type { ScopedRbacOptions } from '../../../src/interfaces/index.ts';
import { createScopedRbac } from '../../../src/scoped/scoped-policy.ts';
import { compileScopedRbac } from '../../../src/scoped/options.ts';
import {
  CATALOGUE,
  manualTiming,
  principal,
  recordingLogger,
  requestContext,
  scopedHarness,
} from '../../fixtures/scoped.ts';

const SCOPE_CANARY = 'CANARY-SCOPE-7f3a';
const USER_CANARY = 'CANARY-USER-9b1c';
const MESSAGE_CANARY = 'CANARY-MESSAGE-4d2e';
const SCOPE: ScopeRef = { type: 'tenant', id: SCOPE_CANARY };

const failingSource = {
  kind: 'custom',
  source: {
    name: 'db',
    grantsFor: () =>
      Promise.reject(
        new Error(
          `SELECT * FROM grants WHERE subject = '${USER_CANARY}' AND scope = '${SCOPE_CANARY}' ${MESSAGE_CANARY}`,
        ),
      ),
  },
} as const;

const okSource = {
  kind: 'static',
  grants: [{ subject: USER_CANARY, role: 'viewer', scope: SCOPE }],
} as const;

interface Row {
  readonly name: string;
  readonly options: ScopedRbacOptions;
  readonly target: unknown;
  readonly reason: string;
}

const rows: readonly Row[] = [
  {
    name: 'an unresolved scope',
    options: { sources: [okSource] },
    target: { context: requestContext() },
    reason: 'scope-unresolved',
  },
  {
    name: 'an invalid scope',
    options: { sources: [okSource] },
    target: { scope: { type: 'Tenant', id: SCOPE_CANARY } },
    reason: 'scope-invalid',
  },
  {
    name: 'a non-object target',
    options: { sources: [okSource] },
    target: SCOPE_CANARY,
    reason: 'scope-invalid',
  },
  {
    name: 'a tenant mismatch',
    options: { sources: [okSource] },
    target: { scope: SCOPE, context: requestContext({ tenant: 'another' }) },
    reason: 'tenant-mismatch',
  },
  {
    name: 'a failing source',
    options: { sources: [failingSource] },
    target: { scope: SCOPE },
    reason: 'source-failed',
  },
  {
    name: 'a grant limit',
    options: { sources: [okSource, okSource], maxGrantsPerPrincipal: 1 },
    target: { scope: SCOPE },
    reason: 'grant-limit',
  },
  {
    name: 'a failing resolver',
    options: {
      sources: [okSource],
      inheritsFrom: () => Promise.reject(new Error(MESSAGE_CANARY + SCOPE_CANARY)),
    },
    target: { scope: SCOPE },
    reason: 'resolver-failed',
  },
  {
    name: 'a cyclic resolver',
    options: { sources: [okSource], inheritsFrom: (scope) => [scope] },
    target: { scope: SCOPE },
    reason: 'scope-cycle',
  },
  {
    name: 'a failing custom-role source',
    options: {
      sources: [{
        kind: 'static',
        grants: [{ subject: USER_CANARY, role: 'custom', scope: SCOPE }],
      }],
      customRoles: { name: 'roles', rolesFor: () => Promise.reject(new Error(MESSAGE_CANARY)) },
    },
    target: { scope: SCOPE },
    reason: 'custom-roles-failed',
  },
];

function assertNoCanary(records: readonly unknown[]): void {
  const text = JSON.stringify(records);
  expect(text).not.toContain(SCOPE_CANARY);
  expect(text).not.toContain(USER_CANARY);
  expect(text).not.toContain(MESSAGE_CANARY);
}

describe('scoped evaluator — fail closed', () => {
  for (const row of rows) {
    it(`denies ${row.name}, logs one record with reason ${row.reason}, and no canary`, async () => {
      const scoped = scopedHarness(row.options);
      const allowed = await scoped.evaluator.allows(principal(USER_CANARY), row.target, {
        kind: 'permission',
        name: 'invoices:read',
      });
      expect(allowed).toBe(false);
      const denials = scoped.logger.records.filter((r) =>
        r.message === 'Scoped authorization denied'
      );
      expect(denials.length).toBe(1);
      expect(denials[0].fields).toMatchObject({ policy: 'scoped-rbac', reason: row.reason });
      assertNoCanary(scoped.logger.records);
    });
  }

  it('logs client-caused denials at warn and outages at error', async () => {
    const client = scopedHarness({ sources: [okSource] });
    await client.evaluator.allows(principal(), { context: requestContext() }, {
      kind: 'role',
      name: 'viewer',
    });
    expect(client.logger.records[0].level).toBe('warn');
    const outage = scopedHarness({ sources: [failingSource] });
    await outage.evaluator.allows(principal(), { scope: SCOPE }, { kind: 'role', name: 'viewer' });
    expect(outage.logger.records[0].level).toBe('error');
  });

  it('allows the same principal and scope once nothing fails — the rows deny for their reason', async () => {
    const scoped = scopedHarness({ sources: [okSource] });
    expect(
      await scoped.evaluator.allows(principal(USER_CANARY), { scope: SCOPE }, {
        kind: 'permission',
        name: 'invoices:read',
      }),
    ).toBe(true);
    expect(scoped.logger.records).toEqual([]);
  });

  it('never throws: an unexpected internal error denies as evaluation-failed', async () => {
    const scoped = scopedHarness({ sources: [okSource] });
    const hostile = {
      get scope(): never {
        throw new RangeError(SCOPE_CANARY);
      },
    };
    expect(await scoped.evaluator.allows(principal(), hostile, { kind: 'role', name: 'viewer' }))
      .toBe(false);
    expect(scoped.logger.records[0].fields).toMatchObject({
      reason: 'evaluation-failed',
      errorName: 'RangeError',
    });
    assertNoCanary(scoped.logger.records);
  });

  it('labels a thrown non-identifier name without copying it', async () => {
    const scoped = scopedHarness({
      sources: [{
        kind: 'custom',
        source: {
          name: 'db',
          grantsFor: () => {
            const error = new Error('x');
            error.name = `Bad Name ${SCOPE_CANARY}`;
            return Promise.reject(error);
          },
        },
      }],
    });
    await scoped.evaluator.allows(principal(), { scope: SCOPE }, { kind: 'role', name: 'viewer' });
    expect(scoped.logger.records[0].fields).toMatchObject({ errorName: '[object]' });
    assertNoCanary(scoped.logger.records);
  });

  it('keeps the deny when the logger itself throws', async () => {
    const config = compileScopedRbac({ sources: [failingSource] }, CATALOGUE, true);
    const throwing = recordingLogger();
    const broken: ILogger = {
      ...throwing,
      error: () => {
        throw new Error('transport down');
      },
    };
    const scoped = createScopedRbac(config, manualTiming(), () => broken);
    scoped.resolver.bind({} as never);
    expect(
      await scoped.evaluator.allows(principal(), { scope: SCOPE }, {
        kind: 'role',
        name: 'viewer',
      }),
    ).toBe(
      false,
    );
  });

  it('reports the dropped-entry count without the entries', async () => {
    const scoped = scopedHarness({
      sources: [{
        kind: 'custom',
        source: { name: 'db', grantsFor: () => Promise.resolve([{ role: SCOPE_CANARY }] as never) },
      }],
    });
    await scoped.evaluator.allows(principal(), { scope: SCOPE }, { kind: 'role', name: 'viewer' });
    expect(scoped.logger.records[0]).toMatchObject({
      level: 'warn',
      message: 'Scoped authorization ignored invalid entries',
      fields: { policy: 'scoped-rbac', kind: 'grants', count: 1 },
    });
    assertNoCanary(scoped.logger.records);
  });
});
