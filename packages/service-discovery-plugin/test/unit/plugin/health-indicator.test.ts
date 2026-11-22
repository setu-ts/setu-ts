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
import { describe, expect, it } from 'vitest';
import type { HealthCheckResult, ServiceInstance } from '@setu-ts/common';
import { ServiceDiscoveryPlugin } from '../../../src/index.ts';
import type { DiscoveryProvider } from '../../../src/index.ts';
import { createFakeRuntime, instance } from '../../fixtures/fakes.ts';
import { RecordingLogger } from '../../../../common/test/fixtures/redis-connection-errors.ts';

it('logs isolated listener failures once with the service name and masked error, without instance data', async () => {
  const provider = {
    ...makeProvider().provider,
    resolve: () => Promise.resolve([instance({ id: 'private-instance', host: 'private-host' })]),
  };
  const logger = new RecordingLogger();
  let discovery!: {
    watch(name: string, listener: () => void): Promise<() => void>;
    resolve(name: string): Promise<unknown>;
  };
  const ctx = {
    runtime: createFakeRuntime(),
    logger,
    services: {
      register: (_name: string, value: typeof discovery) => {
        discovery = value;
      },
    },
    health: { register() {} },
    lifecycle: { onClose() {} },
  } as never;
  ServiceDiscoveryPlugin({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }).register(ctx);
  await discovery.watch('billing', () => {
    throw new Error('listener failed http://user:password@host/path');
  });
  await discovery.resolve('billing');
  await discovery.watch('billing', () => {});
  expect(logger.entries).toHaveLength(1);
  expect(logger.entries[0]?.level).toBe('warn');
  expect(logger.entries[0]?.metadata?.['serviceName']).toBe('billing');
  const rendered = JSON.stringify(logger.entries);
  expect(rendered).toContain('listener failed');
  expect(rendered).not.toContain('password');
  expect(rendered).not.toContain('private-instance');
  expect(rendered).not.toContain('private-host');
});

it('reports DNS failures and abandoned reads down, and warm failures up with a growing stale age', async () => {
  for (const hung of [false, true]) {
    for (const warm of [false, true]) {
      let fail = !warm;
      const error = new Error('resolver unreachable');
      const runtime = createFakeRuntime({
        dns: {
          resolveHost: () =>
            fail
              ? hung
                ? new Promise<never>(() => {})
                : Promise.reject(error)
              : Promise.resolve(['10.0.0.1']),
          resolveSrv: () => Promise.resolve([]),
        },
      });
      let check!: () => Promise<HealthCheckResult>;
      let service!: { resolve(name: string): Promise<unknown> };
      const ctx = {
        runtime,
        services: {
          register: (_name: string, value: typeof service) => {
            service = value;
          },
        },
        health: {
          register: (_name: string, fn: typeof check) => {
            check = fn;
          },
        },
        lifecycle: { onClose() {} },
      } as never;
      ServiceDiscoveryPlugin({
        provider: 'dns',
        mode: 'a',
        port: 80,
        cacheTtlMs: 0,
        resolveTimeoutMs: 50,
      }).register(ctx);
      if (warm) await service.resolve('billing');
      fail = true;
      const call = service.resolve('billing').catch(() => {});
      for (let n = 0; n < 30; n++) await Promise.resolve();
      runtime.advance(50);
      runtime.runTimeouts();
      await call;
      for (let n = 0; n < 30; n++) await Promise.resolve();
      const result = await check();
      expect(result).toMatchObject({
        status: warm ? 'up' : 'down',
        data: { reachable: false, degraded: warm, staleForMs: warm ? 50 : 0 },
      });
    }
  }
});

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

  it('reports up when reachable but the last refresh failed with a warm cache', async () => {
    const { provider, setFailing } = makeProvider();
    const { check, resolve } = registerIndicator(provider);
    await resolve(); // warm the cache
    setFailing(true);
    await resolve(); // refresh fails, stale served

    const result = await check();
    expect(result.status).toBe('up');
    const data = result.data as { degraded: boolean; everResolved: boolean };
    expect(data.degraded).toBe(true);
    expect(data.everResolved).toBe(true);
  });

  it('reports up when warm but the backend just went unreachable', async () => {
    const { provider, setReachable } = makeProvider();
    const { check, resolve } = registerIndicator(provider);
    await resolve();
    setReachable(false);

    const result = await check();
    expect(result.status).toBe('up');
    const data = result.data as { reachable: boolean; everResolved: boolean };
    expect(data.reachable).toBe(false);
    expect(data.everResolved).toBe(true);
  });
});

it('keeps a warm name outage at warn after cold names spend the shared warning budget', async () => {
  let down = false;
  const provider = {
    ...makeProvider().provider,
    resolve: (name: string) =>
      down || name.startsWith('cold-')
        ? Promise.reject(new Error(`no ${name}`))
        : Promise.resolve([instance({ id: name })]),
  };
  const logger = new RecordingLogger();
  let discovery!: { resolve(name: string): Promise<unknown> };
  const ctx = {
    runtime: createFakeRuntime(),
    logger,
    services: {
      register: (_name: string, value: typeof discovery) => {
        discovery = value;
      },
    },
    health: { register() {} },
    lifecycle: { onClose() {} },
  } as never;
  ServiceDiscoveryPlugin({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }).register(ctx);
  await discovery.resolve('payments');
  for (let n = 0; n < 30; n++) await discovery.resolve(`cold-${n}`).catch(() => {});
  const coldWarns = logger.entries.filter((entry) => entry.level === 'warn').length;
  expect(coldWarns).toBe(21); // 20 plus the one notice; the rest went to debug.
  down = true;
  await discovery.resolve('payments'); // Background refresh of a warm name fails.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const last = logger.entries.at(-1);
  expect(last?.level).toBe('warn');
  expect(last?.message).toContain("resolve 'payments'");
});
