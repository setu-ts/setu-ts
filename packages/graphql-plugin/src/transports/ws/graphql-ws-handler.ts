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
  GraphqlRequestParams,
  IGraphqlService,
  IRuntimeServices,
  IWebSocketConnection,
  TimerHandle,
  WebSocketConnectionContext,
  WebSocketHandlers,
} from '@hono-enterprise/common';
import type { IApqResolver } from '../../apq/apq-resolver.ts';
import type { GraphqlWsTransportOptions } from '../../interfaces/options.ts';
import {
  CLOSE_DUPLICATE_SUBSCRIBE,
  CLOSE_FORBIDDEN,
  CLOSE_INIT_TIMEOUT,
  CLOSE_INVALID_MESSAGE,
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
  /**
   * Operations in flight or streaming, keyed by id.
   *
   * An entry is created BEFORE the operation is dispatched, so a client
   * `complete` arriving while a single-result operation is still resolving can
   * suppress its result — which the protocol requires and which is impossible
   * if only live streams are tracked.
   */
  subscriptions: Map<string, {
    iterator: AsyncIterator<unknown> | null;
    suppressed: boolean;
  }>;
  /** Init timeout handle. */
  initTimer: TimerHandle | null;
  /** Heartbeat interval handle. */
  heartbeatTimer: TimerHandle | null;
  /** The GraphqlConnectionInfo built from the upgrade. */
  connectionInfo: GraphqlConnectionInfo;
}

/**
 * Create WebSocket handlers for graphql-transport-ws.
 *
 * @param graphqlService - The GraphQL service
 * @param wsOptions - WebSocket transport options
 * @param runtime - Runtime services, for the init-timeout and heartbeat timers
 * @param apqResolver - APQ resolver, so a hash-only `subscribe` answers
 *   `PERSISTED_QUERY_NOT_FOUND` rather than a parse error; `null` when APQ is off
 * @returns WebSocket handlers
 */
