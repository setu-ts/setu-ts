import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  HealthCheckResult,
  IHttpAdapter,
  IPluginContext,
  IRealtimeBackplane,
  IRequest,
  IResponse,
  IWebSocketService,
  RealtimeFrame,
  ServerHandle,
  WebSocketUpgradeRouter,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { WebSocketPlugin } from '../../src/plugin/websocket-plugin.ts';
import { WebSocketService } from '../../src/services/websocket-service.ts';
import { WebSocketUnavailableError } from '../../src/errors/websocket-errors.ts';
import {
  createFakeRuntime,
  createFakeTransport,
  upgradeRequest,
} from '../fixtures/fake-runtime.ts';

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

/** An adapter predating the upgrade seam. */
function createLegacyAdapter(): IHttpAdapter {
  return {
    setHandler(_handler: (request: IRequest) => Promise<IResponse>): void {},
    fetch: () => Promise.resolve(new Response(null)),
    listen: () => Promise.resolve({} as ServerHandle),
    close: () => Promise.resolve(),
  };
}

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly health: Map<string, () => Promise<HealthCheckResult>>;
  readonly closeHooks: (() => void)[];
}

function createContext(adapter: IHttpAdapter): Harness {
  const registered = new Map<string, unknown>();
  const health = new Map<string, () => Promise<HealthCheckResult>>();
  const closeHooks: (() => void)[] = [];
  const runtime = createFakeRuntime();

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
      register: (name: string, check: () => Promise<HealthCheckResult>): void => {
        health.set(name, check);
      },
    },
    lifecycle: {
      onClose: (hook: () => void): void => {
        closeHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, health, closeHooks };
}

describe('WebSocketPlugin', () => {
  it('declares its identity and the capability it provides', () => {
    const plugin = WebSocketPlugin();

    expect(plugin.name).toBe('websocket-plugin');
    expect(plugin.provides).toEqual([CAPABILITIES.WEBSOCKET]);
    expect(plugin.optionalDependencies).toEqual(['logger', CAPABILITIES.REALTIME_BACKPLANE]);
  });

  it('rejects a contradictory configuration at construction, before registration', () => {
    expect(() => WebSocketPlugin({ idleTimeoutMs: 30_000 })).toThrow('requires heartbeatMs');
  });

  it('registers the service under the WEBSOCKET token', async () => {
    const harness = createContext(createUpgradableAdapter());

    await WebSocketPlugin().register(harness.ctx);

    const service = harness.registered.get(CAPABILITIES.WEBSOCKET);
    expect(service).toBeInstanceOf(WebSocketService);
    expect((service as IWebSocketService).available).toBe(true);
  });

  it('installs its upgrade router on an adapter that supports upgrades', async () => {
    const adapter = createUpgradableAdapter();
    const harness = createContext(adapter);

    await WebSocketPlugin().register(harness.ctx);
    const service = harness.registered.get(CAPABILITIES.WEBSOCKET) as IWebSocketService;
    service.route('/ws', {});

    expect(adapter.router).not.toBeNull();
    // Routes added after installation are still picked up, since the router
    // reads the live table rather than a snapshot.
    const decision = await adapter.router!(upgradeRequest('http://localhost/ws'));
    expect(decision?.accept).toBe(true);
  });

  it('still registers on a legacy adapter but reports unavailable and fails route()', async () => {
    const harness = createContext(createLegacyAdapter());

    await WebSocketPlugin().register(harness.ctx);

    const service = harness.registered.get(CAPABILITIES.WEBSOCKET) as IWebSocketService;
    expect(service.available).toBe(false);
    expect(() => service.route('/ws', {})).toThrow(WebSocketUnavailableError);
  });

  it('registers a websocket health indicator reporting availability and counts', async () => {
    const harness = createContext(createUpgradableAdapter());
    await WebSocketPlugin().register(harness.ctx);
    const service = harness.registered.get(CAPABILITIES.WEBSOCKET) as IWebSocketService;
    service.route('/ws', {});

    const result = await harness.health.get('websocket')!();

    expect(result).toEqual({
      status: 'up',
      data: { available: true, connections: 0, rooms: 0, routes: 1 },
    });
  });

  it('reports available false in the health indicator on a legacy adapter', async () => {
    const harness = createContext(createLegacyAdapter());
    await WebSocketPlugin().register(harness.ctx);

    const result = await harness.health.get('websocket')!();

    expect(result.data).toEqual({ available: false, connections: 0, rooms: 0, routes: 0 });
  });

  it('closes every live connection with 1001 on shutdown', async () => {
    const adapter = createUpgradableAdapter();
    const harness = createContext(adapter);
    await WebSocketPlugin().register(harness.ctx);
    const service = harness.registered.get(CAPABILITIES.WEBSOCKET) as IWebSocketService;
    service.route('/ws', {});

    const decision = await adapter.router!(upgradeRequest('http://localhost/ws'));
    const transport = createFakeTransport();
    if (decision?.accept === true) {
      decision.sink.onOpen(transport);
    }
    expect(service.connectionCount).toBe(1);

    for (const hook of harness.closeHooks) {
      hook();
    }

    expect(transport.closes).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
    expect(service.connectionCount).toBe(0);
  });
});

