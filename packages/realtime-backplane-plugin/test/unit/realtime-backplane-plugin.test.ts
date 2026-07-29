/**
 * Tests for the plugin factory's declared surface and health indicator.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IPluginContext,
  IRealtimeBackplane,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import { RealtimeBackplanePlugin } from '../../src/plugin/realtime-backplane-plugin.ts';

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly health: Map<string, () => Promise<HealthCheckResult>>;
  readonly closeHooks: Array<() => void | Promise<void>>;
}

function createContext(): Harness {
  const registered = new Map<string, unknown>();
  const health = new Map<string, () => Promise<HealthCheckResult>>();
  const closeHooks: Array<() => void | Promise<void>> = [];
  let counter = 0;

  const ctx = {
    runtime: {
      // Honors the real contract: a fresh identifier per call, never a constant.
      uuid: (): string => `uuid-${++counter}`,
    },
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
    lifecycle: {
      onClose: (hook: () => void | Promise<void>): void => {
        closeHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, health, closeHooks };
}

describe('RealtimeBackplanePlugin', () => {
  it('declares its identity, capability, and priority', () => {
    const plugin = RealtimeBackplanePlugin();
    expect(plugin.name).toBe('realtime-backplane-plugin');
    expect(plugin.provides).toEqual([CAPABILITIES.REALTIME_BACKPLANE]);
    // Above normal, so the transport is connected before the WebSocket and SSE
    // plugins register and subscribe.
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.HIGH);
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.MESSAGING]);
  });

  it('defaults to the memory transport when called with no options', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin().register(harness.ctx);

    const backplane = harness.registered.get(
      CAPABILITIES.REALTIME_BACKPLANE,
    ) as IRealtimeBackplane;
    expect(backplane).toBeDefined();
    expect(backplane.origin).toBe('uuid-1');
  });

  it('reports the transport and origin through its health indicator', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({ transport: 'memory', bus: 'unit-1' }).register(harness.ctx);

    const indicator = harness.health.get('realtime-backplane');
    expect(indicator).toBeDefined();
    expect(await indicator?.()).toEqual({
      status: 'up',
      data: { transport: 'memory', origin: 'uuid-1' },
    });
  });

  it('reports a configured transport name in the indicator', async () => {
    const harness = createContext();
    const instance: IRealtimeBackplane = {
      origin: 'custom-origin',
      connect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(() => {}),
      close: () => Promise.resolve(),
    };
    await RealtimeBackplanePlugin({ transport: 'custom', instance }).register(harness.ctx);

    const indicator = harness.health.get('realtime-backplane');
    expect(await indicator?.()).toEqual({
      status: 'up',
      data: { transport: 'custom', origin: 'custom-origin' },
    });
  });

  it('closes the transport through its onClose hook', async () => {
    const harness = createContext();
    let closed = false;
    const instance: IRealtimeBackplane = {
      origin: 'custom-origin',
      connect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(() => {}),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    await RealtimeBackplanePlugin({ transport: 'custom', instance }).register(harness.ctx);

    expect(harness.closeHooks.length).toBe(1);
    await harness.closeHooks[0]?.();
    expect(closed).toBe(true);
  });

  it('propagates a factory failure out of register', async () => {
    const harness = createContext();
    const plugin = RealtimeBackplanePlugin({ transport: 'messaging' });
    await expect(plugin.register(harness.ctx)).rejects.toThrow(/requires a plugin providing/);
  });
});

describe('RealtimeBackplanePlugin transport naming', () => {
  it('reports memory in the indicator when options omit the transport entirely', async () => {
    const harness = createContext();
    // The `options.transport ?? 'memory'` branch: an options object with no
    // discriminant at all, distinct from calling the factory with no argument.
    await RealtimeBackplanePlugin({ bus: 'unit-2' }).register(harness.ctx);

    const indicator = harness.health.get('realtime-backplane');
    expect(await indicator?.()).toEqual({
      status: 'up',
      data: { transport: 'memory', origin: 'uuid-1' },
    });
  });
});
