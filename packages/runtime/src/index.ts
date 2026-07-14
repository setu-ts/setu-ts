/**
 * @module
 *
 * RuntimePlugin and runtime adapters providing {@linkcode IRuntimeServices}
 * for Node.js, Deno, and Bun. HTTP server adapters are also provided for
 * running the framework on real HTTP servers.
 *
 * Every export is documented in PUBLIC_API.md section 36.
 */

// Plugin factory
export { RuntimePlugin } from './plugin/runtime-plugin.ts';
export type { HttpAdapterFactories, RuntimeOptions } from './plugin/runtime-plugin.ts';

// Runtime detection
export { detectRuntime } from './detector/runtime-detector.ts';
export type { GlobalScope } from './detector/runtime-detector.ts';

// Runtime adapters — factories
export { createDenoRuntimeServices } from './adapters/deno/deno-runtime.ts';
export type { DenoDirEntry, DenoFileInfo, DenoHost } from './adapters/deno/deno-runtime.ts';

export { buildNodeHost, createNodeRuntimeServices } from './adapters/node/node-runtime.ts';
export type { NodeFsInfo, NodeHost, NodeModules } from './adapters/node/node-runtime.ts';

export { createBunRuntimeServices } from './adapters/bun/bun-runtime.ts';
export type { BunFileInfo, BunHost } from './adapters/bun/bun-runtime.ts';

export { createCloudflareRuntimeServices } from './adapters/cloudflare/cf-runtime.ts';

// HTTP adapters
export { DenoHttpAdapter } from './adapters/deno/deno-http-adapter.ts';
export type { DenoHttpServerHandle } from './adapters/deno/deno-http-adapter.ts';

export { NodeHttpAdapter } from './adapters/node/node-http-adapter.ts';
export type { NodeHttpServerHandle } from './adapters/node/node-http-adapter.ts';

export { BunHttpAdapter } from './adapters/bun/bun-http-adapter.ts';
export type {
  BunHttpServerHandle,
  BunServeHost,
  BunServer,
} from './adapters/bun/bun-http-adapter.ts';
