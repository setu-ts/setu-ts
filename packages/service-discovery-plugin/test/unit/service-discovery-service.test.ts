/**
 * Unit tests for the discovery service — cache, coalescing, stale-on-failure,
 * and the two entry points that must honour one configuration.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';

import { createConnectionErrorReporter, describeError, httpStatusHintOf } from '@setu-ts/common';
import type { ConnectionErrorReporter } from '@setu-ts/common';
import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { RefreshBackoff } from '../../src/services/refresh-backoff.ts';
import { createProvider } from '../../src/providers/provider-factory.ts';
import { resolveOptions, type ServiceDiscoveryPluginOptions } from '../../src/options.ts';
import { DiscoveryUnavailableError } from '../../src/errors.ts';
import { RecordingLogger } from '../../../common/test/fixtures/redis-connection-errors.ts';
import {
  createFakeProvider,
  createFakeRuntime,
  type FakeProvider,
  type FakeRuntime,
  instance,
} from '../fixtures/fakes.ts';

async function flush(): Promise<void> {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

const a = instance({ id: 'a', host: '10.0.0.1' });
const b = instance({ id: 'b', host: '10.0.0.2' });

describe('background discovery refresh', () => {
  it('hands a cold in-flight read over to a warm watch entry without a second backend read', async () => {
    const runtime = createFakeRuntime();
    const watched = createFakeProvider();
    let finish!: (list: readonly (typeof a)[]) => void;
    let calls = 0;
    const provider = {
      ...watched,
      resolve: () => {
        calls++;
        return new Promise<readonly (typeof a)[]>((resolve) => {
          finish = resolve;
        });
      },
    };
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
    );
    const cold = service.resolve('billing');
    await flush();
    await service.watch('billing', () => {});
    watched.emit('billing', [a]);
    let warm: unknown;
    void service.resolve('billing').then((list) => {
      warm = list;
    });
    await flush();
    expect(warm).toEqual([a]);
    expect(calls).toBe(1);
    // The read started before the watch delivery, so its older answer is
    // dropped: the cold caller gets the newer watched list, and so does the cache.
    finish([b]);
    expect(await cold).toEqual([a]);
    expect(await service.resolve('billing')).toEqual([a]);
    service.close();
  });
  it('serves warm names immediately, coalesces refreshes, bounds hung reads, and ignores late writes after close', async () => {
    const runtime = createFakeRuntime();
    let finish!: (list: readonly (typeof a)[]) => void;
    let calls = 0;
    const provider = {
      ...createFakeProvider(),
      resolve: () => {
        calls++;
        return calls === 1
          ? Promise.resolve([a])
          : new Promise<readonly (typeof a)[]>((resolve) => {
              finish = resolve;
            });
      },
    };
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({
        provider: 'custom',
        discovery: provider,
        cacheTtlMs: 0,
        resolveTimeoutMs: 50,
      }),
    );
    await service.resolve('billing');
    let answered = 0;
    for (let n = 0; n < 10; n++)
      void service.resolve('billing').then((list) => {
        expect(list).toEqual([a]);
        answered++;
      });
    await flush();
    expect(answered).toBe(10);
    expect(calls).toBe(2);
    runtime.advance(50);
    runtime.runTimeouts();
    await flush();
    expect(service.degraded).toBe(true);
    expect(service.staleForMs).toBe(50);
    await service.resolve('billing');
    expect(calls).toBe(2);
    runtime.advance(1000);
    await service.resolve('billing');
    await flush();
    expect(calls).toBe(3);
    service.close();
    finish([b]);
    await flush();
    expect(service.cachedServices).toBe(0);
    expect(service.degraded).toBe(false);
    await expect(service.resolve('billing')).rejects.toThrow('closed');
  });

  it('bounds a cold read with a named branded 503, and allows the next cold attempt', async () => {
    const runtime = createFakeRuntime();
    const provider = { ...createFakeProvider(), resolve: () => new Promise<never>(() => {}) };
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({ provider: 'custom', discovery: provider, resolveTimeoutMs: 50 }),
    );
    for (let n = 0; n < 2; n++) {
      let error: unknown;
      void service.resolve('billing').catch((thrown: unknown) => {
        error = thrown;
      });
      await flush();
      expect(error).toBeUndefined();
      runtime.runTimeouts();
      await flush();
      expect((error as Error).message).toContain(
        "fake discovery did not answer the read for 'billing' within 50 ms",
      );
      expect(httpStatusHintOf(error)?.status).toBe(503);
    }
    service.close();
  });

  it('tracks failures and reporter recovery separately for two names, with retry spacing and success reset', async () => {
    const { service: unused, provider, runtime } = setup();
    unused.close();
    const logger = new RecordingLogger();
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
      undefined,
      (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
    );
    await service.resolve('billing');
    await service.resolve('orders');
    provider.failWith(new Error('down'));
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = provider.resolveCalls;
      for (const name of ['billing', 'orders']) await service.resolve(name);
      await flush();
      expect(provider.resolveCalls).toBe(before + 2);
      expect(service.degraded).toBe(true);
      runtime.advance(delay - 1);
      for (const name of ['billing', 'orders']) await service.resolve(name);
      await flush();
      expect(provider.resolveCalls).toBe(before + 2);
      runtime.advance(1);
    }
    for (const name of ['billing', 'orders'])
      expect(logger.forSource(name).map((e) => e.level)).toEqual([
        'warn',
        'debug',
        'debug',
        'debug',
        'debug',
        'debug',
        'debug',
      ]);
    expect(service.staleForMs).toBeGreaterThan(0);
    provider.failWith(null);
    await service.resolve('billing');
    await flush();
    expect(service.degraded).toBe(true);
    await service.resolve('orders');
    await flush();
    expect(service.degraded).toBe(false);
    expect(service.staleForMs).toBe(0);
    expect(logger.forSource('billing').at(-1)?.level).toBe('info');
    provider.failWith(new Error('down again'));
    await service.resolve('billing');
    await flush();
    runtime.advance(1000);
    const before = provider.resolveCalls;
    await service.resolve('billing');
    await flush();
    expect(provider.resolveCalls).toBe(before + 1);
    service.close();
  });

  it('drops late failures and late watch registrations after close', async () => {
    const runtime = createFakeRuntime();
    let reject!: (error: Error) => void;
    let deliver!: (list: readonly (typeof a)[]) => void;
    let ready!: (unsubscribe: () => void) => void;
    let stopped = false;
    const provider = {
      kind: 'fake',
      resolve: () =>
        new Promise<never>((_, fail) => {
          reject = fail;
        }),
      watch: (_name: string, listener: typeof deliver) => {
        deliver = listener;
        return new Promise<() => void>((resolve) => {
          ready = resolve;
        });
      },
    };
    const service = new ServiceDiscoveryService(
      provider,
      runtime,
      resolveOptions({ provider: 'custom', discovery: provider }),
    );
    const reading = service.resolve('billing').catch(() => {});
    const watching = service.watch('billing', () => {
      throw new Error('late watch');
    });
    await flush();
    service.close();
    deliver([a]);
    ready(() => {
      stopped = true;
    });
    reject(new Error('late'));
    await reading;
    await watching;
    expect(stopped).toBe(true);
    expect(service.cachedServices).toBe(0);
    expect(service.degraded).toBe(false);
  });
});

function setup(
  options: Partial<ServiceDiscoveryPluginOptions> = {},
  instances: readonly (typeof a)[] = [a, b],
): { service: ServiceDiscoveryService; provider: FakeProvider; runtime: FakeRuntime } {
  const provider = createFakeProvider(instances);
  const runtime = createFakeRuntime();
  const resolved = resolveOptions({
    provider: 'static',
    services: {},
    ...options,
  } as ServiceDiscoveryPluginOptions);
  return {
    service: new ServiceDiscoveryService(provider, runtime, resolved),
    provider,
    runtime,
  };
}

describe('ServiceDiscoveryService — cache', () => {
  it('serves a second resolve inside the TTL from cache', async () => {
    const { service, provider } = setup();
    await service.resolve('billing');
    await service.resolve('billing');
    expect(provider.resolveCalls).toBe(1);
  });

  it('re-reads once the TTL has elapsed', async () => {
    const { service, provider, runtime } = setup({ cacheTtlMs: 1_000 });
    await service.resolve('billing');
    runtime.advance(1_001);
    await service.resolve('billing');
    expect(provider.resolveCalls).toBe(2);
  });

  it('cacheTtlMs: 0 hits the provider every time', async () => {
    const { service, provider } = setup({ cacheTtlMs: 0 });
    await service.resolve('billing');
    await service.resolve('billing');
    await service.resolve('billing');
    await flush();
    await service.resolve('billing');
    expect(provider.resolveCalls).toBeGreaterThanOrEqual(2);
  });

  it('coalesces concurrent reads of a cold service into one provider call', async () => {
    const { service, provider } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => service.resolve('billing')));
    expect(provider.resolveCalls).toBe(1);
    for (const result of results) {
      expect(result.map((i) => i.id)).toEqual(['a', 'b']);
    }
  });

  it('a watch event invalidates that name and only that name', async () => {
    const { service, provider } = setup();
    await service.resolve('billing');
    await service.resolve('orders');
    expect(provider.resolveCalls).toBe(2);

    await service.watch('billing', () => {});
    provider.emit('billing', [a]);

    // billing now serves the pushed list without a further provider call...
    expect((await service.resolve('billing')).map((i) => i.id)).toEqual(['a']);
    // ...and orders is untouched, still served from its own cache entry.
    expect((await service.resolve('orders')).map((i) => i.id)).toEqual(['a', 'b']);
    expect(provider.resolveCalls).toBe(2);
  });

  it('serves the stale list and reports degraded when a refresh fails', async () => {
    const { service, provider, runtime } = setup({ cacheTtlMs: 1_000 });
    await service.resolve('billing');
    expect(service.degraded).toBe(false);

    provider.failWith(new Error('consul unreachable'));
    runtime.advance(1_001);
    const result = await service.resolve('billing');

    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
    await flush();
    expect(service.degraded).toBe(true);
  });

  it('clears degraded once a refresh succeeds again', async () => {
    const { service, provider, runtime } = setup({ cacheTtlMs: 1_000 });
    await service.resolve('billing');
    provider.failWith(new Error('down'));
    runtime.advance(1_001);
    await service.resolve('billing');
    await flush();
    expect(service.degraded).toBe(true);

    provider.failWith(null);
    runtime.advance(1_001);
    await service.resolve('billing');
    await flush();
    expect(service.degraded).toBe(false);
  });

  it('throws DiscoveryUnavailableError carrying the cause and a 503 hint on a cold failure', async () => {
    const { service, provider } = setup();
    const cause = new Error('connection refused');
    provider.failWith(cause);

    await expect(service.resolve('billing')).rejects.toThrow(DiscoveryUnavailableError);
    try {
      await service.resolve('billing');
    } catch (error) {
      expect((error as Error).cause).toBe(cause);
      expect((error as Error).message).toContain('billing');
      // M119g, V10-34: only this throw is branded, so the kernel answers a named
      // 503 instead of a masked 500. The detail carries no service name.
      expect(httpStatusHintOf(error)).toEqual({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Service discovery is temporarily unavailable.',
      });
    }
  });

  it('passes a provider configuration error through unbranded on a cold failure', async () => {
    const { service, provider } = setup();
    const misconfigured = new DiscoveryUnavailableError(
      "Service 'billing' exposes several ports (http, grpc); set the 'portName' option to choose one.",
    );
    provider.failWith(misconfigured);
    let thrown: unknown;
    try {
      await service.resolve('billing');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(misconfigured);
    expect(httpStatusHintOf(thrown)).toBeUndefined();
  });

  it('does not brand a configuration error with a status hint', () => {
    const runtime = createFakeRuntime();
    const resolved = resolveOptions({ provider: 'dns', mode: 'srv' });
    let thrown: unknown;
    try {
      createProvider({ provider: 'dns', mode: 'srv' }, resolved, runtime);
    } catch (error) {
      thrown = error;
    }
    // A misconfiguration is the operator's to fix, so it stays an unmasked 500.
    expect(thrown).toBeInstanceOf(DiscoveryUnavailableError);
    expect(httpStatusHintOf(thrown)).toBeUndefined();
  });
});

describe('ServiceDiscoveryService — pick and resolveUrl share one implementation', () => {
  it('both entry points select the same instance under a non-default strategy', async () => {
    const { service, runtime } = setup({ strategy: 'weighted-random' }, [
      instance({ id: 'a', host: '10.0.0.1', weight: 1 }),
      instance({ id: 'b', host: '10.0.0.2', weight: 9 }),
    ]);
    // 0.5 of a total of 10 lands in the second bucket.
    runtime.setRandomBytes(new Uint8Array([0x80, 0, 0, 0]));

    const picked = await service.pick('billing');
    const url = await service.resolveUrl('billing', '/invoices');

    expect(picked?.id).toBe('b');
    expect(url).toBe('http://10.0.0.2:8080/invoices');
  });

  it('both entry points honour a per-call strategy override identically', async () => {
    const { service, runtime } = setup({ strategy: 'round-robin' });
    runtime.setRandomBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]));

    const picked = await service.pick('billing', { strategy: 'random' });
    const url = await service.resolveUrl('billing', '/x', { strategy: 'random' });

    expect(picked?.id).toBe('b');
    expect(url).toBe('http://10.0.0.2:8080/x');
  });

  it('both entry points skip an ejected instance', async () => {
    const { service } = setup({ ejection: { failureThreshold: 2 } });
    await service.resolve('billing');
    service.report(a, 'failure');
    service.report(a, 'failure');

    expect((await service.pick('billing'))?.id).toBe('b');
    expect(await service.resolveUrl('billing')).toBe('http://10.0.0.2:8080');
  });

  it('resolveUrl returns null when the service has no instance', async () => {
    const { service } = setup({}, []);
    expect(await service.pick('billing')).toBeNull();
    expect(await service.resolveUrl('billing', '/x')).toBeNull();
  });
});

describe('ServiceDiscoveryService — ejection interaction', () => {
  it('resolve reports ejected instances while pick does not', async () => {
    const { service } = setup({ ejection: { failureThreshold: 1 } });
    await service.resolve('billing');
    service.report(a, 'failure');

    expect((await service.resolve('billing')).map((i) => i.id)).toEqual(['a', 'b']);
    expect((await service.pick('billing'))?.id).toBe('b');
    expect(service.ejectedInstances).toBe(1);
  });

  it('falls back to the unfiltered list when every instance is ejected', async () => {
    const { service } = setup({ ejection: { failureThreshold: 1, maxEjectionPercent: 100 } });
    await service.resolve('billing');
    service.report(a, 'failure');
    service.report(b, 'failure');

    expect(service.ejectedInstances).toBe(2);
    expect(await service.pick('billing')).not.toBeNull();
  });

  it('report is a no-op when ejection is disabled', async () => {
    const { service } = setup({ ejection: false });
    await service.resolve('billing');
    for (let i = 0; i < 20; i++) {
      service.report(a, 'failure');
    }
    expect(service.ejectedInstances).toBe(0);
    expect((await service.pick('billing'))?.id).toBe('a');
  });
});

describe('ServiceDiscoveryService — watch and close', () => {
  it('forwards the provider unsubscribe and stops counting the watch', async () => {
    const { service, provider } = setup();
    const unsubscribe = await service.watch('billing', () => {});
    expect(service.watchedServices).toBe(1);

    unsubscribe();
    expect(provider.unsubscribeCalls).toBe(1);
    expect(service.watchedServices).toBe(0);
  });

  it('delivers the full list to the listener', async () => {
    const { service, provider } = setup();
    const seen: string[][] = [];
    await service.watch('billing', (list) => seen.push(list.map((i) => i.id)));

    provider.emit('billing', [a]);
    provider.emit('billing', [a, b]);
    expect(seen).toEqual([['a'], ['a', 'b']]);
  });

  it('close() unsubscribes every active watch and clears ejection state', async () => {
    const { service, provider } = setup({ ejection: { failureThreshold: 1 } });
    await service.watch('billing', () => {});
    await service.watch('orders', () => {});
    await service.resolve('billing');
    service.report(a, 'failure');
    expect(service.ejectedInstances).toBe(1);

    service.close();

    expect(provider.unsubscribeCalls).toBe(2);
    expect(service.watchedServices).toBe(0);
    expect(service.ejectedInstances).toBe(0);
  });

  it('exposes the provider kind and cached count for the health indicator', async () => {
    const { service } = setup();
    expect(service.providerKind).toBe('fake');
    expect(service.cachedServices).toBe(0);
    await service.resolve('billing');
    expect(service.cachedServices).toBe(1);
  });
});

describe('ServiceDiscoveryService — M70c everResolved', () => {
  it('is false before any successful resolve', () => {
    const { service } = setup();
    expect(service.everResolved).toBe(false);
    expect(service.degraded).toBe(false);
  });

  it('is true once a resolve succeeds', async () => {
    const { service } = setup();
    await service.resolve('billing');
    expect(service.everResolved).toBe(true);
  });

  it('is NOT set by a cold failure (no stale to serve) — the X10-3 case', async () => {
    const { service, provider } = setup();
    provider.failWith(new Error('backend unreachable'));
    await expect(service.resolve('billing')).rejects.toThrow(DiscoveryUnavailableError);
    // A failure must not flip everResolved: there was no prior success.
    expect(service.everResolved).toBe(false);
    expect(service.degraded).toBe(false);
  });

  it('is set by a watch push (a delivered list is a successful read)', async () => {
    const { service, provider } = setup();
    expect(service.everResolved).toBe(false);
    await service.watch('billing', () => {});
    provider.emit('billing', [a]);
    expect(service.everResolved).toBe(true);
  });

  it('is already true when a stale-cache serve happens (the stale path does not set it)', async () => {
    const { service, provider, runtime } = setup({ cacheTtlMs: 1_000 });
    await service.resolve('billing');
    expect(service.everResolved).toBe(true);

    provider.failWith(new Error('down'));
    runtime.advance(1_001);
    await service.resolve('billing'); // serves stale, sets degraded
    await flush();
    expect(service.degraded).toBe(true);
    expect(service.everResolved).toBe(true);
  });
});

describe('ServiceDiscoveryService — M139f X10-3 probe reasons and the cold-resolve cause', () => {
  /** A reporter that records what the service hands it. */
  function recordingReporter(): {
    reporter: ConnectionErrorReporter;
    reports: unknown[];
    recoveries: number;
  } {
    const record = { reports: [] as unknown[], recoveries: 0 };
    return {
      reporter: {
        report: (error) => record.reports.push(error),
        recovered: () => {
          record.recoveries++;
        },
      },
      get reports() {
        return record.reports;
      },
      get recoveries() {
        return record.recoveries;
      },
    };
  }

  function serviceWith(
    isHealthy: (() => Promise<boolean>) | undefined,
    reporter: ConnectionErrorReporter,
  ): ServiceDiscoveryService {
    const provider = createFakeProvider([a]);
    const runtime = createFakeRuntime();
    const resolved = resolveOptions({
      provider: 'static',
      services: {},
    } as ServiceDiscoveryPluginOptions);
    return new ServiceDiscoveryService(
      isHealthy === undefined ? provider : { ...provider, isHealthy },
      runtime,
      resolved,
      reporter,
    );
  }

  it('reports a rejecting probe with its own error and answers false', async () => {
    const tls = new Error('invalid peer certificate: UnknownIssuer');
    const record = recordingReporter();
    const service = serviceWith(() => Promise.reject(tls), record.reporter);
    expect(await service.isHealthy()).toBe(false);
    expect(record.reports).toEqual([tls]);
    expect(record.recoveries).toBe(0);
  });

  it('reports a probe that resolves false with a reason naming the provider', async () => {
    const record = recordingReporter();
    const service = serviceWith(() => Promise.resolve(false), record.reporter);
    expect(await service.isHealthy()).toBe(false);
    expect(record.reports).toHaveLength(1);
    expect((record.reports[0] as Error).message).toBe(
      'fake discovery backend reported unreachable',
    );
  });

  it('tells the reporter about a healthy probe so it can log a recovery', async () => {
    const record = recordingReporter();
    const service = serviceWith(() => Promise.resolve(true), record.reporter);
    expect(await service.isHealthy()).toBe(true);
    expect(record.reports).toEqual([]);
    expect(record.recoveries).toBe(1);
  });

  it('reports nothing for a provider with no probe', async () => {
    const record = recordingReporter();
    const service = serviceWith(undefined, record.reporter);
    expect(await service.isHealthy()).toBe(true);
    expect(record.reports).toEqual([]);
    expect(record.recoveries).toBe(0);
  });

  it('names the cause in a cold-resolve error and keeps the public 503 detail', async () => {
    const { service, provider } = setup();
    const cause = new TypeError('fetch failed', { cause: new Error('UnknownIssuer') });
    provider.failWith(cause);
    const error = await service.resolve('orders').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(DiscoveryUnavailableError);
    expect((error as Error).message).toBe(
      `Service discovery could not resolve 'orders' and has nothing cached: ${describeError(cause)}`,
    );
    // The TLS reason itself, not only the generic fetch failure, is in the line.
    expect((error as Error).message).toContain('UnknownIssuer');
    expect(httpStatusHintOf(error)).toMatchObject({
      status: 503,
      detail: 'Service discovery is temporarily unavailable.',
    });
  });
});

