import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse, WebSocketEventSink } from '@hono-enterprise/common';
import {
  bindDenoSocketToSink,
  type DenoWebSocketLike,
} from '../../src/adapters/deno/deno-ws-upgrader.ts';
import { DenoHttpAdapter, type DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';

/** A Deno-shaped socket exposing the `on*` handler properties. */
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

/** Records every sink callback. */
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

describe('DenoHttpAdapter WebSocket upgrade', () => {
  /** Builds an adapter over a host whose upgrade is fully faked. */
  function build(options?: { omitUpgrade?: boolean; upgradeThrows?: unknown }) {
    const socket = fakeSocket();
    const response = new Response(null, { status: 101 });
    const upgradeCalls: { request: Request; protocol?: string }[] = [];
    let frameworkHandlerCalls = 0;

    const host: DenoServeHost = {
      serve: () => ({ shutdown: () => Promise.resolve() }),
      ...(options?.omitUpgrade === true ? {} : {
        upgradeWebSocket: (request: Request, opts?: { protocol?: string }) => {
          if (options?.upgradeThrows !== undefined) {
            // Deno throws on a malformed handshake (e.g. no Sec-WebSocket-Key).
            throw options.upgradeThrows;
          }
          upgradeCalls.push({
            request,
            ...(opts?.protocol !== undefined && {
              protocol: opts.protocol,
            }),
          });
          return { socket, response };
        },
      }),
    };

    const adapter = new DenoHttpAdapter(host);
    adapter.setHandler((_request: IRequest): Promise<IResponse> => {
      frameworkHandlerCalls++;
      return Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 200,
          headers: new Headers(),
          body: 'http',
        }),
      } as unknown as IResponse);
    });

    return { adapter, socket, response, upgradeCalls, calls: () => frameworkHandlerCalls };
  }

  it('completes the handshake and returns the runtime response', async () => {
    const { adapter, response, upgradeCalls } = build();
    const sink = recordingSink();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));

    const result = await adapter.fetch(upgradeRequest());

    expect(result).toBe(response);
    expect(upgradeCalls).toHaveLength(1);
  });

  it('never maps the request to a framework request for an accepted upgrade', async () => {
    // This is the correctness requirement, not an optimization: the shared
    // mapping reads the body, and Deno refuses to upgrade a disturbed request.
    const { adapter, calls } = build();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink: recordingSink() }));

    await adapter.fetch(upgradeRequest());

    expect(calls()).toBe(0);
  });

  it('binds the accepted socket to the sink', async () => {
    const { adapter, socket } = build();
    const sink = recordingSink();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));

    await adapter.fetch(upgradeRequest());
    socket.onopen?.({});
    socket.onmessage?.({ data: 'ping' });

    expect(sink.events).toEqual(['open:open', 'message:ping']);
  });

  it('forwards a negotiated subprotocol to the runtime', async () => {
    const { adapter, upgradeCalls } = build();
    adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink(), protocol: 'chat' })
    );

    await adapter.fetch(upgradeRequest());

    expect(upgradeCalls[0]?.protocol).toBe('chat');
  });

  it('answers a rejection with the decision status', async () => {
    const { adapter, calls } = build();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: false, status: 503 }));

    const result = await adapter.fetch(upgradeRequest());

    expect(result.status).toBe(503);
    expect(calls()).toBe(0);
  });

  it('falls through to the HTTP pipeline when the router returns null', async () => {
    const { adapter, calls } = build();
    adapter.setUpgradeRouter(() => Promise.resolve(null));

    const result = await adapter.fetch(upgradeRequest());

    expect(result.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it('leaves ordinary requests entirely alone', async () => {
    const { adapter, calls, upgradeCalls } = build();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink: recordingSink() }));

    const result = await adapter.fetch(new Request('http://localhost/ws'));

    expect(result.status).toBe(200);
    expect(calls()).toBe(1);
    expect(upgradeCalls).toHaveLength(0);
  });

  it('answers 501 when the injected host cannot handshake, and releases the sink', async () => {
    const { adapter } = build({ omitUpgrade: true });
    const sink = recordingSink();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));

    const result = await adapter.fetch(upgradeRequest());

    expect(result.status).toBe(501);
    // The router already accepted, so the consumer must learn the socket is
    // over — otherwise a reserved connection slot leaks forever.
    expect(sink.events).toEqual(['close:1006:Upgrade unsupported']);
  });

  it('releases the sink when the runtime handshake throws', async () => {
    const { adapter, calls } = build({ upgradeThrows: new Error('bad handshake') });
    const sink = recordingSink();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));

    const result = await adapter.fetch(upgradeRequest());

    // A malformed handshake must not be able to leak slots: without this, a
    // burst of bad upgrades would starve maxConnections permanently.
    expect(result.status).toBe(400);
    expect(sink.events).toEqual(['close:1006:bad handshake']);
    expect(calls()).toBe(0);
  });

  it('reports a generic reason when the handshake throws a non-Error', async () => {
    const { adapter } = build({ upgradeThrows: 'not an error object' });
    const sink = recordingSink();
    adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));

    const result = await adapter.fetch(upgradeRequest());

    expect(result.status).toBe(400);
    expect(sink.events).toEqual(['close:1006:Handshake failed']);
  });

  it('serves plain HTTP unchanged when no router was ever installed', async () => {
    const { adapter, calls } = build();

    const result = await adapter.fetch(upgradeRequest());

    expect(result.status).toBe(200);
    expect(calls()).toBe(1);
  });
});
