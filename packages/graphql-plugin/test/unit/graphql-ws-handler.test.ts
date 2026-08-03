/**
 * Tests for transports/ws/graphql-ws-handler.ts
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
  overrideSubscribe?: (
    params: GraphqlRequestParams,
    ctx?: GraphqlOperationContext,
  ) => Promise<GraphqlSubscriptionOutcome>,
): IGraphqlService {
  const defaultSubscribe = async (
    _params: GraphqlRequestParams,
  ): Promise<GraphqlSubscriptionOutcome> => {
    return {
      kind: 'single',
      status: 200,
      result: { data: { hello: 'world' } },
    };
  };
  return {
    execute: async () => ({ status: 200, result: { data: {} } }),
    subscribe: overrideSubscribe ?? defaultSubscribe,
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
      conn.isOpen = false;
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

describe('createWsHandlers', () => {
  it('returns handlers object', () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    expect(typeof handlers.onOpen).toBe('function');
    expect(typeof handlers.onMessage).toBe('function');
    expect(typeof handlers.onClose).toBe('function');
    expect(typeof handlers.onError).toBe('function');
  });

  it('onOpen initializes state and starts init timer', () => {
    const service = createMockService();
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
  });

  it('connection_init sends connection_ack', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);

    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));

    expect(conn.sent.length).toBe(1);
    const ack = decodeFrame(conn.sent[0]);
    expect(ack!.type).toBe(GQL_CONNECTION_ACK);
  });

  it('duplicate connection_init closes with 4429', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);

    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4429);
  });

  it('subscribe before ack closes with 4401', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);

    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: '{ hello }' },
      }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4401);
  });

  it('ping sends pong', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_PING }));

    expect(conn.sent.length).toBe(2);
    const pong = decodeFrame(conn.sent[1]);
    expect(pong!.type).toBe(GQL_PONG);
  });

  it('subscribe emits next and complete for single result', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: '{ hello }' },
      }),
    );

    // Should have: ack, next, complete
    expect(conn.sent.length).toBe(3);
    const next = decodeFrame(conn.sent[1]);
    expect(next!.type).toBe(GQL_NEXT);
    expect(next!.id).toBe('1');
    const complete = decodeFrame(conn.sent[2]);
    expect(complete!.type).toBe(GQL_COMPLETE);
    expect(complete!.id).toBe('1');
  });

  it('subscribe emits error (no complete) for request error', async () => {
    const service = createMockService(async () => ({
      kind: 'error',
      status: 400,
      result: { errors: [{ message: 'Validation error' }] },
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: '{ invalid }' },
      }),
    );

    // ack + error (no complete)
    expect(conn.sent.length).toBe(2);
    const error = decodeFrame(conn.sent[1]);
    expect(error!.type).toBe(GQL_ERROR);
    expect(error!.id).toBe('1');
  });

  it('client complete releases subscription', async () => {
    const resolveStream: (() => void)[] = [];
    const service = createMockService(async () => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: { tick: 0 } };
        await new Promise<void>((resolve) => {
          resolveStream.push(resolve);
        });
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: 'subscription { tick }' },
      }),
    );

    // Client sends complete
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_COMPLETE, id: '1' }));

    // Resolve the stream — should not send more
    if (resolveStream[0]) resolveStream[0]();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('onConnect returning false closes with 4403', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {
      onConnect: () => false,
    });
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(
      conn,
      encodeFrame({ type: GQL_CONNECTION_INIT, payload: { token: 'bad' } }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4403);
  });

  it('unknown message type is ignored (not closed)', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(conn, JSON.stringify({ type: 'unknown_type' }));

    expect(conn.isOpen).toBe(true);
    expect(conn.closed).toBeUndefined();
  });

  it('duplicate subscribe id closes with 4409', async () => {
    const service = createMockService(async () => ({
      kind: 'stream',
      status: 200,
      stream: (async function* () {
        yield { data: {} };
      })(),
    }));
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, encodeFrame({ type: GQL_CONNECTION_INIT }));
    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: 'subscription { tick }' },
      }),
    );
    await handlers.onMessage!(
      conn,
      encodeFrame({
        type: GQL_SUBSCRIBE,
        id: '1',
        payload: { query: 'subscription { tick }' },
      }),
    );

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4409);
  });

  it('invalid frame closes with 4400', async () => {
    const service = createMockService();
    const handlers = createWsHandlers(service, {});
    const conn = createMockConnection();

    handlers.onOpen!(conn, mockContext);
    await handlers.onMessage!(conn, 'not json at all');

    expect(conn.closed).toBeDefined();
    expect(conn.closed!.code).toBe(4400);
  });
});