it('retains cold reporters without degraded state and retains one reporter for a warm failure run', async () => {
  const provider = createFakeProvider([a]);
  const runtime = createFakeRuntime();
  let created = 0;
  const logger = new RecordingLogger();
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
    undefined,
    (name) => {
      created++;
      return createConnectionErrorReporter({ source: name, logger: () => logger });
    },
  );
  provider.failWith(new Error('down'));
  for (const name of ['forgotten', 'forgotten', 'other']) {
    await expect(service.resolve(name)).rejects.toThrow();
    expect(service.degraded).toBe(false);
  }
  expect(created).toBe(2);
  expect(logger.forSource('forgotten').map((entry) => entry.level)).toEqual(['warn', 'debug']);
  provider.failWith(null);
  await service.resolve('billing');
  provider.failWith(new Error('down'));
  await service.resolve('billing');
  await flush();
  runtime.advance(1000);
  await service.resolve('billing');
  await flush();
  expect(created).toBe(3);
  expect(logger.forSource('billing').map((entry) => entry.level)).toEqual(['warn', 'debug']);
  expect(service.degraded).toBe(true);
  service.close();
});

it('deduplicates cold failures, reports recovery and evicts the least recently used of 256 reporters', async () => {
  const provider = createFakeProvider([a]);
  const logger = new RecordingLogger();
  const created: string[] = [];
  const service = new ServiceDiscoveryService(
    provider,
    createFakeRuntime(),
    resolveOptions({ provider: 'custom', discovery: provider }),
    undefined,
    (name) => {
      created.push(name);
      return createConnectionErrorReporter({ source: name, logger: () => logger });
    },
  );
  provider.failWith(new Error('down'));
  for (let n = 0; n < 3; n++) await expect(service.resolve('recover')).rejects.toThrow();
  expect(logger.forSource('recover').map((entry) => entry.level)).toEqual([
    'warn',
    'debug',
    'debug',
  ]);
  provider.failWith(null);
  await service.resolve('recover');
  expect(logger.forSource('recover').at(-1)?.level).toBe('info');
  expect(service.degraded).toBe(false);
  service.close();
  const bounded = new ServiceDiscoveryService(
    provider,
    createFakeRuntime(),
    resolveOptions({ provider: 'custom', discovery: provider }),
    undefined,
    (name) => {
      created.push(name);
      return createConnectionErrorReporter({ source: name, logger: () => logger });
    },
  );
  provider.failWith(new Error('down'));
  for (let n = 0; n < 256; n++) await expect(bounded.resolve(`name-${n}`)).rejects.toThrow();
  await expect(bounded.resolve('name-0')).rejects.toThrow(); // Refresh its recency.
  await expect(bounded.resolve('name-256')).rejects.toThrow();
  await expect(bounded.resolve('name-1')).rejects.toThrow();
  await expect(bounded.resolve('name-0')).rejects.toThrow();
  expect(created.filter((name) => name === 'name-1')).toHaveLength(2);
  expect(created.filter((name) => name === 'name-0')).toHaveLength(1);
  expect(bounded.degraded).toBe(false);
  bounded.close();
});

