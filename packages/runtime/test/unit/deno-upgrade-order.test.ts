import { upgradeResponse } from '../../../../test/node-helpers.ts';
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

import { describe, expect, it } from 'vitest';
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
  return new Request(url, {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  });
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
    const response = upgradeResponse(null, { status: 101 });
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
        return { socket: fakeSocket(), response: upgradeResponse(null, { status: 101 }) };
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
    const router: WebSocketUpgradeRouter = () => {
      routerConsulted.value = true;
      return Promise.resolve(null);
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
        return { socket: fakeSocket(), response: upgradeResponse(null, { status: 101 }) };
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

describe('DenoHttpAdapter handshake headers (V13-276)', () => {
  /** An adapter over a host that records whether Deno was asked to upgrade. */
  function adapterOver(): { adapter: DenoHttpAdapter; upgraded: Request[]; closes: string[] } {
    const upgraded: Request[] = [];
    const closes: string[] = [];
    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      upgradeWebSocket: (request: Request) => {
        upgraded.push(request);
        return { socket: fakeSocket(), response: upgradeResponse(null, { status: 101 }) };
      },
    };
    const adapter = new DenoHttpAdapter(host);
    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      (request as unknown as Record<symbol, { sink: WebSocketEventSink }>)[UPGRADE_INTENT] = {
        sink: {
          onOpen: () => {},
          onMessage: () => {},
          onClose: (event) => {
            closes.push(event.reason);
          },
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
    return { adapter, upgraded, closes };
  }

  /** An upgrade request with only the given handshake headers. */
  function withHeaders(extra: Record<string, string>): Request {
    return new Request('http://localhost/ws', {
      headers: { upgrade: 'websocket', connection: 'Upgrade', ...extra },
    });
  }

  it('refuses a malformed key with 400 before asking Deno to upgrade', async () => {
    const { adapter, upgraded, closes } = adapterOver();

    const response = await adapter.fetch(
      withHeaders({ 'sec-websocket-key': 'short', 'sec-websocket-version': '13' }),
    );

    expect(response.status).toBe(400);
    expect(upgraded).toEqual([]);
    expect(closes).toEqual(['Missing or invalid Sec-WebSocket-Key header']);
  });

  it('refuses a missing version with 400 naming the versions it speaks', async () => {
    const { adapter, upgraded } = adapterOver();

    const response = await adapter.fetch(
      withHeaders({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('sec-websocket-version')).toBe('13, 8');
    expect(upgraded).toEqual([]);
  });

  it('accepts version 8, as ws does', async () => {
    const { adapter, upgraded } = adapterOver();

    const response = await adapter.fetch(
      withHeaders({
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '8',
      }),
    );

    expect(response.status).toBe(101);
    expect(upgraded).toHaveLength(1);
  });
});
