/**
 * `scanPolicyGuards` (M110a §3.7): a guard naming an unregistered policy or
 * ability, or a same-named policy that disagrees on `anonymous`, is refused —
 * every problem in one error.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MiddlewareFunction, PolicyDefinition, RouteInfo } from '@setu-ts/common';

import { definePolicy } from '../../../src/policies/define-policy.ts';
import { requirePolicy } from '../../../src/policies/policy-guard.ts';
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
