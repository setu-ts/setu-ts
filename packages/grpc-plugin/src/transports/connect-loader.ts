/**
 * Connect runtime loader — the inject-or-lazy seam over the four Connect-ES /
 * Protobuf-ES specifiers (AI_GUIDELINES §12.2).
 *
 * The split is deliberate: {@linkcode adaptConnectModule} is a PURE adapter over
 * already-imported modules, so every branch is unit-testable with a hand-built
 * fake, while {@linkcode loadConnectModule} owns the four real `import()` calls
 * behind a guarded real-import test. There is no global hook and no no-op
 * fallback runtime — a missing dependency throws {@linkcode GrpcRuntimeLoadError}
 * naming the specifier, rather than degrading into a router that silently
 * answers `404`.
 *
 * @module
 */

import { GrpcDescriptorError, GrpcRuntimeLoadError } from '../errors/grpc-errors.ts';
import type {
  ConnectRouterLike,
  ConnectRuntime,
  FileDescriptorLike,
  FileRegistryLike,
  ServiceDescriptorLike,
  UniversalHandlerLike,
} from '../interfaces/connect-runtime.ts';

/** The four specifiers the runtime is assembled from, in load order. */
const SPECIFIERS = {
  connect: 'npm:@connectrpc/connect@^2.1.2',
  protocol: 'npm:@connectrpc/connect@^2.1.2/protocol',
  protobuf: 'npm:@bufbuild/protobuf@^2.7.0',
  wkt: 'npm:@bufbuild/protobuf@^2.7.0/wkt',
} as const;

/** The install command suggested for each failing specifier. */
const INSTALL_COMMANDS: Record<keyof typeof SPECIFIERS, string> = {
  connect: 'deno add npm:@connectrpc/connect@^2.1.2',
  protocol: 'deno add npm:@connectrpc/connect@^2.1.2',
  protobuf: 'deno add npm:@bufbuild/protobuf@^2.7.0',
  wkt: 'deno add npm:@bufbuild/protobuf@^2.7.0',
};

/** Structural shape of `@connectrpc/connect`. */
export interface ConnectCoreModuleLike {
  createConnectRouter(options?: Record<string, unknown>): ConnectRouterLike;
}

/** Structural shape of `@connectrpc/connect/protocol`. */
export interface ConnectProtocolModuleLike {
  createFetchHandler(
    handler: UniversalHandlerLike,
    options?: Record<string, unknown>,
  ): (request: Request) => Promise<Response>;
}

/** Structural shape of `@bufbuild/protobuf`. */
export interface ProtobufModuleLike {
  createFileRegistry(fileDescriptorSet: unknown): FileRegistryLike;
  fromBinary(schema: unknown, bytes: Uint8Array): unknown;
  toBinary(schema: unknown, message: unknown): Uint8Array;
}

/** Structural shape of `@bufbuild/protobuf/wkt`. */
export interface ProtobufWktModuleLike {
  FileDescriptorSetSchema: unknown;
  FileDescriptorProtoSchema: unknown;
}

/** The four modules the runtime is adapted from. */
export interface ConnectModuleLike {
  connect: ConnectCoreModuleLike;
  protocol: ConnectProtocolModuleLike;
  protobuf: ProtobufModuleLike;
  wkt: ProtobufWktModuleLike;
}

/** Decodes a base64 string into bytes. */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Adapts already-imported Connect and Protobuf-ES modules into the internal
 * {@linkcode ConnectRuntime} port. Pure — it performs no I/O, so unit tests
 * drive it with a fake module bundle.
 *
 * @param modules - The four modules of {@linkcode ConnectModuleLike}.
 * @returns The internal runtime port every other module consumes.
 */
export function adaptConnectModule(modules: ConnectModuleLike): ConnectRuntime {
  const { connect, protocol, protobuf, wkt } = modules;

  return {
    createConnectRouter(): ConnectRouterLike {
      return connect.createConnectRouter();
    },

    createFetchHandler(handler: UniversalHandlerLike): (request: Request) => Promise<Response> {
      // `httpVersion` is deliberately left unset: IHttpAdapter surfaces no
      // negotiated HTTP version, and the only behavior it gates is Connect's
      // bidi refusal, which would then fire even on transports that support
      // bidi (plan §3.5/§3.8).
      return protocol.createFetchHandler(handler);
    },

    reviveDescriptorSet(base64: string): FileRegistryLike {
      let fileDescriptorSet: unknown;
      try {
        fileDescriptorSet = protobuf.fromBinary(
          wkt.FileDescriptorSetSchema,
          decodeBase64(base64),
        );
      } catch (cause) {
        throw new GrpcDescriptorError(
          'the embedded descriptor set could not be decoded as a FileDescriptorSet',
          { cause },
        );
      }
      return protobuf.createFileRegistry(fileDescriptorSet);
    },

    getService(
      registry: FileRegistryLike,
      serviceName: string,
    ): ServiceDescriptorLike | undefined {
      return registry.getService(serviceName);
    },

    serializeFileDescriptor(file: FileDescriptorLike): Uint8Array {
      return protobuf.toBinary(wkt.FileDescriptorProtoSchema, file.proto);
    },
  };
}

/**
 * The dynamic import used by {@linkcode loadConnectModule}. Injectable so the
 * per-specifier failure branches are unit-testable without uninstalling a
 * package; the default performs the REAL `import()`.
 */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/** Default importer — a real dynamic `import()`, never a global hook. */
export const defaultImporter: ModuleImporter = (specifier) => import(specifier);

/**
 * Lazily imports the four Connect/Protobuf-ES specifiers and adapts them into
 * the internal runtime port.
 *
 * @param importer - Injected importer; defaults to a real dynamic `import()`.
 * @throws {GrpcRuntimeLoadError} If any specifier cannot be imported. The error
 *   names the failing specifier and the command that installs it.
 */
export async function loadConnectModule(
  importer: ModuleImporter = defaultImporter,
): Promise<ConnectRuntime> {
  const loaded = {} as Record<keyof typeof SPECIFIERS, unknown>;

  for (const key of Object.keys(SPECIFIERS) as Array<keyof typeof SPECIFIERS>) {
    try {
      loaded[key] = await importer(SPECIFIERS[key]);
    } catch (cause) {
      throw new GrpcRuntimeLoadError(SPECIFIERS[key], INSTALL_COMMANDS[key], { cause });
    }
  }

  return adaptConnectModule({
    connect: loaded.connect as ConnectCoreModuleLike,
    protocol: loaded.protocol as ConnectProtocolModuleLike,
    protobuf: loaded.protobuf as ProtobufModuleLike,
    wkt: loaded.wkt as ProtobufWktModuleLike,
  });
}
