/**
 * Unit tests for the plugin factory and lifecycle (plan §3.14).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IIdempotencyService,
  ILogger,
  IPluginContext,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { IdempotencyConfigurationError } from '../../src/errors.ts';
import { IdempotencyPlugin } from '../../src/plugin/idempotency-plugin.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A fake plugin context recording registration. */
function fakeContext(options: { failHealth?: boolean } = {}) {
  const registered = new Map<string, unknown>();
  const indicators = new Map<string, () => Promise<HealthCheckResult>>();
  let close: (() => Promise<void> | void) | undefined;
  const ctx = {
    runtime: createClockRuntime(),
    logger: undefined,
    services: {
      register: (token: string, service: unknown): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (name: string, fn: () => Promise<HealthCheckResult>): void => {
        if (options.failHealth) throw new Error('health registration failed');
        indicators.set(name, fn);
      },
    },
    lifecycle: {
      onClose: (fn: () => Promise<void> | void): void => {
        close = fn;
      },
    },
  } as unknown as IPluginContext;
  return {
    ctx,
    registered,
    indicators,
    close: async (): Promise<void> => {
      await close?.();
    },
  };
}

describe('IdempotencyPlugin (M109a §3.14)', () => {
  it('declares its name, version and capability', () => {
    const plugin = IdempotencyPlugin();
    expect(plugin.name).toBe('idempotency-plugin');
    expect(plugin.version).toBe('0.8.0');
    expect(plugin.provides).toEqual([CAPABILITIES.IDEMPOTENCY]);
  });

  it('registers the service and the indicator, and reports down after close', async () => {
    const { ctx, registered, indicators, close } = fakeContext();
    await IdempotencyPlugin().register(ctx);
    expect(registered.get(CAPABILITIES.IDEMPOTENCY)).toBeDefined();
    const indicator = indicators.get('idempotency');
    expect(indicator).toBeDefined();
    if (indicator === undefined) throw new Error('fixture error: no indicator');
    expect((await indicator()).status).toBe('up');
    await close();
    expect((await indicator()).status).toBe('down');
  });

  it('validates plugin options at the factory', () => {
    expect(() => IdempotencyPlugin({ leaseMs: 0 })).toThrow(IdempotencyConfigurationError);
  });

  it('registers the close hook right after connect, so a store still disconnects when the indicator registration throws', async () => {
    let disconnected = false;
    const store = {
      name: 'custom',
      connect: () => Promise.resolve(),
      disconnect: () => {
        disconnected = true;
        return Promise.resolve();
      },
      claim: () => Promise.resolve({ outcome: 'claimed' as const, takeover: false }),
      complete: () => Promise.resolve('settled' as const),
      release: () => Promise.resolve('lost' as const),
    };
    const { ctx, close } = fakeContext({ failHealth: true });
    await expect(IdempotencyPlugin({ store: { type: 'custom', store } }).register(ctx)).rejects
      .toThrow(
        'health registration failed',
      );
    await close();
    expect(disconnected).toBe(true);
  });

  it('registers a service that builds a middleware and a behavior', async () => {
    const { ctx, registered } = fakeContext();
    await IdempotencyPlugin().register(ctx);
    const service = registered.get(CAPABILITIES.IDEMPOTENCY) as IIdempotencyService;
    expect(typeof service.middleware()).toBe('function');
    expect(typeof service.behavior({ topics: ['t'] }).handle).toBe('function');
  });

  it('reads the logger thunk through the plugin context when a Redis store reports an evicting policy', async () => {
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
    } as unknown as ILogger;
    const { ctx, registered } = fakeContext();
    (ctx as unknown as { logger: ILogger }).logger = logger;
    const client = {
      eval: () => Promise.resolve('settled'),
      ping: () => Promise.resolve('PONG'),
      quit: () => Promise.resolve('OK'),
      call: () => Promise.resolve(['maxmemory-policy', 'allkeys-lru']),
    };
    await IdempotencyPlugin({ store: { type: 'redis', namespace: 'ok', client } }).register(ctx);
    expect(warnings).toHaveLength(1);
    expect(registered.get(CAPABILITIES.IDEMPOTENCY)).toBeDefined();
  });
});
