import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IResponse, WebSocketEventSink } from '@setu-ts/common';
import {
  adaptWsModule,
  asUpgradeEmitter,
  bindWsSocketToSink,
  createUpgradeRequest,
  createWsTransport,
  NodeUpgradeCoordinator,
  rejectRawUpgrade,
  toWsReadyState,
  type WsModuleLike,
  type WsServerLike,
  type WsSocketLike,
} from '../../src/adapters/node/node-ws-upgrader.ts';
import {
  NodeHttpAdapter,
  type NodeServeHost,
  type NodeServer,
} from '../../src/adapters/node/node-http-adapter.ts';

/** A `ws`-shaped socket driven by `.on(event, listener)`. */
function fakeWsSocket(readyState = 1): WsSocketLike & {
  emit(event: string, ...args: unknown[]): void;
  sent: (string | Uint8Array)[];
  closes: unknown[];
} {
  const listeners = new Map<string, (...args: never[]) => void>();
  const sent: (string | Uint8Array)[] = [];
  const closes: unknown[] = [];
  return {
    readyState,
    sent,
    closes,
    send: (data) => void sent.push(data),
    close: (code, reason) => void closes.push({ code, reason }),
    on: (event, listener) => void listeners.set(event, listener),
    emit(event: string, ...args: unknown[]): void {
      (listeners.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
    },
  };
}

function recordingSink(): WebSocketEventSink & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    onOpen: (transport) => void events.push(`open:${transport.readyState}`),
    onMessage: (data) => void events.push(`message:${String(data)}`),
    onClose: (event) => void events.push(`close:${event.code}:${event.reason}`),
    onError: (error) => void events.push(`error:${error.message}`),
  };
}

describe('toWsReadyState', () => {
  it('maps every ws numeric state', () => {
    expect(toWsReadyState(0)).toBe('connecting');
    expect(toWsReadyState(1)).toBe('open');
    expect(toWsReadyState(2)).toBe('closing');
    expect(toWsReadyState(3)).toBe('closed');
    expect(toWsReadyState(42)).toBe('closed');
  });
});

describe('createWsTransport', () => {
  it('forwards sends and closes and reports live state', () => {
    const socket = fakeWsSocket(0);
    const transport = createWsTransport(socket);
    expect(transport.readyState).toBe('connecting');

    (socket as { readyState: number }).readyState = 1;
    transport.send('hi');
    transport.close(1000, 'done');

    expect(transport.readyState).toBe('open');
    expect(socket.sent).toEqual(['hi']);
    expect(socket.closes).toEqual([{ code: 1000, reason: 'done' }]);
  });
});

describe('adaptWsModule', () => {
  it('narrows a module exposing WebSocketServer', () => {
    class FakeServer {}
    const adapted = adaptWsModule({ WebSocketServer: FakeServer });

    expect(adapted.WebSocketServer).toBe(FakeServer);
  });

  it('rejects a non-object module', () => {
    expect(() => adaptWsModule(null)).toThrow('module namespace');
    expect(() => adaptWsModule('ws')).toThrow('module namespace');
  });

  it('rejects a module without a WebSocketServer constructor', () => {
    expect(() => adaptWsModule({})).toThrow('WebSocketServer constructor');
    expect(() => adaptWsModule({ WebSocketServer: 'nope' })).toThrow('WebSocketServer constructor');
  });
});

describe('asUpgradeEmitter', () => {
  it('returns the emitter when the handle can subscribe', () => {
    const server = { on: () => {} };

    expect(asUpgradeEmitter(server)).toBe(server);
  });

  it('returns null for a handle that emits nothing', () => {
    expect(asUpgradeEmitter({ close: () => {} })).toBeNull();
    expect(asUpgradeEmitter(null)).toBeNull();
    expect(asUpgradeEmitter('server')).toBeNull();
  });
});

describe('createUpgradeRequest', () => {
  it('rebuilds a web Request from Node upgrade arguments', () => {
    const request = createUpgradeRequest({
      url: '/ws/chat?room=general',
      method: 'GET',
      headers: { host: 'example.com:8080', upgrade: 'websocket' },
    });

    expect(request.url).toBe('http://example.com:8080/ws/chat?room=general');
    expect(request.headers.get('upgrade')).toBe('websocket');
  });

  it('flattens a multi-valued header', () => {
    const request = createUpgradeRequest({
      headers: { 'x-forwarded-for': ['10.0.0.1', '10.0.0.2'] },
    });

    expect(request.headers.get('x-forwarded-for')).toBe('10.0.0.1, 10.0.0.2');
  });

  it('skips undefined header values', () => {
    const request = createUpgradeRequest({ headers: { 'x-absent': undefined } });

    expect(request.headers.get('x-absent')).toBeNull();
  });

  it('defaults the host and target when Node reports neither', () => {
    const request = createUpgradeRequest({ headers: {} });

    expect(request.url).toBe('http://localhost/');
    expect(request.method).toBe('GET');
  });
});