export function createWsHandlers(
  graphqlService: IGraphqlService,
  wsOptions: GraphqlWsTransportOptions,
  runtime: IRuntimeServices,
  apqResolver: IApqResolver | null = null,
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
      state.initTimer = runtime.setTimeout(() => {
        if (!state.initialized) {
          conn.close(CLOSE_INIT_TIMEOUT, 'Connection initialisation timeout');
        }
      }, connectionInitWaitMs);

      // Start heartbeat if configured
      if (heartbeatMs > 0) {
        state.heartbeatTimer = runtime.setInterval(() => {
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
            runtime.clearTimeout(state.initTimer);
            state.initTimer = null;
          }

          // Build connection info with payload
          state.connectionInfo = {
            ...state.connectionInfo,
            ...(frame.payload ? { connectionParams: frame.payload } : {}),
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

          const id = frame.id;

          // Claim the id BEFORE any await. The protocol says a client
          // `complete` that arrives while a single-result operation is still
          // resolving must suppress that result, which is unreachable if the
          // id is only registered once a live stream exists.
          const entry: { iterator: AsyncIterator<unknown> | null; suppressed: boolean } = {
            iterator: null,
            suppressed: false,
          };
          state.subscriptions.set(id, entry);

          // Resolve APQ before subscribing so a hash-only request gets
          // PERSISTED_QUERY_NOT_FOUND rather than a parse error.
          if (apqResolver !== null) {
            const apqResult = await apqResolver.resolve({
              query: params.query,
              ...(params.extensions ? { extensions: params.extensions } : {}),
            });
            if (!apqResult.ok) {
              state.subscriptions.delete(id);
              if (!entry.suppressed && conn.isOpen) {
                conn.send(encodeFrame({
                  type: GQL_ERROR,
                  id,
                  payload: [{
                    message: apqResult.message,
                    extensions: { code: apqResult.code },
                  }],
                }));
              }
              return;
            }
            params.query = apqResult.query;
          }

          // Build operation context (WS path supplies connection)
          const context: GraphqlOperationContext = {
            connection: state.connectionInfo,
          };

          const outcome = await graphqlService.subscribe(params, context);

          // The client completed (or the socket closed) while we were
          // resolving: send nothing.
          if (entry.suppressed || !conn.isOpen) {
            state.subscriptions.delete(id);
            if (outcome.kind === 'stream') {
              const it = outcome.stream[Symbol.asyncIterator]();
              await it.return?.();
            }
            return;
          }

          if (outcome.kind === 'error') {
            // Request error: emit `error` and NO `complete` — the protocol
            // states the error message terminates the operation on its own.
            state.subscriptions.delete(id);
            conn.send(encodeFrame({
              type: GQL_ERROR,
              id,
              payload: outcome.result.errors ?? [],
            }));
            return;
          }

          if (outcome.kind === 'single') {
            // Query/mutation: one next, then complete
            state.subscriptions.delete(id);
            conn.send(encodeFrame({ type: GQL_NEXT, id, payload: outcome.result }));
            conn.send(encodeFrame({ type: GQL_COMPLETE, id }));
            return;
          }

          // Stream: start pumping
          entry.iterator = outcome.stream[Symbol.asyncIterator]();
          void pumpWsSubscription(conn, id, entry.iterator, state);
          break;
        }

        case GQL_COMPLETE: {
          if (frame.id !== undefined) {
            const sub = state.subscriptions.get(frame.id);
            if (sub) {
              sub.suppressed = true;
              // Release the iterator when one already exists; when the
              // operation is still resolving, `suppressed` is what stops it.
              if (sub.iterator && typeof sub.iterator.return === 'function') {
                void sub.iterator.return();
              }
              state.subscriptions.delete(frame.id);
            }
          }
          break;
        }

        default:
          // PROTOCOL.md: "Receiving a message of a type or format which is not
          // specified in this document will result in an immediate socket
          // closure with the event 4400". The ignore rule applies to unknown
          // IDs, not to unknown types — `next`, `error`, and `connection_ack`
          // are server-to-client and are invalid inbound.
          conn.close(CLOSE_INVALID_MESSAGE, `Invalid message type: ${frame.type}`);
          break;
      }
    },

    onClose: (conn: IWebSocketConnection) => {
      // Release the init-timeout and heartbeat timers so a closed socket does
      // not keep scheduling work (and so a `setInterval` heartbeat does not
      // outlive the connection).
      // Also release every active subscription iterator so the producer's
      // resources (DB watch / timer / event listener) are freed.
      const state = conn.data.get('__wsState') as ConnectionState | undefined;
      if (state) {
        if (state.initTimer) {
          runtime.clearTimeout(state.initTimer);
          state.initTimer = null;
        }
        if (state.heartbeatTimer) {
          runtime.clearInterval(state.heartbeatTimer);
          state.heartbeatTimer = null;
        }
        // C1: release every active subscription iterator
        for (const sub of state.subscriptions.values()) {
          sub.suppressed = true;
          if (sub.iterator && typeof sub.iterator.return === 'function') {
            void sub.iterator.return();
          }
        }
        state.subscriptions.clear();
      }
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
  iterator: AsyncIterator<unknown>,
  state: ConnectionState,
): Promise<void> {
  // E2: terminal .catch() so a conn.send throw in the catch block does not
  // become an unhandled rejection.
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
  } catch {
    // The service already converts a source failure into a final MASKED
    // payload, so reaching here means the iterator itself misbehaved. The
    // message is deliberately generic: a raw `err.message` here is how the
    // subscription path came to publish internals the HTTP path masks.
    if (conn.isOpen) {
      try {
        conn.send(encodeFrame({
          type: GQL_ERROR,
          id,
          payload: [{
            message: 'Internal server error',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          }],
        }));
      } catch {
        // send may throw after isOpen was true (race); swallow to avoid
        // an unhandled rejection.
      }
    }
  } finally {
    state.subscriptions.delete(id);
  }
}