it('does not overwrite a newer watch delivery with an older in-flight refresh, but records success', async () => {
  const runtime = createFakeRuntime();
  const watched = createFakeProvider([a]);
  let finish!: (list: readonly (typeof a)[]) => void;
  let fail = false;
  const provider = {
    ...watched,
    resolve: () =>
      fail
        ? Promise.reject(new Error('down'))
        : new Promise<readonly (typeof a)[]>((resolve) => {
            finish = resolve;
          }),
  };
  const logger = new RecordingLogger();
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0, resolveTimeoutMs: 0 }),
    undefined,
    (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
  );
  const seen: string[][] = [];
  await service.watch('billing', (list) => seen.push(list.map((i) => i.id)));
  watched.emit('billing', [a]);
  fail = true;
  await service.resolve('billing');
  await flush();
  expect(service.degraded).toBe(true);
  runtime.advance(1000);
  fail = false;
  await service.resolve('billing');
  await flush();
  watched.emit('billing', [b]);
  seen.length = 0;
  finish([a]);
  await flush();
  expect(seen).toEqual([]);
  // A fresh resolve starts the next read but still returns the newer cache.
  expect(await service.resolve('billing')).toEqual([b]);
  expect(service.degraded).toBe(false);
  expect(service.staleForMs).toBe(0);
  expect(logger.forSource('billing').map((entry) => entry.level)).toEqual(['warn', 'info']);
  finish([b]);
  await flush();
  service.close();
});

