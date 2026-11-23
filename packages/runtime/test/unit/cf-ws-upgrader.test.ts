import { WorkersResponse } from '../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
import { upgradeResponse } from '../../../../test/node-helpers.ts';
import { describe, expect, it } from 'vitest';
import type { IRequest, IResponse, IWebSocketTransport, WebSocketEventSink } from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import {
  bindCloudflareSocketToSink,
  buildUpgradeResponseInit,
  type CloudflareServerSocket,
  type CloudflareWebSocketHost,
  createDefaultCloudflareWebSocketHost,
  WORKERS_WS_MAX_MESSAGE_BYTES,
} from '../../src/adapters/workers/cf-ws-upgrader.ts';
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';

function fakeServerSocket(): CloudflareServerSocket & {
  accepted: boolean;
  emit(type: string, event: unknown): void;
  sent: (string | Uint8Array)[];
} {
  const listeners = new Map<string, (event: never) => void>();
  const sent: (string | Uint8Array)[] = [];
  return {
    readyState: 1,
    accepted: false,
    sent,
    accept(): void {
      this.accepted = true;
    },
    addEventListener(type: string, listener: (event: never) => void): void {
      listeners.set(type, listener);
    },
    emit(type: string, event: unknown): void {
      listeners.get(type)?.(event as never);
    },
    send(data: string | Uint8Array): void {
      sent.push(data);
    },
    close(): void {},
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

describe('bindCloudflareSocketToSink', () => {
  it('accepts the socket and signals open immediately', () => {
    const socket = fakeServerSocket();
    const sink = recordingSink();
    bindCloudflareSocketToSink(socket, sink);
    expect(socket.accepted).toBe(true);
    expect(sink.events).toEqual(['open:open']);
  });

  it('routes message, close, and error events to the sink', () => {
    const socket = fakeServerSocket();
    const sink = recordingSink();
    bindCloudflareSocketToSink(socket, sink);
    socket.emit('message', { data: 'hello' });
    socket.emit('error', new Error('bad frame'));
    socket.emit('close', { code: 1000, reason: 'bye' });
    expect(sink.events).toEqual([
      'open:open',
      'message:hello',
      'error:bad frame',
      'close:1000:bye',
    ]);
  });

  it('defaults a close event that carries no code or reason', () => {
    const socket = fakeServerSocket();
    const sink = recordingSink();
    bindCloudflareSocketToSink(socket, sink);
    socket.emit('close', {});
    expect(sink.events).toContain('close:1006:');
  });
});

describe('createDefaultCloudflareWebSocketHost', () => {
  it('throws a clear error when WebSocketPair is absent from the runtime', () => {
    const host = createDefaultCloudflareWebSocketHost();
    expect(() => host.createPair()).toThrow('WebSocketPair is not available');
  });

  it('builds a 101 response', () => {
    const host = createDefaultCloudflareWebSocketHost();
    expect(host.createUpgradeResponse({ id: 'client-half' }).status).toBe(101);
  });

  it('echoes a negotiated subprotocol on the response', () => {
    const host = createDefaultCloudflareWebSocketHost();
    const response = host.createUpgradeResponse({}, 'chat');
    expect(response.headers.get('sec-websocket-protocol')).toBe('chat');
  });
});

describe('buildUpgradeResponseInit', () => {
  it('hands the client half back under the Workers webSocket member', () => {
    const client = { id: 'client-half' };
    const init = buildUpgradeResponseInit(client);
    expect(init.status).toBe(101);
    expect(init.webSocket).toBe(client);
    expect(init.headers.get('sec-websocket-protocol')).toBeNull();
  });

  it('sets the subprotocol header only when one was negotiated', () => {
    expect(buildUpgradeResponseInit({}, 'json').headers.get('sec-websocket-protocol')).toBe('json');
  });
});

describe('createDefaultCloudflareWebSocketHost createPair', () => {
  it('builds a pair from a WebSocketPair global when one exists', () => {
    const socket = fakeServerSocket();
    const scope = globalThis as { WebSocketPair?: unknown };
    scope.WebSocketPair = class {
      0 = { id: 'client' };
      1 = socket;
    };
    try {
      const pair = createDefaultCloudflareWebSocketHost().createPair();
      expect(pair.server).toBe(socket);
      expect(pair.client).toEqual({ id: 'client' });
    } finally {
      delete scope.WebSocketPair;
    }
  });

  it('throws when the pair constructor yields no halves', () => {
    const scope = globalThis as { WebSocketPair?: unknown };
    scope.WebSocketPair = class {};
    try {
      expect(() => createDefaultCloudflareWebSocketHost().createPair()).toThrow(
        'did not produce a client/server pair',
      );
    } finally {
      delete scope.WebSocketPair;
    }
  });
});

describe('CloudflareWorkersHttpAdapter WebSocket upgrade (post-M70a)', () => {
  function build() {
    const socket = fakeServerSocket();
    const responses: Response[] = [];
    let frameworkHandlerCalls = 0;

    const host: CloudflareWebSocketHost = {
      createPair: () => ({ client: { id: 'client' }, server: socket }),
      createUpgradeResponse: (_client, protocol) => {
        const response = upgradeResponse(null, {
          status: 101,
          ...(protocol !== undefined && { headers: { 'sec-websocket-protocol': protocol } }),
        });
        responses.push(response);
        return response;
      },
    };

    const adapter = new CloudflareWorkersHttpAdapter(host);

    return {
      adapter,
      socket,
      responses,
      calls: () => frameworkHandlerCalls,
      incrementCalls: () => frameworkHandlerCalls++,
    };
  }

  it('answers upgrade when framework handler writes UPGRADE_INTENT', async () => {
    const { adapter, socket, calls, incrementCalls } = build();
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

    const response = await adapter.fetch(upgradeRequest());
    expect(response.status).toBe(101);
    expect(socket.accepted).toBe(true);
    expect(sink.events).toEqual(['open:open']);
    expect(calls()).toBe(1);
  });

  it('echoes the negotiated subprotocol', async () => {
    const { adapter, incrementCalls } = build();
    const sink = recordingSink();

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      incrementCalls();
      const intent = { sink, protocol: 'json' };
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

    const response = await adapter.fetch(upgradeRequest());
    expect(response.headers.get('sec-websocket-protocol')).toBe('json');
  });

  it('falls through to HTTP when no UPGRADE_INTENT', async () => {
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

    const response = await adapter.fetch(upgradeRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('http');
  });

  it('releases the sink when the pair cannot be created', async () => {
    const sink = recordingSink();
    const failingHost: CloudflareWebSocketHost = {
      createPair: () => {
        throw new Error('WebSocketPair is not available');
      },
      createUpgradeResponse: () => upgradeResponse(null, { status: 101 }),
    };
    const adapter = new CloudflareWorkersHttpAdapter(failingHost);

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
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

    const response = await adapter.fetch(upgradeRequest());
    expect(response.status).toBe(500);
    expect(sink.events).toEqual(['close:1006:WebSocketPair is not available']);
  });

  it('still refuses listen, since Workers has no socket model', () => {
    const { adapter } = build();
    expect(() => adapter.listen(3000)).toThrow('no listen(port) model');
  });

  it('closes as a no-op', async () => {
    const { adapter } = build();
    await expect(adapter.close({})).resolves.toBeUndefined();
  });
});

describe('Workers transport: tracked state and the close reply (V13-195, V13-203)', () => {
  /** A socket whose native readyState and close calls are recorded. */
  function tracedSocket(options?: { closeThrows?: boolean }) {
    const base = fakeServerSocket();
    const closes: { code: number | undefined; reason: string | undefined }[] = [];
    let nativeReads = 0;
    const socket = Object.assign(base, {
      close(code?: number, reason?: string): void {
        closes.push({ code, reason });
        if (options?.closeThrows === true) throw new Error('already replied');
      },
    });
    Object.defineProperty(socket, 'readyState', {
      get: () => {
        nativeReads++;
        return 1;
      },
    });
    return { socket, closes, nativeReads: () => nativeReads };
  }

  function openTransport(socket: CloudflareServerSocket) {
    let transport!: IWebSocketTransport;
    const events: string[] = [];
    bindCloudflareSocketToSink(socket, {
      onOpen: (t) => {
        transport = t;
      },
      onMessage: () => {},
      onClose: (event) => {
        events.push(`close:${event.code}`);
      },
      onError: () => {},
    });
    return { transport, events };
  }

  it('tracks open, closing and closed without reading the native readyState', () => {
    const { socket, nativeReads } = tracedSocket();
    const { transport } = openTransport(socket);
    expect(transport.readyState).toBe('open');
    transport.close(1000, 'bye');
    expect(transport.readyState).toBe('closing');
    socket.emit('close', { code: 1000, reason: 'bye' });
    expect(transport.readyState).toBe('closed');
    expect(nativeReads()).toBe(0);
  });

  it('marks the transport closed on an error event', () => {
    const { socket } = tracedSocket();
    const { transport } = openTransport(socket);
    socket.emit('error', new Error('x'));
    expect(transport.readyState).toBe('closed');
  });

  it("answers the peer's close once, echoing a sendable code, before telling the sink", () => {
    const { socket, closes } = tracedSocket();
    const { events } = openTransport(socket);
    socket.emit('close', { code: 4001, reason: 'done' });
    expect(closes).toEqual([{ code: 4001, reason: 'done' }]);
    expect(events).toEqual(['close:4001']);
  });

  it.each([1004, 1005, 1006, 1015, 1016, 2999, 999, 5000])(
    'answers the unsendable code %s with 1000, reporting the received code to the sink',
    (code) => {
      const { socket, closes } = tracedSocket();
      const { events } = openTransport(socket);
      socket.emit('close', { code, reason: '' });
      expect(closes[0]?.code).toBe(1000);
      expect(events).toEqual([`close:${code}`]);
    },
  );

  it.each([1000, 1003, 1007, 1014, 3000, 4999])('echoes the sendable code %s', (code) => {
    const { socket, closes } = tracedSocket();
    openTransport(socket);
    socket.emit('close', { code });
    expect(closes[0]).toEqual({ code, reason: '' });
  });

  it('swallows a reply the runtime already sent (web_socket_auto_reply_to_close)', () => {
    const { socket } = tracedSocket({ closeThrows: true });
    const { events } = openTransport(socket);
    expect(() => socket.emit('close', { code: 1000 })).not.toThrow();
    expect(events).toEqual(['close:1000']);
  });

  it('does not answer a close the server started itself', () => {
    const { socket, closes } = tracedSocket();
    const { transport } = openTransport(socket);
    transport.close(1000, 'server');
    socket.emit('close', { code: 1000, reason: 'server' });
    expect(closes).toHaveLength(1);
  });

  it('stays open when a local close throws, so the peer close is still answered', () => {
    const { socket, closes } = tracedSocket({ closeThrows: true });
    const { transport } = openTransport(socket);
    expect(() => transport.close(1005)).toThrow('already replied');
    expect(transport.readyState).toBe('open');
    socket.emit('close', { code: 1000 });
    expect(closes).toHaveLength(2);
  });

  it('sends through the native socket', () => {
    const { socket } = tracedSocket();
    const { transport } = openTransport(socket);
    transport.send('hello');
    expect(socket.sent).toEqual(['hello']);
  });
});

describe('Workers WebSocket ceiling (V13-41)', () => {
  function adapterWith(records: Readonly<Record<string, unknown>>[]) {
    const host: CloudflareWebSocketHost = {
      createPair: () => ({ client: {}, server: fakeServerSocket() }),
      createUpgradeResponse: () => upgradeResponse(null, { status: 101 }),
    };
    return new CloudflareWorkersHttpAdapter(host, {
      reportError: (record) => {
        records.push(record);
      },
    });
  }

  async function upgradeWith(adapter: CloudflareWorkersHttpAdapter, maxMessageBytes?: number) {
    const sink = {
      ...recordingSink(),
      ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    };
    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      (request as unknown as Record<symbol, unknown>)[UPGRADE_INTENT] = { sink };
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
  }

  it('is 32 MiB', () => {
    expect(WORKERS_WS_MAX_MESSAGE_BYTES).toBe(33_554_432);
  });

  it.each([0, WORKERS_WS_MAX_MESSAGE_BYTES + 1])(
    'reports a limit of %s once per server, across two handshakes',
    async (limit) => {
      const records: Readonly<Record<string, unknown>>[] = [];
      const adapter = adapterWith(records);
      await upgradeWith(adapter, limit);
      await upgradeWith(adapter, limit);
      expect(records).toEqual([
        {
          level: 'warn',
          msg: 'WebSocket message limit exceeds the runtime ceiling',
          configured: limit,
          ceiling: WORKERS_WS_MAX_MESSAGE_BYTES,
          platform: 'cloudflare-workers',
        },
      ]);
    },
  );

  it.each([undefined, 1, WORKERS_WS_MAX_MESSAGE_BYTES])(
    'says nothing for a limit of %s',
    async (limit) => {
      const records: Readonly<Record<string, unknown>>[] = [];
      const adapter = adapterWith(records);
      await upgradeWith(adapter, limit);
      expect(records).toEqual([]);
    },
  );
});
