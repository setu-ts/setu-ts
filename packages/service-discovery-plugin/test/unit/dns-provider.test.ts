import { isNameAbsent } from '../../src/providers/dns-provider.ts';
/**
 * Unit tests for the DNS provider.
 *
 * The priority-tier case is the one with real consequences: ignoring RFC 2782
 * priority spreads traffic across a primary and its designated fallback at the
 * same time, which is the opposite of what the zone author asked for.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { DnsProvider, lowestPriorityTier } from '../../src/providers/dns-provider.ts';
import type { IDnsResolver, SrvRecord } from '@setu-ts/common';
import { createFakeDns, createFakeRuntime, type FakeRuntime } from '../fixtures/fakes.ts';

describe('DNS aggregate absence', () => {
  const absent = (code: string) => Object.assign(new Error(code), { code });
  const rows = [
    ['lone absent', absent('ENOTFOUND'), true],
    ['wrapped absent', new Error('wrapper', { cause: absent('ENOTFOUND') }), true],
    ['both absent', new AggregateError([absent('ENOTFOUND'), absent('ENODATA')]), true],
    ['mixed timeout', new AggregateError([absent('ENOTFOUND'), absent('ETIMEOUT')]), false],
    ['both timeout', new AggregateError([absent('ETIMEOUT'), absent('ETIMEOUT')]), false],
    [
      'timeout code with absent name',
      Object.assign(new Error(), { code: 'ETIMEOUT', name: 'NotFound' }),
      false,
    ],
    ['empty aggregate', new AggregateError([]), false],
    ['other code', new AggregateError([absent('ENOTFOUND'), absent('ESERVFAIL')]), false],
    ['Deno absence', new AggregateError([Object.assign(new Error(), { name: 'NotFound' })]), true],
    [
      'failure wrapping absence',
      Object.assign(new Error('timeout', { cause: absent('ENOTFOUND') }), { code: 'ETIMEOUT' }),
      false,
    ],
    [
      'member budget',
      new AggregateError(Array.from({ length: 64 }, () => absent('ENOTFOUND'))),
      false,
    ],
  ] as const;
  it.each(rows)('%s is absent: %s', async (_label, error, expected) => {
    expect(isNameAbsent(error)).toBe(expected);
    const provider = srvProvider(createFakeDns({ srv: new Error('lookup', { cause: error }) }));
    if (expected) {
      expect(await provider.resolve('billing')).toEqual([]);
      expect(await provider.isHealthy()).toBe(true);
    } else {
      await expect(provider.resolve('billing')).rejects.toThrow('lookup');
      await expect(provider.isHealthy()).rejects.toThrow('lookup');
    }
  });
  it('bounds aggregate depth, cycles and nested total member traversal', () => {
    let error: Error = absent('ENOTFOUND');
    for (let n = 0; n < 5; n++) error = new AggregateError([error]);
    expect(isNameAbsent(error)).toBe(true);
    expect(isNameAbsent(new AggregateError([error]))).toBe(false);
    const cycle = new Error('cycle');
    cycle.cause = cycle;
    expect(isNameAbsent(cycle)).toBe(false);
    const wide = new AggregateError(
      Array.from(
        { length: 8 },
        () => new AggregateError(Array.from({ length: 8 }, () => absent('ENODATA'))),
      ),
    );
    expect(isNameAbsent(wide)).toBe(false);
  });
});

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
    await srvProvider(resolver, { domainTemplate: '_http._tcp.{service}.internal' }).resolve(
      'billing',
    );
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
  it('arms the interval before delivering the first lookup', async () => {
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

  it('unsubscribing before the first lookup resolves clears the armed interval', async () => {
    const runtime = createFakeRuntime();
    const resolver = createFakeDns({ srv: [srv('a.internal', 8080, 0, 1)] });
    const provider = srvProvider(resolver, {}, runtime);

    const seen: number[] = [];
    const unsubscribe = await provider.watch('billing', (list) => seen.push(list.length));
    unsubscribe();
    await flush();

    // An interval armed after the clear would leak a timer nothing can stop.
    expect(runtime.intervals).toHaveLength(1);
    expect(runtime.intervals[0].cleared).toBe(true);
    expect(seen).toEqual([]);
  });
});

/** Yields to the event loop so the detached first lookup can settle. */
function flush(times = 30): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

