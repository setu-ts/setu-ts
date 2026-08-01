/**
 * Unit tests for the `Deno.resolveDns` resolver.
 *
 * Deno names the SRV target field `target` while Node names it `name`; both
 * are normalized onto {@linkcode SrvRecord.host} so neither runtime's shape
 * escapes this package.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createDenoDnsResolver } from '../../src/adapters/deno/deno-dns-resolver.ts';
import type { DenoDnsHost, DenoSrvRecord } from '../../src/adapters/deno/deno-dns-resolver.ts';

/** A host whose per-record-type answers the test controls. */
function fakeHost(answers: {
  SRV?: DenoSrvRecord[] | Error;
  A?: string[] | Error;
  AAAA?: string[] | Error;
  onQuery?: (query: string, type: string) => void;
}): DenoDnsHost {
  const answer = (value: unknown): Promise<never> | Promise<unknown> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);

  return {
    resolveDns: ((query: string, recordType: 'SRV' | 'A' | 'AAAA') => {
      answers.onQuery?.(query, recordType);
      return answer(answers[recordType]);
    }) as DenoDnsHost['resolveDns'],
  };
}

describe('createDenoDnsResolver — resolveSrv', () => {
  it("maps Deno's `target` field onto `host`", async () => {
    const resolver = createDenoDnsResolver(fakeHost({
      SRV: [{ target: 'a.internal', port: 8080, priority: 10, weight: 5 }],
    }));

    expect(await resolver.resolveSrv('billing.service.consul')).toEqual([
      { host: 'a.internal', port: 8080, priority: 10, weight: 5 },
    ]);
  });

  it("queries with the 'SRV' record type", async () => {
    const seen: string[] = [];
    const resolver = createDenoDnsResolver(fakeHost({
      onQuery: (query, type) => seen.push(`${type} ${query}`),
    }));

    await resolver.resolveSrv('_http._tcp.billing');
    expect(seen).toEqual(['SRV _http._tcp.billing']);
  });

  it('propagates a lookup failure', async () => {
    const resolver = createDenoDnsResolver(fakeHost({ SRV: new Error('NXDOMAIN') }));
    await expect(resolver.resolveSrv('missing')).rejects.toThrow('NXDOMAIN');
  });
});

describe('createDenoDnsResolver — resolveHost', () => {
  it('concatenates A and AAAA results', async () => {
    const resolver = createDenoDnsResolver(fakeHost({
      A: ['10.0.0.1'],
      AAAA: ['2001:db8::1'],
    }));
    expect(await resolver.resolveHost('svc')).toEqual(['10.0.0.1', '2001:db8::1']);
  });

  it('tolerates a missing AAAA record when A succeeds', async () => {
    const resolver = createDenoDnsResolver(fakeHost({
      A: ['10.0.0.1'],
      AAAA: new Error('NXDOMAIN'),
    }));
    expect(await resolver.resolveHost('svc')).toEqual(['10.0.0.1']);
  });

  it('tolerates a missing A record when AAAA succeeds', async () => {
    const resolver = createDenoDnsResolver(fakeHost({
      A: new Error('NXDOMAIN'),
      AAAA: ['2001:db8::1'],
    }));
    expect(await resolver.resolveHost('svc')).toEqual(['2001:db8::1']);
  });

  it('rejects only when both families fail, carrying the first as cause', async () => {
    const first = new Error('NXDOMAIN v4');
    const resolver = createDenoDnsResolver(fakeHost({
      A: first,
      AAAA: new Error('NXDOMAIN v6'),
    }));

    await expect(resolver.resolveHost('missing')).rejects.toThrow('DNS lookup failed for missing');
    try {
      await resolver.resolveHost('missing');
    } catch (error) {
      expect((error as Error).cause).toBe(first);
    }
  });

  it('resolves to an empty list when both families return nothing', async () => {
    const resolver = createDenoDnsResolver(fakeHost({}));
    expect(await resolver.resolveHost('svc')).toEqual([]);
  });
});
