/**
 * Unit tests for the DNS provider.
 *
 * The priority-tier case is the one with real consequences: ignoring RFC 2782
 * priority spreads traffic across a primary and its designated fallback at the
 * same time, which is the opposite of what the zone author asked for.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DnsProvider, lowestPriorityTier } from '../../src/providers/dns-provider.ts';
import type { IDnsResolver, SrvRecord } from '@hono-enterprise/common';
import { createFakeDns, createFakeRuntime, type FakeRuntime } from '../fixtures/fakes.ts';

function srv(host: string, port: number, priority: number, weight: number): SrvRecord {
  return { host, port, priority, weight };
}

function srvProvider(
  resolver: IDnsResolver,
  overrides: { domainTemplate?: string; secure?: boolean } = {},
  runtime: FakeRuntime = createFakeRuntime(),
): DnsProvider {
  return new DnsProvider(resolver, runtime, {
    mode: 'srv',
    domainTemplate: overrides.domainTemplate ?? '{service}.service.consul',
    ...(overrides.secure !== undefined ? { secure: overrides.secure } : {}),
    watchIntervalMs: 30_000,
  });
}

describe('lowestPriorityTier', () => {
  it('keeps only the numerically lowest priority', () => {
    const records = [srv('a', 1, 10, 5), srv('b', 2, 20, 5), srv('c', 3, 10, 5)];
    expect(lowestPriorityTier(records).map((r) => r.host)).toEqual(['a', 'c']);
  });

  it('returns an empty list for no records', () => {
    expect(lowestPriorityTier([])).toEqual([]);
  });

  it('keeps everything when every record shares one priority', () => {
    const records = [srv('a', 1, 5, 1), srv('b', 2, 5, 1)];
    expect(lowestPriorityTier(records)).toHaveLength(2);
  });
});

describe('DnsProvider — srv mode', () => {
  it('substitutes the service name into the domain template', async () => {
    let queried = '';
    const resolver: IDnsResolver = {
      resolveSrv(hostname: string) {
        queried = hostname;
        return Promise.resolve([]);
      },
      resolveHost: () => Promise.resolve([]),
    };
    await srvProvider(resolver, { domainTemplate: '_http._tcp.{service}.internal' })
      .resolve('billing');
    expect(queried).toBe('_http._tcp.billing.internal');
  });

  it('defaults the template to Consul DNS layout', async () => {
    let queried = '';
    const resolver: IDnsResolver = {
      resolveSrv(hostname: string) {
        queried = hostname;
        return Promise.resolve([]);
      },
      resolveHost: () => Promise.resolve([]),
    };
    await srvProvider(resolver).resolve('billing');
    expect(queried).toBe('billing.service.consul');
  });

  it('keeps only the lowest priority tier and passes each weight through', async () => {
    const resolver = createFakeDns({
      srv: [srv('a.internal', 8080, 10, 5), srv('b.internal', 8081, 20, 9)],
    });
    const instances = await srvProvider(resolver).resolve('billing');
    expect(instances).toEqual([
      {
        id: 'a.internal:8080',
        serviceName: 'billing',
        host: 'a.internal',
        port: 8080,
        secure: false,
        weight: 5,
      },
    ]);
  });

  it('strips the trailing dot DNS returns on a fully qualified target', async () => {
    const resolver = createFakeDns({ srv: [srv('a.internal.', 8080, 10, 1)] });
    const [only] = await srvProvider(resolver).resolve('billing');
    expect(only.host).toBe('a.internal');
    expect(only.id).toBe('a.internal:8080');
  });

  it('marks instances secure when configured', async () => {
    const resolver = createFakeDns({ srv: [srv('a.internal', 443, 0, 1)] });
    const [only] = await srvProvider(resolver, { secure: true }).resolve('billing');
    expect(only.secure).toBe(true);
  });

  it('propagates a resolver rejection', async () => {
    const resolver = createFakeDns({ srv: new Error('NXDOMAIN') });
    await expect(srvProvider(resolver).resolve('billing')).rejects.toThrow('NXDOMAIN');
  });

  it('reports the backend id', () => {
    expect(srvProvider(createFakeDns({})).kind).toBe('dns');
  });
});

describe('DnsProvider — a mode', () => {
  function aProvider(resolver: IDnsResolver, runtime = createFakeRuntime()): DnsProvider {
    return new DnsProvider(resolver, runtime, {
      mode: 'a',
      domainTemplate: '{service}.internal',
      port: 9000,
      watchIntervalMs: 30_000,
    });
  }

  it('emits one instance per address at the configured port', async () => {
    const resolver = createFakeDns({ a: ['10.0.0.1', '2001:db8::1'] });
    expect(await aProvider(resolver).resolve('billing')).toEqual([
      { id: '10.0.0.1:9000', serviceName: 'billing', host: '10.0.0.1', port: 9000, secure: false },
      {
        id: '2001:db8::1:9000',
        serviceName: 'billing',
        host: '2001:db8::1',
        port: 9000,
        secure: false,
      },
    ]);
  });

  it('resolves an empty address list to no instances', async () => {
    expect(await aProvider(createFakeDns({ a: [] })).resolve('billing')).toEqual([]);
  });
});

describe('DnsProvider — watch', () => {
  it('fires on the first lookup, then arms the poll interval', async () => {
    const runtime = createFakeRuntime();
    const resolver = createFakeDns({ srv: [srv('a.internal', 8080, 0, 1)] });
    const provider = srvProvider(resolver, {}, runtime);

    const seen: number[] = [];
    await provider.watch('billing', (list) => seen.push(list.length));
    await flush();

    expect(seen).toEqual([1]);
    expect(runtime.intervals).toHaveLength(1);
    expect(runtime.intervals[0].ms).toBe(30_000);
  });

  it('stays silent when a poll returns an unchanged record set', async () => {
    const runtime = createFakeRuntime();
    const resolver = createFakeDns({ srv: [srv('a.internal', 8080, 0, 1)] });
    const provider = srvProvider(resolver, {}, runtime);

    const seen: number[] = [];
    await provider.watch('billing', (list) => seen.push(list.length));
    await flush();
    runtime.runIntervals();
    await flush();

    expect(seen).toEqual([1]);
  });

  it('fires again when the record set changes', async () => {
    const runtime = createFakeRuntime();
    let records = [srv('a.internal', 8080, 0, 1)];
    const resolver: IDnsResolver = {
      resolveSrv: () => Promise.resolve(records),
      resolveHost: () => Promise.resolve([]),
    };
    const provider = srvProvider(resolver, {}, runtime);

    const seen: number[] = [];
    await provider.watch('billing', (list) => seen.push(list.length));
    await flush();

    records = [srv('a.internal', 8080, 0, 1), srv('b.internal', 8080, 0, 1)];
    runtime.runIntervals();
    await flush();

    expect(seen).toEqual([1, 2]);
  });

  it('swallows a failed lookup and fires again on recovery', async () => {
    const runtime = createFakeRuntime();
    let fail = true;
    const resolver: IDnsResolver = {
      resolveSrv: () =>
        fail
          ? Promise.reject(new Error('SERVFAIL'))
          : Promise.resolve([srv('a.internal', 8080, 0, 1)]),
      resolveHost: () => Promise.resolve([]),
    };
    const provider = srvProvider(resolver, {}, runtime);

    const seen: number[] = [];
    await provider.watch('billing', (list) => seen.push(list.length));
    await flush();
    expect(seen).toEqual([]);

    fail = false;
    runtime.runIntervals();
    await flush();
    expect(seen).toEqual([1]);
  });

  it('unsubscribe clears the interval', async () => {
    const runtime = createFakeRuntime();
    const resolver = createFakeDns({ srv: [srv('a.internal', 8080, 0, 1)] });
    const provider = srvProvider(resolver, {}, runtime);

    const unsubscribe = await provider.watch('billing', () => {});
    await flush();
    unsubscribe();

    expect(runtime.intervals[0].cleared).toBe(true);
  });

  it('unsubscribing before the first lookup resolves never arms an interval', async () => {
    const runtime = createFakeRuntime();
    const resolver = createFakeDns({ srv: [srv('a.internal', 8080, 0, 1)] });
    const provider = srvProvider(resolver, {}, runtime);

    const seen: number[] = [];
    const unsubscribe = await provider.watch('billing', (list) => seen.push(list.length));
    unsubscribe();
    await flush();

    // An interval armed after the clear would leak a timer nothing can stop.
    expect(runtime.intervals).toHaveLength(0);
    expect(seen).toEqual([]);
  });
});

/** Yields to the event loop so the detached first lookup can settle. */
function flush(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => undefined);
  }
  return chain;
}
