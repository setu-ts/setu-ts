/**
 * HealthPlugin factory-arm tests: instances register during `register()`,
 * factories are resolved at `onInit` (before the contribution drain), a
 * duplicate name throws naming the application entry, and a throwing factory
 * rejects `start()`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { HealthPlugin } from '../../src/plugin/health-plugin.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IHealthIndicator,
  IHealthService,
  IPluginContext,
  IRuntimeServices,
  IServiceRegistry,
  RuntimePlatform,
} from '@setu-ts/common';

function makeContext(): {
  ctx: IPluginContext;
  services: Map<string, unknown>;
  multi: Map<string, unknown[]>;
  onInit: (() => void)[];
} {
  const services = new Map<string, unknown>();
  const multi = new Map<string, unknown[]>();
  const onInit: (() => void)[] = [];
  const fakeRuntime = {
    now: () => 1_000_000_000_000,
    hrtime: () => 0,
    platform: () => 'node' as RuntimePlatform,
    version: () => '18.0.0',
    hostname: () => 'test-host',
    uuid: () => '00000000-0000-0000-0000-000000000000',
    randomBytes: () => new Uint8Array(32),
    subtle: {} as Crypto['subtle'],
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    env: {} as Record<string, string | undefined>,
    exit: (() => {
      throw new Error('exit called');
    }) as () => never,
    fs: {} as IRuntimeServices['fs'],
  } as unknown as IRuntimeServices;

  // The generic `get`/`getAll` cannot be implemented by a non-generic closure
  // without a cast, so the fake registry is cast — the same pattern the committed
  // `health-plugin.test.ts` uses. `getAll` must return real data (the drain reads
  // it), so an empty-array or throwing implementation would not do.
  const registry = {
    register: (token: string, service: unknown) => {
      services.set(token, service);
    },
    registerFactory: () => {},
    get: (token: string) => {
      const found = services.get(token);
      if (found === undefined) throw new Error(`no service for ${token}`);
      return found;
    },
    getAll: (token: string) => multi.get(token) ?? [],
    has: (token: string) => services.has(token),
    unregister: () => false,
  } as IServiceRegistry;

  const ctx: IPluginContext = {
    services: registry,
    runtime: fakeRuntime,
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    lifecycle: {
      onRegister: () => {},
      onInit: (handler: () => void) => {
        onInit.push(handler);
      },
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onStopping: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as IPluginContext['app'],
  };
  return { ctx, services, multi, onInit };
}

function indicator(name: string): IHealthIndicator {
  return { name, check: () => Promise.resolve({ status: 'up' as const }) };
}

describe('HealthPlugin factory arm', () => {
  it('registers an instance indicator during register()', async () => {
    const { ctx, services } = makeContext();
    const appIndicator = indicator('app-db');
    await HealthPlugin({ indicators: [appIndicator] }).register!(ctx);
    const service = services.get(CAPABILITIES.HEALTH) as IHealthService;
    const report = await service.check();
    expect(report.checks['app-db']).toBeDefined();
  });

  it('does not call a factory during register(), and calls it once at onInit', async () => {
    const { ctx, services, onInit } = makeContext();
    let calls = 0;
    const registrySeen: unknown[] = [];
    // Capture the registry the factory is handed, by identity.
    const capturing = (registry: unknown): IHealthIndicator => {
      registrySeen.push(registry);
      calls += 1;
      return indicator('factory-db');
    };
    await HealthPlugin({ indicators: [capturing] }).register!(ctx);
    expect(calls).toBe(0);

    for (const hook of onInit) hook();
    expect(calls).toBe(1);

    const service = services.get(CAPABILITIES.HEALTH) as IHealthService;
    const report = await service.check();
    expect(report.checks['factory-db']).toBeDefined();
    // The factory received the plugin's own registry.
    expect(registrySeen[0]).toBe(ctx.services);
  });

  it('a duplicate name throws, naming the application entry', async () => {
    const { ctx, multi, onInit } = makeContext();
    const factory = (): IHealthIndicator => indicator('dup');
    await HealthPlugin({ indicators: [factory] }).register!(ctx);
    // A contribution with the same name arrives after the factory has
    // registered it, so the drain reports the application entry's name.
    multi.set(CAPABILITIES.HEALTH_INDICATOR, [
      { name: 'dup', check: () => Promise.resolve({ status: 'up' as const }) },
    ]);
    expect(() => {
      for (const hook of onInit) hook();
    }).toThrow('dup');
  });

  it('a throwing factory rejects, naming the option and entry', async () => {
    const { ctx, onInit } = makeContext();
    const boom = new Error('capability missing');
    const factory = (): IHealthIndicator => {
      throw boom;
    };
    await HealthPlugin({ indicators: [factory] }).register!(ctx);
    expect(() => {
      for (const hook of onInit) hook();
    }).toThrow('HealthPlugin({ indicators })[0]');
  });
});