it('does not mark a name failed when its read fails after a newer watch delivery', async () => {
  const runtime = createFakeRuntime();
  const watched = createFakeProvider([a]);
  let fail!: (error: Error) => void;
  let calls = 0;
  const provider = {
    ...watched,
    resolve: () => {
      calls++;
      return calls === 1
        ? Promise.resolve([a])
        : new Promise<readonly (typeof a)[]>((_, reject) => {
            fail = reject;
          });
    },
  };
  const logger = new RecordingLogger();
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0, resolveTimeoutMs: 0 }),
    undefined,
    (name) => createConnectionErrorReporter({ source: name, logger: () => logger }),
  );
  await service.resolve('billing');
  await service.watch('billing', () => {});
  await service.resolve('billing'); // Starts the background read that will fail.
  await flush();
  watched.emit('billing', [b]);
  fail(new Error('down'));
  await flush();
  expect(service.degraded).toBe(false);
  expect(service.staleForMs).toBe(0);
  // No retry spacing started: the next expired call refreshes at once.
  const before = calls;
  await service.resolve('billing');
  await flush();
  expect(calls).toBe(before + 1);
  expect(await service.resolve('billing')).toEqual([b]);
  service.close();
});

it('keeps a failing name reporter while long-recovered names refresh, so its recovery logs', async () => {
  const runtime = createFakeRuntime();
  const provider = createFakeProvider([a]);
  const logger = new RecordingLogger();
  const created: string[] = [];
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
    undefined,
    (name) => {
      created.push(name);
      return createConnectionErrorReporter({ source: name, logger: () => logger });
    },
  );
  provider.failWith(new Error('down'));
  for (let n = 0; n < 256; n++) await expect(service.resolve(`old-${n}`)).rejects.toThrow();
  provider.failWith(null);
  for (let n = 0; n < 256; n++) await service.resolve(`old-${n}`); // All recover.
  provider.failWith(new Error('down'));
  await expect(service.resolve('failing')).rejects.toThrow();
  provider.failWith(null);
  // The recovered names keep refreshing successfully (background refreshes on
  // every call with cacheTtlMs 0), which must not push the failing name out.
  for (let n = 0; n < 256; n++) {
    await service.resolve(`old-${n}`);
    await flush();
  }
  provider.failWith(new Error('down'));
  await expect(service.resolve('another')).rejects.toThrow();
  provider.failWith(null);
  await service.resolve('failing');
  expect(logger.forSource('failing').map((entry) => entry.level)).toEqual(['warn', 'info']);
  // 257 names failing at once evict the oldest open run.
  provider.failWith(new Error('down'));
  for (let n = 0; n < 257; n++) await expect(service.resolve(`now-${n}`)).rejects.toThrow();
  await expect(service.resolve('now-0')).rejects.toThrow();
  expect(created.filter((name) => name === 'now-0')).toHaveLength(2);
  service.close();
});

