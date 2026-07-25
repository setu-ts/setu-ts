import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IWebSocketConnection,
  WebSocketCloseEvent,
  WebSocketEventSink,
} from '@hono-enterprise/common';
import {
  buildContext,
  frameByteLength,
  resolveOptions,
  WebSocketService,
} from '../../src/services/websocket-service.ts';
import { WebSocketUnavailableError } from '../../src/errors/websocket-errors.ts';
import {
  createFakeRuntime,
  createFakeTransport,
  type FakeTransport,
  upgradeRequest,
} from '../fixtures/fake-runtime.ts';

/** Drives the router and returns the accepted sink, failing loudly otherwise. */
async function accept(
  service: WebSocketService,
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocketEventSink> {
  const decision = await service.createUpgradeRouter()(upgradeRequest(url, headers));
  if (decision === null || !decision.accept) {
    throw new Error(`expected an accepted upgrade, got ${JSON.stringify(decision)}`);
  }
  return decision.sink;
}

/** Opens a live connection through the sink and returns its transport. */
function open(sink: WebSocketEventSink): FakeTransport {
  const transport = createFakeTransport();
  sink.onOpen(transport);
  return transport;
}

describe('resolveOptions', () => {
  it('applies inert defaults', () => {
    expect(resolveOptions()).toEqual({
      maxConnections: 0,
      heartbeatMs: 0,
      heartbeatPayload: 'ping',
      idleTimeoutMs: 0,
      maxMessageBytes: 0,
    });
  });

  it('keeps every supplied value', () => {
    expect(
      resolveOptions({
        maxConnections: 10,
        heartbeatMs: 1000,
        heartbeatPayload: 'beat',
        idleTimeoutMs: 5000,
        maxMessageBytes: 64,
      }),
    ).toEqual({
      maxConnections: 10,
      heartbeatMs: 1000,
      heartbeatPayload: 'beat',
      idleTimeoutMs: 5000,
      maxMessageBytes: 64,
    });
  });

  it('refuses an idle timeout with no heartbeat to sweep on', () => {
    expect(() => resolveOptions({ idleTimeoutMs: 1000 })).toThrow('requires heartbeatMs');
  });
});

describe('frameByteLength', () => {
  it('measures text by its UTF-8 encoding, not its string length', () => {
    // 4 characters, 8 bytes — a length-based check would undercount.
    expect('日本語だ'.length).toBe(4);
    expect(frameByteLength('日本語だ')).toBe(12);
  });

  it('measures binary frames by byte length', () => {
    expect(frameByteLength(new Uint8Array(9))).toBe(9);
  });
});

describe('buildContext', () => {
  it('exposes url, path, query, and headers', () => {
    const context = buildContext(
      upgradeRequest('http://localhost/ws/chat?room=general&tab=2', { 'x-token': 'abc' }),
      undefined,
    );

    expect(context.path).toBe('/ws/chat');
    expect(context.query).toEqual({ room: 'general', tab: '2' });
    expect(context.headers.get('x-token')).toBe('abc');
    expect(context.protocol).toBeUndefined();
  });

  it('carries the negotiated protocol when one was selected', () => {
    const context = buildContext(upgradeRequest('http://localhost/ws'), 'chat');

    expect(context.protocol).toBe('chat');
  });
});

describe('WebSocketService', () => {
  function build(options?: Parameters<typeof resolveOptions>[0], available = true) {
    const runtime = createFakeRuntime();
    return { runtime, service: new WebSocketService(runtime, resolveOptions(options), available) };
  }

  it('reports availability and starts empty', () => {
    const { service } = build();

    expect(service.available).toBe(true);
    expect(service.connectionCount).toBe(0);
    expect(service.roomCount).toBe(0);
    expect(service.routeCount).toBe(0);
  });

  it('throws WebSocketUnavailableError when the adapter cannot upgrade', () => {
    const { service } = build(undefined, false);

    expect(service.available).toBe(false);
    expect(() => service.route('/ws', {})).toThrow(WebSocketUnavailableError);
    expect(service.routeCount).toBe(0);
  });

  it('starts the heartbeat once the first route is registered', () => {
    const { runtime, service } = build({ heartbeatMs: 1000 });
    expect(runtime.intervals).toHaveLength(0);

    service.route('/ws', {});

    expect(runtime.intervals).toHaveLength(1);
    expect(service.routeCount).toBe(1);
  });

  it('falls through with null for a path it does not serve', async () => {
    const { service } = build();
    service.route('/ws/known', {});

    const decision = await service.createUpgradeRouter()(
      upgradeRequest('http://localhost/ws/other'),
    );

    expect(decision).toBeNull();
  });

  it('drives onOpen with the connection and its context', async () => {
    const { service } = build();
    let seen: { conn: IWebSocketConnection; room: string | undefined } | null = null;
    service.route('/ws/chat', {
      onOpen: (conn, context) => {
        seen = { conn, room: context.query.room };
      },
    });

    const sink = await accept(service, 'http://localhost/ws/chat?room=general');
    open(sink);

    expect(seen).not.toBeNull();
    expect(seen!.room).toBe('general');
    expect(seen!.conn.path).toBe('/ws/chat');
    expect(service.connectionCount).toBe(1);
  });

  it('delivers inbound frames to onMessage and refreshes the idle stamp', async () => {
    const { runtime, service } = build();
    const received: (string | Uint8Array)[] = [];
    let stampAtMessage = 0;
    service.route('/ws', {
      onMessage: (conn, data) => {
        received.push(data);
        stampAtMessage = (conn as unknown as { lastSeenAt: number }).lastSeenAt;
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);
    runtime.advance(500);
    sink.onMessage('hello');

    expect(received).toEqual(['hello']);
    expect(stampAtMessage).toBe(runtime.hrtime());
  });

  it('closes with 1009 and suppresses onMessage for an oversized frame', async () => {
    const { service } = build({ maxMessageBytes: 4 });
    const received: unknown[] = [];
    service.route('/ws', {
      onMessage: (_conn, data) => {
        received.push(data);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    const transport = open(sink);
    sink.onMessage('this is far too long');

    expect(transport.closes).toEqual([{ code: 1009, reason: 'Message too large' }]);
    expect(received).toEqual([]);
  });

  it('delivers a frame exactly at the size limit', async () => {
    const { service } = build({ maxMessageBytes: 5 });
    const received: unknown[] = [];
    service.route('/ws', {
      onMessage: (_conn, data) => {
        received.push(data);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    const transport = open(sink);
    sink.onMessage('12345');

    expect(received).toEqual(['12345']);
    expect(transport.closes).toEqual([]);
  });

  it('deregisters the connection and evicts it from rooms on close', async () => {
    const { service } = build();
    const closes: WebSocketCloseEvent[] = [];
    service.route('/ws', {
      onOpen: (conn) => {
        service.room('lobby').add(conn);
      },
      onClose: (_conn, event) => {
        closes.push(event);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);
    expect(service.connectionCount).toBe(1);
    expect(service.roomCount).toBe(1);

    sink.onClose({ code: 1000, reason: 'bye' });

    expect(closes).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(service.connectionCount).toBe(0);
    // The room held only that connection, so it is discarded too.
    expect(service.roomCount).toBe(0);
  });

  it('refuses at capacity and accepts again once a connection closes', async () => {
    const { service } = build({ maxConnections: 1 });
    service.route('/ws', {});
    const router = service.createUpgradeRouter();

    const first = await router(upgradeRequest('http://localhost/ws'));
    expect(first?.accept).toBe(true);
    (first as { sink: WebSocketEventSink }).sink.onOpen(createFakeTransport());

    const second = await router(upgradeRequest('http://localhost/ws'));
    expect(second).toEqual({ accept: false, status: 503 });

    (first as { sink: WebSocketEventSink }).sink.onClose({ code: 1000, reason: '' });
    const third = await router(upgradeRequest('http://localhost/ws'));
    expect(third?.accept).toBe(true);
  });

  it('refuses with 400 when the requested subprotocol is unacceptable', async () => {
    const { service } = build();
    service.route('/ws', {}, { protocols: ['chat'] });

    const decision = await service.createUpgradeRouter()(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'binary' }),
    );

    expect(decision).toEqual({ accept: false, status: 400 });
  });

  it('carries the negotiated protocol into the decision', async () => {
    const { service } = build();
    service.route('/ws', {}, { protocols: ['chat'] });

    const decision = await service.createUpgradeRouter()(
      upgradeRequest('http://localhost/ws', { 'sec-websocket-protocol': 'chat' }),
    );

    expect(decision?.accept === true && decision.protocol).toBe('chat');
  });

  it('routes a synchronous handler throw to onError instead of escaping', async () => {
    const { service } = build();
    const errors: Error[] = [];
    service.route('/ws', {
      onMessage: () => {
        throw new Error('handler blew up');
      },
      onError: (_conn, error) => {
        errors.push(error);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);
    sink.onMessage('boom');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('handler blew up');
  });

  it('routes a rejected async handler to onError', async () => {
    const { service } = build();
    const errors: Error[] = [];
    service.route('/ws', {
      onMessage: () => Promise.reject(new Error('async failure')),
      onError: (_conn, error) => {
        errors.push(error);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);
    sink.onMessage('boom');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.map((e) => e.message)).toEqual(['async failure']);
  });

  it('forwards a transport error to onError', async () => {
    const { service } = build();
    const errors: Error[] = [];
    service.route('/ws', {
      onError: (_conn, error) => {
        errors.push(error);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);
    sink.onError(new Error('socket died'));

    expect(errors.map((e) => e.message)).toEqual(['socket died']);
  });

  it('tolerates a throwing onError rather than breaking event dispatch', async () => {
    const { service } = build();
    service.route('/ws', {
      onMessage: () => {
        throw new Error('first');
      },
      onError: () => {
        throw new Error('reporter also failed');
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);

    expect(() => sink.onMessage('boom')).not.toThrow();
  });

  it('ignores events that arrive before onOpen', async () => {
    const { service } = build();
    const seen: string[] = [];
    service.route('/ws', {
      onMessage: () => {
        seen.push('message');
      },
      onClose: () => {
        seen.push('close');
      },
      onError: () => {
        seen.push('error');
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    sink.onMessage('early');
    sink.onClose({ code: 1006, reason: '' });
    sink.onError(new Error('early'));

    expect(seen).toEqual([]);
    expect(service.connectionCount).toBe(0);
  });

  it('runs without any handlers configured', async () => {
    const { service } = build();
    service.route('/ws', {});

    const sink = await accept(service, 'http://localhost/ws');
    open(sink);

    expect(() => {
      sink.onMessage('quiet');
      sink.onError(new Error('quiet'));
      sink.onClose({ code: 1000, reason: '' });
    }).not.toThrow();
  });

  it('closes every connection, stops the heartbeat, and clears rooms on closeAll', async () => {
    const { runtime, service } = build({ heartbeatMs: 1000 });
    service.route('/ws', {
      onOpen: (conn) => {
        service.room('lobby').add(conn);
      },
    });

    const sink = await accept(service, 'http://localhost/ws');
    const transport = open(sink);

    service.closeAll();

    expect(transport.closes).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
    expect(service.connectionCount).toBe(0);
    expect(service.roomCount).toBe(0);
    expect(runtime.intervals[0]?.cleared).toBe(true);
  });

  it('returns the same room instance for a repeated name', () => {
    const { service } = build();

    expect(service.room('lobby')).toBe(service.room('lobby'));
    expect(service.roomCount).toBe(1);
  });
});
