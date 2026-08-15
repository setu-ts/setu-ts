import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse, WebSocketEventSink } from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import {
  bindDenoSocketToSink,
  type DenoWebSocketLike,
} from '../../src/adapters/deno/deno-ws-upgrader.ts';
import { DenoHttpAdapter, type DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';

function fakeSocket(): DenoWebSocketLike & { sent: (string | Uint8Array)[] } {
  const sent: (string | Uint8Array)[] = [];
  return {
    readyState: 1,
    send: (data) => {
      sent.push(data);
    },
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent,
  };
}

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

function upgradeRequest(url = 'http://localhost/ws'): Request {
  return new Request(url, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
}

describe('bindDenoSocketToSink', () => {
  it('drives every sink callback from the socket handlers', () => {
    const socket = fakeSocket();
    const sink = recordingSink();
    bindDenoSocketToSink(socket, sink);
    socket.onopen?.({});
    socket.onmessage?.({ data: 'hello' });
    socket.onerror?.(new Error('socket died'));
    socket.onclose?.({ code: 1000, reason: 'bye' });
    expect(sink.events).toEqual([
      'open:open',
      'message:hello',
      'error:socket died',
      'close:1000:bye',
    ]);
  });

  it('normalizes a binary frame before handing it to the sink', () => {
    const socket = fakeSocket();
    const received: unknown[] = [];
    bindDenoSocketToSink(socket, {
      onOpen: () => {},
      onMessage: (data) => {
        received.push(data);
      },
      onClose: () => {},
      onError: () => {},
    });
    socket.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2]);
  });

  it('coerces a non-Error error event', () => {
    const socket = fakeSocket();
    const sink = recordingSink();
    bindDenoSocketToSink(socket, sink);
    socket.onerror?.({ type: 'error' });
    expect(sink.events).toEqual(['error:WebSocket transport error']);
  });

  it('gives the sink a transport that writes to the socket', () => {
    const socket = fakeSocket();
    bindDenoSocketToSink(socket, {
      onOpen: (transport) => transport.send('from sink'),
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    });
    socket.onopen?.({});
    expect(socket.sent).toEqual(['from sink']);
  });
});

describe('DenoHttpAdapter WebSocket upgrade (post-M70a)', () => {
  function build(options?: { omitUpgrade?: boolean; upgradeThrows?: unknown }) {
    const socket = fakeSocket();
    const response = new Response(null, { status: 101 });
    const upgradeCalls: { request: Request; protocol?: string }[] = [];
    let frameworkHandlerCalls = 0;

    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      ...(options?.omitUpgrade === true ? {} : {
        upgradeWebSocket: (request: Request, opts?: { protocol?: string }) => {
          if (options?.upgradeThrows !== undefined) throw options.upgradeThrows;
          upgradeCalls.push({
            request,
            ...(opts?.protocol !== undefined && { protocol: opts.protocol }),
          });
          return { socket, response };
        },
      }),
    };

    const adapter = new DenoHttpAdapter(host);

    return {
      adapter,
      socket,
      response,
      upgradeCalls,
      calls: () => frameworkHandlerCalls,
      incrementCalls: () => frameworkHandlerCalls++,
    };
  }

  it('completes the handshake when framework handler writes UPGRADE_INTENT', async () => {
    const { adapter, response, upgradeCalls, incrementCalls } = build();
    const sink = recordingSink();

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

    const result = await adapter.fetch(upgradeRequest());
    expect(result).toBe(response);
    expect(upgradeCalls).toHaveLength(1);
  });

  it('framework handler runs before the handshake (pipeline first)', async () => {
    const { adapter, calls, incrementCalls } = build();
    const sink = recordingSink();

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

    await adapter.fetch(upgradeRequest());
    expect(calls()).toBe(1);
  });

  it('binds the accepted socket to the sink', async () => {
    const { adapter, socket, incrementCalls } = build();
    const sink = recordingSink();

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

    await adapter.fetch(upgradeRequest());
    socket.onopen?.({});
    socket.onmessage?.({ data: 'ping' });
    expect(sink.events).toEqual(['open:open', 'message:ping']);
  });

  it('forwards a negotiated subprotocol to the runtime', async () => {
    const { adapter, upgradeCalls, incrementCalls } = build();

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink: recordingSink(), protocol: 'chat' };
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

    await adapter.fetch(upgradeRequest());
    expect(upgradeCalls[0]?.protocol).toBe('chat');
  });

  it('falls through to HTTP when no UPGRADE_INTENT written', async () => {
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

  it('answers 501 when the injected host cannot handshake', async () => {
    const { adapter, incrementCalls } = build({ omitUpgrade: true });
    const sink = recordingSink();

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

    const result = await adapter.fetch(upgradeRequest());
    expect(result.status).toBe(501);
    expect(sink.events).toEqual(['close:1006:Upgrade unsupported']);
  });

  it('releases the sink when the runtime handshake throws', async () => {
    const { adapter, calls, incrementCalls } = build({ upgradeThrows: new Error('bad handshake') });
    const sink = recordingSink();

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

    const result = await adapter.fetch(upgradeRequest());
    expect(result.status).toBe(400);
    expect(sink.events).toEqual(['close:1006:bad handshake']);
    expect(calls()).toBe(1);
  });

  it('reports a generic reason when the handshake throws a non-Error', async () => {
    const { adapter, incrementCalls } = build({ upgradeThrows: 'not an error object' });
    const sink = recordingSink();

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

    const result = await adapter.fetch(upgradeRequest());
    expect(result.status).toBe(400);
    expect(sink.events).toEqual(['close:1006:Handshake failed']);
  });

  it('serves plain HTTP unchanged when no intent written', async () => {
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
  });
});
