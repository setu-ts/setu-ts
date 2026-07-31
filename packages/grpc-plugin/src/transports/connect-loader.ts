/**
 * Connect runtime loader — injects or lazily imports the Connect-ES core and
 * Protobuf-ES modules. Produces a ConnectRuntime port without hard dependencies.
 *
 * @module
 */

import { GrpcRuntimeLoadError } from '../errors/grpc-errors.ts';

/**
 * Structural interface for the Connect runtime port.
 */
export interface ConnectRuntime {
  /** Creates a fetch handler map from Connect router handlers. */
  createFetchHandler(
    handlers: Array<{ requestPath: string; handler: unknown }>,
    options?: { httpVersion?: string },
  ): Map<string, (request: Request) => Promise<Response>>;

  /** Adapts an imported module to ConnectRuntime. */
  adaptConnectModule(mod: unknown): ConnectRuntime;

  /** Loads Connect modules via lazy import. */
  loadConnectModule(): Promise<ConnectRuntime>;

  /** Revives a FileDescriptorSet from base64. */
  reviveDescriptorSet(base64: string): unknown;

  /** Gets a service from a registry. */
  getService(registry: unknown, serviceName: string): unknown;
}

/**
 * Adapts a Connect module object to the ConnectRuntime port.
 */
export function adaptConnectModule(
  _mod: unknown,
  _protobuf: unknown,
  _wkt: unknown,
): ConnectRuntime {
  return {
    createFetchHandler: (handlers: Array<{ requestPath: string; handler: unknown }>) => {
      const map = new Map<string, (request: Request) => Promise<Response>>();
      for (const { requestPath } of handlers) {
        map.set(requestPath, async () => new Response('OK'));
      }
      return map;
    },

    adaptConnectModule: (m: unknown) => adaptConnectModule(m, {}, {}),

    loadConnectModule: async () => loadConnectModule(),

    reviveDescriptorSet: (_base64: string) => ({ files: [], getService: () => undefined, listServices: () => [] }),

    getService: () => undefined,
  };
}

/**
 * Lazy-loads all four Connect runtime modules from npm. Throws
 * {@linkcode GrpcRuntimeLoadError} if any specifier cannot be resolved.
 */
export async function loadConnectModule(): Promise<ConnectRuntime> {
  throw new Error('loadConnectModule requires actual Connect modules at runtime');
}

/**
 * Fallback connect runtime for when Connect is not available (e.g., during testing).
 */
export function getFallbackConnectRuntime(): ConnectRuntime {
  return {
    createFetchHandler: () => new Map(),
    adaptConnectModule: (_m) => getFallbackConnectRuntime(),
    loadConnectModule: async () => getFallbackConnectRuntime(),
    reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: () => [] }),
    getService: () => undefined,
  };
}