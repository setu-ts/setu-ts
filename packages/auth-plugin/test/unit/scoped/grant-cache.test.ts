/**
 * The three layers that keep sources from being asked twice (M110b plan
 * §3.12, §3.13): the per-request memo, the cross-request cache and in-flight
 * coalescing — and the isolation each must keep between principals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { GrantQuery, IGrantSource, IPrincipal, ScopeRef } from '@setu-ts/common';
import type { ScopedRbacTiming } from '../../../src/interfaces/index.ts';
import { principal, requestContext, scopedHarness } from '../../fixtures/scoped.ts';

const T1: ScopeRef = { type: 'tenant', id: 't1' };
const CHAIN: GrantQuery = { kind: 'chain', scopes: [T1] };

/** A source counting calls, optionally failing, answering per principal. */
function countingSource(options: { fail?: boolean; gate?: Promise<void> } = {}) {
  const calls: string[] = [];
  const source: IGrantSource = {
    name: 'counted',
    grantsFor: async (who: IPrincipal) => {
      calls.push(who.id);
      await options.gate;
      if (options.fail === true) {
        throw new Error('down');
      }
      return [{ role: who.id === 'admin' ? 'owner' : 'viewer', scope: T1 }];
    },
  };
  return { source, calls };
}

function harness(source: IGrantSource, timing?: ScopedRbacTiming) {
  return scopedHarness({
    sources: [{ kind: 'custom', source }],
    ...(timing === undefined ? {} : { timing }),
  });
}

describe('per-request memo', () => {
  it('asks the source once per request for one question', async () => {
    const { source, calls } = countingSource();
    const { resolver } = harness(source);
    const ctx = requestContext();
    await resolver.grantsFor(principal(), CHAIN, ctx);
    await resolver.grantsFor(principal(), CHAIN, ctx);
    expect(calls.length).toBe(1);
    await resolver.grantsFor(principal(), CHAIN, requestContext());
    expect(calls.length).toBe(2);
  });

  it('memoises a failure for the rest of the request only — one call, one log', async () => {
    const { source, calls } = countingSource({ fail: true });
    const scoped = harness(source);
    const ctx = requestContext();
    const target = { scope: T1, context: ctx };
    expect(
      await scoped.evaluator.allows(principal(), target, {
        kind: 'permission',
        name: 'invoices:read',
      }),
    )
      .toBe(false);
    expect(
      await scoped.evaluator.allows(principal(), target, {
        kind: 'permission',
        name: 'invoices:read',
      }),
    )
      .toBe(false);
    expect(calls.length).toBe(1);
    const denials = scoped.logger.records.filter((r) =>
      r.message === 'Scoped authorization denied'
    );
    expect(denials.length).toBe(1);
    // A new request asks again: a failure is never carried across requests.
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    expect(calls.length).toBe(2);
  });

  it('memoises nothing without a request context', async () => {
    const { source, calls } = countingSource();
    const { resolver } = harness(source);
    await resolver.grantsFor(principal(), CHAIN, undefined);
    await resolver.grantsFor(principal(), CHAIN, undefined);
    expect(calls.length).toBe(2);
  });

  it('never shares one request memo between principals', async () => {
    const { source, calls } = countingSource();
    const { resolver } = harness(source);
    const ctx = requestContext();
    const viewer = await resolver.grantsFor(principal('u1'), CHAIN, ctx);
    const admin = await resolver.grantsFor(principal('admin'), CHAIN, ctx);
    expect(calls).toEqual(['u1', 'admin']);
    expect(viewer.ok && viewer.grants[0].role).toBe('viewer');
    expect(admin.ok && admin.grants[0].role).toBe('owner');
  });
});

