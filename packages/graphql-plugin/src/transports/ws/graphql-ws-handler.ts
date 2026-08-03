/**
 * GraphQL-over-WebSocket handler implementing graphql-transport-ws.
 *
 * State machine over {@linkcode IWebSocketService.route()}: init/ack,
 * ping/pong, subscribe registry, next/error/complete per protocol.
 *
 * @module
 * @since 0.3.0
 */

import type {
  GraphqlConnectionInfo,
  GraphqlOperationContext,
  IGraphqlService,
  IWebSocketConnection,
  WebSocketConnectionContext,
  WebSocketHandlers,
} from '@hono-enterprise/common';
import type { GraphqlWsTransportOptions } from '../../interfaces/options.ts';
import {
  CLOSE_DUPLICATE_SUBSCRIBE,
  CLOSE_FORBIDDEN,
  CLOSE_INIT_TIMEOUT,
  CLOSE_INVALID_MESSAGE,
  CLOSE_NORMAL,
  CLOSE_SUBSCRIBE_BEFORE_ACK,
  CLOSE_TOO_MANY_INITS,
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
} from './ws-protocol.ts';

/** Per-connection state machine. */
interface ConnectionState {
  /** Whether `connection_ack` has been sent. */
  acknowledged: boolean;
  /** Whether `connection_init` was received and accepted. */
  initialized: boolean;
  /** Active subscriptions keyed by id. */
  subscriptions: Map<string, {
    iterator: AsyncIterableIterator<unknown>;
    suppressed: boolean;
  }>;
  /** Init timeout handle. */
  initTimer: ReturnType<typeof setTimeout> | null;
  /** Heartbeat interval handle. */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  /** The GraphqlConnectionInfo built from the upgrade. */
  connectionInfo: GraphqlConnectionInfo;
}

/**
 * Create WebSocket handlers for graphql-transport-ws.
 *
 * @param graphqlService - The GraphQL service
 * @param wsOptions - WebSocket transport options
 * @param serviceRegistry - Plugin-level service registry for context building
 * @returns WebSocket handlers
 */
