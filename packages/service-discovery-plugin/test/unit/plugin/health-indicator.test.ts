/**
 * M70c health-indicator tests — the X10-3 case.
 *
 * The old source comment claimed `down` was "unreachable by construction".
 * Its premise was false: `#degraded` is only ever set *after* a prior success,
 * so a provider that never reached its backend reported `up` forever. These
 * tests drive the real plugin indicator through a `custom` provider and
 * assert the corrected mapping.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, ServiceInstance } from '@setu-ts/common';
import { ServiceDiscoveryPlugin } from '../../../src/index.ts';
import type { DiscoveryProvider } from '../../../src/index.ts';
import { createFakeRuntime, instance } from '../../fixtures/fakes.ts';

/** A provider whose answers and reachability the test controls. */
function makeProvider() {
  let reachable = true;
  let failing = false;
  const provider: DiscoveryProvider = {
    kind: 'fake',
    resolve(_name: string): Promise<readonly ServiceInstance[]> {
      return failing
        ? Promise.reject(new Error('backend unreachable'))
        : Promise.resolve([instance({ id: 'a' })]);
    },
    watch: () => Promise.resolve(() => {}),
    isHealthy: () => Promise.resolve(reachable),
  };
  return {
    provider,
    setReachable(v: boolean): void {
      reachable = v;
    },
    setFailing(v: boolean): void {
      failing = v;
    },
  };
}

interface Registered {
  check: () => Promise<HealthCheckResult>;
  resolve: () => Promise<readonly ServiceInstance[]>;
}

/** Registers the plugin against a minimal context and captures the indicator. */
function registerIndicator(provider: DiscoveryProvider): Registered {
  let indicator: (() => Promise<HealthCheckResult>) | undefined;
  let service: unknown;
  const ctx = {
    runtime: createFakeRuntime(),
    services: {
      register: (_name: string, value: unknown): void => {
        service = value;
      },
    },
    health: {
      register: (_name: string, fn: () => Promise<HealthCheckResult>): void => {
        indicator = fn;
      },
    },
    lifecycle: { onBootstrap: () => {}, onStopping: () => {}, onClose: () => {} },
  } as never;

  ServiceDiscoveryPlugin({
    provider: 'custom',
    discovery: provider,
    cacheTtlMs: 0,
  }).register(ctx);

  if (indicator === undefined) {
    throw new Error('no indicator registered');
  }
  const captured = indicator;
  const svc = service as { resolve: (n: string) => Promise<readonly ServiceInstance[]> };
  return { check: () => captured(), resolve: () => svc.resolve('billing') };
}

describe('ServiceDiscoveryPlugin — health indicator (M70c)', () => {
  it('reports down, not up, when the provider has never resolved and is unreachable (X10-3)', async () => {
    const { provider, setFailing, setReachable } = makeProvider();
    setFailing(true);
    setReachable(false);
    const { check, resolve } = registerIndicator(provider);
    await expect(resolve()).rejects.toThrow();

    const result = await check();
    expect(result.status).toBe('down');
    const data = result.data as { everResolved: boolean; reachable: boolean };
    expect(data.everResolved).toBe(false);
    expect(data.reachable).toBe(false);
  });

  it('reports up once the provider has resolved and is reachable', async () => {
    const { provider } = makeProvider();
    const { check, resolve } = registerIndicator(provider);
    await resolve();

    const result = await check();
    expect(result.status).toBe('up');
    const data = result.data as { everResolved: boolean; reachable: boolean };
    expect(data.everResolved).toBe(true);
    expect(data.reachable).toBe(true);
  });

  it('reports degraded when reachable but the last refresh failed with a warm cache', async () => {
    const { provider, setFailing } = makeProvider();
    const { check, resolve } = registerIndicator(provider);
    await resolve(); // warm the cache
    setFailing(true);
    await resolve(); // refresh fails, stale served

    const result = await check();
    expect(result.status).toBe('degraded');
    const data = result.data as { degraded: boolean; everResolved: boolean };
    expect(data.degraded).toBe(true);
    expect(data.everResolved).toBe(true);
  });

  it('reports degraded when warm but the backend just went unreachable', async () => {
    const { provider, setReachable } = makeProvider();
    const { check, resolve } = registerIndicator(provider);
    await resolve();
    setReachable(false);

    const result = await check();
    expect(result.status).toBe('degraded');
    const data = result.data as { reachable: boolean; everResolved: boolean };
    expect(data.reachable).toBe(false);
    expect(data.everResolved).toBe(true);
  });
});
