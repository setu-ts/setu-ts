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

describe('claims sources are read per credential, never shared', () => {
  const O1: ScopeRef = { type: 'organisation', id: 'o1' };
  const ORG: GrantQuery = { kind: 'chain', scopes: [O1] };
  const ISS = 'https://idp.example';
  /** Two tokens for one `sub` and `iss`: only the broad one carries `o1`. */
  const broad = principal('ann', { claims: { iss: ISS, orgs: ['o1'] } });
  const narrow = principal('ann', { claims: { iss: ISS, orgs: [] } });

  function claimsHarness(timing?: ScopedRbacTiming, shared?: IGrantSource) {
    let maps = 0;
    const scoped = scopedHarness({
      sources: [
        ...(shared === undefined ? [] : [{ kind: 'custom' as const, source: shared }]),
        {
          kind: 'claims',
          map: (claims) => {
            maps += 1;
            return (claims.orgs as string[]).map((id) => ({
              role: 'viewer',
              scope: { type: 'organisation', id },
            }));
          },
        },
      ],
      ...(timing === undefined ? {} : { timing }),
    });
    return { scoped, maps: () => maps };
  }

  it('does not hand one token’s cached claims grants to another token of the same principal', async () => {
    const { scoped, maps } = claimsHarness({ kind: 'cache', ttlMs: 60_000, maxEntries: 10 });
    expect(await scoped.resolver.grantsFor(broad, ORG, requestContext())).toMatchObject({
      grants: [{ role: 'viewer', scope: O1 }],
    });
    expect(await scoped.resolver.grantsFor(narrow, ORG, requestContext())).toMatchObject({
      ok: true,
      grants: [],
    });
    // And the reverse order: the narrow token does not deny the broad one.
    expect(await scoped.resolver.grantsFor(broad, ORG, requestContext())).toMatchObject({
      grants: [{ role: 'viewer', scope: O1 }],
    });
    expect(maps()).toBe(3);
  });

  it('does not coalesce concurrent resolutions for two tokens of one principal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { source, calls } = countingSource({ gate });
    const { scoped } = claimsHarness(undefined, source);
    const both = Promise.all([
      scoped.resolver.grantsFor(broad, ORG, requestContext()),
      scoped.resolver.grantsFor(narrow, ORG, requestContext()),
    ]);
    release();
    const [fromBroad, fromNarrow] = await both;
    expect(fromBroad).toMatchObject({
      ok: true,
      grants: [{ role: 'viewer', scope: T1 }, { role: 'viewer', scope: O1 }],
    });
    expect(fromNarrow).toMatchObject({ ok: true, grants: [{ role: 'viewer', scope: T1 }] });
    // The custom source is still shared: one call for both.
    expect(calls.length).toBe(1);
  });

  it('does not reuse a request memo across two credentials in one request', async () => {
    const { scoped, maps } = claimsHarness();
    const ctx = requestContext();
    await scoped.resolver.grantsFor(broad, ORG, ctx);
    expect(await scoped.resolver.grantsFor(narrow, ORG, ctx)).toMatchObject({ grants: [] });
    expect(maps()).toBe(2);
  });

  it('counts the limit across shared and claims grants together', async () => {
    const shared: IGrantSource = {
      name: 'shared',
      grantsFor: () => Promise.resolve([{ role: 'viewer', scope: T1 }]),
    };
    const scoped = scopedHarness({
      sources: [
        { kind: 'custom', source: shared },
        { kind: 'claims', map: () => [{ role: 'viewer', scope: O1 }] },
      ],
      maxGrantsPerPrincipal: 1,
    });
    expect(await scoped.resolver.grantsFor(broad, ORG, requestContext())).toEqual({
      ok: false,
      reason: 'grant-limit',
      source: 'claims',
    });
  });

  it('denies when the claims source fails, even with shared grants', async () => {
    const { source } = countingSource();
    const scoped = scopedHarness({
      sources: [
        { kind: 'custom', source },
        {
          kind: 'claims',
          map: () => {
            throw new TypeError('bad claim');
          },
        },
      ],
    });
    expect(await scoped.resolver.grantsFor(broad, ORG, requestContext())).toMatchObject({
      ok: false,
      reason: 'source-failed',
      errorName: 'TypeError',
    });
  });

  it('reports a failing shared source before the claims grants', async () => {
    const { source } = countingSource({ fail: true });
    const { scoped } = claimsHarness(undefined, source);
    expect(await scoped.resolver.grantsFor(broad, ORG, requestContext())).toMatchObject({
      ok: false,
      reason: 'source-failed',
      source: 'counted',
    });
  });
});

describe('custom sources see only what their shared answer is keyed by', () => {
  const O1: ScopeRef = { type: 'organisation', id: 'o1' };
  const ORG: GrantQuery = { kind: 'chain', scopes: [O1] };
  const ISS = 'https://idp.example';

  function claimsReadingSource() {
    const seen: IPrincipal[] = [];
    const source: IGrantSource = {
      name: 'idp',
      grantsFor: (who: IPrincipal) => {
        seen.push(who);
        const orgs = (who.claims?.orgs as string[] | undefined) ?? [];
        return Promise.resolve(
          orgs.map((id) => ({ role: 'viewer', scope: { type: 'organisation', id } })),
        );
      },
    };
    return { source, seen };
  }

  it('hands a custom source only the id and iss — never other claims, roles or permissions', async () => {
    const { source, seen } = claimsReadingSource();
    const { resolver } = harness(source);
    await resolver.grantsFor(
      principal('ann', {
        roles: ['admin'],
        permissions: ['*'],
        claims: { iss: ISS, orgs: ['o1'], sub: 'ann' },
      }),
      ORG,
      requestContext(),
    );
    expect(seen).toEqual([{ id: 'ann', claims: { iss: ISS } }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    await resolver.grantsFor(principal('bob'), ORG, requestContext());
    expect(seen[1]).toEqual({ id: 'bob' });
  });

  it('so a source reading claims cannot leak one token’s grants to another of the same principal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { source } = claimsReadingSource();
    const gated: IGrantSource = {
      name: 'idp',
      grantsFor: async (who, query, signal) => {
        await gate;
        return await source.grantsFor(who, query, signal);
      },
    };
    const { resolver } = harness(gated);
    const both = Promise.all([
      resolver.grantsFor(
        principal('ann', { claims: { iss: ISS, orgs: ['o1'] } }),
        ORG,
        requestContext(),
      ),
      resolver.grantsFor(
        principal('ann', { claims: { iss: ISS, orgs: [] } }),
        ORG,
        requestContext(),
      ),
    ]);
    release();
    const [broad, narrow] = await both;
    expect(broad).toMatchObject({ ok: true, grants: [] });
    expect(narrow).toMatchObject({ ok: true, grants: [] });
  });

  it('reads iss once, so the key and the source cannot see two different values', async () => {
    const { source, seen } = claimsReadingSource();
    const { resolver } = harness(source);
    let reads = 0;
    const claims = {
      get iss(): string {
        reads += 1;
        return reads === 1 ? 'https://first.example' : 'https://second.example';
      },
    };
    await resolver.grantsFor(principal('ann', { claims }), ORG, requestContext());
    expect(reads).toBe(1);
    expect(seen).toEqual([{ id: 'ann', claims: { iss: 'https://first.example' } }]);
  });
});