export function createWsHandlers(
  graphqlService: IGraphqlService,
  wsOptions: GraphqlWsTransportOptions,
  _serviceRegistry?: unknown,
): WebSocketHandlers {
  const connectionInitWaitMs = wsOptions.connectionInitWaitMs ?? 3000;
  const heartbeatMs = wsOptions.heartbeatMs ?? 0;
  const onConnect = wsOptions.onConnect;

  return {
    onOpen: (conn: IWebSocketConnection, context: WebSocketConnectionContext) => {
      // Build connection info
      const baseConnectionInfo:
        & Partial<GraphqlConnectionInfo>
        & Pick<GraphqlConnectionInfo, 'id' | 'headers' | 'query' | 'data'> = {
          id: conn.id,
          headers: context.headers,
          query: context.query,
          data: conn.data,
        };
      const connectionInfo: GraphqlConnectionInfo = {
        ...baseConnectionInfo,
        ...(context.protocol !== undefined ? { protocol: context.protocol } : {}),
      };

      // Set up initial state on connection data
      const state: ConnectionState = {
        acknowledged: false,
        initialized: false,
        subscriptions: new Map(),
        initTimer: null,
        heartbeatTimer: null,
        connectionInfo,
      };

      conn.data.set('__wsState', state);

      // Start init timeout
      state.initTimer = setTimeout(() => {
        if (!state.initialized) {
          conn.close(CLOSE_INIT_TIMEOUT, 'Connection initialisation timeout');
        }
      }, connectionInitWaitMs);

      // Start heartbeat if configured
      if (heartbeatMs > 0) {
        state.heartbeatTimer = setInterval(() => {
          if (conn.isOpen) {
            try {
              conn.send(encodeFrame({ type: GQL_PING }));
            } catch {
              // Connection likely closed
            }
          }
        }, heartbeatMs);
      }
    },

    onMessage: async (conn: IWebSocketConnection, raw: string | Uint8Array) => {
      const state = conn.data.get('__wsState') as ConnectionState | undefined;
      if (!state) {
        return;
      }

      const str = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const frame = decodeFrame(str);

      if (!frame) {
        conn.close(CLOSE_INVALID_MESSAGE, 'Invalid message');
        return;
      }

      switch (frame.type) {
        case GQL_CONNECTION_INIT: {
          if (state.initialized) {
            conn.close(CLOSE_TOO_MANY_INITS, 'Too many init requests');
            return;
          }

          state.initialized = true;
          if (state.initTimer) {
            clearTimeout(state.initTimer);
            state.initTimer = null;
          }

          // Build connection info with payload
          state.connectionInfo = {
            ...state.connectionInfo,
            connectionParams: frame.payload ?? undefined,
          };

          // Run onConnect hook
          if (onConnect) {
            try {
              const result = await onConnect(state.connectionInfo);
              if (result === false) {
                conn.close(CLOSE_FORBIDDEN, 'Forbidden');
                return;
              }
            } catch (err) {
              conn.close(CLOSE_FORBIDDEN, err instanceof Error ? err.message : 'Forbidden');
              return;
            }
          }

          conn.send(encodeFrame({ type: GQL_CONNECTION_ACK }));
          state.acknowledged = true;
          break;
        }

        case GQL_PING:
          if (conn.isOpen) {
            conn.send(encodeFrame({ type: GQL_PONG }));
          }
          break;

        case GQL_PONG:
          // Client pong — satisfies idle clock, nothing else needed
          break;

        case GQL_SUBSCRIBE: {
          if (!state.acknowledged) {
            conn.close(CLOSE_SUBSCRIBE_BEFORE_ACK, 'Subscribe before acknowledged');
            return;
          }

          if (frame.id === undefined) {
            conn.close(CLOSE_INVALID_MESSAGE, 'Subscribe missing id');
            return;
          }

          if (state.subscriptions.has(frame.id)) {
            conn.close(
              CLOSE_DUPLICATE_SUBSCRIBE,
              `Subscriber for ${frame.id} already exists`,
            );
            return;
          }

          const payload = frame.payload as Record<string, unknown> | undefined;

          // Build request params
          const params: GraphqlRequestParams = {
            query: typeof payload?.query === 'string' ? payload.query : '',
          };
          if (typeof payload?.operationName === 'string') {
            params.operationName = payload.operationName;
          }
          if (
            typeof payload?.variables === 'object' &&
            payload.variables !== null &&
            !Array.isArray(payload.variables)
          ) {
            params.variables = payload.variables as Record<string, unknown>;
          }
          if (typeof payload?.extensions === 'object' && payload.extensions !== null) {
            params.extensions = payload.extensions as Record<string, unknown>;
          }

          // Build operation context (WS path supplies connection)
          const context: GraphqlOperationContext = {
            connection: state.connectionInfo,
          };

          // Subscribe
          const outcome = await graphqlService.subscribe(params, context);

          if (outcome.kind === 'error') {
            // Request error: emit error and NO complete
            conn.send(encodeFrame({
              type: GQL_ERROR,
              id: frame.id,
              payload: outcome.result.errors ?? [],
            }));
            return;
          }

          if (outcome.kind === 'single') {
            // Query/mutation: one next, then complete
            conn.send(encodeFrame({
              type: GQL_NEXT,
              id: frame.id,
              payload: outcome.result,
            }));
            conn.send(encodeFrame({
              type: GQL_COMPLETE,
              id: frame.id,
            }));
            return;
          }

          // Stream: start pumping
          const iterator = outcome.stream[Symbol.asyncIterator]();
          state.subscriptions.set(frame.id, { iterator, suppressed: false });

          pumpWsSubscription(conn, frame.id, iterator, state);
          break;
        }

        case GQL_COMPLETE: {
          if (frame.id !== undefined) {
            const sub = state.subscriptions.get(frame.id);
            if (sub) {
              sub.suppressed = true;
              // Release the iterator
              if (typeof sub.iterator.return === 'function') {
                void sub.iterator.return();
              }
              state.subscriptions.delete(frame.id);
            }
          }
          break;
        }

        default:
          // Unknown message type — ignore (protocol requires)
          break;
      }
    },

    onClose: () => {
      // Cleanup happens via connection data being cleared
    },

    onError: () => {
      // Handled by close path
    },
  };
}

/**
 * Pump a subscription stream to a WebSocket connection.
 */
async function pumpWsSubscription(
  conn: IWebSocketConnection,
  id: string,
  iterator: AsyncIterableIterator<unknown>,
  state: ConnectionState,
): Promise<void> {
  try {
    while (true) {
      if (state.subscriptions.get(id)?.suppressed) {
        break;
      }

      const { done, value } = await iterator.next();
      if (done) {
        if (conn.isOpen) {
          conn.send(encodeFrame({ type: GQL_COMPLETE, id }));
        }
        break;
      }

      if (conn.isOpen) {
        conn.send(encodeFrame({
          type: GQL_NEXT,
          id,
          payload: value,
        }));
      }
    }
  } catch (err) {
    if (conn.isOpen) {
      conn.send(encodeFrame({
        type: GQL_ERROR,
        id,
        payload: [{ message: err instanceof Error ? err.message : 'Stream error' }],
      }));
    }
  } finally {
    state.subscriptions.delete(id);
  }
}
