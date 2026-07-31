/**
 * @module
 *
 * RuntimePlugin and runtime adapters providing {@linkcode IRuntimeServices}
 * for Node.js, Deno, Bun, and Cloudflare Workers. HTTP server adapters are
 * also provided for running the framework on real HTTP servers.
 *
 * Every export is documented in PUBLIC_API.md section 36.
 */

// Plugin factory
export { RuntimePlugin } from './plugin/runtime-plugin.ts';
export type { HttpAdapterFactories, RuntimeOptions } from './plugin/runtime-plugin.ts';

// Runtime detection
export { detectRuntime } from './detector/runtime-detector.ts';
export type { GlobalScope } from './detector/runtime-detector.ts';

// Runtime services for the detected platform, without an application
export { createRuntimeServices } from './adapters/shared/runtime-services-factory.ts';
export type {
  CreateRuntimeServicesOptions,
  RuntimeAdapterFactories,
} from './adapters/shared/runtime-services-factory.ts';

// Runtime adapters — factories
export { createDenoRuntimeServices } from './adapters/deno/deno-runtime.ts';
export type { DenoDirEntry, DenoFileInfo, DenoHost } from './adapters/deno/deno-runtime.ts';

export { buildNodeHost, createNodeRuntimeServices } from './adapters/node/node-runtime.ts';
export type { NodeFsInfo, NodeHost, NodeModules } from './adapters/node/node-runtime.ts';

export { buildBunHost, createBunRuntimeServices } from './adapters/bun/bun-runtime.ts';
export type { BunFileInfo, BunHost, BunModules } from './adapters/bun/bun-runtime.ts';

export { createCloudflareRuntimeServices } from './adapters/workers/cf-runtime.ts';
export type { CloudflareEnv, CloudflareRuntimeOptions } from './adapters/workers/cf-runtime.ts';

// Worker hosts (thread spawning behind IRuntimeServices.workers)
export { createWebWorkerHost } from './adapters/shared/web-worker-host.ts';
export type { WebWorkerGlobals, WebWorkerLike } from './adapters/shared/web-worker-host.ts';

export { createNodeWorkerHost } from './adapters/node/node-worker-host.ts';
export type { NodeWorkerLike, NodeWorkerModules } from './adapters/node/node-worker-host.ts';

// WebSocket upgrade — shared primitives
export { isWebSocketUpgradeRequest } from './adapters/shared/upgrade-detection.ts';
export {
  createWebSocketTransport,
  normalizeFrame,
  toReadyState,
  toTransportError,
} from './adapters/shared/web-socket-transport.ts';
export type { WebSocketLike } from './adapters/shared/web-socket-transport.ts';

// WebSocket upgrade — per-runtime seams
export { bindDenoSocketToSink } from './adapters/deno/deno-ws-upgrader.ts';
export type { DenoWebSocketLike, DenoWebSocketUpgrade } from './adapters/deno/deno-ws-upgrader.ts';

export {
  adaptWsModule,
  asUpgradeEmitter,
  bindWsSocketToSink,
  createUpgradeRequest,
  createWsTransport,
  loadWsModule,
  NodeUpgradeCoordinator,
  rejectRawUpgrade,
  toWsReadyState,
} from './adapters/node/node-ws-upgrader.ts';
export type {
  NodeIncomingMessage,
  RawUpgradeSocket,
  UpgradeEmitter,
  WsModuleLike,
  WsServerLike,
  WsSocketLike,
} from './adapters/node/node-ws-upgrader.ts';

export { createBunWebSocketHandlers } from './adapters/bun/bun-ws-upgrader.ts';
export type {
  BunServerWebSocket,
  BunSocketData,
  BunWebSocketHandlers,
} from './adapters/bun/bun-ws-upgrader.ts';

export {
  bindCloudflareSocketToSink,
  createDefaultCloudflareWebSocketHost,
} from './adapters/workers/cf-ws-upgrader.ts';
export type {
  CloudflareServerSocket,
  CloudflareWebSocketHost,
  CloudflareWebSocketPair,
} from './adapters/workers/cf-ws-upgrader.ts';

// HTTP adapters
export { DenoHttpAdapter } from './adapters/deno/deno-http-adapter.ts';
export type { DenoServeHost, DenoServer } from './adapters/deno/deno-http-adapter.ts';

export { NodeHttpAdapter } from './adapters/node/node-http-adapter.ts';
export type { NodeServeHost, NodeServer } from './adapters/node/node-http-adapter.ts';

export { BunHttpAdapter } from './adapters/bun/bun-http-adapter.ts';
export type { BunServeHost, BunServer } from './adapters/bun/bun-http-adapter.ts';

export { CloudflareWorkersHttpAdapter } from './adapters/workers/cf-http-adapter.ts';
