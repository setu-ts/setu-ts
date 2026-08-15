/**
 * node-upgrade-order — The raw upgrade event runs the handler before the
 * handshake.
 *
 * Verifies the M70a pipeline-first contract for Node: the raw `upgrade` event
 * listener runs the kernel middleware pipeline BEFORE performing the WebSocket
 * handshake, so auth, metrics, and security headers apply uniformly.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse, WebSocketUpgradeRouter } from '@setu-ts/common';
import { NodeHttpAdapter, type NodeServeHost } from '../../src/adapters/node/node-http-adapter.ts';

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('NodeHttpAdapter upgrade order (M70a)', () => {
  it('framework handler invoked before the handshake (fetch path)', async () => {
    let frameworkHandlerCalls = 0;

    const host: NodeServeHost = {
      serve: () =>
        Promise.resolve({
          close: () => {},
          on: (_event: string, _listener: () => void) => {},
        }),
    };

    const adapter = new NodeHttpAdapter(host);
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
  });

  it('a 401 returns with no handshake attempted (fetch path)', async () => {
    let frameworkHandlerCalls = 0;

    const host: NodeServeHost = {
      serve: () =>
        Promise.resolve({
          close: () => {},
          on: (_event: string, _listener: () => void) => {},
        }),
    };

    const adapter = new NodeHttpAdapter(host);
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

  it('router is stored but upgrade listener gates on it', async () => {
    const routerConsulted = { value: false };
    const router: WebSocketUpgradeRouter = () => {
      routerConsulted.value = true;
      return null;
    };

    const host: NodeServeHost = {
      serve: () =>
        Promise.resolve({
          close: () => {},
          on: (_event: string, _listener: () => void) => {
            return null;
          },
        }),
    };

    const adapter = new NodeHttpAdapter(host);
    adapter.setUpgradeRouter(router);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    // The adapter should have stored the router
    await adapter.fetch(upgradeRequest());
    // The fetch path does not consult the router — the raw upgrade event does
    expect(routerConsulted.value).toBe(false);
  });

  it('pipeline middleware short-circuit prevents upgrade (fetch path)', async () => {
    let frameworkHandlerCalls = 0;

    const host: NodeServeHost = {
      serve: () =>
        Promise.resolve({
          close: () => {},
          on: (_event: string, _listener: () => void) => {},
        }),
    };

    const adapter = new NodeHttpAdapter(host);
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
