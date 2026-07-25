/**
 * @module
 *
 * WebSocket plugin for full-duplex, bidirectional real-time messaging —
 * completing the real-time story that the SSE plugin (Milestone 43) covers
 * one-way.
 *
 * Routes are declared with lifecycle handlers, connections are addressed
 * individually or through named rooms, and the RFC 6455 handshake is performed
 * by the runtime's HTTP adapter, so the same application code runs on Node,
 * Deno, Bun, and Cloudflare Workers.
 *
 * @example
 * ```typescript
 * import { createApplication } from '@hono-enterprise/kernel';
 * import { RuntimePlugin } from '@hono-enterprise/runtime';
 * import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
 * import { CAPABILITIES, type IWebSocketService } from '@hono-enterprise/common';
 *
 * const app = createApplication({
 *   plugins: [RuntimePlugin(), WebSocketPlugin({ heartbeatMs: 30_000 })],
 * });
 *
 * const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
 * ws.route('/ws/chat', {
 *   onOpen: (conn, { query }) => {
 *     conn.data.set('room', query.room ?? 'lobby');
 *     ws.room(query.room ?? 'lobby').add(conn);
 *   },
 *   onMessage: (conn, data) => {
 *     ws.room(conn.data.get('room') as string).broadcast(data, { except: conn });
 *   },
 * });
 *
 * await app.start({ port: 3000 });
 * ```
 * @since 0.1.0
 */

export { WebSocketPlugin } from './plugin/websocket-plugin.ts';
export {
  buildContext,
  frameByteLength,
  resolveOptions,
  WebSocketService,
} from './services/websocket-service.ts';
export { WebSocketConnection } from './connection/websocket-connection.ts';
export { Room, RoomRegistry } from './rooms/room-registry.ts';
export { parseRequestedProtocols, selectProtocol, WsRouteTable } from './routing/ws-route-table.ts';
export type { WsRoute, WsRouteMatch } from './routing/ws-route-table.ts';
export { HeartbeatSweeper } from './heartbeat/heartbeat.ts';
export type { HeartbeatOptions } from './heartbeat/heartbeat.ts';
export { WebSocketUnavailableError } from './errors/websocket-errors.ts';
export type { WebSocketPluginOptions } from './interfaces/index.ts';

// Re-export the common WebSocket contracts for convenience.
export type {
  IWebSocketConnection,
  IWebSocketService,
  IWebSocketTransport,
  RoomBroadcastOptions,
  WebSocketCloseEvent,
  WebSocketConnectionContext,
  WebSocketEventSink,
  WebSocketHandlers,
  WebSocketReadyState,
  WebSocketRoom,
  WebSocketRouteOptions,
  WebSocketUpgradeDecision,
  WebSocketUpgradeRouter,
} from '@hono-enterprise/common';
export { CAPABILITIES } from '@hono-enterprise/common';