it('caches empty-only names but keeps at most 256, evicting the oldest unwatched one', async () => {
  const provider = createFakeProvider();
  const service = new ServiceDiscoveryService(
    provider,
    createFakeRuntime(),
    resolveOptions({ provider: 'custom', discovery: provider }),
  );
  await service.watch('absent-0', () => {});
  for (let n = 0; n < 1000; n++) expect(await service.resolve(`absent-${n}`)).toEqual([]);
  expect(service.cachedServices).toBe(256);
  expect(service.degraded).toBe(false);
  expect(service.everResolved).toBe(true);
  // A recent empty name is served from cache inside its TTL; the watched one survived.
  const calls = provider.resolveCalls;
  expect(await service.resolve('absent-999')).toEqual([]);
  expect(await service.resolve('absent-0')).toEqual([]);
  expect(provider.resolveCalls).toBe(calls);
  // An evicted name reads the backend again.
  await service.resolve('absent-1');
  expect(provider.resolveCalls).toBe(calls + 1);
  service.close();
});

it('answers a read raced by a cold empty watch delivery, and a joiner gets the empty list', async () => {
  const runtime = createFakeRuntime();
  const watched = createFakeProvider();
  let finish!: (list: readonly (typeof a)[]) => void;
  let fail!: (error: Error) => void;
  let mode: 'ok' | 'fail' = 'ok';
  const provider = {
    ...watched,
    resolve: () =>
      new Promise<readonly (typeof a)[]>((resolve, reject) => {
        if (mode === 'ok') finish = resolve;
        else fail = reject;
      }),
  };
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, resolveTimeoutMs: 0 }),
  );
  const read = service.resolve('billing');
  await flush();
  await service.watch('billing', () => {});
  watched.emit('billing', []);
  finish([a]);
  expect(await read).toEqual([]);
  const joined: string[][] = [];
  await service.watch('billing', (list) => joined.push(list.map((i) => i.id)));
  expect(joined).toEqual([[]]);
  // A failing read raced the same way answers the delivered empty list, not a 503.
  mode = 'fail';
  const second = service.resolve('other');
  await flush();
  await service.watch('other', () => {});
  watched.emit('other', []);
  fail(new Error('down'));
  expect(await second).toEqual([]);
  service.close();
});

