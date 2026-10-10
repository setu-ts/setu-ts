/**
 * Grant sources and their union (M110b plan §3.7, §3.13): static, claims,
 * custom and factory sources; validation; one failing source failing the
 * whole resolution; the grant bound; the deadline.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IGrantSource, IServiceRegistry, ScopeRef } from '@setu-ts/common';
import { compileScopedRbac } from '../../../src/scoped/options.ts';
import { GrantResolver, principalKey } from '../../../src/scoped/grant-resolver.ts';
import { ScopedDeadlineError } from '../../../src/scoped/model.ts';
import type { Bounded } from '../../../src/scoped/model.ts';
import type { ScopedRbacOptions } from '../../../src/interfaces/index.ts';
import { CATALOGUE, principal, scopedHarness } from '../../fixtures/scoped.ts';

const T1: ScopeRef = { type: 'tenant', id: 't1' };
const CHAIN = { kind: 'chain', scopes: [T1] } as const;
const plain: Bounded = (run) => run(new AbortController().signal);

function resolver(options: ScopedRbacOptions, bounded: Bounded = plain): GrantResolver {
  const instance = new GrantResolver(compileScopedRbac(options, CATALOGUE, true), {
    bounded,
    hrtime: () => 0,
  });
  instance.bind({} as IServiceRegistry);
  return instance;
}

function source(answer: unknown, name = 'directory'): IGrantSource {
  return { name, grantsFor: () => Promise.resolve(answer as never) };
}

describe('GrantResolver — sources', () => {
  it('unions static, claims and custom sources', async () => {
    const outcome = await resolver({
      sources: [
        { kind: 'static', grants: [{ subject: 'u1', role: 'viewer', scope: T1 }] },
        {
          kind: 'claims',
          map: (claims) =>
            (claims.orgs as string[]).map((id) => ({
              role: 'approver',
              scope: { type: 'organisation', id },
            })),
        },
        { kind: 'custom', source: source([{ role: 'owner', scope: null }]) },
      ],
    }).resolveFromSources(principal('u1', { claims: { orgs: ['o1'] } }), CHAIN);
    expect(outcome).toEqual({
      ok: true,
      dropped: 0,
      grants: [
        { role: 'viewer', scope: T1 },
        { role: 'approver', scope: { type: 'organisation', id: 'o1' } },
        { role: 'owner', scope: null },
      ],
    });
  });

  it('gives a claims source an empty object when the principal carries no claims', async () => {
    let seen: unknown;
    await resolver({
      sources: [{
        kind: 'claims',
        map: (claims) => {
          seen = claims;
          return [];
        },
      }],
    }).resolveFromSources(principal(), CHAIN);
    expect(seen).toEqual({});
  });

  it('passes the principal, the query and the signal to a custom source', async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    await resolver(
      {
        sources: [{
          kind: 'custom',
          source: {
            name: 'spy',
            grantsFor: (who, query, signal) => {
              calls.push(who.id, query, signal);
              return Promise.resolve([]);
            },
          },
        }],
      },
      (run) => run(controller.signal),
    ).resolveFromSources(principal(), CHAIN);
    expect(calls).toEqual(['u1', CHAIN, controller.signal]);
  });

  it('resolves a factory source against the registry at bind, and uses its name', async () => {
    let registry: unknown;
    const instance = new GrantResolver(
      compileScopedRbac(
        {
          sources: [{
            kind: 'custom',
            source: (services) => {
              registry = services;
              return source([{ role: 'boom', scope: 7 }], 'factory-made');
            },
          }],
        },
        CATALOGUE,
        true,
      ),
      { bounded: plain, hrtime: () => 0 },
    );
    const services = { marker: true } as unknown as IServiceRegistry;
    instance.bind(services);
    expect(registry).toBe(services);
    expect(await instance.resolveFromSources(principal(), CHAIN)).toEqual({
      ok: true,
      grants: [],
      dropped: 1,
    });
  });

  it('falls back to a positional name for a source without a usable one', async () => {
    const outcome = await resolver({
      sources: [{
        kind: 'custom',
        source: { name: '', grantsFor: () => Promise.reject(new Error('x')) },
      }],
    }).resolveFromSources(principal(), CHAIN);
    expect(outcome).toMatchObject({ ok: false, source: 'custom[0]' });
  });

  it('fails bind for a factory that answers no grantsFor', () => {
    const instance = new GrantResolver(
      compileScopedRbac(
        { sources: [{ kind: 'custom', source: () => ({}) as IGrantSource }] },
        CATALOGUE,
        true,
      ),
      { bounded: plain, hrtime: () => 0 },
    );
    expect(() => instance.bind({} as IServiceRegistry)).toThrow('does not implement grantsFor');
  });

  it('fails a resolution attempted before bind', async () => {
    const instance = new GrantResolver(
      compileScopedRbac({ sources: [{ kind: 'static', grants: [] }] }, CATALOGUE, true),
      { bounded: plain, hrtime: () => 0 },
    );
    expect(await instance.resolveFromSources(principal(), CHAIN)).toEqual({
      ok: false,
      reason: 'source-failed',
      source: 'unbound',
    });
  });
});

describe('GrantResolver — validation and failure', () => {
  it('drops and counts invalid grants, reading each once', async () => {
    let reads = 0;
    const flipping = {
      get role() {
        reads += 1;
        return reads === 1 ? 'viewer' : 'owner';
      },
      scope: T1,
    };
    const outcome = await resolver({
      sources: [{
        kind: 'custom',
        source: source([flipping, { role: 'viewer' }, { role: '', scope: null }, null, 'x', {
          role: 'a',
          scope: { type: 'T', id: 'x' },
        }]),
      }],
    }).resolveFromSources(principal(), CHAIN);
    expect(outcome).toEqual({ ok: true, grants: [{ role: 'viewer', scope: T1 }], dropped: 5 });
    expect(reads).toBe(1);
  });

  it('fails the whole resolution when one source rejects, naming only its error class', async () => {
    const outcome = await resolver({
      sources: [
        { kind: 'custom', source: source([{ role: 'viewer', scope: null }], 'ok-source') },
        {
          kind: 'custom',
          source: {
            name: 'db',
            grantsFor: () => Promise.reject(new TypeError('SELECT … WHERE id = $1 [u1]')),
          },
        },
      ],
    }).resolveFromSources(principal(), CHAIN);
    expect(outcome).toEqual({
      ok: false,
      reason: 'source-failed',
      source: 'db',
      errorName: 'TypeError',
    });
  });

  it('fails when a claims mapper throws synchronously', async () => {
    const outcome = await resolver({
      sources: [{
        kind: 'claims',
        map: () => {
          throw new Error('bad claim');
        },
      }],
    }).resolveFromSources(principal(), CHAIN);
    expect(outcome).toMatchObject({ ok: false, reason: 'source-failed', source: 'claims[0]' });
  });

  it('fails when a source answers something other than an array', async () => {
    const outcome = await resolver({
      sources: [{ kind: 'custom', source: source({ role: 'viewer' }) }],
    })
      .resolveFromSources(principal(), CHAIN);
    expect(outcome).toEqual({ ok: false, reason: 'source-failed', source: 'directory' });
  });

  it('fails with source-timeout when the deadline fires', async () => {
    const outcome = await resolver(
      { sources: [{ kind: 'custom', source: source([]) }] },
      () => Promise.reject(new ScopedDeadlineError()),
    ).resolveFromSources(principal(), CHAIN);
    expect(outcome).toEqual({ ok: false, reason: 'source-timeout', source: 'directory' });
  });

  it('denies more grants than maxGrantsPerPrincipal rather than truncating', async () => {
    const many = Array.from({ length: 3 }, () => ({ role: 'viewer', scope: null }));
    const limited = resolver({
      sources: [{ kind: 'custom', source: source(many) }],
      maxGrantsPerPrincipal: 2,
    });
    expect(await limited.resolveFromSources(principal(), CHAIN)).toEqual({
      ok: false,
      reason: 'grant-limit',
      source: 'directory',
    });
    const exact = resolver({
      sources: [{ kind: 'custom', source: source(many) }],
      maxGrantsPerPrincipal: 3,
    });
    expect((await exact.resolveFromSources(principal(), CHAIN)).ok).toBe(true);
  });
});

describe('GrantResolver — the real deadline', () => {
  it('denies a source that never settles once sourceTimeoutMs elapses, and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const harness = scopedHarness({
      sources: [{
        kind: 'custom',
        source: {
          name: 'hang',
          grantsFor: (_who, _query, received) => {
            signal = received;
            return new Promise(() => {});
          },
        },
      }],
      sourceTimeoutMs: 50,
    });
    const pending = harness.resolver.resolveFromSources(principal(), CHAIN);
    await Promise.resolve();
    harness.timing.advance(49);
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    harness.timing.advance(1);
    expect(await pending).toEqual({ ok: false, reason: 'source-timeout', source: 'hang' });
    expect(signal?.aborted).toBe(true);
    expect(harness.timing.pending()).toBe(0);
  });
});

describe('principalKey', () => {
  it('distinguishes one id under two issuers, and an id with no issuer', () => {
    const a = principalKey(principal('sub', { claims: { iss: 'https://a' } }));
    const b = principalKey(principal('sub', { claims: { iss: 'https://b' } }));
    const none = principalKey(principal('sub'));
    expect(new Set([a, b, none]).size).toBe(3);
    expect(principalKey(principal('sub', { claims: { iss: 7 } }))).toBe(none);
  });
});
