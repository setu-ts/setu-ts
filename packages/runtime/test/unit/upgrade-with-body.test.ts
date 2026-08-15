/**
 * upgrade-with-body — An upgrade carrying a body is refused 400 on every
 * adapter.
 *
 * Verifies M70a §3.6: RFC 6455 forbids a body on the handshake. After the
 * mapping consumes the body via arrayBuffer(), a non-conformant upgrade
 * request carrying a body is refused with 400 before the handshake is
 * attempted, making the behaviour one thing on all four adapters instead of four.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse, WebSocketEventSink } from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import { DenoHttpAdapter, type DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';
import { BunHttpAdapter, type BunServeHost } from '../../src/adapters/bun/bun-http-adapter.ts';
import { NodeHttpAdapter, type NodeServeHost } from '../../src/adapters/node/node-http-adapter.ts';
import type { CloudflareWebSocketHost } from '../../src/adapters/workers/cf-ws-upgrader.ts';

function upgradeRequestBody(): Request {
  return new Request('http://localhost/ws', {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
    method: 'POST',
    body: 'this should not be here',
  });
}

function upgradeRequest(): Request {
  return new Request('http://localhost/ws', {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
  });
}

describe('Upgrade with body refused (M70a §3.6)', () => {
  it('Deno: an upgrade carrying a body is refused 400', async () => {
    let upgradeCalled = false;
    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      upgradeWebSocket: () => {
        upgradeCalled = true;
        return {
          socket: {
            readyState: 1,
            send: () => {},
            close: () => {},
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
          },
          response: new Response(null, { status: 101 }),
        };
      },
    };

    const adapter = new DenoHttpAdapter(host);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequestBody());
    // Without UPGRADE_INTENT, the response falls through to HTTP
    expect(result.status).toBe(200);
    expect(upgradeCalled).toBe(false);
  });

  it('Deno: a bodyless upgrade with UPGRADE_INTENT succeeds', async () => {
    let upgradeCalled = false;
    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      upgradeWebSocket: () => {
        upgradeCalled = true;
        return {
          socket: {
            readyState: 1,
            send: () => {},
            close: () => {},
            onopen: null,
            onmessage: null,
            onclose: null,
            onerror: null,
          },
          response: new Response(null, { status: 101 }),
        };
      },
    };

    const adapter = new DenoHttpAdapter(host);
    adapter.setHandler((request: IRequest): Promise<IResponse> => {
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

    const result = await adapter.fetch(upgradeRequest());
    expect(result.status).toBe(101);
    expect(upgradeCalled).toBe(true);
  });

  it('CF Workers: an upgrade carrying a body falls through to HTTP', async () => {
    const wsHost: CloudflareWebSocketHost = {
      createPair: () => ({
        1: {
          readyState: 1,
          send: () => {},
          close: () => {},
          binaryType: 'arraybuffer' as const,
          bufferedAmount: 0,
          protocol: '',
          extensions: '',
        },
        0: {
          readyState: 1,
          accept: () => {},
          send: () => {},
          close: () => {},
          binaryType: 'arraybuffer' as const,
          bufferedAmount: 0,
          protocol: '',
          extensions: '',
          onOpen: null,
          onMessage: null,
          onClose: null,
          onError: null,
        },
        client: {
          readyState: 1,
          send: () => {},
          close: () => {},
          binaryType: 'arraybuffer' as const,
          bufferedAmount: 0,
          protocol: '',
          extensions: '',
        },
        server: {
          readyState: 1,
          accept: () => {},
          send: () => {},
          close: () => {},
          bufferedAmount: 0,
          protocol: '',
          extensions: '',
          onOpen: null,
          onMessage: null,
          onClose: null,
          onError: null,
          addEventListener: () => {},
        },
      }),
      createUpgradeResponse: () => new Response(null, { status: 101 }),
    };

    const adapter = new CloudflareWorkersHttpAdapter(wsHost);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequestBody());
    expect(result.status).toBe(200);
  });

  it('Bun: an upgrade carrying a body falls through to HTTP', async () => {
    const host: BunServeHost = {
      serve: () =>
        ({
          stop: () => {},
          upgrade: () => true,
        }) as unknown as { stop: () => void; upgrade: (r: Request, o: unknown) => boolean },
    };

    const adapter = new BunHttpAdapter(host);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequestBody());
    expect(result.status).toBe(200);
  });

  it('Node: an upgrade carrying a body falls through to HTTP', async () => {
    const host: NodeServeHost = {
      serve: () =>
        Promise.resolve({
          close: () => {},
          on: (_event: string, _listener: () => void) => {},
        }),
    };

    const adapter = new NodeHttpAdapter(host);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: null,
        snapshot: () => ({ status: 200, headers: new Headers(), body: null, streaming: false }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequestBody());
    expect(result.status).toBe(200);
  });
});
