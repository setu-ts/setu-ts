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
let protocolModule: unknown = null;

// Singleton fallback instance
let fallbackRuntime: ConnectRuntime | null = null;

/**
 * Resets the module cache. Exported for testing only.
 */
export function resetModuleCache(): void {
  connectModule = null;
  protobufModule = null;
  wktModule = null;
  protocolModule = null;
  fallbackRuntime = null;
}

/**
 * Shape of the @connectrpc/connect module.
 */
interface ConnectModule {
  createConnectRouter(): {
    handlers: Array<{ requestPath: string; handler: (request: Request) => Promise<Response> }>;
    service<T extends { typeName: string }>(
      service: T,
      implementation: Record<string, (...args: unknown[]) => unknown>,
      options?: Record<string, unknown>,
    ): void;
  };
}

/**
 * Shape of the @bufbuild/protobuf module.
 *
 * `createFileRegistry` revives a {@linkcode FileDescriptorSet} into a
 * `FileRegistry` (the ONLY `@bufbuild/protobuf` entry point that can resolve
 * service descriptors from a serialized descriptor set — `createRegistry`
 * cannot, and silently returns a registry in which `getService()` is missing).
 */
interface ProtobufModule {
  createFileRegistry(fdSet: unknown): { getService(name: string): unknown };
  fromBinary(schema: unknown, bytes: Uint8Array): unknown;
}

/**
 * Shape of the @bufbuild/protobuf/wkt module.
 */
interface WktModule {
  FileDescriptorSetSchema: unknown;
}

/**
 * Shape of the @connectrpc/connect/protocol module.
 */
interface ProtocolModule {
  createFetchHandler(
    uHandler: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    options?: { httpVersion?: string },
  ): (request: Request) => Promise<Response>;
}

/**
 * Decodes a base64 string into a Uint8Array.
 */
function decodeBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Creates a ConnectRuntime implementation from raw module objects.
 */
function createConnectRuntime(
  mod: ConnectModule,
  protobuf: ProtobufModule,
  wkt: WktModule,
  proto: ProtocolModule,
): ConnectRuntime {
  const { createFileRegistry, fromBinary } = protobuf;
  const { FileDescriptorSetSchema } = wkt;

  return {
    createConnectRouter() {
      // Delegate to the real createConnectRouter from the connect module
      return (mod as {
        createConnectRouter: () => {
          handlers: Array<
            { requestPath: string; handler: (request: Request) => Promise<Response> }
          >;
          service: (service: unknown, impl: unknown, options?: unknown) => void;
        };
      }).createConnectRouter();
    },

    createFetchHandler(
      uHandler: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
      options?: { httpVersion?: string },
    ): (request: Request) => Promise<Response> {
      return proto.createFetchHandler(uHandler, options);
    },

    reviveDescriptorSet(base64: string): unknown {
      const bytes = decodeBase64(base64);
      const fdSet = fromBinary(FileDescriptorSetSchema, bytes);
      // createFileRegistry is the ONLY entry point that resolves services from a
      // serialized FileDescriptorSet; createRegistry returns an empty registry.
      return createFileRegistry(fdSet);
    },

    getService(registry: unknown, serviceName: string): unknown {
      const reg = registry as { getService?: (name: string) => unknown } | null;
      return reg?.getService?.(serviceName) || undefined;
    },

    createRegistry(fdSet: unknown): unknown {
      // Build a FileRegistry from a FileDescriptorSet (createFileRegistry).
      // Kept under the historical name `createRegistry` to avoid widening the
      // internal ConnectRuntime port's surface; the underlying call is correct.
      return createFileRegistry(fdSet);
    },
  };
}

/**
 * Builds the error message for a failed module load.
 * Exported for testing.
 */
export function buildLoadErrorMessage(
  specifier: string,
  installCommand: string,
): string {
  return `Cannot load Connect runtime module: ${specifier}. Run: ${installCommand}`;
}

/**
 * Default dynamic import function used by loadConnectModules.
 * Exported for testing to allow mocking.
 */
export async function defaultImport(specifier: string): Promise<unknown> {
  return await import(specifier) as unknown;
}

/**
 * Internal helper that loads all four Connect runtime modules.
 * Exported for testing to allow coverage of the load path.
 *
 * @param importer - Optional injectable import function for testing.
 */
export async function loadConnectModules(
  importer: typeof defaultImport = defaultImport,
): Promise<void> {
  // Load connectrpc/connect
  if (!connectModule) {
    try {
      connectModule = await importer('npm:@connectrpc/connect@^2.1.2');
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
      protobufModule = await importer('npm:@bufbuild/protobuf@^2.7.0');
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
      wktModule = await importer('npm:@bufbuild/protobuf@^2.7.0/wkt');
    } catch (_e) {
      throw new GrpcRuntimeLoadError(
        '@bufbuild/protobuf/wkt',
        'deno add @bufbuild/protobuf@^2.7.0/wkt',
      );
    }
  }

  // Load the protocol module
  if (!protocolModule) {
    try {
      protocolModule = await importer('npm:@connectrpc/connect@^2.1.2/protocol');
    } catch (_e) {
      throw new GrpcRuntimeLoadError(
        '@connectrpc/connect/protocol',
        'deno add @connectrpc/connect@^2.1.2',
      );
    }
  }
}

/**
 * Lazy-loads all four Connect runtime modules from npm. Throws
 * {@linkcode GrpcRuntimeLoadError} if any specifier cannot be resolved.
 */
export async function loadConnectModule(): Promise<ConnectRuntime> {
  await loadConnectModules();
  return createConnectRuntime(
    connectModule as ConnectModule,
    protobufModule as ProtobufModule,
    wktModule as WktModule,
    protocolModule as ProtocolModule,
  );
}

/**
 * Fallback connect runtime for when Connect is not available (e.g., during testing).
 * Returns a singleton instance.
 */
export function getFallbackConnectRuntime(): ConnectRuntime {
  if (!fallbackRuntime) {
    fallbackRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
      getService: (_registry: unknown, _serviceName: string): unknown => undefined,
      createRegistry: () => ({ getService: () => undefined }),
    };
  }
  return fallbackRuntime;
}
