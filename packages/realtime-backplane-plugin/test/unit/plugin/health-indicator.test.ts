import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, IPluginContext, IRealtimeBackplane } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { RealtimeBackplanePlugin } from '../../../src/plugin/realtime-backplane-plugin.ts';

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly health: Map<string, () => Promise<HealthCheckResult>>;
}

function createContext(): Harness {
  const registered = new Map<string, unknown>();
  const health = new Map<string, () => Promise<HealthCheckResult>>();
  const ctx = {
    runtime: { uuid: (): string => 'fixed-origin' },
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => registered.get(token) as T,
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (name: string, check: () => Promise<HealthCheckResult>): void => {
        health.set(name, check);
      },
    },
    lifecycle: { onClose: (): void => {} },
  } as unknown as IPluginContext;
  return { ctx, registered, health };
}

function customInstance(isHealthy?: () => Promise<boolean>): IRealtimeBackplane {
  const instance: Record<string, unknown> = {
    origin: 'custom-origin',
    connect: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve(() => {}),
    close: () => Promise.resolve(),
  };
  if (isHealthy !== undefined) {
    instance.isHealthy = isHealthy;
  }
  return instance as unknown as IRealtimeBackplane;
}

describe('RealtimeBackplanePlugin health indicator (M70c)', () => {
  it('reports degraded — never down — when the transport is unreachable', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({
      transport: 'custom',
      instance: customInstance(() => Promise.resolve(false)),
    }).register(harness.ctx);

    const indicator = harness.health.get('realtime-backplane');
    const result = await indicator?.();
    // Local delivery still works, so /ready keeps serving: degraded, not down.
    expect(result?.status).toBe('degraded');
    expect(result?.data).toEqual({
      transport: 'custom',
      origin: 'custom-origin',
      reachable: false,
    });
  });

  it('reports up with reachable true when the transport is healthy', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({
      transport: 'custom',
      instance: customInstance(() => Promise.resolve(true)),
    }).register(harness.ctx);

    const indicator = harness.health.get('realtime-backplane');
    const result = await indicator?.();
    expect(result?.status).toBe('up');
    expect(result?.data).toEqual({
      transport: 'custom',
      origin: 'custom-origin',
      reachable: true,
    });
  });

  it('reports up with reachable unknown when the transport cannot probe', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({
      transport: 'custom',
      instance: customInstance(),
    }).register(harness.ctx);

    const indicator = harness.health.get('realtime-backplane');
    const result = await indicator?.();
    expect(result?.status).toBe('up');
    expect(result?.data).toEqual({
      transport: 'custom',
      origin: 'custom-origin',
      reachable: 'unknown',
    });
  });

  it('preserves transport and origin in data on the memory arm', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({ transport: 'memory', bus: 'health-unit' }).register(
      harness.ctx,
    );
    const indicator = harness.health.get('realtime-backplane');
    const result = await indicator?.();
    expect(result?.status).toBe('up');
    expect(result?.data).toEqual({
      transport: 'memory',
      origin: 'fixed-origin',
      reachable: true,
    });
    const backplane = harness.registered.get(CAPABILITIES.REALTIME_BACKPLANE) as IRealtimeBackplane;
    expect(backplane.origin).toBe('fixed-origin');
  });
});
