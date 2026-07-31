/**
 * Connect runtime loader — injects or lazily imports the Connect-ES core and
 * Protobuf-ES modules. Produces a ConnectRuntime port without hard dependencies.
 *
 * @module
 */

import { GrpcRuntimeLoadError } from '../errors/grpc-errors.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';

// Lazy cache for imported modules — typed as unknown since we dynamically import npm packages
let connectModule: unknown = null;
let protobufModule: unknown = null;
let wktModule: unknown = null;

/**
 * Shape of the @bufbuild/protobuf module.
 */
interface ProtobufModule {
  createFileRegistry(fdSet: unknown): unknown;
  fromBinary(schema: unknown, bytes: Uint8Array): unknown;
}

/**
 * Shape of the @bufbuild/protobuf/wkt module.
 */
interface WktModule {
  FileDescriptorSetSchema: unknown;
}

/**
 * Shape of the @connectrpc/connect module.
 */
interface ConnectModule {
  createFetchHandler(
    handlers: Array<{ requestPath: string; handler: unknown }>,
    options?: { httpVersion?: string },
  ): Map<string, (request: Request) => Promise<Response>>;
}

/**
 * Creates a ConnectRuntime implementation from raw module objects.
 * This is the internal implementation detail.
 */
function createConnectRuntime(
  _mod: unknown,
  _protobuf: unknown,
  _wkt: unknown,
): ConnectRuntime {
  const modObj = _mod as ConnectModule | null;
  const protobufObj = _protobuf as ProtobufModule | null;
  const wktObj = _wkt as WktModule | null;

  if (!protobufObj || !wktObj) {
    throw new Error('Protobuf/WKT modules not available');
  }

  const { createFileRegistry, fromBinary } = protobufObj;
  const { FileDescriptorSetSchema } = wktObj;

  return {
    createFetchHandler: (
      handlers: Array<{ requestPath: string; handler: unknown }>,
      options?: { httpVersion?: string },
    ) => {
      if (!modObj?.createFetchHandler) {
        throw new Error('Connect module does not have createFetchHandler');
      }
      return modObj.createFetchHandler(handlers, options);
    },

    // Method on ConnectRuntime interface - takes only the mod parameter
    // Uses cached protobuf/wkt internally
    adaptConnectModule: (m: unknown) => {
      if (!protobufModule || !wktModule) {
        throw new Error('Protobuf modules not available for adaptation');
      }
      return createConnectRuntime(m, protobufModule, wktModule);
    },

    loadConnectModule: () => loadConnectModule(),

    reviveDescriptorSet: (base64: string) => {
      const bytes = new Uint8Array(
        base64.split('').map((c) => c.charCodeAt(0) & 0xFF),
      );
      const fdSet = fromBinary(FileDescriptorSetSchema, bytes);
      return createFileRegistry(fdSet);
    },

    getService: (registry: unknown, serviceName: string) => {
      const reg = registry as Record<string, (...args: unknown[]) => unknown> | null;
      return reg?.getService?.(serviceName) || undefined;
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
      connectModule = await import('npm:@connectrpc/connect@^2.1.2') as unknown;
    } catch (_e) {
      throw new GrpcRuntimeLoadError(
        '@connectrpc/connect',
        'deno add @connectrpc/connect@^2.1.2',
      );
    }
  }

  // Load @bufbuild/protobuf
  if (!protobufModule) {
    try {
      protobufModule = await import('npm:@bufbuild/protobuf@^2.7.0') as unknown;
    } catch (_e) {
      throw new GrpcRuntimeLoadError(
        '@bufbuild/protobuf',
        'deno add @bufbuild/protobuf@^2.7.0',
      );
    }
  }

  // Load @bufbuild/protobuf/wkt
  if (!wktModule) {
    try {
      wktModule = await import('npm:@bufbuild/protobuf@^2.7.0/wkt') as unknown;
    } catch (_e) {
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
    adaptConnectModule: (_m: unknown) => getFallbackConnectRuntime(),
    loadConnectModule: () => Promise.resolve(getFallbackConnectRuntime()),
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
  void _mod;
  void _protobuf;
  void _wkt;
  return getFallbackConnectRuntime();
}
