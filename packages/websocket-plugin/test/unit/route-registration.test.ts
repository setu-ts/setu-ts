/**
 * Route registration arms (M86 §3.5) — `WebSocketPlugin({ routes })` and
 * `WebSocketPlugin({ behaviors })`, each accepting instances or
 * `RegistryFactory` entries, split once at construction with factories
 * resolved in `onInit` under the DECLARED-array index.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IHttpAdapter,
  IIngressBehavior,
  IngressContext,
  IPluginContext,
  IRequest,
  IResponse,
  IServiceRegistry,
  RegistryFactory,
  ServerHandle,
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/plugin/websocket-plugin.ts';
import { WebSocketService } from '../../src/services/websocket-service.ts';
import {
  createFakeRuntime,
  createFakeTransport,
  upgradeRequest,
} from '../fixtures/fake-runtime.ts';
// Declared against the BARREL, not the interfaces module: dropping the export
// from `src/index.ts` must fail this file's type-check (the M56 defect class).
import type { WebSocketPluginOptions, WebSocketRouteDefinition } from '../../src/index.ts';

/** An adapter that records the router installed on it. */
function createUpgradableAdapter(): IHttpAdapter & { router: WebSocketUpgradeRouter | null } {
  return {
    router: null,
    setHandler(_handler: (request: IRequest) => Promise<IResponse>): void {},
    setUpgradeRouter(router: WebSocketUpgradeRouter): void {
      this.router = router;
    },
    fetch: () => Promise.resolve(new Response(null)),
    listen: () => Promise.resolve({} as ServerHandle),
    close: () => Promise.resolve(),
  };
}

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly adapter: IHttpAdapter & { router: WebSocketUpgradeRouter | null };
  /** The `onInit` hooks the plugin registered, in registration order. */
  readonly initHooks: (() => void | Promise<void>)[];
}

function createHarness(): Harness {
  const registered = new Map<string, unknown>();
  const initHooks: (() => void | Promise<void>)[] = [];
  const runtime = createFakeRuntime();
  const adapter = createUpgradableAdapter();

  const ctx = {
    runtime,
    services: {
      has: (token: string): boolean => token === CAPABILITIES.HTTP_ADAPTER || registered.has(token),
      get: <T>(token: string): T => {
        if (token === CAPABILITIES.HTTP_ADAPTER) {
          return adapter as unknown as T;
        }
        const found = registered.get(token);
        if (found === undefined) {
          throw new Error(`no service for ${token}`);
        }
        return found as T;
      },
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: {
      register: (_name: string, _check: () => Promise<HealthCheckResult>): void => {},
    },
    lifecycle: {
      onClose: (_hook: () => void): void => {},
      onInit: (hook: () => void | Promise<void>): void => {
        initHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, adapter, initHooks };
}

interface Boot {
  readonly harness: Harness;
  readonly service: WebSocketService;
  readonly router: WebSocketUpgradeRouter;
}

async function boot(options?: WebSocketPluginOptions): Promise<Boot> {
  const harness = createHarness();
  await WebSocketPlugin(options).register(harness.ctx);
  const service = harness.registered.get(CAPABILITIES.WEBSOCKET);
  if (!(service instanceof WebSocketService)) {
    throw new Error('plugin did not register the service');
  }
  const router = harness.adapter.router;
  if (router === null) {
    throw new Error('plugin did not install the upgrade router');
  }
  return { harness, service, router };
}

/** Runs the plugin's `onInit` hooks, as the kernel does during `start()`. */
async function runInitHooks(harness: Harness): Promise<void> {
  for (const hook of harness.initHooks) {
    await hook();
  }
}

/** A factory that throws — the entry a mixed array must attribute by index. */
function routeFactoryThatThrows(_services: IServiceRegistry): WebSocketRouteDefinition {
  throw new Error('registry exploded');
}

/** A behavior factory that throws, for the behaviors-arm label assertion. */
function behaviorFactoryThatThrows(_services: IServiceRegistry): IIngressBehavior {
  throw new Error('behavior exploded');
}

/** A pass-through recorder behavior. */
function recorder(log: string[], label: string): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      void ctx;
      log.push(label);
      return next();
    },
  };
}

