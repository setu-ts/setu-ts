/**
 * `scanPolicyGuards` (M110a §3.7): a guard naming an unregistered policy or
 * ability, or a same-named policy that disagrees on `anonymous`, is refused —
 * every problem in one error.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { SCOPED_RBAC_POLICY } from '@setu-ts/common';
import type { MiddlewareFunction, PolicyDefinition, RouteInfo } from '@setu-ts/common';

import { definePolicy } from '../../../src/policies/define-policy.ts';
import { brandPolicyGuard, requirePolicy } from '../../../src/policies/policy-guard.ts';
import { PolicyService } from '../../../src/policies/policy-service.ts';
import { scanPolicyGuards } from '../../../src/policies/startup-scan.ts';
import { AuthPluginConfigurationError } from '../../../src/errors.ts';

const docPolicy = definePolicy({
  name: 'doc',
  abilities: { edit: () => true, view: { anonymous: true, check: () => true } },
});

function route(path: string, middleware?: readonly MiddlewareFunction[]): RouteInfo {
  return {
    method: 'GET',
    path,
    definition: {
      handler: (ctx) => ctx.response.json({}),
      ...(middleware === undefined ? {} : { middleware }),
    },
  };
}

function registry(...policies: PolicyDefinition[]): PolicyService {
  const service = new PolicyService(() => undefined);
  for (const policy of policies) {
    service.define(policy);
  }
  return service;
}

describe('scanPolicyGuards', () => {
  it('passes registered guards, routes without middleware, and ordinary middleware', () => {
    const ordinary: MiddlewareFunction = (_ctx, next) => next();
    expect(() =>
      scanPolicyGuards([
        route('/a', [ordinary, requirePolicy(docPolicy, 'edit')]),
        route('/b'),
        route('/c', [requirePolicy(docPolicy, 'view')]),
      ], registry(docPolicy))
    ).not.toThrow();
  });

  it('refuses a guard whose policy was never registered, naming the route and names', () => {
    expect(() => scanPolicyGuards([route('/docs', [requirePolicy(docPolicy, 'edit')])], registry()))
      .toThrow(
        'route GET /docs uses requirePolicy("doc", "edit"), but no such policy ability is registered',
      );
  });

  it('refuses a same-named policy that disagrees on anonymous', () => {
    const impostor = definePolicy({
      name: 'doc',
      abilities: { edit: () => true, view: () => true },
    });
    expect(() =>
      scanPolicyGuards([route('/docs', [requirePolicy(docPolicy, 'view')])], registry(impostor))
    )
      .toThrow(/a different policy is registered under the same name/);
  });

  it('reports every problem in one AuthPluginConfigurationError', () => {
    let thrown: unknown;
    try {
      scanPolicyGuards([
        route('/one', [requirePolicy(docPolicy, 'edit')]),
        route('/two', [requirePolicy(docPolicy, 'view')]),
      ], registry());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuthPluginConfigurationError);
    const message = (thrown as Error).message;
    expect(message).toContain('/one');
    expect(message).toContain('/two');
    expect(message).toContain('AuthPlugin({ policies })');
  });
});

describe('scanPolicyGuards — multi-ability brands (M110b)', () => {
  function branded(policy: string, abilities: readonly string[]): MiddlewareFunction {
    const guard: MiddlewareFunction = (_ctx, next) => next();
    brandPolicyGuard(guard, { policy, abilities, anonymous: false });
    return guard;
  }

  it('checks every ability a brand lists, refusing the one that is unregistered', () => {
    expect(() =>
      scanPolicyGuards(
        [route('/docs', [branded('doc', ['edit', 'delete'])])],
        registry(docPolicy),
      )
    ).toThrow('uses requirePolicy("doc", "delete"), but no such policy ability is registered');
  });

  it('passes a brand whose every ability is registered', () => {
    const both = definePolicy({ name: 'doc', abilities: { edit: () => true, delete: () => true } });
    expect(() =>
      scanPolicyGuards([route('/docs', [branded('doc', ['edit', 'delete'])])], registry(both))
    )
      .not.toThrow();
  });

  it('names scopedRbac, not AuthPlugin({ policies }), for an unknown scoped ability', () => {
    let message = '';
    try {
      scanPolicyGuards(
        [route('/inv', [branded(SCOPED_RBAC_POLICY, ['perm:invoices:aprove'])])],
        registry(),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('uses a scoped guard naming "perm:invoices:aprove"');
    expect(message).toContain('AuthPlugin({ scopedRbac })');
    expect(message).not.toContain('AuthPlugin({ policies })');
  });

  it('passes a scoped brand whose abilities the built-in policy declares', () => {
    const scoped = definePolicy({ name: SCOPED_RBAC_POLICY, abilities: { 'perm:a': () => true } });
    expect(() =>
      scanPolicyGuards([route('/a', [branded(SCOPED_RBAC_POLICY, ['perm:a'])])], registry(scoped))
    )
      .not.toThrow();
  });
});
