/**
 * The scope-chain walk and the tenant-consistency rule (M110b plan §3.5, §3.6).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ScopeRef } from '@setu-ts/common';
import { tenantMismatch, walkScopeChain } from '../../../src/scoped/scope-chain.ts';
import type { ChainConfig } from '../../../src/scoped/scope-chain.ts';
import { ScopedDeadlineError } from '../../../src/scoped/model.ts';
import type { Bounded } from '../../../src/scoped/model.ts';
import { requestContext } from '../../fixtures/scoped.ts';

const plain: Bounded = (run) => run(new AbortController().signal);

const ref = (type: string, id: string): ScopeRef => ({ type, id });

function graph(edges: Record<string, readonly ScopeRef[]>): ChainConfig['inheritsFrom'] {
  return (scope) => edges[`${scope.type}/${scope.id}`] ?? [];
}

function config(
  inheritsFrom: ChainConfig['inheritsFrom'],
  bounds: Partial<ChainConfig> = {},
): ChainConfig {
  return { inheritsFrom, maxScopeDepth: 8, maxScopeNodes: 32, ...bounds };
}

const PROJECT = ref('project', 'p1');
const TEAM = ref('team', 'tm1');
const ORG = ref('organisation', 'o1');

describe('walkScopeChain', () => {
  it('is the scope alone when no resolver is configured', async () => {
    expect(await walkScopeChain(PROJECT, config(undefined), plain)).toEqual({
      ok: true,
      chain: [PROJECT],
    });
  });

  it('walks a three-level hierarchy, crossing scope types', async () => {
    const outcome = await walkScopeChain(
      PROJECT,
      config(graph({ 'project/p1': [TEAM], 'team/tm1': [ORG] })),
      plain,
    );
    expect(outcome).toEqual({ ok: true, chain: [PROJECT, TEAM, ORG] });
  });

  it('visits a diamond once rather than reporting a cycle', async () => {
    const left = ref('team', 'l');
    const right = ref('team', 'r');
    const outcome = await walkScopeChain(
      PROJECT,
      config(graph({ 'project/p1': [left, right], 'team/l': [ORG], 'team/r': [ORG] })),
      plain,
    );
    expect(outcome).toEqual({ ok: true, chain: [PROJECT, left, ORG, right] });
  });

  it('denies a cycle on its own path, including a self-reference', async () => {
    expect(
      await walkScopeChain(
        PROJECT,
        config(graph({ 'project/p1': [TEAM], 'team/tm1': [PROJECT] })),
        plain,
      ),
    ).toEqual({ ok: false, reason: 'scope-cycle', scopeType: 'project' });
    expect(await walkScopeChain(PROJECT, config(graph({ 'project/p1': [PROJECT] })), plain))
      .toEqual({
        ok: false,
        reason: 'scope-cycle',
        scopeType: 'project',
      });
  });

  it('denies a walk deeper than maxScopeDepth, and allows one exactly at it', async () => {
    const edges = graph({ 'project/p1': [TEAM], 'team/tm1': [ORG] });
    expect(await walkScopeChain(PROJECT, config(edges, { maxScopeDepth: 1 }), plain)).toEqual({
      ok: false,
      reason: 'scope-depth',
      scopeType: 'team',
    });
    expect((await walkScopeChain(PROJECT, config(edges, { maxScopeDepth: 2 }), plain)).ok).toBe(
      true,
    );
  });

  it('denies a walk visiting more than maxScopeNodes scopes', async () => {
    const wide = Array.from({ length: 5 }, (_, index) => ref('team', `t${index}`));
    expect(
      await walkScopeChain(
        PROJECT,
        config(graph({ 'project/p1': wide }), { maxScopeNodes: 3 }),
        plain,
      ),
    ).toEqual({ ok: false, reason: 'scope-nodes', scopeType: 'team' });
  });

  it('drops an invalid scope the resolver answers, and treats a non-array as none', async () => {
    const outcome = await walkScopeChain(
      PROJECT,
      config((scope) =>
        scope.type === 'project'
          ? [{ type: 'Bad', id: 'x' }, { type: 'team', id: '' }, TEAM] as never
          : []
      ),
      plain,
    );
    expect(outcome).toEqual({ ok: true, chain: [PROJECT, TEAM] });
    expect(await walkScopeChain(PROJECT, config(() => 'nope' as never), plain)).toEqual({
      ok: true,
      chain: [PROJECT],
    });
  });

  it('denies when the resolver throws, naming the error only', async () => {
    const outcome = await walkScopeChain(
      PROJECT,
      config(() => {
        throw new RangeError('secret scope o1 lookup failed');
      }),
      plain,
    );
    expect(outcome).toEqual({
      ok: false,
      reason: 'resolver-failed',
      scopeType: 'project',
      errorName: 'RangeError',
    });
  });

  it('denies when the resolver outlives its deadline', async () => {
    const timedOut: Bounded = () => Promise.reject(new ScopedDeadlineError());
    expect(await walkScopeChain(PROJECT, config(graph({})), timedOut)).toEqual({
      ok: false,
      reason: 'resolver-timeout',
      scopeType: 'project',
    });
  });

  it('forwards the deadline signal to the resolver', async () => {
    let received: AbortSignal | undefined;
    const controller = new AbortController();
    await walkScopeChain(
      PROJECT,
      config((_scope, signal) => {
        received = signal;
        return [];
      }),
      (run) => run(controller.signal),
    );
    expect(received).toBe(controller.signal);
  });
});

describe('tenantMismatch', () => {
  const tenant = ref('tenant', 't1');

  it('denies a tenant scope naming another tenant than the resolved one', () => {
    expect(tenantMismatch(ref('tenant', 't2'), requestContext({ tenant: 't1' }), 'tenant')).toBe(
      true,
    );
  });

  it('allows the resolved tenant itself', () => {
    expect(tenantMismatch(tenant, requestContext({ tenant: 't1' }), 'tenant')).toBe(false);
  });

  it('has nothing to compare with no request or no resolved tenant', () => {
    expect(tenantMismatch(ref('tenant', 't2'), undefined, 'tenant')).toBe(false);
    expect(tenantMismatch(ref('tenant', 't2'), requestContext(), 'tenant')).toBe(false);
  });

  it('compares only the configured tenant scope type', () => {
    expect(tenantMismatch(ref('organisation', 'x'), requestContext({ tenant: 't1' }), 'tenant'))
      .toBe(
        false,
      );
    expect(tenantMismatch(ref('account', 'a2'), requestContext({ tenant: 'a1' }), 'account')).toBe(
      true,
    );
  });
});
