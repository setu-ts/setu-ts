/**
 * Tests that every guard factory brands the middleware it returns, and that
 * branding leaves the guard's enforcement behaviour untouched.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { securityMetadataOf } from '@setu-ts/common';
import type { IPrincipal, IRequestContext } from '@setu-ts/common';
import {
  publicRoute,
  requireAllPermissions,
  requireAnyRole,
  requireAnyRole as requireAnyRoleAlias,
  requireAuth,
  requireMfa,
  requirePermission,
  requireRole,
  requireScopes,
} from '../../src/guards/index.ts';

/** Records what a guard did to the response, and whether it continued. */
interface Probe {
  readonly ctx: IRequestContext;
  readonly state: { status: number | null; body: unknown; continued: boolean };
}

function makeProbe(user?: IPrincipal, authorized = true): Probe {
  const state = { status: null as number | null, body: null as unknown, continued: false };
  const response = {
    status(code: number) {
      state.status = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return undefined as never;
    },
  };
  const ctx = {
    ...(user !== undefined ? { request: { user } } : { request: {} }),
    response,
    // `respondWithError` reads the responder from `ctx.state`; a real
    // `IRequestContext` always carries one, so the fake must too.
    state: new Map<string, unknown>(),
    services: {
      // `IServiceRegistry` declares `has`, and the guards consult it before
      // resolving (M89b). A fake omitting it is a contract-violating double:
      // it would report the absent-capability path for a registry that does
      // have the service.
      has: () => true,
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

const next = (state: { continued: boolean }) => () => {
  state.continued = true;
  return Promise.resolve();
};

describe('guard security metadata', () => {
  it('should brand requireAuth as requiring authentication', () => {
    expect(securityMetadataOf(requireAuth())).toEqual({ authenticated: true });
  });

  it('should brand every authorization guard as requiring authentication and able to forbid', () => {
    // Each of these rejects an anonymous caller with 401 before it ever
    // reaches its role/permission check, and a caller lacking the grant with
    // 403 — so each carries `forbids` (M137b §3.1).
    const forbidding = { authenticated: true, forbids: true };
    expect(securityMetadataOf(requireRole('admin'))).toEqual(forbidding);
    expect(securityMetadataOf(requirePermission('users:create'))).toEqual(forbidding);
    expect(securityMetadataOf(requireAnyRole(['admin']))).toEqual(forbidding);
    expect(securityMetadataOf(requireAllPermissions(['a', 'b']))).toEqual(forbidding);
  });

  // The brand of every auth-plugin guard factory call, as data (M137b §3.1):
  // `forbids` exactly where the guard can answer 403.
  const brandTable: readonly {
    readonly name: string;
    readonly guard: () => ReturnType<typeof requireAuth>;
    readonly brand: object;
  }[] = [
    { name: 'requireAuth()', guard: () => requireAuth(), brand: { authenticated: true } },
    {
      name: "requireAuth({ delegation: 'allow' })",
      guard: () => requireAuth({ delegation: 'allow' }),
      brand: { authenticated: true },
    },
    {
      name: "requireAuth({ delegation: 'forbid' })",
      guard: () => requireAuth({ delegation: 'forbid' }),
      brand: { authenticated: true, forbids: true },
    },
    {
      name: "requireAuth({ signInPage, delegation: 'require' })",
      guard: () => requireAuth({ signInPage: '/login', delegation: 'require' }),
      brand: { authenticated: true, forbids: true },
    },
    {
      name: 'requireAuth({ signInPage })',
      guard: () => requireAuth({ signInPage: '/login' }),
      brand: { authenticated: true },
    },
    {
      name: 'requireMfa()',
      guard: () => requireMfa(),
      brand: { authenticated: true, forbids: true },
    },
    {
      name: "requireScopes('a', 'b')",
      guard: () => requireScopes('a', 'b'),
      brand: { authenticated: true, scopes: ['a', 'b'], forbids: true },
    },
    { name: 'publicRoute()', guard: () => publicRoute(), brand: { authenticated: false } },
  ];

  for (const row of brandTable) {
    it(`brands ${row.name} as ${JSON.stringify(row.brand)}`, () => {
      expect(securityMetadataOf(row.guard())).toEqual(row.brand);
    });
  }

  it('should brand publicRoute as explicitly public', () => {
    expect(securityMetadataOf(publicRoute())).toEqual({ authenticated: false });
  });

  it('should NOT carry the role or permission a guard checks', () => {
    // An OpenAPI security requirement names a scheme, not a role, and no
    // declared scheme can be inferred from the string 'admin'. Carrying it
    // would be a field nothing reads.
    const metadata = securityMetadataOf(requireRole('admin'));

    expect(metadata).toEqual({ authenticated: true, forbids: true });
    expect(Object.keys(metadata as object)).toEqual(['authenticated', 'forbids']);
  });

  it('should leave requireAuth rejecting an anonymous caller with 401', async () => {
    const { ctx, state } = makeProbe();

    await requireAuth()(ctx, next(state));

    expect(state.status).toBe(401);
    expect(state.continued).toBe(false);
  });

  it('should leave requireAuth continuing for an authenticated caller', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal);

    await requireAuth()(ctx, next(state));

    expect(state.status).toBeNull();
    expect(state.continued).toBe(true);
  });

  it('should leave requireRole rejecting an unauthorized caller with 403', async () => {
    const { ctx, state } = makeProbe({ id: 'alice' } as IPrincipal, false);

    await requireRole('admin')(ctx, next(state));

    expect(state.status).toBe(403);
    expect(state.continued).toBe(false);
  });

  it('should leave publicRoute always continuing', async () => {
    const { ctx, state } = makeProbe();

    await publicRoute()(ctx, next(state));

    expect(state.status).toBeNull();
    expect(state.continued).toBe(true);
  });

  it('should brand each call independently of any other', () => {
    // The brand is shared and frozen, so this pins that two guards do not
    // interfere and that the shared value cannot be mutated through one.
    const a = requireAuth();
    const b = publicRoute();

    expect(securityMetadataOf(a)).toEqual({ authenticated: true });
    expect(securityMetadataOf(b)).toEqual({ authenticated: false });
    expect(Object.isFrozen(securityMetadataOf(a))).toBe(true);
  });

  it('should expose the same guard through every import path', () => {
    expect(securityMetadataOf(requireAnyRoleAlias(['x']))).toEqual({
      authenticated: true,
      forbids: true,
    });
  });
});