describe('bindWsSocketToSink', () => {
  it('signals open immediately, since ws hands over a live socket', () => {
    const socket = fakeWsSocket();
    const sink = recordingSink();

    bindWsSocketToSink(socket, sink);

    expect(sink.events).toEqual(['open:open']);
  });

  it('decodes a text frame that ws delivered as bytes', () => {
    const socket = fakeWsSocket();
    const sink = recordingSink();
    bindWsSocketToSink(socket, sink);

    // ws hands text frames over as Buffers, flagged by isBinary === false.
    socket.emit('message', new TextEncoder().encode('hello'), false);

    expect(sink.events).toContain('message:hello');
  });

  it('keeps a binary frame as bytes', () => {
    const socket = fakeWsSocket();
    const received: unknown[] = [];
    bindWsSocketToSink(socket, {
      onOpen: () => {},
      onMessage: (data) => void received.push(data),
      onClose: () => {},
      onError: () => {},
    });

    socket.emit('message', new Uint8Array([1, 2, 3]), true);

    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('decodes the close reason Buffer', () => {
    const socket = fakeWsSocket();
    const sink = recordingSink();
    bindWsSocketToSink(socket, sink);

    socket.emit('close', 1001, new TextEncoder().encode('going away'));

    expect(sink.events).toContain('close:1001:going away');
  });

  it('defaults a close with no code or reason', () => {
    const socket = fakeWsSocket();
    const sink = recordingSink();
    bindWsSocketToSink(socket, sink);

    socket.emit('close', undefined, undefined);

    expect(sink.events).toContain('close:1006:');
  });

  it('forwards socket errors', () => {
    const socket = fakeWsSocket();
    const sink = recordingSink();
    bindWsSocketToSink(socket, sink);

    socket.emit('error', new Error('ECONNRESET'));

    expect(sink.events).toContain('error:ECONNRESET');
  });
});

describe('NodeUpgradeCoordinator', () => {
  function fakeModule(options?: { throwOnHandshake?: boolean }) {
    const socket = fakeWsSocket();
    const handshakes: unknown[][] = [];
    const closes: number[] = [];
    let constructedWith: unknown = null;

    const module: WsModuleLike = {
      WebSocketServer: class implements WsServerLike {
        constructor(opts: unknown) {
          constructedWith = opts;
        }
        handleUpgrade(
          request: unknown,
          sock: unknown,
          head: unknown,
          callback: (ws: WsSocketLike) => void,
        ): void {
          handshakes.push([request, sock, head]);
          if (options?.throwOnHandshake === true) {
            throw new Error('handshake failed');
          }
          callback(socket);
        }
        close(): void {
          closes.push(1);
        }
      },
    };

    return { module, socket, handshakes, closes, constructedWith: () => constructedWith };
  }

  const incoming = { url: '/ws', method: 'GET', headers: {} };

  it('creates no ws server until the first accepted upgrade', () => {
    const { module } = fakeModule();

    expect(new NodeUpgradeCoordinator(module).hasServer).toBe(false);
  });

  it('creates the server in noServer mode and binds the socket', async () => {
    const { module, handshakes, constructedWith } = fakeModule();
    const coordinator = new NodeUpgradeCoordinator(module);
    const sink = recordingSink();

    await coordinator.handshake(incoming, {}, new Uint8Array(), sink);

    expect((constructedWith() as { noServer: boolean }).noServer).toBe(true);
    expect(handshakes).toHaveLength(1);
    expect(sink.events).toEqual(['open:open']);
    expect(coordinator.hasServer).toBe(true);
  });

  it('reuses the same ws server across upgrades', async () => {
    const { module, handshakes } = fakeModule();
    const coordinator = new NodeUpgradeCoordinator(module);

    await coordinator.handshake(incoming, {}, new Uint8Array(), recordingSink());
    await coordinator.handshake(incoming, {}, new Uint8Array(), recordingSink());

    expect(handshakes).toHaveLength(2);
  });

  it('hands the negotiated subprotocol to ws through handleProtocols', async () => {
    const { module, constructedWith } = fakeModule();
    const coordinator = new NodeUpgradeCoordinator(module);

    await coordinator.handshake(incoming, {}, new Uint8Array(), recordingSink(), 'chat');

    const opts = constructedWith() as { handleProtocols: () => string | false };
    expect(opts.handleProtocols()).toBe('chat');
  });

  it('selects no subprotocol when none was negotiated', async () => {
    const { module, constructedWith } = fakeModule();
    const coordinator = new NodeUpgradeCoordinator(module);

    await coordinator.handshake(incoming, {}, new Uint8Array(), recordingSink());

    const opts = constructedWith() as { handleProtocols: () => string | false };
    expect(opts.handleProtocols()).toBe(false);
  });

  it('propagates a handshake failure to the caller', async () => {
    const { module } = fakeModule({ throwOnHandshake: true });
    const coordinator = new NodeUpgradeCoordinator(module);

    await expect(
      coordinator.handshake(incoming, {}, new Uint8Array(), recordingSink()),
    ).rejects.toThrow('handshake failed');
  });

  it('closes the server and forgets it, idempotently', async () => {
    const { module, closes } = fakeModule();
    const coordinator = new NodeUpgradeCoordinator(module);
    await coordinator.handshake(incoming, {}, new Uint8Array(), recordingSink());

    coordinator.close();
    coordinator.close();

    expect(closes).toHaveLength(1);
    expect(coordinator.hasServer).toBe(false);
  });

  it('closes as a no-op when no server was ever created', () => {
    const { module, closes } = fakeModule();

    new NodeUpgradeCoordinator(module).close();

    expect(closes).toEqual([]);
  });
});

describe('rejectRawUpgrade', () => {
  function fakeRawSocket() {
    const writes: string[] = [];
    let destroyed = false;
    return {
      writes,
      destroyed: () => destroyed,
      write: (data: string) => void writes.push(data),
      destroy: () => {
        destroyed = true;
      },
    };
  }

  it('writes a status line and destroys the socket', () => {
    const socket = fakeRawSocket();

    rejectRawUpgrade(socket, 400);

    expect(socket.writes[0]).toBe('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    expect(socket.destroyed()).toBe(true);
  });

  it('names each status it can answer with', () => {
    for (
      const [status, reason] of [
        [503, 'Service Unavailable'],
        [501, 'Not Implemented'],
        [500, 'Internal Server Error'],
        [418, 'Bad Request'],
      ] as const
    ) {
      const socket = fakeRawSocket();
      rejectRawUpgrade(socket, status);
      expect(socket.writes[0]).toContain(`${status} ${reason}`);
    }
  });
});

describe('NodeHttpAdapter WebSocket upgrade', () => {
  interface UpgradeArgs {
    incoming: { url?: string; method?: string; headers: Record<string, string> };
    socket: { writes: string[]; write(d: string): void; destroy(): void };
    head: unknown;
  }

  function build(options?: { omitOn?: boolean; handleUpgradeThrows?: boolean }) {
    const wsSocket = fakeWsSocket();
    const handleUpgradeCalls: unknown[][] = [];
    let constructedWith: unknown = null;

    const wsModule: WsModuleLike = {
      WebSocketServer: class implements WsServerLike {
        constructor(opts: unknown) {
          constructedWith = opts;
        }
        handleUpgrade(
          request: unknown,
          socket: unknown,
          head: unknown,
          callback: (ws: WsSocketLike) => void,
        ): void {
          handleUpgradeCalls.push([request, socket, head]);
          if (options?.handleUpgradeThrows === true) {
            throw new Error('handshake failed');
          }
          callback(wsSocket);
        }
        close(): void {}
      },
    };

    let upgradeListener: ((...args: never[]) => void) | null = null;
    const server: NodeServer = {
      close: () => {},
      ...(options?.omitOn === true ? {} : {
        on: (_event: string, listener: (...args: never[]) => void) => {
          upgradeListener = listener;
        },
      }),
    };

    const host: NodeServeHost = { serve: () => Promise.resolve(server) };
    const adapter = new NodeHttpAdapter(host, wsModule);
    adapter.setHandler(() =>
      Promise.resolve({
        snapshot: () => ({
          streaming: false as const,
          status: 200,
          headers: new Headers(),
          body: 'http',
        }),
      } as unknown as IResponse)
    );

    function rawSocket() {
      const writes: string[] = [];
      return { writes, write: (d: string) => void writes.push(d), destroy: () => {} };
    }

    async function emitUpgrade(args: Partial<UpgradeArgs> = {}) {
      const socket = args.socket ?? rawSocket();
      upgradeListener?.(
        ...([
          args.incoming ?? {
            url: '/ws',
            method: 'GET',
            headers: { host: 'localhost', upgrade: 'websocket', connection: 'Upgrade' },
          },
          socket,
          args.head ?? new Uint8Array(),
        ] as never[]),
      );
      // The listener is synchronous but its work is async.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return socket;
    }

    return {
      adapter,
      wsSocket,
      handleUpgradeCalls,
      emitUpgrade,
      hasListener: () => upgradeListener !== null,
      constructedWith: () => constructedWith,
    };
  }

  it('attaches no upgrade listener when no router was installed', async () => {
    const harness = build();

    await harness.adapter.listen(3000);

    expect(harness.hasListener()).toBe(false);
  });

  it('attaches no listener when the server handle emits nothing', async () => {
    const harness = build({ omitOn: true });
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink() })
    );

    await harness.adapter.listen(3000);

    expect(harness.hasListener()).toBe(false);
  });

  it('completes the handshake and binds the socket to the sink', async () => {
    const harness = build();
    const sink = recordingSink();
    harness.adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));
    await harness.adapter.listen(3000);

    await harness.emitUpgrade();

    expect(harness.handleUpgradeCalls).toHaveLength(1);
    expect(sink.events).toEqual(['open:open']);
  });

  it('creates the ws server in noServer mode with a protocol selector', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink(), protocol: 'chat' })
    );
    await harness.adapter.listen(3000);

    await harness.emitUpgrade();

    const opts = harness.constructedWith() as {
      noServer: boolean;
      handleProtocols: () => string | false;
    };
    expect(opts.noServer).toBe(true);
    expect(opts.handleProtocols()).toBe('chat');
  });

  it('selects no protocol when the decision negotiated none', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink() })
    );
    await harness.adapter.listen(3000);

    await harness.emitUpgrade();

    const opts = harness.constructedWith() as { handleProtocols: () => string | false };
    expect(opts.handleProtocols()).toBe(false);
  });

  it('refuses on the raw socket when the router rejects', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() => Promise.resolve({ accept: false, status: 503 }));
    await harness.adapter.listen(3000);

    const socket = await harness.emitUpgrade();

    expect(socket.writes[0]).toContain('503 Service Unavailable');
    expect(harness.handleUpgradeCalls).toHaveLength(0);
  });

  it('refuses with 400 when no route matches, rather than hanging the client', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() => Promise.resolve(null));
    await harness.adapter.listen(3000);

    const socket = await harness.emitUpgrade();

    expect(socket.writes[0]).toContain('400 Bad Request');
  });

  it('refuses with 500 and releases the sink when the handshake itself throws', async () => {
    const harness = build({ handleUpgradeThrows: true });
    const sink = recordingSink();
    harness.adapter.setUpgradeRouter(() => Promise.resolve({ accept: true, sink }));
    await harness.adapter.listen(3000);

    const socket = await harness.emitUpgrade();

    // The listener cannot be async, so a rejection there must not escape as an
    // unhandled one — it becomes a 500 on the raw socket.
    expect(harness.handleUpgradeCalls).toHaveLength(1);
    expect(socket.writes[0]).toContain('500 Internal Server Error');
    // And the consumer's reserved slot is released rather than leaked.
    expect(sink.events).toEqual(['close:1006:handshake failed']);
  });

  it('defaults the request target when Node reports no url', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink() })
    );
    await harness.adapter.listen(3000);

    await harness.emitUpgrade({
      incoming: { headers: { upgrade: 'websocket', connection: 'Upgrade' } },
    });

    expect(harness.handleUpgradeCalls).toHaveLength(1);
  });

  it('refuses a raw upgrade event that is not a WebSocket handshake', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink() })
    );
    await harness.adapter.listen(3000);

    // An `upgrade` event for some other protocol (h2c) must not be handshaken.
    const socket = await harness.emitUpgrade({
      incoming: { headers: { upgrade: 'h2c', connection: 'Upgrade' } },
    });

    expect(harness.handleUpgradeCalls).toHaveLength(0);
    expect(socket.writes[0]).toContain('400 Bad Request');
  });

  it('closes the ws server when the adapter closes', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink() })
    );
    const handle = await harness.adapter.listen(3000);
    await harness.emitUpgrade();

    await expect(harness.adapter.close(handle)).resolves.toBeUndefined();
  });

  it('rejects a foreign server handle', async () => {
    const harness = build();
    await harness.adapter.listen(3000);

    expect(() => harness.adapter.close({})).toThrow('Invalid server handle');
  });

  it('leaves the plain HTTP fetch path untouched', async () => {
    const harness = build();
    harness.adapter.setUpgradeRouter(() =>
      Promise.resolve({ accept: true, sink: recordingSink() })
    );

    const response = await harness.adapter.fetch(
      new Request('http://localhost/ws', {
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      }),
    );

    // Node upgrades never travel the fetch path — they arrive on the raw
    // `upgrade` event — so this is ordinary HTTP.
    expect(response.status).toBe(200);
  });
});