describe('WebSocketPlugin({ routes }) registration arms', () => {
  it('registers an instance entry at register() timing, before any onInit hook', async () => {
    const { harness, router } = await boot({
      routes: [{ path: '/ws/declared', handlers: {} }],
    });

    // Instance timing: no init hook has run, and the route already answers.
    expect(harness.initHooks).toHaveLength(0);
    const decision = await router(upgradeRequest('http://localhost/ws/declared'));
    expect(decision?.accept).toBe(true);
  });

  it('resolves a RegistryFactory entry in onInit with the application registry', async () => {
    let received: IServiceRegistry | undefined;
    const factory: RegistryFactory<WebSocketRouteDefinition> = (services) => {
      received = services;
      return { path: '/ws/factory', handlers: {} };
    };
    const { harness, router } = await boot({ routes: [factory] });

    // Not registered before onInit — the factory has not run yet.
    const early = await router(upgradeRequest('http://localhost/ws/factory'));
    expect(early).toBeNull();

    await runInitHooks(harness);

    expect(received).toBe(harness.ctx.services);
    const decision = await router(upgradeRequest('http://localhost/ws/factory'));
    expect(decision?.accept).toBe(true);
  });

  it('registers instance and factory entries alongside an imperative route()', async () => {
    const { harness, service, router } = await boot({
      routes: [
        { path: '/ws/instance', handlers: {} },
        (): WebSocketRouteDefinition => ({ path: '/ws/factory', handlers: {} }),
      ],
    });
    await runInitHooks(harness);
    service.route('/ws/manual', {});

    expect(service.routeCount).toBe(3);
    for (const path of ['/ws/instance', '/ws/factory', '/ws/manual']) {
      const decision = await router(upgradeRequest(`http://localhost${path}`));
      expect(decision?.accept).toBe(true);
    }
  });

  it('rejects onInit naming the DECLARED index when a mixed routes array has a throwing factory', async () => {
    const { harness, router } = await boot({
      routes: [
        { path: '/ws/instance', handlers: {} },
        routeFactoryThatThrows,
      ],
    });

    // Index 0 is an instance and registered before the failure.
    const ok = await router(upgradeRequest('http://localhost/ws/instance'));
    expect(ok?.accept).toBe(true);

    // The label names index 1 — the DECLARED position, not the 0th factory.
    await expect(runInitHooks(harness)).rejects.toThrow('WebSocketPlugin({ routes })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('registry exploded');
  });
});

describe('WebSocketPlugin({ behaviors }) registration arms', () => {
  it('rejects onInit naming the DECLARED index when a mixed behaviors array has a throwing factory', async () => {
    const { harness } = await boot({
      behaviors: [recorder([], 'instance'), behaviorFactoryThatThrows],
    });

    await expect(runInitHooks(harness)).rejects.toThrow('WebSocketPlugin({ behaviors })[1]');
    await expect(runInitHooks(harness)).rejects.toThrow('behavior exploded');
  });

  it('hands behavior instances to the service at register() with no onInit hook', async () => {
    const envelopes: IngressContext[] = [];
    const behavior: IIngressBehavior = {
      handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
        envelopes.push(ctx);
        return next();
      },
    };
    const { harness, service, router } = await boot({ behaviors: [behavior] });
    service.route('/ws/echo', { onMessage: () => {} });

    // Instances need no resolution, so no lifecycle hook is registered at all.
    expect(harness.initHooks).toHaveLength(0);

    const decision = await router(upgradeRequest('http://localhost/ws/echo'));
    if (decision?.accept !== true) {
      throw new Error('upgrade refused');
    }
    decision.sink.onOpen(createFakeTransport());
    decision.sink.onMessage('frame');

    expect(envelopes).toEqual([{ kind: 'websocket', name: '/ws/echo', payload: 'frame' }]);
  });

  it('appends factory-resolved behaviors to the chain in onInit', async () => {
    const instances: string[] = [];
    const factories: string[] = [];
    const { harness, service, router } = await boot({
      behaviors: [
        recorder(instances, 'instance'),
        (services): IIngressBehavior => {
          void services;
          return recorder(factories, 'factory');
        },
      ],
    });
    service.route('/ws/echo', { onMessage: () => {} });
    await runInitHooks(harness);

    const decision = await router(upgradeRequest('http://localhost/ws/echo'));
    if (decision?.accept !== true) {
      throw new Error('upgrade refused');
    }
    decision.sink.onOpen(createFakeTransport());
    decision.sink.onMessage('frame');

    expect(instances).toEqual(['instance']);
    expect(factories).toEqual(['factory']);
  });

  it('registers routes from factories and behaviors from factories in one onInit pass', async () => {
    const log: string[] = [];
    const { harness, router } = await boot({
      routes: [(): WebSocketRouteDefinition => ({ path: '/ws/factory', handlers: {} })],
      behaviors: [
        (services): IIngressBehavior => {
          void services;
          return recorder(log, 'factory-behavior');
        },
      ],
    });
    await runInitHooks(harness);

    const decision = await router(upgradeRequest('http://localhost/ws/factory'));
    if (decision?.accept !== true) {
      throw new Error('upgrade refused');
    }
    decision.sink.onOpen(createFakeTransport());
    decision.sink.onMessage('frame');
    expect(log).toEqual(['factory-behavior']);
  });

  it('registers no onInit hook when no registration arm is configured', async () => {
    const { harness } = await boot();

    expect(harness.initHooks).toHaveLength(0);
  });

  it('registers no onInit hook when only instance entries are configured', async () => {
    const { harness, router } = await boot({
      routes: [{ path: '/ws/instance', handlers: {} }],
      behaviors: [recorder([], 'instance')],
    });

    expect(harness.initHooks).toHaveLength(0);
    const decision = await router(upgradeRequest('http://localhost/ws/instance'));
    expect(decision?.accept).toBe(true);
  });
});