it('shrinks back to 256 empty-only names after watches end and evicts a failing name last', async () => {
  const runtime = createFakeRuntime();
  const provider = createFakeProvider();
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
  );
  const stops: Array<() => void> = [];
  for (let n = 0; n < 300; n++) {
    stops.push(await service.watch(`watched-${n}`, () => {}));
    await service.resolve(`watched-${n}`);
  }
  expect(service.cachedServices).toBe(300); // Watched names are never evicted.
  for (const stop of stops) stop();
  // A failing empty-only name is kept while others can go.
  await service.resolve('bad');
  provider.failWith(new Error('down'));
  await service.resolve('bad'); // Starts the refresh that fails.
  await flush();
  expect(service.degraded).toBe(true);
  provider.failWith(null);
  await service.resolve('fresh-0');
  expect(service.cachedServices).toBe(256);
  for (let n = 1; n < 200; n++) await service.resolve(`fresh-${n}`);
  expect(service.cachedServices).toBe(256);
  expect(service.degraded).toBe(true);
  service.close();
});

it('drops an evicted name retry spacing and reporter with its cache entry', async () => {
  const runtime = createFakeRuntime();
  const provider = createFakeProvider();
  const reset = vi.spyOn(RefreshBackoff.prototype, 'reset');
  const service = new ServiceDiscoveryService(
    provider,
    runtime,
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
  );
  for (let n = 0; n < 257; n++) {
    await service.resolve(`name-${n}`);
    provider.failWith(new Error('down'));
    await service.resolve(`name-${n}`); // Its background refresh fails: failing, spaced.
    await flush();
    provider.failWith(null);
    // name-0 never succeeds again, so any later reset of it is the eviction's.
    if (n === 0) reset.mockClear();
  }
  // Every cached name is failing, so the oldest failing one went: name-0.
  expect(service.cachedServices).toBe(256);
  expect(reset.mock.calls.some(([name]) => name === 'name-0')).toBe(true);
  reset.mockRestore();
  service.close();
});

it('tells the reporter factory whether a failing name is warm', async () => {
  const provider = createFakeProvider([a]);
  const seen: [string, boolean][] = [];
  const service = new ServiceDiscoveryService(
    provider,
    createFakeRuntime(),
    resolveOptions({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
    undefined,
    (name, warm) => {
      seen.push([name, warm]);
      return createConnectionErrorReporter({ source: name, logger: () => undefined });
    },
  );
  await service.resolve('known');
  provider.failWith(new Error('down'));
  await expect(service.resolve('never')).rejects.toThrow();
  await service.resolve('known'); // Background refresh fails for a warm name.
  await flush();
  expect(seen).toEqual([
    ['never', false],
    ['known', true],
  ]);
  service.close();
});
