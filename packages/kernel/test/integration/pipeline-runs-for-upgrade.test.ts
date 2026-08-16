/**
 * Integration test: the middleware pipeline runs BEFORE the WebSocket upgrade
 * decision (M70a). A short-circuiting guard prevents the upgrade intent from
 * being set at all.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IPlugin,
  IPluginContext,
  IWebSocketService,
  MiddlewareFunction,
  WebSocketEventSink,
  WebSocketUpgradeDecision,
} from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** Records the close the kernel reports when it refuses after accepting. */
interface SinkProbe {
  readonly closes: { code: number; reason?: string | undefined }[];
  readonly sink: WebSocketEventSink;
}

function sinkProbe(): SinkProbe {
  const closes: { code: number; reason?: string | undefined }[] = [];
  return {
    closes,
    sink: {
      onOpen: () => {},
      onMessage: () => {},
      onClose: (event) => closes.push(event),
      onError: () => {},
    },
  };
}

/**
 * A minimal `IWebSocketService` stand-in. Only the members the kernel terminal
 * handler reads are implemented; the rest throw, so a test that starts
 * depending on them fails loudly rather than reading a silent default.
 */
function wsPlugin(
  routeUpgrade: (request: Request) => Promise<WebSocketUpgradeDecision | null>,
): IPlugin {
  const service = {
    routeUpgrade,
    available: true,
    connectionCount: 0,
    route: () => {
      throw new Error('not used by these tests');
    },
    room: () => {
      throw new Error('not used by these tests');
    },
    broadcast: () => {
      throw new Error('not used by these tests');
    },
  } as unknown as IWebSocketService;

  return {
    name: 'fake-websocket',
    version: '1.0.0',
    provides: [CAPABILITIES.WEBSOCKET],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.WEBSOCKET, service);
    },
  };
}

const UPGRADE_HEADERS = { upgrade: 'websocket', connection: 'Upgrade' } as const;

describe('Pipeline runs for upgrade requests (M70a)', () => {
  it('a short-circuiting guard prevents upgrade intent being set', async () => {
    let middlewareRan = false;
    const guardMiddleware: MiddlewareFunction = (ctx) => {
      middlewareRan = true;
      // Short-circuit with 401 — no upgrade should happen
      ctx.response.status(401).json({ error: 'Unauthorized' });
      // Intentionally NOT calling next()
    };

    const app = createApplication({ plugins: [runtimePlugin()] });
    app.middleware.add(guardMiddleware);

    await app.start();

    // Inject an upgrade-like request
    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });

    // The middleware ran and short-circuited with 401
    expect(middlewareRan).toBe(true);
    expect(result.statusCode).toBe(401);

    await app.stop();
  });

  it('middleware executes before the terminal handler', async () => {
    const order: string[] = [];
    const trackingMiddleware: MiddlewareFunction = async (_ctx, next) => {
      order.push('middleware-before');
      await next();
      order.push('middleware-after');
    };

    const app = createApplication({ plugins: [runtimePlugin()] });
    app.middleware.add(trackingMiddleware);

    await app.start();

    // A normal request (no route matches → 404)
    await app.inject({
      method: 'GET',
      url: 'http://localhost/nope',
    });

    expect(order).toEqual(['middleware-before', 'middleware-after']);

    await app.stop();
  });

  it('refuses 400 when an accepted upgrade carries a body (§3.6)', async () => {
    // RFC 6455 forbids a body on the handshake, and the framework mapping has
    // already disturbed it — so the handshake would fail differently on each
    // runtime. The kernel refuses instead, making it one behaviour everywhere.
    const probe = sinkProbe();
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        wsPlugin(() => Promise.resolve({ accept: true, sink: probe.sink })),
      ],
    });
    await app.start();

    const result = await app.inject({
      method: 'POST',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
      body: 'this should not be here',
    });

    expect(result.statusCode).toBe(400);
    // The router already accepted, so it may hold a reserved connection slot;
    // refusing without releasing it would leak one slot per malformed upgrade.
    expect(probe.closes).toEqual([
      { code: 1006, reason: 'Upgrade request carried a body' },
    ]);

    await app.stop();
  });

  it('upgrades a bodyless request the router accepts', async () => {
    // The control for the test above: same route, same router, no body. Without
    // it a `400` on everything would pass the §3.6 test.
    const probe = sinkProbe();
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        wsPlugin(() => Promise.resolve({ accept: true, sink: probe.sink })),
      ],
    });
    await app.start();

    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
    });

    // `inject()` bypasses the HTTP adapter, so no handshake happens here — what
    // this pins is that the kernel did NOT refuse, and reserved nothing.
    expect(result.statusCode).not.toBe(400);
    expect(probe.closes).toEqual([]);

    await app.stop();
  });

  it('answers 500 when the upgrade router throws, rather than crashing', async () => {
    // Before M70a the adapter-side `UpgradeRouterStore` caught here. The
    // service reports its own failures through its logger; this backstop is for
    // a third-party service that does not.
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        wsPlugin(() => {
          throw new Error('route selection blew up');
        }),
      ],
    });
    await app.start();

    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
    });

    expect(result.statusCode).toBe(500);

    await app.stop();
  });

  it('falls through to the ordinary 404 when the router declines', async () => {
    // Upgrade DETECTION belongs to the router, not the kernel — see
    // `WebSocketService.#route`, and the websocket-plugin's own tests for the
    // header rules. What the kernel owes is that a `null` decision is a
    // fall-through rather than a refusal, so registering the plugin never
    // changes the behaviour of non-WebSocket traffic.
    let consulted = 0;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        wsPlugin(() => {
          consulted++;
          return Promise.resolve(null);
        }),
      ],
    });
    await app.start();

    const result = await app.inject({ method: 'GET', url: 'http://localhost/nope' });

    expect(result.statusCode).toBe(404);
    expect(result.body).toBe('{"error":"Not Found"}');
    expect(consulted).toBe(1);

    await app.stop();
  });

  it('passes the undisturbed raw Request to the router', async () => {
    // The router runs RFC 6455 header checks and reads the URL, so it must see
    // the real request rather than the mapped `IRequest`.
    let seen: Request | undefined;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        wsPlugin((request) => {
          seen = request;
          return Promise.resolve(null);
        }),
      ],
    });
    await app.start();

    await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
    });

    expect(seen?.url).toBe('http://localhost/ws');
    expect(seen?.headers.get('upgrade')).toBe('websocket');
    expect(seen?.bodyUsed).toBe(false);

    await app.stop();
  });
});
