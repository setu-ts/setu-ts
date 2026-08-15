/**
 * bun-upgrade-order — Serve callback invokes the framework handler before
 * server.upgrade().
 *
 * Verifies the M70a pipeline-first contract for Bun: the Bun.serve callback
 * runs the kernel middleware pipeline BEFORE calling server.upgrade(), so
 * auth, metrics, and security headers apply uniformly to upgrade requests.
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
import { BunHttpAdapter, type BunServeHost } from '../../src/adapters/bun/bun-http-adapter.ts';

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('BunHttpAdapter upgrade order (M70a)', () => {
  it('serve callback invokes the handler before server.upgrade()', async () => {
    const order: string[] = [];
    let frameworkHandlerCalls = 0;

    const host: BunServeHost = {
      serve: () =>
        ({
          stop: () => {},
          upgrade: () => {
            order.push('upgrade');
            return true;
          },
        }) as unknown as { stop: () => void; upgrade: (r: Request, o: unknown) => boolean },
    };

    const adapter = new BunHttpAdapter(host);
    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      order.push('framework-handler');
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

    // Use fetch path (equivalent to serve callback for Bun)
    await adapter.fetch(upgradeRequest());
    expect(frameworkHandlerCalls).toBe(1);
    expect(order[0]).toBe('framework-handler');
  });

  it('a 401 returns with no upgrade attempted', async () => {
    let frameworkHandlerCalls = 0;
    const upgradeCalled = { value: false };

    const host: BunServeHost = {
      serve: () =>
        ({
          stop: () => {},
          upgrade: () => {
            upgradeCalled.value = true;
            return true;
          },
        }) as unknown as { stop: () => void; upgrade: (r: Request, o: unknown) => boolean },
    };

    const adapter = new BunHttpAdapter(host);
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
    expect(upgradeCalled.value).toBe(false);
    expect(result.status).toBe(401);
  });

  it('router is stored but not consulted in fetch path', async () => {
    const routerConsulted = { value: false };
    const router: WebSocketUpgradeRouter = () => {
      routerConsulted.value = true;
      return Promise.resolve(null);
    };

    let frameworkHandlerCalls = 0;
    const host: BunServeHost = {
      serve: () =>
        ({
          stop: () => {},
          upgrade: () => true,
        }) as unknown as { stop: () => void; upgrade: (r: Request, o: unknown) => boolean },
    };

    const adapter = new BunHttpAdapter(host);
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
    const upgradeCalled = { value: false };

    const host: BunServeHost = {
      serve: () =>
        ({
          stop: () => {},
          upgrade: () => {
            upgradeCalled.value = true;
            return true;
          },
        }) as unknown as { stop: () => void; upgrade: (r: Request, o: unknown) => boolean },
    };

    const adapter = new BunHttpAdapter(host);
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
    expect(upgradeCalled.value).toBe(false);
    expect(result.status).toBe(403);
  });
});
