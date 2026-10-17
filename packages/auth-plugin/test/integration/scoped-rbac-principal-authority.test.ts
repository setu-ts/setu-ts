/**
 * The X72 control for V9-28 (M113e plan §3.1), through a REAL kernel
 * application and a REAL signed JWT.
 *
 * A principal holds a scoped `owner` grant in tenant A only, and its token
 * also carries `owner` as a role. Before 0.10.0 that token role counted as a
 * global grant, so the principal passed every scoped check in tenant B too.
 * By default it no longer does; `principalAuthorityIsGlobal: true` restores
 * the old answer, and the unscoped `requireRole` reads the token either way.
 *
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { requireRole, requireScopedPermission, requireScopedRole } from '../../src/index.ts';
import type { ScopedRbacOptions } from '../../src/index.ts';
import { startScopedApp, status } from '../fixtures/scoped-app.ts';

const SECRET = 'x'.repeat(48);

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(extra: Partial<ScopedRbacOptions> = {}): Promise<IKernelApplication> {
  return await startScopedApp({
    tenancy: true,
    auth: {
      jwt: { secret: SECRET },
      scopedRbac: {
        sources: [
          {
            kind: 'static',
            grants: [{ subject: 'ann', role: 'owner', scope: { type: 'tenant', id: 'acme' } }],
          },
        ],
        ...extra,
      },
    },
    routes: [
      { method: 'get', path: '/scoped-role', guard: requireScopedRole('owner') },
      {
        method: 'post',
        path: '/scoped-permission',
        guard: requireScopedPermission('invoices:approve'),
      },
      { method: 'get', path: '/unscoped-role', guard: requireRole('owner') },
    ],
  });
}

async function bearer(target: IKernelApplication, claims: Record<string, unknown>) {
  const jwt = target.services.get<IJwtService>(CAPABILITIES.JWT);
  return { authorization: `Bearer ${await jwt.sign({ sub: 'ann', ...claims })}` };
}

describe('scoped RBAC and the principal’s own authority (V9-28)', () => {
  it('admits the token role only where the grant is (default)', async () => {
    app = await start();
    const auth = await bearer(app, { roles: ['owner'] });
    expect(await status(app, '/scoped-role', { ...auth, 'x-tenant-id': 'acme' })).toBe(200);
    expect(await status(app, '/scoped-role', { ...auth, 'x-tenant-id': 'globex' })).toBe(403);
    expect(
      await status(app, '/scoped-permission', { ...auth, 'x-tenant-id': 'globex' }, 'POST'),
    ).toBe(403);
  });

  it('ignores a token wildcard permission in a tenant that granted nothing (default)', async () => {
    app = await start();
    const auth = await bearer(app, { permissions: ['*'] });
    expect(
      await status(app, '/scoped-permission', { ...auth, 'x-tenant-id': 'globex' }, 'POST'),
    ).toBe(403);
  });

  it('still answers the unscoped requireRole from the token in both tenants', async () => {
    app = await start();
    const auth = await bearer(app, { roles: ['owner'] });
    expect(await status(app, '/unscoped-role', { ...auth, 'x-tenant-id': 'acme' })).toBe(200);
    expect(await status(app, '/unscoped-role', { ...auth, 'x-tenant-id': 'globex' })).toBe(200);
  });

  it('restores the pre-0.10.0 answer with principalAuthorityIsGlobal: true', async () => {
    app = await start({ principalAuthorityIsGlobal: true });
    const roles = await bearer(app, { roles: ['owner'] });
    expect(await status(app, '/scoped-role', { ...roles, 'x-tenant-id': 'globex' })).toBe(200);
    const wildcard = await bearer(app, { permissions: ['*'] });
    expect(
      await status(app, '/scoped-permission', { ...wildcard, 'x-tenant-id': 'globex' }, 'POST'),
    ).toBe(200);
  });

  it('NEGATIVE: a token with no matching role is refused in both modes', async () => {
    app = await start({ principalAuthorityIsGlobal: true });
    const auth = await bearer(app, { roles: ['viewer'] });
    expect(await status(app, '/scoped-role', { ...auth, 'x-tenant-id': 'globex' })).toBe(403);
  });
});
