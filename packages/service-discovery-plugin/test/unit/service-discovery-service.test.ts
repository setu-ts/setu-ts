/**
 * Unit tests for the discovery service — cache, coalescing, stale-on-failure,
 * and the two entry points that must honour one configuration.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ServiceDiscoveryService } from '../../src/services/service-discovery-service.ts';
import { resolveOptions, type ServiceDiscoveryPluginOptions } from '../../src/options.ts';
import { DiscoveryUnavailableError } from '../../src/errors.ts';
import {
  createFakeProvider,
  createFakeRuntime,
  type FakeProvider,
  type FakeRuntime,
  instance,
} from '../fixtures/fakes.ts';

const a = instance({ id: 'a', host: '10.0.0.1' });
const b = instance({ id: 'b', host: '10.0.0.2' });

function setup(
  options: Partial<ServiceDiscoveryPluginOptions> = {},
  instances: readonly typeof a[] = [a, b],
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
    expect(provider.resolveCalls).toBe(3);
  });

  it('coalesces concurrent reads of a cold service into one provider call', async () => {
    const { service, provider } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.resolve('billing')),
    );
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
    expect(service.degraded).toBe(true);
  });

  it('clears degraded once a refresh succeeds again', async () => {
    const { service, provider, runtime } = setup({ cacheTtlMs: 1_000 });
    await service.resolve('billing');
    provider.failWith(new Error('down'));
    runtime.advance(1_001);
    await service.resolve('billing');
    expect(service.degraded).toBe(true);

    provider.failWith(null);
    runtime.advance(1_001);
    await service.resolve('billing');
    expect(service.degraded).toBe(false);
  });

  it('throws DiscoveryUnavailableError carrying the cause on a cold failure', async () => {
    const { service, provider } = setup();
    const cause = new Error('connection refused');
    provider.failWith(cause);

    await expect(service.resolve('billing')).rejects.toThrow(DiscoveryUnavailableError);
    try {
      await service.resolve('billing');
    } catch (error) {
      expect((error as Error).cause).toBe(cause);
      expect((error as Error).message).toContain('billing');
    }
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
