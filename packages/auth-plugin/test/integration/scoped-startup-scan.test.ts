/**
 * Startup refusal through a REAL kernel application (M110b plan §3.9): a
 * scoped guard naming a permission or role outside the catalogue fails
 * `start()` naming the route, as does a scoped guard with `scopedRbac` not
 * configured; a route added after `start()` rejects per request instead.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireScopedPermission, requireScopedRole } from '../../src/index.ts';
import { headerStrategy, startScopedApp, status } from '../fixtures/scoped-app.ts';
import { CATALOGUE } from '../fixtures/scoped.ts';

let app: IKernelApplication | undefined;

afterEach(async () => {
  await app?.stop().catch(() => {});
  app = undefined;
});

const SCOPED = { sources: [{ kind: 'static', grants: [] }] } as const;

async function startError(
  guard: ReturnType<typeof requireScopedRole>,
  scoped = true,
): Promise<string> {
  app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({
        rbac: CATALOGUE,
        ...(scoped ? { scopedRbac: SCOPED } : {}),
        strategies: [headerStrategy],
      }),
    ],
  });
  app.router.get('/guarded', { middleware: [guard], handler: (ctx) => ctx.response.json({}) });
  try {
    await app.start();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('scoped guards — startup scan', () => {
  it('fails start() for a permission outside the catalogue, naming the route', async () => {
    const message = await startError(requireScopedPermission('invoices:aprove'));
    expect(message).toContain(
      'route GET /guarded uses a scoped guard naming "perm:invoices:aprove"',
    );
    expect(message).toContain('AuthPlugin({ scopedRbac })');
  });

  it('fails start() for a role outside the catalogue — a custom role cannot be named', async () => {
    const message = await startError(requireScopedRole(['approver', 'regional-approver']));
    expect(message).toContain('"role:regional-approver"');
    expect(message).not.toContain('"role:approver"');
  });

  it('fails start() for the wildcard, which is never a checkable permission', async () => {
    expect(await startError(requireScopedPermission('*'))).toContain('"perm:*"');
  });

  it('fails start() for a scoped guard with scopedRbac not configured', async () => {
    const message = await startError(requireScopedRole('approver'), false);
    expect(message).toContain('uses a scoped guard naming "role:approver"');
    expect(message).toContain('AuthPlugin({ scopedRbac })');
  });

  it('starts when every scoped name is in the catalogue', async () => {
    expect(await startError(requireScopedPermission(['invoices:read', 'invoices:approve']))).toBe(
      '',
    );
  });

  it('a scoped route added after start() rejects per request, never serving the handler', async () => {
    app = await startScopedApp({ auth: { scopedRbac: SCOPED }, routes: [] });
    let served = false;
    app.router.get('/late', {
      middleware: [requireScopedPermission('nope')],
      handler: (ctx) => {
        served = true;
        return ctx.response.json({});
      },
    });
    expect(await status(app, '/late', { 'x-user': 'u' })).toBe(500);
    expect(served).toBe(false);
  });
});
