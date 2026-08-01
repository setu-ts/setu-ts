/**
 * Unit tests for the `node:dns/promises` resolver shared by the Node and Bun
 * adapters.
 *
 * The `name → host` mapping is the case that matters: Deno spells the same
 * field `target`, so a resolver that passed either shape through unchanged
 * would type-check on both runtimes and produce `undefined` hostnames on one.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createNodeDnsResolver } from '../../src/adapters/shared/node-dns-resolver.ts';
import type { NodeDnsModule } from '../../src/adapters/shared/node-dns-resolver.ts';

function fakeDns(overrides: Partial<NodeDnsModule>): NodeDnsModule {
  return {
    resolveSrv: () => Promise.resolve([]),
    resolve4: () => Promise.resolve([]),
    resolve6: () => Promise.resolve([]),
    ...overrides,
  };
}

describe('createNodeDnsResolver — resolveSrv', () => {
  it("maps Node's `name` field onto `host`", async () => {
    const resolver = createNodeDnsResolver(fakeDns({
      resolveSrv: () =>
        Promise.resolve([{ name: 'a.internal', port: 8080, priority: 10, weight: 5 }]),
    }));

    expect(await resolver.resolveSrv('billing.service.consul')).toEqual([
      { host: 'a.internal', port: 8080, priority: 10, weight: 5 },
    ]);
  });

  it('passes the queried hostname through', async () => {
    let queried = '';
    const resolver = createNodeDnsResolver(fakeDns({
      resolveSrv: (hostname: string) => {
        queried = hostname;
        return Promise.resolve([]);
      },
    }));

    await resolver.resolveSrv('_http._tcp.billing');
    expect(queried).toBe('_http._tcp.billing');
  });

  it('propagates a lookup failure', async () => {
    const resolver = createNodeDnsResolver(fakeDns({
      resolveSrv: () => Promise.reject(new Error('ENOTFOUND')),
    }));
    await expect(resolver.resolveSrv('missing')).rejects.toThrow('ENOTFOUND');
  });
});

describe('createNodeDnsResolver — resolveHost', () => {
  it('concatenates A and AAAA results', async () => {
    const resolver = createNodeDnsResolver(fakeDns({
      resolve4: () => Promise.resolve(['10.0.0.1']),
      resolve6: () => Promise.resolve(['2001:db8::1']),
    }));
    expect(await resolver.resolveHost('svc')).toEqual(['10.0.0.1', '2001:db8::1']);
  });

  it('tolerates a missing AAAA record when A succeeds', async () => {
    // An IPv4-only host has no AAAA record at all and the resolver REJECTS
    // rather than returning an empty list — so tolerating one family is what
    // makes this usable against an ordinary host.
    const resolver = createNodeDnsResolver(fakeDns({
      resolve4: () => Promise.resolve(['10.0.0.1']),
      resolve6: () => Promise.reject(new Error('ENODATA')),
    }));
    expect(await resolver.resolveHost('svc')).toEqual(['10.0.0.1']);
  });

  it('tolerates a missing A record when AAAA succeeds', async () => {
    const resolver = createNodeDnsResolver(fakeDns({
      resolve4: () => Promise.reject(new Error('ENODATA')),
      resolve6: () => Promise.resolve(['2001:db8::1']),
    }));
    expect(await resolver.resolveHost('svc')).toEqual(['2001:db8::1']);
  });

  it('rejects only when both families fail, carrying the first as cause', async () => {
    const first = new Error('ENOTFOUND v4');
    const resolver = createNodeDnsResolver(fakeDns({
      resolve4: () => Promise.reject(first),
      resolve6: () => Promise.reject(new Error('ENOTFOUND v6')),
    }));

    await expect(resolver.resolveHost('missing')).rejects.toThrow('DNS lookup failed for missing');
    try {
      await resolver.resolveHost('missing');
    } catch (error) {
      expect((error as Error).cause).toBe(first);
    }
  });

  it('resolves to an empty list when both families return nothing', async () => {
    const resolver = createNodeDnsResolver(fakeDns({}));
    expect(await resolver.resolveHost('svc')).toEqual([]);
  });
});

describe('createNodeDnsResolver — the real node:dns/promises default', () => {
  it('builds a resolver over the real module with no injection', () => {
    // Exercises the default parameter, which is the only path production
    // takes: a resolver that only ever ran against a fake would not prove the
    // static `node:` import resolves at all.
    const resolver = createNodeDnsResolver();
    expect(typeof resolver.resolveSrv).toBe('function');
    expect(typeof resolver.resolveHost).toBe('function');
  });
});