describe('WebSocketPlugin with a realtime backplane', () => {
  /** A backplane double recording its subscriptions and publishes. */
  function fakeBackplane(): IRealtimeBackplane & {
    readonly published: RealtimeFrame[];
    readonly handlers: Array<(frame: RealtimeFrame) => void>;
    unsubscribeCount: number;
  } {
    const published: RealtimeFrame[] = [];
    const handlers: Array<(frame: RealtimeFrame) => void> = [];
    const backplane = {
      origin: 'node-a',
      published,
      handlers,
      unsubscribeCount: 0,
      connect: (): Promise<void> => Promise.resolve(),
      publish: (frame: RealtimeFrame): Promise<void> => {
        published.push(frame);
        return Promise.resolve();
      },
      subscribe: (handler: (frame: RealtimeFrame) => void): Promise<() => void> => {
        handlers.push(handler);
        return Promise.resolve(() => {
          backplane.unsubscribeCount++;
        });
      },
      close: (): Promise<void> => Promise.resolve(),
    };
    return backplane;
  }

  it('subscribes to a registered backplane and routes frames into rooms', async () => {
    const harness = createContext(createUpgradableAdapter());
    const backplane = fakeBackplane();
    harness.registered.set(CAPABILITIES.REALTIME_BACKPLANE, backplane);

    await WebSocketPlugin().register(harness.ctx);
    expect(backplane.handlers.length).toBe(1);

    const service = harness.registered.get(CAPABILITIES.WEBSOCKET) as IWebSocketService;
    const received: unknown[] = [];
    service.room('lobby').add(
      {
        isOpen: true,
        send: (payload: string | Uint8Array): void => {
          received.push(payload);
        },
      } as never,
    );

    // A frame arriving on the backplane reaches the local room member.
    backplane.handlers[0]?.({
      kind: 'ws-room',
      origin: 'node-b',
      name: 'lobby',
      data: 'from-peer',
    });
    expect(received).toEqual(['from-peer']);

    // And a local broadcast is forwarded to the backplane.
    service.room('lobby').broadcast('to-peers');
    await Promise.resolve();
    expect(backplane.published).toEqual([
      { kind: 'ws-room', origin: 'node-a', name: 'lobby', data: 'to-peers' },
    ]);
  });

  it('unsubscribes from the backplane on shutdown', async () => {
    const harness = createContext(createUpgradableAdapter());
    const backplane = fakeBackplane();
    harness.registered.set(CAPABILITIES.REALTIME_BACKPLANE, backplane);

    await WebSocketPlugin().register(harness.ctx);
    for (const hook of harness.closeHooks) {
      hook();
    }
    expect(backplane.unsubscribeCount).toBe(1);
  });

  it('registers no subscription when no backplane capability exists', async () => {
    const harness = createContext(createUpgradableAdapter());
    await WebSocketPlugin().register(harness.ctx);

    const service = harness.registered.get(CAPABILITIES.WEBSOCKET) as IWebSocketService;
    // Rooms still work; they simply never leave the process.
    const received: unknown[] = [];
    service.room('lobby').add(
      {
        isOpen: true,
        send: (payload: string | Uint8Array): void => {
          received.push(payload);
        },
      } as never,
    );
    service.room('lobby').broadcast('local');
    expect(received).toEqual(['local']);
  });
});
