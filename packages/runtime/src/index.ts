/**
 * @module
 *
 * RuntimePlugin and runtime adapters providing {@linkcode IRuntimeServices}
 * for Node.js, Deno, and Bun.
 *
 * M3 provides runtime services only; HTTP server adapters are deferred to a
 * dedicated milestone (see ROADMAP.md).
 *
 * Every export is documented in PUBLIC_API.md section 36.
 */

// Plugin factory
export { RuntimePlugin } from './plugin/runtime-plugin.ts';
export type { RuntimeOptions } from './plugin/runtime-plugin.ts';

// Runtime detection
export { detectRuntime } from './detector/runtime-detector.ts';
export type { GlobalScope } from './detector/runtime-detector.ts';

// Adapters — factories
export { createDenoRuntimeServices } from './adapters/deno/deno-runtime.ts';
export type { DenoDirEntry, DenoFileInfo, DenoHost } from './adapters/deno/deno-runtime.ts';

export { buildNodeHost, createNodeRuntimeServices } from './adapters/node/node-runtime.ts';
export type { NodeFsInfo, NodeHost, NodeHostLoaders } from './adapters/node/node-runtime.ts';

export { createBunRuntimeServices } from './adapters/bun/bun-runtime.ts';
export type { BunFileInfo, BunHost } from './adapters/bun/bun-runtime.ts';

export { createCloudflareRuntimeServices } from './adapters/cloudflare/cf-runtime.ts';
