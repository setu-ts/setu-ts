import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse, WebSocketEventSink } from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import {
  type BunServerWebSocket,
  type BunSocketData,
  createBunWebSocketHandlers,
} from '../../src/adapters/bun/bun-ws-upgrader.ts';
import {
  BunHttpAdapter,
  type BunServeHost,
  type BunServer,
} from '../../src/adapters/bun/bun-http-adapter.ts';

function recordingSink(): WebSocketEventSink & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    onOpen: (transport) => {
      events.push(`open:${transport.readyState}`);
    },
    onMessage: (data) => {
      events.push(`message:${String(data)}`);
    },
    onClose: (event) => {
      events.push(`close:${event.code}:${event.reason}`);
    },
    onError: (error) => {
      events.push(`error:${error.message}`);
    },
  };
}

function fakeBunSocket(
  data: BunSocketData,
): BunServerWebSocket & { sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = [];
  return { readyState: 1, data, sent, send: (d) => void sent.push(d), close: () => {} };
}

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('createBunWebSocketHandlers', () => {
  it('routes every Bun socket event to the sink carried on ws.data', () => {
    const sink = recordingSink();
    const socket = fakeBunSocket({ sink });
    const handlers = createBunWebSocketHandlers();

    handlers.open(socket);
    handlers.message(socket, 'hello');
    handlers.error(socket, new Error('bun failure'));
    handlers.close(socket, 1000, 'bye');

    expect(sink.events).toEqual([
      'open:open',
      'message:hello',
      'error:bun failure',
      'close:1000:bye',
    ]);
  });

  it('normalizes a binary frame', () => {
    const received: unknown[] = [];
    const socket = fakeBunSocket({
      sink: {
        onOpen: () => {},
        onMessage: (data) => void received.push(data),
        onClose: () => {},
        onError: () => {},
      },
    });

    createBunWebSocketHandlers().message(socket, new Uint8Array([7, 8]));

    expect(Array.from(received[0] as Uint8Array)).toEqual([7, 8]);
  });

  it('gives the sink a transport that writes back to the Bun socket', () => {
    const socket = fakeBunSocket({
      sink: {
        onOpen: (transport) => transport.send('greeting'),
        onMessage: () => {},
        onClose: () => {},
        onError: () => {},
      },
    });

    createBunWebSocketHandlers().open(socket);

    expect(socket.sent).toEqual(['greeting']);
  });
});

// ---------------------------------------------------------------------------
// BunHttpAdapter WebSocket upgrade — post-M70a behavior
//
// After M70a, the adapter fetch handler runs the framework handler FIRST
// (which executes the kernel middleware pipeline). The kernel terminal handler
// writes UPGRADE_INTENT on the IRequest when it decides to upgrade. The adapter
// then reads the intent and performs the WebSocket handshake.
// ---------------------------------------------------------------------------

