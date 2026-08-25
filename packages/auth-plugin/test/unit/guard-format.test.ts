/**
 * Unit test for the auth guards' M70f conversion: each of the nine rejections
 * keeps its status and short-circuits (the handler never runs), and its
 * disclosure text is preserved (plan §3.5).
 *
 * The guards call `respondWithError`, which — with no `errorHandler` installed
 * — writes the framework-default `{ error: title, detail? }` body. The probe
 * captures that body so the assertion is on the guard's own status/title/
 * disclosure, not on a formatter.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IPrincipal, IRequestContext } from '@setu-ts/common';
import {
  publicRoute,
  requireAllPermissions,
  requireAnyRole,
  requireAuth,
  requirePermission,
  requireRole,
} from '../../src/guards/index.ts';

interface Probe {
  readonly ctx: IRequestContext;
  readonly state: {
    status: number | null;
    body: Record<string, unknown> | null;
    continued: boolean;
  };
}

/**
 * Builds a probe whose authorization service answers `authorized` for every
 * role/permission check, and whose response captures the status and the JSON
 * body `respondWithError` writes.
 */
function makeProbe(user?: IPrincipal, authorized = true): Probe {
  const state = {
    status: null as number | null,
    body: null as Record<string, unknown> | null,
    continued: false,
  };
  const response = {
    status(code: number) {
      state.status = code;
      return response;
    },
    json(body: unknown) {
      state.body = body as Record<string, unknown>;
      return undefined as never;
    },
  };
  const ctx = {
    ...(user !== undefined ? { request: { user } } : { request: {} }),
    response,
    state: new Map<string, unknown>(),
    services: {
      get: () => ({
        hasRole: () => authorized,
        hasPermission: () => authorized,
        hasAnyRole: () => authorized,
        hasAllPermissions: () => authorized,
      }),
    },
  } as unknown as IRequestContext;
  return { ctx, state };
}

const next = (state: Probe['state']) => () => {
  state.continued = true;
  return Promise.resolve();
};

describe('auth guards keep their status and short-circuit (M70f)', () => {
  it('requireAuth rejects an anonymous caller with 401 and does not run the handler', async () => {
    const { ctx, state } = makeProbe();
    await requireAuth()(ctx, next(state));
    expect(state.status).toBe(401);
    expect(state.continued).toBe(false);
    expect(state.body).toEqual({ error: 'Unauthorized', detail: 'Authentication required' });
  });

  it('requireRole rejects an anonymous caller with 401', async () => {
    const { ctx, state } = makeProbe();
    await requireRole('admin')(ctx, next(state));
    expect(state.status).toBe(401);
    expect(state.continued).toBe(false);
  });

  it('requirePermission rejects an anonymous caller with 401', async () => {
    const { ctx, state } = makeProbe();
    await requirePermission('users:create')(ctx, next(state));
    expect(state.status).toBe(401);
    expect(state.continued).toBe(false);
  });

  it('requireAnyRole rejects an anonymous caller with 401', async () => {
    const { ctx, state } = makeProbe();
    await requireAnyRole(['admin'])(ctx, next(state));
    expect(state.status).toBe(401);
    expect(state.continued).toBe(false);
  });

  it('requireAllPermissions rejects an anonymous caller with 401', async () => {
    const { ctx, state } = makeProbe();
    await requireAllPermissions(['a', 'b'])(ctx, next(state));
    expect(state.status).toBe(401);
    expect(state.continued).toBe(false);
  });

  it('requireRole rejects an authenticated but insufficient caller with 403', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal, false);
    await requireRole('admin')(ctx, next(state));
    expect(state.status).toBe(403);
    expect(state.continued).toBe(false);
    expect(state.body).toEqual({ error: 'Forbidden', detail: 'Role "admin" is required' });
  });

  it('requirePermission rejects an authenticated but insufficient caller with 403', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal, false);
    await requirePermission('users:create')(ctx, next(state));
    expect(state.status).toBe(403);
    expect(state.continued).toBe(false);
    expect(state.body).toEqual({
      error: 'Forbidden',
      detail: 'Permission "users:create" is required',
    });
  });

  it('requireAnyRole rejects an authenticated but insufficient caller with 403', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal, false);
    await requireAnyRole(['admin', 'manager'])(ctx, next(state));
    expect(state.status).toBe(403);
    expect(state.continued).toBe(false);
  });

  it('requireAllPermissions rejects an authenticated but insufficient caller with 403', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal, false);
    await requireAllPermissions(['a', 'b'])(ctx, next(state));
    expect(state.status).toBe(403);
    expect(state.continued).toBe(false);
  });

  it('an authorized caller passes through (handler runs)', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal, true);
    await requireRole('admin')(ctx, next(state));
    expect(state.status).toBeNull();
    expect(state.continued).toBe(true);
  });

  it('publicRoute never rejects', async () => {
    const { ctx, state } = makeProbe();
    await publicRoute()(ctx, next(state));
    expect(state.status).toBeNull();
    expect(state.continued).toBe(true);
  });
});
