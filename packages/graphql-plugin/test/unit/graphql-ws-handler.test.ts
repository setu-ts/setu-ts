/**
 * Tests for transports/ws/graphql-ws-handler.ts
 *
 * Covers the graphql-transport-ws state machine: init/ack (incl. duplicate and
 * timeout-eligible init), ping/pong, subscribe registry (duplicate, missing id,
 * before-ack), the three outcome arms (error/single/stream), the ignore rule
 * for unknown ids and unknown message types, the onConnect auth hook, and the
 * heartbeat/protocol-ping scheduler.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  GraphqlConnectionInfo,
  GraphqlOperationContext,
  GraphqlRequestParams,
  GraphqlSubscriptionOutcome,
  IGraphqlService,
  IWebSocketConnection,
  WebSocketConnectionContext,
} from '@hono-enterprise/common';
import { createWsHandlers } from '../../src/transports/ws/graphql-ws-handler.ts';
import {
  decodeFrame,
  encodeFrame,
  GQL_COMPLETE,
  GQL_CONNECTION_ACK,
  GQL_CONNECTION_INIT,
  GQL_ERROR,
  GQL_NEXT,
  GQL_PING,
  GQL_PONG,
  GQL_SUBSCRIBE,
} from '../../src/transports/ws/ws-protocol.ts';

function createMockService(
  outcome: (
    params: GraphqlRequestParams,
    ctx?: GraphqlOperationContext,
  ) => GraphqlSubscriptionOutcome,
): IGraphqlService {
  return {
    execute: () => Promise.resolve({ status: 200, result: { data: {} } }),
    subscribe: (params: GraphqlRequestParams, ctx?: GraphqlOperationContext) =>
      Promise.resolve(outcome(params, ctx)),
    get endpoint() {
      return '/graphql';
    },
    get cachedDocumentCount() {
      return 0;
    },
  };
}

function createMockConnection(): IWebSocketConnection & {
  sent: string[];
  closed?: { code: number; reason?: string };
} {
  const conn = {
    id: 'conn-1',
    data: new Map<string, unknown>(),
    isOpen: true,
    sent: [] as string[],
    closed: undefined as { code: number; reason?: string } | undefined,
    send: (data: string | Uint8Array) => {
      conn.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    sendJson: <T>(_payload: T) => {},
    close: (code?: number, reason?: string) => {
      (conn as unknown as { isOpen: boolean }).isOpen = false;
      const c: { code: number; reason?: string } = { code: code ?? 1000 };
      if (typeof reason === 'string') c.reason = reason;
      conn.closed = c;
    },
  };
  return conn as IWebSocketConnection & {
    sent: string[];
    closed?: { code: number; reason?: string };
  };
}

const mockContext: WebSocketConnectionContext = {
  url: 'ws://localhost/graphql/ws',
  path: '/graphql/ws',
  query: {},
  headers: new Headers(),
};

/** Drive init + ack so subsequent subscribe frames are accepted. */
async function init(handlers: ReturnType<typeof createWsHandlers>, conn: IWebSocketConnection) {
  handlers.onOpen!(conn, mockContext);
  await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
}

