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

/**
 * Shape of the @connectrpc/connect module.
 */
interface ConnectModule {
  createConnectRouter(): {
    handlers: Array<{ requestPath: string; handler: unknown }>;
    service<T extends { typeName: string }>(
      service: T,
      implementation: Record<string, (...args: unknown[]) => unknown>,
      options?: Record<string, unknown>,
    ): void;
  };
}

/**
 * Shape of the @bufbuild/protobuf module.
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

  // Cache the real router so createConnectRouter() always returns the same instance
  let cachedRealRouter: {
    handlers: Array<{ requestPath: string; handler: unknown }>;
    service: (service: unknown, impl: unknown, options?: unknown) => void;
  } | null = null;

  return {
    createConnectRouter() {
      if (cachedRealRouter === null) {
        // Delegate to the real createConnectRouter from the connect module
        const realRouter = (mod as {
          createConnectRouter: () => {
            handlers: Array<{ requestPath: string; handler: unknown }>;
            service: (service: unknown, impl: unknown, options?: unknown) => void;
          };
        }).createConnectRouter();
        // Cache the real router directly to ensure handlers are shared
        cachedRealRouter = realRouter;
      }
      return cachedRealRouter;
    },

    createFetchHandler(
      uHandler: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
      options?: { httpVersion?: string },
    ): (request: Request) => Promise<Response> {
      return proto.createFetchHandler(uHandler, options);
    },

    adaptConnectModule(_m: unknown): ConnectRuntime {
      if (!protobufModule || !wktModule || !protocolModule) {
        throw new Error('Protobuf/protocol modules not available for adaptation');
      }
      return createConnectRuntime(
        _m as ConnectModule,
        protobufModule as ProtobufModule,
        wktModule as WktModule,
        protocolModule as ProtocolModule,
      );
    },

    loadConnectModule: () => loadConnectModule(),

    reviveDescriptorSet(base64: string): unknown {
      const bytes = new Uint8Array(
        base64.split('').map((c) => c.charCodeAt(0) & 0xFF),
      );
      const fdSet = fromBinary(FileDescriptorSetSchema, bytes);
      return createFileRegistry(fdSet);
    },

    getService(registry: unknown, serviceName: string): unknown {
      const reg = registry as { getService?: (name: string) => unknown } | null;
      return reg?.getService?.(serviceName) || undefined;
    },
  };
}

/**
 * Lazy-loads all four Connect runtime modules from npm. Throws
 * {@linkcode GrpcRuntimeLoadError} if any specifier cannot be resolved.
 */
export async function loadConnectModule(): Promise<ConnectRuntime> {
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

  // Load the protocol module
  if (!protocolModule) {
    try {
      protocolModule = await import('npm:@connectrpc/connect@^2.1.2/protocol') as unknown;
    } catch (_e) {
      throw new GrpcRuntimeLoadError(
        '@connectrpc/connect/protocol',
        'deno add @connectrpc/connect@^2.1.2',
      );
    }
  }

  // Create a NEW runtime instance for each call — don't cache at module level
  // This ensures each plugin instance gets its own router
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
  return {
    createConnectRouter: () => ({ handlers: [], service: () => {} }),
    createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
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
  mod: unknown,
  protobuf: unknown,
  wkt: unknown,
): ConnectRuntime {
  // For tests, we need a protocol module too
  const protocolModule = {
    createFetchHandler: (
      uHandler: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => {
      return async (request: Request) => {
        // Build a minimal universal request from the fetch request
        const universalRequest = {
          url: request.url,
          method: request.method,
          header: Object.fromEntries(request.headers.entries()),
          body: null,
          httpVersion: '',
          signal: request.signal,
        };

        try {
          const response = await uHandler(universalRequest);
          const body = response.body ? await request.text() : null;
          return new Response(body ?? JSON.stringify(response), {
            status: (response.status as number) ?? 200,
            headers: (response.header as HeadersInit) ?? new Headers(),
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
      };
    },
  } as ProtocolModule;

  return createConnectRuntime(
    mod as ConnectModule,
    protobuf as ProtobufModule,
    wkt as WktModule,
    protocolModule,
  );
}
