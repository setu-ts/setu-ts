/**
 * Integration test: the kernel threads `ctx.request.user` into
 * `IWebSocketService.routeUpgrade` at the upgrade decision (M73 §3.7).
 *
 * The pipeline runs BEFORE the upgrade decision (M70a —
 * `application.ts:643` `#pipeline.execute`, with `#tryUpgrade` at `:659`
 * inside the terminal callback), so the authentication band has already
 * populated `ctx.request.user` by the time the router is consulted. This
 * suite pins:
 *   1. an authenticated upgrade reaches `routeUpgrade` with that EXACT
 *      principal (identity, not shape);
 *   2. an unauthenticated upgrade reaches it with `undefined`;
 *   3. a service whose `routeUpgrade` takes ONE parameter still upgrades
 *      (the optional-parameter compatibility claim).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, isWebSocketUpgradeRequest } from '@setu-ts/common';
import type {
  IPlugin,
  IPluginContext,
  IPrincipal,
  IWebSocketService,
  MiddlewareFunction,
  WebSocketEventSink,
  WebSocketUpgradeDecision,
} from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const UPGRADE_HEADERS = { upgrade: 'websocket', connection: 'Upgrade' } as const;

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

/** One recorded `routeUpgrade` consultation. */
interface RecordedCall {
  readonly request: Request;
  readonly principal: IPrincipal | undefined;
}

/**
 * A minimal `IWebSocketService` stand-in that records every argument the
 * kernel passes to `routeUpgrade`. The supplied router is wrapped in the SAME
 * RFC 6455 detection a real `IWebSocketService` applies (the websocket
 * service's own `#route` consults it first), so this double cannot accept a
 * plain GET that the real service would decline — which would make a
 * principal test pass for the wrong reason (the M70a lesson).
 *
 * When `singleParameter` is set, the service's `routeUpgrade` is declared
 * with one parameter — the pre-M73 shape — so the kernel's second argument is
 * ignored exactly as it would be for a real legacy service.
 */
function recordingWsPlugin(
  router: (
    request: Request,
    principal: IPrincipal | undefined,
  ) => Promise<WebSocketUpgradeDecision | null>,
  calls: RecordedCall[],
  singleParameter = false,
): IPlugin {
  const consult = (
    request: Request,
    principal: IPrincipal | undefined,
  ): Promise<WebSocketUpgradeDecision | null> => {
    if (!isWebSocketUpgradeRequest(request.headers)) {
      return Promise.resolve(null);
    }
    calls.push({ request, principal });
    return router(request, principal);
  };

  const routeUpgrade = singleParameter
    ? (request: Request): Promise<WebSocketUpgradeDecision | null> => consult(request, undefined)
    : (
      request: Request,
      principal?: IPrincipal,
    ): Promise<WebSocketUpgradeDecision | null> => consult(request, principal);

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

/** Authentication-band middleware that stamps the given principal. */
function authMiddleware(principal: IPrincipal): MiddlewareFunction {
  return async (ctx, next) => {
    ctx.request.user = principal;
    await next();
  };
}

describe('Kernel threads the authenticated principal to routeUpgrade (M73)', () => {
  it('reaches routeUpgrade with the exact principal the authentication band set', async () => {
    const principal: IPrincipal = { id: 'u-42', roles: ['admin'] };
    const probe = sinkProbe();
    const calls: RecordedCall[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        recordingWsPlugin(
          () => Promise.resolve({ accept: true, sink: probe.sink }),
          calls,
        ),
      ],
    });
    app.middleware.add(authMiddleware(principal), { priority: 300, name: 'auth' });
    await app.start();

    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
    });

    // The upgrade was accepted, not refused.
    expect(result.statusCode).not.toBe(400);
    expect(probe.closes).toEqual([]);
    // The router was consulted exactly once, with the raw request and the
    // EXACT principal — identity, not shape.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toBeInstanceOf(Request);
    expect(calls[0]?.request.url).toBe('http://localhost/ws');
    expect(calls[0]?.principal).toBe(principal);

    await app.stop();
  });

  it('reaches routeUpgrade with undefined when no middleware authenticated', async () => {
    const probe = sinkProbe();
    const calls: RecordedCall[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        recordingWsPlugin(
          () => Promise.resolve({ accept: true, sink: probe.sink }),
          calls,
        ),
      ],
    });
    await app.start();

    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
    });

    expect(result.statusCode).not.toBe(400);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.principal).toBeUndefined();

    await app.stop();
  });

  it('still upgrades when the service routeUpgrade takes one parameter', async () => {
    // The M73 widening added an optional second parameter; a service written
    // before it declares one. The kernel's two-argument call must be harmless
    // to it and the upgrade must still complete.
    const probe = sinkProbe();
    const calls: RecordedCall[] = [];
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        recordingWsPlugin(
          () => Promise.resolve({ accept: true, sink: probe.sink }),
          calls,
          true,
        ),
      ],
    });
    await app.start();

    const result = await app.inject({
      method: 'GET',
      url: 'http://localhost/ws',
      headers: UPGRADE_HEADERS,
    });

    expect(result.statusCode).not.toBe(400);
    expect(probe.closes).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBe('http://localhost/ws');

    await app.stop();
  });
});