async function flushOutcomes(): Promise<void> {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

describe('DNS lookup outcomes', () => {
  it('records even a rejection with no value, and observes an abort raised during lookup startup', async () => {
    const options = {
      mode: 'a' as const,
      port: 80,
      domainTemplate: '{service}',
      watchIntervalMs: 100,
    };
    const failed = new DnsProvider(
      { resolveHost: () => Promise.reject(undefined), resolveSrv: () => Promise.resolve([]) },
      createFakeRuntime(),
      options,
    );
    await expect(failed.resolve('billing')).rejects.toBeUndefined();
    await expect(failed.isHealthy()).rejects.toBeUndefined();
    const abort = new AbortController();
    const error = new Error('startup abort');
    const provider = new DnsProvider(
      {
        resolveHost: () => {
          abort.abort(error);
          return new Promise<never>(() => {});
        },
        resolveSrv: () => Promise.resolve([]),
      },
      createFakeRuntime(),
      options,
    );
    await expect(provider.resolve('billing', abort.signal)).rejects.toBe(error);
    await expect(provider.isHealthy()).rejects.toBe(error);
  });
  for (const mode of ['srv', 'a'] as const) {
    for (const [field, value, absent] of [
      ['code', 'ENOTFOUND', true],
      ['code', 'ENODATA', true],
      ['name', 'NotFound', true],
      ['code', 'ETIMEOUT', false],
      ['code', 'ECONNREFUSED', false],
      ['code', 'ESERVFAIL', false],
    ] as const) {
      it(`${mode} treats ${value} as ${absent ? 'an empty answer' : 'a failure'}`, async () => {
        const cause = Object.assign(new Error(value), { [field]: value });
        const error = mode === 'a' ? new Error('DNS lookup failed', { cause }) : cause;
        const resolver = {
          resolveHost: () => Promise.reject(error),
          resolveSrv: () => Promise.reject(error),
        };
        const provider = new DnsProvider(resolver, createFakeRuntime(), {
          mode,
          port: 80,
          domainTemplate: '{service}.svc',
          watchIntervalMs: 100,
        });
        if (absent) expect(await provider.resolve('billing')).toEqual([]);
        else await expect(provider.resolve('billing')).rejects.toBe(error);
      });
    }
  }
  it('limits cause traversal and refuses nonobjects', () => {
    for (const value of [null, undefined, 'ENOTFOUND', {}]) expect(isNameAbsent(value)).toBe(false);
    let error: Error = Object.assign(new Error(), { code: 'ENOTFOUND' });
    for (let n = 0; n < 5; n++) error = new Error('wrapped', { cause: error });
    expect(isNameAbsent(error)).toBe(true);
    error = new Error('too deep', { cause: error });
    expect(isNameAbsent(error)).toBe(false);
  });
  it('abandons a hung lookup at abort, records failure, and ignores its late success', async () => {
    let finish!: (value: readonly string[]) => void;
    const resolver = {
      resolveHost: () =>
        new Promise<readonly string[]>((resolve) => {
          finish = resolve;
        }),
      resolveSrv: () => Promise.resolve([]),
    };
    const provider = new DnsProvider(resolver, createFakeRuntime(), {
      mode: 'a',
      port: 80,
      domainTemplate: '{service}',
      watchIntervalMs: 100,
    });
    const controller = new AbortController();
    const error = new Error('read bound');
    const call = provider.resolve('billing', controller.signal);
    controller.abort(error);
    await expect(call).rejects.toBe(error);
    finish(['10.0.0.1']);
    await flushOutcomes();
    await expect(provider.isHealthy()).rejects.toBe(error);
    await expect(provider.resolve('billing', controller.signal)).rejects.toBe(error);
  });
  it('arms the interval before the first tick, skips overlap, and retries after its bound', async () => {
    const runtime = createFakeRuntime();
    let calls = 0;
    const resolver = {
      resolveHost: () => {
        calls++;
        return calls === 1 ? new Promise<never>(() => {}) : Promise.resolve(['10.0.0.1']);
      },
      resolveSrv: () => Promise.resolve([]),
    };
    const provider = new DnsProvider(resolver, runtime, {
      mode: 'a',
      port: 80,
      domainTemplate: '{service}',
      watchIntervalMs: 100,
      resolveTimeoutMs: 50,
    });
    const seen: unknown[] = [];
    const stop = await provider.watch('billing', (list) => seen.push(list));
    expect(runtime.intervals).toHaveLength(1);
    await flushOutcomes();
    runtime.runIntervals();
    await flushOutcomes();
    expect(calls).toBe(1);
    runtime.runTimeouts();
    await flushOutcomes();
    await expect(provider.isHealthy()).rejects.toThrow('within 50 ms');
    runtime.runIntervals();
    await flushOutcomes();
    expect(calls).toBe(2);
    expect(seen).toHaveLength(1);
    expect(await provider.isHealthy()).toBe(true);
    stop();
    runtime.runIntervals();
    expect(calls).toBe(2);
  });
});

for (const previousFailure of [false, true]) {
  it(`does not change DNS health when a hung watch is stopped (previous failure ${previousFailure})`, async () => {
    const runtime = createFakeRuntime();
    let hung = false;
    const error = new Error('previous DNS failure');
    const resolver = {
      resolveSrv: () => Promise.resolve([]),
      resolveHost: () =>
        hung
          ? new Promise<never>(() => {})
          : previousFailure
            ? Promise.reject(error)
            : Promise.resolve(['10.0.0.1']),
    };
    const provider = new DnsProvider(resolver, runtime, {
      mode: 'a',
      port: 80,
      domainTemplate: '{service}',
      watchIntervalMs: 100,
    });
    await provider.resolve('billing').catch(() => {});
    hung = true;
    const stop = await provider.watch('billing', () => {
      throw new Error('hung tick delivered');
    });
    await flushOutcomes();
    stop();
    await flushOutcomes();
    if (previousFailure) await expect(provider.isHealthy()).rejects.toBe(error);
    else expect(await provider.isHealthy()).toBe(true);
    expect(runtime.timeouts.every((timer) => timer.cleared)).toBe(true);
    expect(runtime.intervals.every((timer) => timer.cleared)).toBe(true);
  });
}
for (const value of [-1, NaN, Infinity, 2147483648]) {
  it(`refuses direct DNS resolveTimeoutMs=${value}`, () => {
    expect(
      () =>
        new DnsProvider(createFakeDns({}), createFakeRuntime(), {
          mode: 'srv',
          domainTemplate: '{service}',
          watchIntervalMs: 100,
          resolveTimeoutMs: value,
        }),
    ).toThrow('resolveTimeoutMs');
  });
}
it('accepts a directly constructed DNS watch with an unbounded tick', async () => {
  const runtime = createFakeRuntime();
  const provider = new DnsProvider(createFakeDns({}), runtime, {
    mode: 'srv',
    domainTemplate: '{service}',
    watchIntervalMs: 100,
    resolveTimeoutMs: 0,
  });
  const stop = await provider.watch('billing', () => {});
  await flushOutcomes();
  stop();
  expect(runtime.timeouts).toHaveLength(0);
});