describe('BunHttpAdapter WebSocket upgrade (post-M70a)', () => {
  function build(options?: { omitUpgrade?: boolean; upgradeReturns?: boolean }) {
    const upgradeCalls: { request: Request; data: BunSocketData; protocol: string | null }[] = [];
    let served: Parameters<BunServeHost['serve']>[0] | null = null;
    let frameworkHandlerCalls = 0;

    const server: BunServer = {
      stop: () => {},
      ...(options?.omitUpgrade === true ? {} : {
        upgrade: (request: Request, opts: { data: BunSocketData; headers?: Headers }) => {
          upgradeCalls.push({
            request,
            data: opts.data,
            protocol: opts.headers?.get('sec-websocket-protocol') ?? null,
          });
          return options?.upgradeReturns ?? true;
        },
      }),
    };

    const host: BunServeHost = {
      serve: (opts) => {
        served = opts;
        return server;
      },
    };

    const adapter = new BunHttpAdapter(host);

    return {
      adapter,
      server,
      upgradeCalls,
      calls: () => frameworkHandlerCalls,
      incrementCalls: () => frameworkHandlerCalls++,
      serveOptions: () => served!,
    };
  }

  it('passes the serve-time websocket handlers to Bun.serve', async () => {
    const { adapter, serveOptions } = build();
    await adapter.listen(3000);
    expect(serveOptions().websocket).toBeDefined();
    expect(typeof serveOptions().websocket?.message).toBe('function');
  });

  it('upgrades when framework handler writes UPGRADE_INTENT', async () => {
    const { adapter, server, upgradeCalls, serveOptions, calls, incrementCalls } = build();
    const sink = recordingSink();
    await adapter.listen(3000);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink, protocol: undefined };
      (request as unknown as Record<symbol, typeof intent>)[UPGRADE_INTENT] = intent;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 101,
          headers: new Headers(),
          body: null,
        }),
      } as unknown as IResponse);
    });

    const result = await serveOptions().fetch(upgradeRequest(), server);

    expect(result).toBeUndefined();
    expect(upgradeCalls).toHaveLength(1);
    expect(upgradeCalls[0]?.data.sink).toBe(sink);
    expect(calls()).toBe(1);
  });

  it('carries the negotiated subprotocol in the handshake headers', async () => {
    const { adapter, server, upgradeCalls, serveOptions, incrementCalls } = build();
    const sink = recordingSink();
    await adapter.listen(3000);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink, protocol: 'chat' };
      (request as unknown as Record<symbol, typeof intent>)[UPGRADE_INTENT] = intent;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 101,
          headers: new Headers(),
          body: null,
        }),
      } as unknown as IResponse);
    });

    await serveOptions().fetch(upgradeRequest(), server);
    expect(upgradeCalls[0]?.protocol).toBe('chat');
  });

  it('answers 400 and releases the sink when Bun refuses the upgrade', async () => {
    const { adapter, server, serveOptions, incrementCalls } = build({ upgradeReturns: false });
    const sink = recordingSink();
    await adapter.listen(3000);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink };
      (request as unknown as Record<symbol, typeof intent>)[UPGRADE_INTENT] = intent;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 101,
          headers: new Headers(),
          body: null,
        }),
      } as unknown as IResponse);
    });

    const result = await serveOptions().fetch(upgradeRequest(), server);
    expect(result?.status).toBe(400);
    expect(sink.events).toEqual(['close:1006:Handshake refused']);
  });

  it('answers 501 and releases the sink when the server cannot upgrade', async () => {
    const { adapter, server, serveOptions, incrementCalls } = build({ omitUpgrade: true });
    const sink = recordingSink();
    await adapter.listen(3000);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink };
      (request as unknown as Record<symbol, typeof intent>)[UPGRADE_INTENT] = intent;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 101,
          headers: new Headers(),
          body: null,
        }),
      } as unknown as IResponse);
    });

    const result = await serveOptions().fetch(upgradeRequest(), server);
    expect(result?.status).toBe(501);
    expect(sink.events).toEqual(['close:1006:Upgrade unsupported']);
  });

  it('framework handler runs first (pipeline before upgrade)', async () => {
    const { adapter, server, serveOptions, calls, incrementCalls } = build();
    const sink = recordingSink();
    await adapter.listen(3000);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink };
      (request as unknown as Record<symbol, typeof intent>)[UPGRADE_INTENT] = intent;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 101,
          headers: new Headers(),
          body: null,
        }),
      } as unknown as IResponse);
    });

    await serveOptions().fetch(upgradeRequest(), server);
    // Framework handler was called BEFORE the upgrade handshake
    expect(calls()).toBe(1);
  });

  it('falls through to HTTP when no UPGRADE_INTENT', async () => {
    const { adapter, server, serveOptions, incrementCalls } = build();
    await adapter.listen(3000);

    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      incrementCalls();
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 200,
          headers: new Headers(),
          body: 'http',
        }),
      } as unknown as IResponse);
    });

    const result = await serveOptions().fetch(new Request('http://localhost/page'), server);
    expect(result?.status).toBe(200);
    expect(await result?.text()).toBe('http');
  });

  it('keeps IHttpAdapter.fetch on the plain HTTP path', async () => {
    const { adapter, incrementCalls } = build();

    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      incrementCalls();
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 200,
          headers: new Headers(),
          body: 'http',
        }),
      } as unknown as IResponse);
    });

    const result = await adapter.fetch(upgradeRequest());
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('http');
  });
});
