/**
 * deno-upgrade-order — Framework handler invoked before the handshake;
 * a 401 returns with no handshake attempted.
 *
 * Verifies the M70a pipeline-first contract for Deno: the kernel middleware
 * pipeline runs BEFORE any WebSocket handshake, so auth, metrics, and
 * security headers apply uniformly to upgrade requests.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IRequest,
  IResponse,
  WebSocketEventSink,
  WebSocketUpgradeRouter,
} from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import { DenoHttpAdapter, type DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';
import type { DenoWebSocketLike } from '../../src/adapters/deno/deno-ws-upgrader.ts';

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

function fakeSocket(): DenoWebSocketLike {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

describe('DenoHttpAdapter upgrade order (M70a)', () => {
  it('framework handler invoked before the handshake', async () => {
    const handlerOrder: string[] = [];
    let frameworkHandlerCalls = 0;
    const socket = fakeSocket();
    const response = new Response(null, { status: 101 });
    const upgradeCalls: { request: Request }[] = [];

    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      upgradeWebSocket: (request: Request) => {
        upgradeCalls.push({ request });
        return { socket, response };
      },
    };

    const adapter = new DenoHttpAdapter(host);
    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      handlerOrder.push('framework-handler');
      frameworkHandlerCalls++;
      // Write upgrade intent (kernel terminal handler behavior)
      (request as unknown as Record<symbol, { sink: WebSocketEventSink }>)[UPGRADE_INTENT] = {
        sink: {
          onOpen: () => {},
          onMessage: () => {},
          onClose: () => {},
          onError: () => {},
        },
      };
      return Promise.resolve({
        status: 101,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 101, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    await adapter.fetch(upgradeRequest());
    expect(frameworkHandlerCalls).toBe(1);
    expect(upgradeCalls.length).toBe(1);
    // Handler must run BEFORE upgrade
    expect(handlerOrder).toEqual(['framework-handler']);
  });

  it('a 401 returns with no handshake attempted', async () => {
    let frameworkHandlerCalls = 0;
    const upgradeCalls: { request: Request }[] = [];

    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      upgradeWebSocket: (request: Request) => {
        upgradeCalls.push({ request });
        return { socket: fakeSocket(), response: new Response(null, { status: 101 }) };
      },
    };

    const adapter = new DenoHttpAdapter(host);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      frameworkHandlerCalls++;
      // Simulate auth middleware short-circuit — no UPGRADE_INTENT written
      return Promise.resolve({
        status: 401,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({ error: 'Unauthorized' })),
        snapshot: () => ({
          status: 401,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          body: new TextEncoder().encode(JSON.stringify({ error: 'Unauthorized' })),
          streaming: false,
        }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequest());
    expect(frameworkHandlerCalls).toBe(1);
    expect(upgradeCalls.length).toBe(0);
    expect(result.status).toBe(401);
  });

  it('router is stored but not consulted in fetch path', async () => {
    const routerConsulted = { value: false };
    const router: WebSocketUpgradeRouter = async () => {
      routerConsulted.value = true;
      return null;
    };

    let frameworkHandlerCalls = 0;
    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
    };

    const adapter = new DenoHttpAdapter(host);
    adapter.setUpgradeRouter(router);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      frameworkHandlerCalls++;
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    await adapter.fetch(upgradeRequest());
    expect(frameworkHandlerCalls).toBe(1);
    // Router should not be consulted — kernel writes UPGRADE_INTENT instead
    expect(routerConsulted.value).toBe(false);
  });

  it('pipeline middleware short-circuit prevents upgrade', async () => {
    let frameworkHandlerCalls = 0;
    const upgradeCalls: { request: Request }[] = [];

    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      upgradeWebSocket: (request: Request) => {
        upgradeCalls.push({ request });
        return { socket: fakeSocket(), response: new Response(null, { status: 101 }) };
      },
    };

    const adapter = new DenoHttpAdapter(host);
    // Simulate middleware that short-circuits with 403
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      frameworkHandlerCalls++;
      // No UPGRADE_INTENT written — middleware stopped the pipeline
      return Promise.resolve({
        status: 403,
        headers: new Headers(),
        body: new TextEncoder().encode('Forbidden'),
        snapshot: () => ({
          status: 403,
          headers: new Headers(),
          body: new TextEncoder().encode('Forbidden'),
          streaming: false,
        }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequest());
    expect(frameworkHandlerCalls).toBe(1);
    expect(upgradeCalls.length).toBe(0);
    expect(result.status).toBe(403);
  });
});
