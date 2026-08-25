/**
 * M70n X3-4 — the process-local transport notice.
 *
 * A `'memory'` backplane is a real single-process transport: frames never
 * cross a process boundary, so behind more than one replica its fan-out looks
 * like partial delivery rather than an error. The plugin that knows its
 * transport is the one that reports it — once, at `register()`, suppressible
 * with `localNotice: false` (matching the SSE/WebSocket `scalingNotice`
 * opt-out shape). Non-memory transports fan out already and stay silent.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, IPluginContext, IRealtimeBackplane } from '@setu-ts/common';
import { RealtimeBackplanePlugin } from '../../../src/plugin/realtime-backplane-plugin.ts';

interface Harness {
  readonly ctx: IPluginContext;
  readonly infoCalls: string[];
}

function createContext(): Harness {
  const registered = new Map<string, unknown>();
  const health = new Map<string, () => Promise<HealthCheckResult>>();
  const closeHooks: Array<() => void | Promise<void>> = [];
  const infoCalls: string[] = [];
  let counter = 0;

  const ctx = {
    runtime: {
      uuid: (): string => `uuid-${++counter}`,
    },
    logger: {
      info: (message: string): void => {
        infoCalls.push(message);
      },
      warn: (): void => {},
      error: (): void => {},
      debug: (): void => {},
      trace: (): void => {},
      fatal: (): void => {},
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

  return { ctx, infoCalls };
}

function makeCustomInstance(): IRealtimeBackplane {
  return {
    origin: 'custom-origin',
    connect: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve(() => {}),
    close: () => Promise.resolve(),
  };
}

describe('RealtimeBackplanePlugin memory-transport notice', () => {
  it('logs the notice exactly once for a bare registration', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin().register(harness.ctx);

    expect(harness.infoCalls.length).toBe(1);
    expect(harness.infoCalls[0]).toContain("'memory'");
  });

  it('logs the notice for an explicit memory transport', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({ transport: 'memory' }).register(harness.ctx);

    expect(harness.infoCalls.length).toBe(1);
    expect(harness.infoCalls[0]).toContain('redis');
  });

  it('logs the notice when the options object omits the discriminant', async () => {
    // Distinct from a bare call: an options object whose `transport` is
    // undefined still resolves to 'memory' (the health-indicator arm).
    const harness = createContext();
    await RealtimeBackplanePlugin({ bus: 'notice-unit' }).register(harness.ctx);

    expect(harness.infoCalls.length).toBe(1);
    expect(harness.infoCalls[0]).toContain("'memory'");
  });

  it('suppresses the notice with localNotice: false', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({
      transport: 'memory',
      localNotice: false,
    }).register(harness.ctx);

    expect(harness.infoCalls).toEqual([]);
  });

  it('does not log the notice for a non-memory transport', async () => {
    const harness = createContext();
    await RealtimeBackplanePlugin({
      transport: 'custom',
      instance: makeCustomInstance(),
    }).register(harness.ctx);

    expect(harness.infoCalls).toEqual([]);
  });
});
