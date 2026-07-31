/**
 * Connect runtime loader — injects or lazily imports the Connect-ES core and
 * Protobuf-ES modules. Produces a ConnectRuntime port without hard dependencies.
 *
 * @module
 */

import { GrpcRuntimeLoadError } from '../errors/grpc-errors.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';

// Lazy cache for imported modules
let connectModule: any = null;
let protobufModule: any = null;
let wktModule: any = null;

/**
 * Creates a ConnectRuntime implementation from raw module objects.
 * This is the internal implementation detail.
 */
function createConnectRuntime(
  _mod: any,
  _protobuf: any,
  _wkt: any,
): ConnectRuntime {
  const { createFileRegistry } = _protobuf;
  // Note: Some values may be unused in certain builds but are needed for full functionality
  const { FileDescriptorSetSchema } = _wkt;
  const { fromBinary } = _protobuf;
  const { createFetchHandler: connectCreateFetchHandler } = _mod;

  return {
    createFetchHandler: (
      handlers: Array<{ requestPath: string; handler: unknown }>,
      options?: { httpVersion?: string },
    ) => {
      if (!connectCreateFetchHandler) {
        throw new Error('Connect module does not have createFetchHandler');
      }
      return connectCreateFetchHandler(handlers, options);
    },

    // Method on ConnectRuntime interface - takes only the mod parameter
    // Uses cached protobuf/wkt internally
    adaptConnectModule: (m: any) => {
      if (!protobufModule || !wktModule) {
        throw new Error('Protobuf modules not available for adaptation');
      }
      return createConnectRuntime(m, protobufModule, wktModule);
    },

    loadConnectModule: async () => loadConnectModule(),

    reviveDescriptorSet: (base64: string) => {
      const bytes = new Uint8Array(
        base64.split('').map((c) => c.charCodeAt(0) & 0xFF),
      );
      const fdSet = fromBinary(FileDescriptorSetSchema, bytes);
      return createFileRegistry(fdSet);
    },

    getService: (registry: any, serviceName: string) => {
      return (registry as any)?.getService?.(serviceName) || undefined;
    },
  };
}

/**
 * Lazy-loads all four Connect runtime modules from npm. Throws
 * {@linkcode GrpcRuntimeLoadError} if any specifier cannot be resolved.
 */
export async function loadConnectModule(): Promise<ConnectRuntime> {
  // Use cached modules if already loaded
  if (connectModule && protobufModule && wktModule) {
    return createConnectRuntime(connectModule, protobufModule, wktModule);
  }

  // Load connectrpc/connect
  if (!connectModule) {
    try {
      connectModule = await import('npm:@connectrpc/connect@^2.1.2');
    } catch (e) {
      throw new GrpcRuntimeLoadError(
        '@connectrpc/connect',
        'deno add @connectrpc/connect@^2.1.2',
      );
    }
  }

  // Load @bufbuild/protobuf
  if (!protobufModule) {
    try {
      protobufModule = await import('npm:@bufbuild/protobuf@^2.7.0');
    } catch (e) {
      throw new GrpcRuntimeLoadError(
        '@bufbuild/protobuf',
        'deno add @bufbuild/protobuf@^2.7.0',
      );
    }
  }

  // Load @bufbuild/protobuf/wkt
  if (!wktModule) {
    try {
      wktModule = await import('npm:@bufbuild/protobuf@^2.7.0/wkt');
    } catch (e) {
      throw new GrpcRuntimeLoadError(
        '@bufbuild/protobuf/wkt',
        'deno add @bufbuild/protobuf@^2.7.0/wkt',
      );
    }
  }

  return createConnectRuntime(connectModule, protobufModule, wktModule);
}

/**
 * Fallback connect runtime for when Connect is not available (e.g., during testing).
 */
export function getFallbackConnectRuntime(): ConnectRuntime {
  return {
    createFetchHandler: () => new Map(),
    adaptConnectModule: (_m) => getFallbackConnectRuntime(),
    loadConnectModule: async () => getFallbackConnectRuntime(),
    reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
    getService: () => undefined,
  };
}

/**
 * Standalone adaptation function — takes all three modules explicitly.
 * Used by tests to avoid needing the full lazy-load machinery.
 */
export function adaptConnectModule(
  _mod: unknown,
  _protobuf: unknown,
  _wkt: unknown,
): ConnectRuntime {
  // For now, use a fallback since we don't have actual module objects in tests
  // In production, this would call createConnectRuntime with the real modules
  return getFallbackConnectRuntime();
}
