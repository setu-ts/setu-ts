/**
 * The ROADMAP's scoped RBAC reference scenarios (M110b plan §6.1), each
 * through a REAL kernel application with configuration only, and each with a
 * negative control. Scenario B (sign-in timing) lives in
 * `scoped-sign-in.test.ts`, beside the session cases it needs.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, scopeFromParam } from '@setu-ts/common';
import type { IAuthorizationDiagnosticsSource, ScopeRef } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createDatabaseGrantSource, createDatabaseRoleSource } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { requireRole, requireScopedPermission, requireScopedRole } from '../../src/index.ts';
import { startScopedApp, status } from '../fixtures/scoped-app.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function seed(
  target: IKernelApplication,
  entity: string,
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  const repo = target.services.get<IDatabaseService>(CAPABILITIES.DATABASE).getRepository<
    Record<string, unknown>
  >(entity);
  for (const row of rows) {
    await repo.create(row);
  }
}

describe('Scenario A — tenant scope, platform-wide grants, parent-to-child delegation, repository-backed', () => {
  const PARENT: Record<string, string> = { 'acme-eu': 'acme', 'acme-us': 'acme' };

  async function start(): Promise<IKernelApplication> {
    const started = await startScopedApp({
      tenancy: true,
      database: true,
      auth: {
        scopedRbac: {
          sources: [{ kind: 'custom', source: createDatabaseGrantSource({ entity: 'Grant' }) }],
          inheritsFrom: (scope) =>
            scope.type === 'tenant' && PARENT[scope.id] !== undefined
              ? [{ type: 'tenant', id: PARENT[scope.id] }]
              : [],
        },
      },
      routes: [
        {
          method: 'post',
          path: '/invoices/approve',
          guard: requireScopedPermission('invoices:approve'),
        },
        { method: 'get', path: '/invoices', guard: requireScopedPermission('invoices:read') },
      ],
    });
    await seed(started, 'Grant', [
      { id: 'g1', subject: 'ann', role: 'approver', scopeType: 'tenant', scopeId: 'acme' },
      { id: 'g2', subject: 'pat', role: 'viewer', scopeType: null, scopeId: null },
    ]);
    return started;
  }

  it('a grant in the parent tenant applies in a child tenant', async () => {
    app = await start();
    expect(
      await status(app, '/invoices/approve', { 'x-user': 'ann', 'x-tenant-id': 'acme-eu' }, 'POST'),
    )
      .toBe(200);
    expect(
      await status(app, '/invoices/approve', { 'x-user': 'ann', 'x-tenant-id': 'acme' }, 'POST'),
    ).toBe(
      200,
    );
  });

  it('a platform-wide grant applies in every tenant', async () => {
    app = await start();
    expect(await status(app, '/invoices', { 'x-user': 'pat', 'x-tenant-id': 'globex' })).toBe(200);
  });

  it('NEGATIVE: the same grant does not reach an unrelated tenant', async () => {
    app = await start();
    expect(
      await status(app, '/invoices/approve', { 'x-user': 'ann', 'x-tenant-id': 'globex' }, 'POST'),
    )
      .toBe(403);
    expect(
      await status(app, '/invoices/approve', { 'x-user': 'pat', 'x-tenant-id': 'acme' }, 'POST'),
    ).toBe(
      403,
    );
  });

  it('NEGATIVE: a request with no tenant resolved is denied, never treated as any scope', async () => {
    app = await start();
    expect(await status(app, '/invoices/approve', { 'x-user': 'ann' }, 'POST')).toBe(403);
  });

  it('anonymous requests are refused 401', async () => {
    app = await start();
    expect(await status(app, '/invoices', { 'x-tenant-id': 'acme' })).toBe(401);
  });
});

describe('Scenario C — organisation → team → project, a grant descends', () => {
  const ORG: ScopeRef = { type: 'organisation', id: 'o1' };
  const TEAM: ScopeRef = { type: 'team', id: 'tm1' };
  const UP: Record<string, ScopeRef> = { 'project/p1': TEAM, 'team/tm1': ORG };

  async function start(): Promise<IKernelApplication> {
    return await startScopedApp({
      auth: {
        scopedRbac: {
          sources: [{
            kind: 'static',
            grants: [
              { subject: 'lead', role: 'approver', scope: ORG },
              { subject: 'dev', role: 'approver', scope: { type: 'project', id: 'p1' } },
            ],
          }],
          inheritsFrom: (scope) => {
            const parent = UP[`${scope.type}/${scope.id}`];
            return parent === undefined ? [] : [parent];
          },
        },
      },
      routes: [
        {
          method: 'post',
          path: '/projects/:projectId/approve',
          guard: requireScopedPermission('invoices:approve', {
            scope: scopeFromParam('projectId', 'project'),
          }),
        },
        {
          method: 'post',
          path: '/orgs/:orgId/approve',
          guard: requireScopedPermission('invoices:approve', {
            scope: scopeFromParam('orgId', 'organisation'),
          }),
        },
      ],
    });
  }

  it('an organisation grant applies on a project two levels down', async () => {
    app = await start();
    expect(await status(app, '/projects/p1/approve', { 'x-user': 'lead' }, 'POST')).toBe(200);
  });

  it('NEGATIVE: a project grant does not ascend to its organisation', async () => {
    app = await start();
    expect(await status(app, '/projects/p1/approve', { 'x-user': 'dev' }, 'POST')).toBe(200);
    expect(await status(app, '/orgs/o1/approve', { 'x-user': 'dev' }, 'POST')).toBe(403);
  });
});

describe('Scenario D — grants carried in token claims, no store', () => {
  async function start(): Promise<IKernelApplication> {
    return await startScopedApp({
      auth: {
        scopedRbac: {
          sources: [{
            kind: 'claims',
            map: (claims) => {
              const orgs = claims.orgs;
              if (typeof orgs !== 'object' || orgs === null) {
                return [];
              }
              return Object.entries(orgs as Record<string, readonly string[]>).flatMap((
                [id, roles],
              ) => roles.map((role) => ({ role, scope: { type: 'organisation', id } })));
            },
          }],
        },
      },
      routes: [{
        method: 'get',
        path: '/orgs/:orgId/admin',
        guard: requireScopedRole('approver', { scope: scopeFromParam('orgId', 'organisation') }),
      }],
    });
  }

  const claims = JSON.stringify({ orgs: { x: ['approver'], y: ['viewer'] } });

  it('a claim for an organisation allows in that organisation', async () => {
    app = await start();
    expect(await status(app, '/orgs/x/admin', { 'x-user': 'u', 'x-claims': claims })).toBe(200);
  });

  it('NEGATIVE: the claim does not reach another organisation', async () => {
    app = await start();
    expect(await status(app, '/orgs/y/admin', { 'x-user': 'u', 'x-claims': claims })).toBe(403);
    expect(await status(app, '/orgs/z/admin', { 'x-user': 'u', 'x-claims': claims })).toBe(403);
  });
});

describe('Scenario E — per-tenant custom roles', () => {
  async function start(): Promise<IKernelApplication> {
    const started = await startScopedApp({
      tenancy: true,
      database: true,
      auth: {
        scopedRbac: {
          sources: [{ kind: 'custom', source: createDatabaseGrantSource({ entity: 'Grant' }) }],
          customRoles: createDatabaseRoleSource({ entity: 'Role' }),
        },
      },
      routes: [{
        method: 'post',
        path: '/invoices/approve',
        guard: requireScopedPermission('invoices:approve'),
      }],
    });
    await seed(started, 'Role', [
      {
        id: 'r1',
        scopeType: 'tenant',
        scopeId: 'x',
        role: 'regional-approver',
        permission: 'invoices:approve',
      },
      // Attempts to shadow the catalogue `viewer` with a wider grant.
      {
        id: 'r2',
        scopeType: 'tenant',
        scopeId: 'x',
        role: 'viewer',
        permission: 'invoices:approve',
      },
    ]);
    await seed(started, 'Grant', [
      { id: 'g1', subject: 'ann', role: 'regional-approver', scopeType: 'tenant', scopeId: 'x' },
      { id: 'g2', subject: 'bob', role: 'regional-approver', scopeType: 'tenant', scopeId: 'y' },
      { id: 'g3', subject: 'vic', role: 'viewer', scopeType: 'tenant', scopeId: 'x' },
    ]);
    return started;
  }

  it('a custom role defined in tenant X grants its permission in X', async () => {
    app = await start();
    expect(await status(app, '/invoices/approve', { 'x-user': 'ann', 'x-tenant-id': 'x' }, 'POST'))
      .toBe(200);
  });

  it('NEGATIVE: the same role name granted in tenant Y, which does not define it, grants nothing', async () => {
    app = await start();
    expect(await status(app, '/invoices/approve', { 'x-user': 'bob', 'x-tenant-id': 'y' }, 'POST'))
      .toBe(403);
  });

  it('NEGATIVE: a custom role cannot shadow a catalogue role', async () => {
    app = await start();
    expect(await status(app, '/invoices/approve', { 'x-user': 'vic', 'x-tenant-id': 'x' }, 'POST'))
      .toBe(403);
  });
});

describe('scoped decisions and M98h explanations', () => {
  it('a scoped check is never observed, while a global guard on the same app is', async () => {
    app = await startScopedApp({
      auth: {
        authorizationDiagnostics: { enabled: true, roles: { approver: 'r1' }, permissions: {} },
        scopedRbac: {
          sources: [{ kind: 'static', grants: [{ subject: 'u', role: 'approver', scope: null }] }],
        },
      },
      routes: [
        { method: 'get', path: '/scoped', guard: requireScopedRole('approver', { scope: null }) },
        { method: 'get', path: '/global', guard: requireRole('approver') },
      ],
    });
    const source = app.services.get<IAuthorizationDiagnosticsSource>(
      CAPABILITIES.AUTHORIZATION_DIAGNOSTICS,
    );
    // Positive control: the global RBAC guard IS observed (a deny is a decision).
    expect(await status(app, '/global', { 'x-user': 'u' })).toBe(403);
    expect(source.read('i', 0).decisions.length).toBe(1);
    // The scoped check allows, and adds nothing.
    expect(await status(app, '/scoped', { 'x-user': 'u' })).toBe(200);
    expect(source.read('i', 0).decisions.length).toBe(1);
  });
});