describe('cross-request cache', () => {
  const cache: ScopedRbacTiming = { kind: 'cache', ttlMs: 1_000, maxEntries: 2 };

  it('serves a hit until ttlMs elapses on the monotonic clock, then asks again', async () => {
    const { source, calls } = countingSource();
    const scoped = harness(source, cache);
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    scoped.timing.advance(999);
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    expect(calls.length).toBe(1);
    scoped.timing.advance(1);
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    expect(calls.length).toBe(2);
  });

  it('evicts the least-recently-used entry beyond maxEntries', async () => {
    const { source, calls } = countingSource();
    const scoped = harness(source, cache);
    await scoped.resolver.grantsFor(principal('a'), CHAIN, requestContext());
    await scoped.resolver.grantsFor(principal('b'), CHAIN, requestContext());
    await scoped.resolver.grantsFor(principal('a'), CHAIN, requestContext()); // refresh a
    await scoped.resolver.grantsFor(principal('c'), CHAIN, requestContext()); // evicts b
    await scoped.resolver.grantsFor(principal('a'), CHAIN, requestContext());
    expect(calls).toEqual(['a', 'b', 'c']);
    await scoped.resolver.grantsFor(principal('b'), CHAIN, requestContext());
    expect(calls).toEqual(['a', 'b', 'c', 'b']);
  });

  it('never caches a failure', async () => {
    const { source, calls } = countingSource({ fail: true });
    const scoped = harness(source, cache);
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    expect(calls.length).toBe(2);
  });

  it('keeps one id under two issuers in separate entries', async () => {
    const { source, calls } = countingSource();
    const scoped = harness(source, cache);
    await scoped.resolver.grantsFor(
      principal('sub', { claims: { iss: 'https://a' } }),
      CHAIN,
      requestContext(),
    );
    await scoped.resolver.grantsFor(
      principal('sub', { claims: { iss: 'https://b' } }),
      CHAIN,
      requestContext(),
    );
    expect(calls.length).toBe(2);
  });

  it('keys the question too: another chain is another entry', async () => {
    const { source, calls } = countingSource();
    const scoped = harness(source, cache);
    await scoped.resolver.grantsFor(principal(), CHAIN, requestContext());
    await scoped.resolver.grantsFor(
      principal(),
      { kind: 'chain', scopes: [{ type: 'tenant', id: 't2' }] },
      requestContext(),
    );
    expect(calls.length).toBe(2);
  });
});

describe('in-flight coalescing', () => {
  it('shares one call between concurrent identical questions across requests', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { source, calls } = countingSource({ gate });
    const { resolver } = harness(source);
    const first = resolver.grantsFor(principal(), CHAIN, requestContext());
    const second = resolver.grantsFor(principal(), CHAIN, requestContext());
    open();
    expect(await first).toEqual(await second);
    expect(calls.length).toBe(1);
    // Settled calls leave the in-flight table: the next request asks afresh.
    await resolver.grantsFor(principal(), CHAIN, requestContext());
    expect(calls.length).toBe(2);
  });

  it('never coalesces two different principals', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { source, calls } = countingSource({ gate });
    const { resolver } = harness(source);
    const first = resolver.grantsFor(principal('u1'), CHAIN, requestContext());
    const second = resolver.grantsFor(principal('admin'), CHAIN, requestContext());
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toEqual(['u1', 'admin']);
    expect(a.ok && a.grants[0].role).toBe('viewer');
    expect(b.ok && b.grants[0].role).toBe('owner');
  });
});

describe("'sign-in' timing", () => {
  it('reads only the stored list, and nothing without a request', async () => {
    const { source, calls } = countingSource();
    const scoped = harness(source, 'sign-in');
    expect(await scoped.resolver.grantsFor(principal(), CHAIN, requestContext())).toEqual({
      ok: true,
      grants: [],
      dropped: 0,
    });
    scoped.resolver.useStoredGrants((_ctx, who) =>
      who.id === 'u1' ? [{ role: 'viewer', scope: T1 }] : null
    );
    expect(await scoped.resolver.grantsFor(principal(), CHAIN, requestContext())).toEqual({
      ok: true,
      grants: [{ role: 'viewer', scope: T1 }],
      dropped: 0,
    });
    expect(await scoped.resolver.grantsFor(principal('other'), CHAIN, requestContext()))
      .toMatchObject({
        grants: [],
      });
    expect(await scoped.resolver.grantsFor(principal(), CHAIN, undefined)).toMatchObject({
      grants: [],
    });
    expect(calls.length).toBe(0);
  });
});
