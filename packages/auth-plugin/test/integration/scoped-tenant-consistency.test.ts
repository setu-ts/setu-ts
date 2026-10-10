/**
 * Tenant consistency through a REAL kernel application with
 * `MultiTenancyPlugin` resolving the request tenant (M110b plan §3.6): a
 * route-parameter scope naming another tenant than the resolved one is
 * refused, while a parent tenant reached from the request tenant applies.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { scopeFromParam } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { requireScopedPermission } from '../../src/index.ts';
import { startScopedApp, status } from '../fixtures/scoped-app.ts';
import { recordingLogger } from '../fixtures/scoped.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(logger = recordingLogger()): Promise<IKernelApplication> {
  return await startScopedApp({
    tenancy: true,
    logger,
    auth: {
      scopedRbac: {
        sources: [{
          kind: 'static',
          grants: [
            { subject: 'ann', role: 'approver', scope: { type: 'tenant', id: 'acme' } },
            { subject: 'eve', role: 'approver', scope: { type: 'tenant', id: 'globex' } },
          ],
        }],
        inheritsFrom: (scope) => scope.id === 'acme-eu' ? [{ type: 'tenant', id: 'acme' }] : [],
      },
    },
    routes: [{
      method: 'post',
      path: '/tenants/:tenantId/approve',
      guard: requireScopedPermission('invoices:approve', {
        scope: scopeFromParam('tenantId', 'tenant'),
      }),
    }],
  });
}

describe('tenant consistency', () => {
  it('refuses a parameter naming another tenant than the resolved one, without its id in the log', async () => {
    const logger = recordingLogger();
    app = await start(logger);
    // eve holds approver in globex; resolved to acme, she names globex.
    expect(
      await status(
        app,
        '/tenants/globex/approve',
        { 'x-user': 'eve', 'x-tenant-id': 'acme' },
        'POST',
      ),
    ).toBe(403);
    const denial = logger.records.find((r) => r.message === 'Scoped authorization denied');
    expect(denial?.fields).toMatchObject({ reason: 'tenant-mismatch', scopeType: 'tenant' });
    expect(JSON.stringify(logger.records)).not.toContain('globex');
  });

  it('allows a parameter naming the resolved tenant itself', async () => {
    app = await start();
    expect(
      await status(
        app,
        '/tenants/globex/approve',
        { 'x-user': 'eve', 'x-tenant-id': 'globex' },
        'POST',
      ),
    ).toBe(200);
  });

  it('honours the parameter as given when no tenant is resolved', async () => {
    app = await start();
    expect(await status(app, '/tenants/globex/approve', { 'x-user': 'eve' }, 'POST')).toBe(200);
  });

  it('a parent tenant reached from the request tenant applies (child inherits parent)', async () => {
    app = await start();
    expect(
      await status(
        app,
        '/tenants/acme-eu/approve',
        { 'x-user': 'ann', 'x-tenant-id': 'acme-eu' },
        'POST',
      ),
    ).toBe(200);
  });

  it('a parent administrator resolved to the parent cannot act on a child through the path', async () => {
    app = await start();
    expect(
      await status(
        app,
        '/tenants/acme-eu/approve',
        { 'x-user': 'ann', 'x-tenant-id': 'acme' },
        'POST',
      ),
    ).toBe(403);
  });
});
