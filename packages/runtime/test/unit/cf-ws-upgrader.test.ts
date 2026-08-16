import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest, IResponse, WebSocketEventSink } from '@setu-ts/common';
import { UPGRADE_INTENT } from '@setu-ts/common';
import {
  bindCloudflareSocketToSink,
  buildUpgradeResponseInit,
  type CloudflareServerSocket,
  type CloudflareWebSocketHost,
  createDefaultCloudflareWebSocketHost,
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
        const response = new Response(null, {
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
      createUpgradeResponse: () => new Response(null, { status: 101 }),
    };
    const adapter = new CloudflareWorkersHttpAdapter(failingHost);
    let frameworkCalls = 0;

    adapter.setHandler((request: IRequest): Promise<IResponse> => {
      frameworkCalls++;
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
