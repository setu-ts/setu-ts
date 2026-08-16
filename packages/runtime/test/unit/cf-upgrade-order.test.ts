/**
 * cf-upgrade-order — Framework handler invoked before the handshake;
 * a 401 returns with no handshake attempted.
 *
 * Verifies the M70a pipeline-first contract for Cloudflare Workers: the kernel
 * middleware pipeline runs BEFORE any WebSocket handshake, so auth, metrics,
 * and security headers apply uniformly to upgrade requests.
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
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';
import type {
  CloudflareServerSocket,
  CloudflareWebSocketHost,
} from '../../src/adapters/workers/cf-ws-upgrader.ts';

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

function fakeServerSocket(): CloudflareServerSocket {
  return {
    readyState: 1,
    accept: () => {},
    send: () => {},
    close: () => {},
    addEventListener: () => {},
  };
}

function fakeClientSocket() {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
    bufferedAmount: 0,
    protocol: '',
    extensions: '',
  };
}

function fakeWsHost(): CloudflareWebSocketHost {
  const serverSocket = fakeServerSocket();
  const clientSocket = fakeClientSocket();
  return {
    createPair: () => ({
      1: clientSocket,
      0: serverSocket,
      client: clientSocket,
      server: serverSocket,
    }),
    createUpgradeResponse: (_client, _protocol) => new Response(null, { status: 101 }),
  };
}

describe('CloudflareWorkersHttpAdapter upgrade order (M70a)', () => {
  it('framework handler invoked before the handshake', async () => {
    const handlerOrder: string[] = [];
    let frameworkHandlerCalls = 0;

    const adapter = new CloudflareWorkersHttpAdapter(fakeWsHost());
    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      handlerOrder.push('framework-handler');
      frameworkHandlerCalls++;
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
    expect(handlerOrder).toEqual(['framework-handler']);
  });

  it('a 401 returns with no handshake attempted', async () => {
    let frameworkHandlerCalls = 0;

    const adapter = new CloudflareWorkersHttpAdapter(fakeWsHost());
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      frameworkHandlerCalls++;
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
    expect(result.status).toBe(401);
  });

  it('router is stored but not consulted in fetch path', async () => {
    const routerConsulted = { value: false };
    const router: WebSocketUpgradeRouter = () => {
      routerConsulted.value = true;
      return Promise.resolve(null);
    };

    let frameworkHandlerCalls = 0;

    const adapter = new CloudflareWorkersHttpAdapter(fakeWsHost());
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
    expect(routerConsulted.value).toBe(false);
  });

  it('pipeline middleware short-circuit prevents upgrade', async () => {
    let frameworkHandlerCalls = 0;

    const adapter = new CloudflareWorkersHttpAdapter(fakeWsHost());
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      frameworkHandlerCalls++;
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
    expect(result.status).toBe(403);
  });
});
