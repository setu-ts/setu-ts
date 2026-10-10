/**
 * `requireScopedRole` and `requireScopedPermission` (M110b plan §3.9,
 * §3.10): every refusal short-circuits — `next()` never runs — in the order
 * `requirePolicy` uses, over the REAL policy service and scoped policy.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, scopeFromParam, securityMetadataOf } from '@setu-ts/common';
import type {
  HandlerResult,
  IAuthorizationPolicyService,
  IPrincipal,
  IRequestContext,
  IResponse,
  IServiceRegistry,
  ScopeRef,
} from '@setu-ts/common';
import { PolicyService } from '../../../src/policies/policy-service.ts';
import { policyGuardOf } from '../../../src/policies/policy-guard.ts';
import { UnknownPolicyError } from '../../../src/policies/errors.ts';
import { AuthPluginConfigurationError } from '../../../src/errors.ts';
import { requireScopedPermission, requireScopedRole } from '../../../src/scoped/scoped-guards.ts';
import type { StaticGrant } from '../../../src/interfaces/index.ts';
import { principal, scopedHarness } from '../../fixtures/scoped.ts';

const T1: ScopeRef = { type: 'tenant', id: 't1' };

interface Harness {
  readonly ctx: IRequestContext;
  readonly recorded: { status: number };
}

function context(
  service: IAuthorizationPolicyService | null,
  options: { user?: IPrincipal; tenant?: string; params?: Record<string, string> } = {},
): Harness {
  const recorded = { status: 0 };
  const response = {
    status(code: number) {
      recorded.status = code;
      return response;
    },
    json() {
      return {} as HandlerResult;
    },
  } as unknown as IResponse;
  const services = {
    has: (token: string) => service !== null && token === CAPABILITIES.AUTHORIZATION_POLICIES,
    get: () => service,
  } as unknown as IServiceRegistry;
  const ctx = {
    request: {
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.tenant === undefined ? {} : { tenant: { id: options.tenant } }),
    },
    response,
    services,
    state: new Map<string, unknown>(),
    params: options.params ?? {},
  } as unknown as IRequestContext;
  return { ctx, recorded };
}

function policies(grants: readonly StaticGrant[]): PolicyService {
  const scoped = scopedHarness({ sources: [{ kind: 'static', grants }] });
  const service = new PolicyService(() => undefined);
  service.define(scoped.policy);
  return service;
}

async function run(
  guard: ReturnType<typeof requireScopedRole>,
  harness: Harness,
): Promise<boolean> {
  let nextRan = false;
  await guard(harness.ctx, () => {
    nextRan = true;
    return Promise.resolve();
  });
  return nextRan;
}

const GRANTS: StaticGrant[] = [
  { subject: 'u1', role: 'approver', scope: T1 },
  { subject: 'u2', role: 'viewer', scope: T1 },
];

describe('scoped guards — refusals', () => {
  it('answers 501 with no policy service', async () => {
    const harness = context(null, { user: principal(), tenant: 't1' });
    expect(await run(requireScopedRole('approver'), harness)).toBe(false);
    expect(harness.recorded.status).toBe(501);
  });

  it('answers 401 for an anonymous request BEFORE the scope source runs', async () => {
    let sourced = 0;
    const harness = context(policies(GRANTS));
    const guard = requireScopedPermission('invoices:read', {
      scope: () => {
        sourced += 1;
        return T1;
      },
    });
    expect(await run(guard, harness)).toBe(false);
    expect(harness.recorded.status).toBe(401);
    expect(sourced).toBe(0);
  });

  it('answers 403 when the role is not held in the scope', async () => {
    const harness = context(policies(GRANTS), { user: principal('u2'), tenant: 't1' });
    expect(await run(requireScopedRole('approver'), harness)).toBe(false);
    expect(harness.recorded.status).toBe(403);
  });

  it('denies 403 when no tenant resolves the default scope', async () => {
    const harness = context(policies(GRANTS), { user: principal('u1') });
    expect(await run(requireScopedRole('approver'), harness)).toBe(false);
    expect(harness.recorded.status).toBe(403);
  });

  it('rejects through can() for an ability the registry does not know, before the scope source', async () => {
    let sourced = 0;
    const harness = context(policies(GRANTS), { user: principal('u1'), tenant: 't1' });
    const guard = requireScopedPermission('invoices:aprove', {
      scope: () => {
        sourced += 1;
        return T1;
      },
    });
    await expect(run(guard, harness)).rejects.toThrow(UnknownPolicyError);
    expect(sourced).toBe(0);
  });

  it('refuses even when a replacement provider allows an ability it does not describe', async () => {
    const replacement: IAuthorizationPolicyService = {
      can: () => Promise.resolve(true),
      authorize: () => Promise.resolve(),
      describe: () => undefined,
      define: () => {},
    };
    const harness = context(replacement, { user: principal('u1'), tenant: 't1' });
    expect(await run(requireScopedRole('approver'), harness)).toBe(false);
    expect(harness.recorded.status).toBe(403);
  });

  it('lets a scope source’s throw propagate, with the handler not run', async () => {
    const harness = context(policies(GRANTS), { user: principal('u1') });
    const guard = requireScopedRole('approver', {
      scope: () => Promise.reject(new Error('lookup failed')),
    });
    await expect(run(guard, harness)).rejects.toThrow('lookup failed');
  });
});

describe('scoped guards — allow', () => {
  it('allows a role held in the request tenant', async () => {
    const harness = context(policies(GRANTS), { user: principal('u1'), tenant: 't1' });
    expect(await run(requireScopedRole('approver'), harness)).toBe(true);
    expect(harness.recorded.status).toBe(0);
  });

  it('reads a route parameter scope', async () => {
    const harness = context(policies(GRANTS), {
      user: principal('u1'),
      params: { tenantId: 't1' },
    });
    expect(
      await run(
        requireScopedPermission('invoices:approve', {
          scope: scopeFromParam('tenantId', 'tenant'),
        }),
        harness,
      ),
    ).toBe(true);
  });

  it('accepts a fixed ScopeRef and a null scope', async () => {
    const service = policies([{ subject: 'u1', role: 'viewer', scope: null }]);
    expect(
      await run(
        requireScopedPermission('invoices:read', { scope: T1 }),
        context(service, { user: principal('u1') }),
      ),
    )
      .toBe(true);
    expect(
      await run(
        requireScopedPermission('invoices:read', { scope: null }),
        context(service, { user: principal('u1') }),
      ),
    )
      .toBe(true);
  });

  it('is ANY-of for roles and stops at the first held', async () => {
    const harness = context(policies(GRANTS), { user: principal('u2'), tenant: 't1' });
    expect(await run(requireScopedRole(['approver', 'viewer']), harness)).toBe(true);
  });

  it('is ALL-of for permissions', async () => {
    const service = policies(GRANTS);
    const viewer = context(service, { user: principal('u2'), tenant: 't1' });
    expect(await run(requireScopedPermission(['invoices:read', 'invoices:approve']), viewer)).toBe(
      false,
    );
    expect(viewer.recorded.status).toBe(403);
    const approver = context(service, { user: principal('u1'), tenant: 't1' });
    expect(await run(requireScopedPermission(['invoices:read', 'invoices:approve']), approver))
      .toBe(true);
  });
});

describe('scoped guards — construction and brands', () => {
  it('refuses no name, an empty name and a malformed scope', () => {
    expect(() => requireScopedRole([])).toThrow(AuthPluginConfigurationError);
    expect(() => requireScopedRole('')).toThrow('non-empty strings');
    expect(() => requireScopedPermission(7 as unknown as string)).toThrow(
      'a name or a non-empty array',
    );
    expect(() => requireScopedRole('approver', { scope: { type: 'Tenant', id: 'x' } })).toThrow(
      'scope must be a ScopeRef',
    );
  });

  it('brands every ability it names for the startup scan, and requires authentication', () => {
    const role = requireScopedRole(['approver', 'viewer']);
    expect(policyGuardOf(role)).toEqual({
      policy: 'scoped-rbac',
      abilities: ['role:approver', 'role:viewer'],
      anonymous: false,
    });
    expect(policyGuardOf(requireScopedPermission('invoices:read'))?.abilities).toEqual([
      'perm:invoices:read',
    ]);
    expect(securityMetadataOf(role)).toEqual({ authenticated: true });
  });
});
