/**
 * Unit tests for the plugin factory: capability registration, the
 * post-M70a pipeline-first behavior (no setRpcHandler call), the health
 * indicator, and teardown.
 *
 * After M70a, GrpcPlugin no longer calls adapter.setRpcHandler. gRPC
 * dispatch is handled by the kernel terminal handler after the middleware
 * pipeline runs. The plugin simply registers IGrpcService under
 * CAPABILITIES.GRPC.
 */

import { describe, expect, it } from 'vitest';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import {
  createFakeConnectRuntime,
  type FakeConnectRuntime,
  fakeFile,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type {
  HealthIndicatorFn,
  IGrpcService,
  IHealthService,
  IPluginContext,
} from '@setu-ts/common';

const HEALTH = 'grpc.health.v1.Health';
const REFLECTION = 'grpc.reflection.v1.ServerReflection';

function runtimeWith(): FakeConnectRuntime {
  return createFakeConnectRuntime({
    services: [
      fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
      fakeService(REFLECTION, ['ServerReflectionInfo'], fakeFile('grpc/reflection/v1/r.proto')),
    ],
  });
}

/** What the fake plugin context recorded. */
interface Harness {
  ctx: IPluginContext;
  registered: Map<string, unknown>;
  indicators: Map<string, HealthIndicatorFn>;
  closeHooks: Array<() => void | Promise<void>>;
  warnings: string[];
}

function createHarness(
  options: { healthService?: IHealthService; logger?: boolean } = {},
): Harness {
  const registered = new Map<string, unknown>();
  const indicators = new Map<string, HealthIndicatorFn>();
  const closeHooks: Array<() => void | Promise<void>> = [];
  const warnings: string[] = [];

  const ctx = {
    services: {
      get(token: string) {
        if (token === CAPABILITIES.HEALTH) {
          if (options.healthService === undefined) {
            throw new Error(`Service not registered: ${token}`);
          }
          return options.healthService;
        }
        const found = registered.get(token);
        if (found === undefined) throw new Error(`Service not registered: ${token}`);
        return found;
      },
      register(token: string, service: unknown) {
        registered.set(token, service);
      },
    },
    health: {
      register(name: string, indicator: HealthIndicatorFn) {
        indicators.set(name, indicator);
      },
    },
    lifecycle: {
      onClose(hook: () => void | Promise<void>) {
        closeHooks.push(hook);
      },
    },
    logger:
      options.logger === false
        ? undefined
        : {
            warn: (message: string) => warnings.push(message),
            info: () => {},
            error: () => {},
            debug: () => {},
          },
  } as unknown as IPluginContext;

  return { ctx, registered, indicators, closeHooks, warnings };
}

describe('GrpcPlugin — descriptor', () => {
  it('declares its name, capability, optional dependencies and priority', () => {
    const plugin = GrpcPlugin();
    expect(plugin.name).toBe('grpc-plugin');
    expect(plugin.provides).toEqual([CAPABILITIES.GRPC]);
    expect(plugin.optionalDependencies).toEqual([
      'logger',
      CAPABILITIES.HEALTH,
      CAPABILITIES.SERVICE_DISCOVERY,
      CAPABILITIES.TELEMETRY,
    ]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });
});

describe('GrpcPlugin — registration (post-M70a)', () => {
  it('registers the service under CAPABILITIES.GRPC', async () => {
    const harness = createHarness();
    await GrpcPlugin({ connectModule: runtimeWith() }).register?.(harness.ctx);

    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    expect(service).toBeDefined();
    expect(typeof service.addService).toBe('function');
    expect(service.available).toBe(true);
  });

  it('does NOT call adapter.setRpcHandler (M70a: kernel dispatches gRPC)', async () => {
    const harness = createHarness();
    await GrpcPlugin({ connectModule: runtimeWith() }).register?.(harness.ctx);

    // After M70a, the plugin no longer installs a fetch handler on the adapter.
    // The harness no longer tracks installedHandlers because the plugin never
    // calls setRpcHandler. The plugin simply registers IGrpcService.
    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    expect(service).toBeDefined();
    expect(service.available).toBe(true);
  });

  it('uses the injected connectModule instead of importing Connect', async () => {
    const runtime = runtimeWith();
    const harness = createHarness();
    await GrpcPlugin({ connectModule: runtime }).register?.(harness.ctx);

    // The router is built lazily, so drive one request first.
    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    await service.handleRequest(new Request('http://x/unknown'));

    // Proof the injected runtime is the one in use: it revived the embedded
    // sets and registered the built-ins on ITS router.
    expect(runtime.revived.length).toBe(2);
    expect(runtime.registered.map((r) => r.definition.typeName)).toEqual([HEALTH, REFLECTION]);
  });

  it('registers services passed through options', async () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const harness = createHarness();
    await GrpcPlugin({
      connectModule: runtimeWith(),
      services: [{ definition: echo, implementation: { echo: () => ({}) } }],
    }).register?.(harness.ctx);

    const indicator = harness.indicators.get('grpc')!;
    const result = await indicator();
    expect((result.data as { serviceCount: number }).serviceCount).toBe(1);
  });
});

describe('GrpcPlugin — health indicator', () => {
  it('reports available: true and the service count', async () => {
    const harness = createHarness();
    await GrpcPlugin({ connectModule: runtimeWith() }).register?.(harness.ctx);

    const result = await harness.indicators.get('grpc')!();
    expect(result.status).toBe('up');
    expect(result.data).toEqual({ available: true, serviceCount: 0 });
  });
});

describe('GrpcPlugin — health capability bridging', () => {
  it('registers without a health capability', async () => {
    const harness = createHarness();
    await GrpcPlugin({ connectModule: runtimeWith() }).register?.(harness.ctx);
    expect(harness.registered.has(CAPABILITIES.GRPC)).toBe(true);
  });

  it('resolves the health capability when one is registered', async () => {
    let checked = false;
    const healthService = {
      checkReady: () => {
        checked = true;
        return Promise.resolve({ status: 'up' });
      },
    } as unknown as IHealthService;

    const runtime = runtimeWith();
    const harness = createHarness({ healthService });
    await GrpcPlugin({ connectModule: runtime }).register?.(harness.ctx);

    // Drive Check through the registered implementation to prove the bridge is wired.
    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    await service.handleRequest(new Request('http://x/unknown'));
    const healthImpl = runtime.registered.find((r) => r.definition.typeName === HEALTH)!;
    const check = healthImpl.implementation.check as (r: {
      service: string;
    }) => Promise<{ status: number }>;

    expect((await check({ service: '' })).status).toBe(1);
    expect(checked).toBe(true);
  });
});

describe('GrpcPlugin — lifecycle', () => {
  it('registers a close hook', async () => {
    const harness = createHarness();
    await GrpcPlugin({ connectModule: runtimeWith() }).register?.(harness.ctx);
    expect(harness.closeHooks).toHaveLength(1);
  });
});

describe('GrpcPlugin — no logger capability', () => {
  it('registers cleanly with no logger capability', async () => {
    const harness = createHarness({ logger: false });
    await GrpcPlugin({ connectModule: runtimeWith() }).register?.(harness.ctx);
    expect(harness.registered.has(CAPABILITIES.GRPC)).toBe(true);
  });
});

describe('GrpcPlugin — calling side (M139b §3.12)', () => {
  it('serve: false claims nothing and serves no procedure, health or reflection', async () => {
    const harness = createHarness();
    const runtime = runtimeWith();
    await GrpcPlugin({ connectModule: runtime, serve: false, basePath: '/grpc' }).register?.(
      harness.ctx,
    );
    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    for (const path of [
      '/grpc',
      `/grpc/${HEALTH}/Check`,
      `/grpc/${REFLECTION}/ServerReflectionInfo`,
    ]) {
      expect(service.claims?.(new Request(`http://x${path}`, { method: 'POST' }))).toBe(false);
    }
    expect(service.streamsRequest?.(new Request(`http://x/grpc/${HEALTH}/Check`))).toBe(false);
    const reply = await service.handleRequest(
      new Request(`http://x/grpc/${HEALTH}/Check`, { method: 'POST' }),
    );
    expect(reply.status).toBe(404);
    expect(runtime.routerOptions).toHaveLength(0);
    expect(runtime.registered).toHaveLength(0);
  });

  it('serve defaults to true', async () => {
    const harness = createHarness();
    const runtime = runtimeWith();
    await GrpcPlugin({ connectModule: runtime, basePath: '/grpc' }).register?.(harness.ctx);
    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    expect(service.claims?.(new Request(`http://x/grpc/${HEALTH}/Check`, { method: 'POST' }))).toBe(
      true,
    );
    await service.handleRequest(new Request(`http://x/grpc/${HEALTH}/Check`, { method: 'POST' }));
    expect(runtime.routerOptions).toHaveLength(1);
  });

  it.each([
    [{ serve: 'no' }, 'GrpcPlugin: serve must be a boolean, received no'],
    [
      { serve: false, services: [{ definition: { typeName: 'a.B', method: {} } }] },
      'GrpcPlugin: serve: false serves nothing, so services must be empty',
    ],
    [
      { clients: { billing: { basePath: 'grpc' } } },
      'GrpcPlugin: clients["billing"]: basePath must be \'\' or start with \'/\' and not end with one, received "grpc"',
    ],
    // A URL key is named by its origin only, never its path.
    [
      { clients: { 'http://billing:3410/s3cret-path': { timeoutMs: 0 } } },
      'GrpcPlugin: clients["http://billing:3410"]: timeoutMs must be an integer from 1 to 2147483647, received 0',
    ],
    // A key is a target: refused the same way, unechoed.
    [
      { clients: { 'http://u:s3cret@billing': { timeoutMs: 0 } } },
      'grpc client: a target must not carry credentials (user:password@); send them as call headers',
    ],
    [
      { clients: { 'http://billing?token=s3cret': {} } },
      'grpc client: a target URL must not carry a query or fragment; Connect never sends them',
    ],
  ])('refuses %j at construction', (options, message) => {
    expect(() => GrpcPlugin(options as never)).toThrow(new TypeError(message));
  });

  it('resolves discovery when a client is made, and closes clients with the service', async () => {
    const registered = new Map<string, unknown>();
    const closeHooks: Array<() => void | Promise<void>> = [];
    const ctx = {
      services: {
        has: (token: string) => registered.has(token),
        get(token: string) {
          if (!registered.has(token)) throw new Error(`Service not registered: ${token}`);
          return registered.get(token);
        },
        register: (token: string, service: unknown) => registered.set(token, service),
      },
      health: { register: () => {} },
      lifecycle: { onClose: (hook: () => void) => closeHooks.push(hook) },
    } as unknown as IPluginContext;
    await GrpcPlugin({ connectModule: runtimeWith(), serve: false }).register?.(ctx);
    const service = registered.get(CAPABILITIES.GRPC) as IGrpcService;
    const definition = { typeName: 'billing.v1.BillingService', method: {} };
    expect(() => service.client?.(definition, 'billing')).toThrow(TypeError);
    registered.set(CAPABILITIES.SERVICE_DISCOVERY, { pick: () => Promise.resolve(null) });
    registered.set(CAPABILITIES.TELEMETRY, { withSpan: () => undefined });
    const client = service.client?.(definition, 'billing') as {
      transport: { unary(...args: unknown[]): Promise<unknown> };
    };
    await expect(client.transport.unary({}, undefined, undefined, undefined, {})).rejects.toThrow(
      'no instance of "billing" is available',
    );
    for (const hook of closeHooks) await hook();
    await expect(client.transport.unary({}, undefined, undefined, undefined, {})).rejects.toThrow(
      'the gRPC client is closed',
    );
  });

  it('a registry that throws on lookup reads as no discovery', async () => {
    const registered = new Map<string, unknown>();
    const ctx = {
      services: {
        has: () => {
          throw new Error('registry broke');
        },
        get: (token: string) => registered.get(token),
        register: (token: string, service: unknown) => registered.set(token, service),
      },
      health: { register: () => {} },
      lifecycle: { onClose: () => {} },
    } as unknown as IPluginContext;
    await GrpcPlugin({ connectModule: runtimeWith(), serve: false }).register?.(ctx);
    const service = registered.get(CAPABILITIES.GRPC) as IGrpcService;
    expect(() => service.client?.({ typeName: 'a.B', method: {} }, 'billing')).toThrow(
      'no service discovery is registered',
    );
  });
});