describe('createWsHandlers', () => {
  it('returns handlers object', () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    expect(typeof handlers.onOpen).toBe('function');
    expect(typeof handlers.onMessage).toBe('function');
    expect(typeof handlers.onClose).toBe('function');
    expect(typeof handlers.onError).toBe('function');
  });

  it('onOpen initializes state and starts init timer', () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, { connectionInitWaitMs: 5000 });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);

    const state = conn.data.get('__wsState') as {
      initialized: boolean;
      acknowledged: boolean;
      connectionInfo: GraphqlConnectionInfo;
    } | undefined;
    expect(state).toBeDefined();
    expect(state!.initialized).toBe(false);
    expect(state!.acknowledged).toBe(false);
    expect(state!.connectionInfo.id).toBe('conn-1');
    // Tear down the init timer to satisfy the op sanitizer.
    handlers.onClose!(conn, { code: 1000, reason: '' } as CloseEvent);
  });

  it('connection_init sends connection_ack', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);

    expect(conn.sent.length).toBe(1);
    const ack = decodeFrame(conn.sent[0]);
    expect(ack!.type).toBe(GQL_CONNECTION_ACK);
  });

  it('connection_init records connection params on the connection info', async () => {
    let seenCtx: GraphqlOperationContext | undefined;
    const service = createMockService((_params, ctx) => {
      seenCtx = ctx;
      return { kind: 'single', status: 200, result: { data: {} } };
    });
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_CONNECTION_INIT, payload: { token: 'abc' } }),
    );
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: '{ t }' } }),
    );

    // The subscribe path reads connectionParams off the connection info.
    expect(seenCtx?.connection?.connectionParams).toEqual({ token: 'abc' });
  });

  it('duplicate connection_init closes with 4429', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4429);
  });

  it('subscribe before ack closes with 4401', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: '{ hello }' } }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4401);
  });

  it('ping sends pong', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_PING }));

    const pong = decodeFrame(conn.sent[1]);
    expect(pong!.type).toBe(GQL_PONG);
  });

  it('ping when connection is closed sends nothing', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    // Close the connection so conn.isOpen is false.
    (conn as unknown as { isOpen: boolean }).isOpen = false;
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_PING }));

    // Only the ack was sent before the close; no pong.
    expect(conn.sent.length).toBe(1);
  });

  it('ping when connection is closed does not throw', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    // Close the connection so conn.isOpen is false.
    (conn as unknown as { isOpen: boolean }).isOpen = false;
    // This should not throw even though the connection is closed.
    await expect(handlers.onMessage!(conn, encodeFrame({ type: GQL_PING }))).resolves
      .toBeUndefined();
  });

  it('pong is accepted as a no-op', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_PONG }));

    // No additional frame, no close.
    expect(conn.sent.length).toBe(1);
    expect(conn.closed).toBeUndefined();
  });

  it('subscribe missing id closes with 4400', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, payload: { query: '{ x }' } }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4400);
  });

  it('subscribe threads operationName, variables, and extensions to the service', async () => {
    let received: GraphqlRequestParams | undefined;
    const service = createMockService((params) => {
      received = params;
      return { kind: 'single', status: 200, result: { data: {} } };
    });
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: {
          query: '{ hello }',
          operationName: 'Hello',
          variables: { id: '1' },
          extensions: { persistedQuery: { version: 1 } },
        },
      }),
    );

    expect(received).toBeDefined();
    expect(received!.operationName).toBe('Hello');
    expect(received!.variables).toEqual({ id: '1' });
    expect(received!.extensions).toEqual({ persistedQuery: { version: 1 } });
  });

  it('subscribe emits next and complete for single result', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: { hello: 'world' } },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: '{ hello }' } }),
    );

    // ack, next, complete
    expect(conn.sent.length).toBe(3);
    const next = decodeFrame(conn.sent[1]);
    expect(next!.type).toBe(GQL_NEXT);
    expect(next!.id).toBe('1');
    const complete = decodeFrame(conn.sent[2]);
    expect(complete!.type).toBe(GQL_COMPLETE);
    expect(complete!.id).toBe('1');
  });

  it('subscribe emits error (no complete) for request error', async () => {
    const service = createMockService(() => ({
      kind: 'error',
      status: 400,
      result: { errors: [{ message: 'Validation error' }] },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: '{ invalid }' } }),
    );

    // ack + error (no complete)
    expect(conn.sent.length).toBe(2);
    const error = decodeFrame(conn.sent[1]);
    expect(error!.type).toBe(GQL_ERROR);
    expect(error!.id).toBe('1');
  });

  it('client complete releases an active subscription', async () => {
    const releaseStream: (() => void)[] = [];
    const service = createMockService(() => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: { tick: 0 } };
        await new Promise<void>((resolve) => {
          releaseStream.push(resolve);
        });
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: 'subscription { tick }' } }),
    );
    // The pump is fire-and-forget; let its first iteration run before asserting.
    await new Promise((r) => setTimeout(r, 5));
    expect(decodeFrame(conn.sent[1])!.type).toBe(GQL_NEXT);

    await handlers.onMessage!(conn, encodeFrame({ type: GQL_COMPLETE, id: '1' }));

    // Resolve the stream — the suppressed subscription must emit no further
    // `next` (data) frames. (A trailing protocol `complete` when the generator
    // ends is benign and not asserted against here.)
    if (releaseStream[0]) releaseStream[0]();
    await new Promise((r) => setTimeout(r, 10));
    const nextCount = conn.sent
      .map((s) => decodeFrame(s)?.type)
      .filter((t) => t === GQL_NEXT).length;
    expect(nextCount).toBe(1); // only tick:0
  });

  it('client complete for an unknown id is ignored', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_COMPLETE, id: 'nope' }));

    expect(conn.isOpen).toBe(true);
    expect(conn.closed).toBeUndefined();
  });

  it('client complete without an id is ignored', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_COMPLETE }));

    expect(conn.isOpen).toBe(true);
  });

  it('a stream that completes normally emits complete', async () => {
    const service = createMockService(() => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: { tick: 0 } };
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: 'subscription { tick }' } }),
    );
    // Allow the pump to drain the generator to completion.
    await new Promise((r) => setTimeout(r, 10));

    // ack, next, complete (from pump's done branch)
    expect(conn.sent.length).toBe(3);
    expect(decodeFrame(conn.sent[2])!.type).toBe(GQL_COMPLETE);
  });

  it('a stream that throws emits error and no complete', async () => {
    const service = createMockService(() => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: { tick: 0 } };
        throw new Error('producer failed');
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: 'subscription { tick }' } }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const errorFrame = decodeFrame(conn.sent[2]);
    expect(errorFrame!.type).toBe(GQL_ERROR);
    expect(JSON.stringify(errorFrame!.payload)).toContain('producer failed');
  });

  it('a closed connection suppresses pump output without throwing', async () => {
    const service = createMockService(() => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: { tick: 0 } };
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    // Close the connection so conn.isOpen is false when the pump tries to send.
    (conn as unknown as { isOpen: boolean }).isOpen = false;
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: 'subscription { tick }' } }),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Only the ack was sent (before the close); the pump emitted nothing.
    expect(conn.sent.length).toBe(1);
  });

  it('onConnect returning false closes with 4403', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, { onConnect: () => false });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_CONNECTION_INIT, payload: { token: 'bad' } }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4403);
  });

  it('onConnect throwing closes with 4403 and the error message', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {
      onConnect: () => {
        throw new Error('auth service down');
      },
    });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4403);
    expect(conn.closed!.reason).toContain('auth service down');
  });

  it('onConnect returning a truthy value accepts the connection', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, { onConnect: () => undefined });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));

    expect(conn.closed).toBeUndefined();
    expect(decodeFrame(conn.sent[0])!.type).toBe(GQL_CONNECTION_ACK);
  });

  it('unknown message type is ignored (not closed)', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(conn, JSON.stringify({ type: 'unknown_type' }));

    expect(conn.isOpen).toBe(true);
    expect(conn.closed).toBeUndefined();
  });

  it('duplicate subscribe id closes with 4409', async () => {
    const service = createMockService(() => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: {} };
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    await init(handlers, conn);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: 'subscription { tick }' } }),
    );
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_SUBSCRIBE, id: '1', payload: { query: 'subscription { tick }' } }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4409);
  });

  it('invalid frame closes with 4400', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, 'not json at all');

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4400);
  });

  it('a message on a connection with no state is ignored', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();
    // Note: onOpen NOT called → no __wsState on conn.data.

    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));

    expect(conn.sent.length).toBe(0);
    expect(conn.closed).toBeUndefined();
  });

  it('heartbeatMs > 0 schedules protocol ping frames', async () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, { heartbeatMs: 5 });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    // Allow the interval to fire at least once.
    await new Promise((r) => setTimeout(r, 20));

    const pings = conn.sent.map((s) => decodeFrame(s)).filter((f) => f?.type === GQL_PING);
    expect(pings.length).toBeGreaterThan(0);
    // Tear down the heartbeat interval to satisfy the op sanitizer.
    handlers.onClose!(conn, { code: 1000, reason: '' } as CloseEvent);
  });

  it('onError is a no-op', () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    // onError should not throw and should not change connection state.
    handlers.onError!(conn, new Error('test error'));
    expect(conn.isOpen).toBe(true);
    expect(conn.closed).toBeUndefined();
  });

  it('onClose clears the init and heartbeat timers', () => {
    const service = createMockService(() => ({
      kind: 'single',
      status: 200,
      result: { data: {} },
    }));
    const handlers = createWsHandlers(service, { heartbeatMs: 5 });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    const state = conn.data.get('__wsState') as { initTimer: unknown; heartbeatTimer: unknown };
    expect(state.heartbeatTimer).not.toBeNull();

    handlers.onClose!(conn, { code: 1000, reason: '' } as CloseEvent);
    expect(state.heartbeatTimer).toBeNull();
    expect(state.initTimer).toBeNull();
  });
});
