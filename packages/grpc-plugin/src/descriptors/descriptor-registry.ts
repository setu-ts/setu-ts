/**
 * The reflection registry — the single index behind every
 * `grpc.reflection.v1.ServerReflection` answer.
 *
 * It is built once at router-build time from the plugin's two embedded files
 * plus every registered application service's own `DescFile` and its transitive
 * `dependencies`, then indexed three ways: by proto filename, by
 * fully-qualified symbol, and by extended-message type name. Reflection lookups
 * are therefore `Map` hits rather than scans (AI_GUIDELINES §14).
 *
 * The symbol walk is deliberately our own rather than a delegation to
 * `FileRegistry.get()`: verified against `@bufbuild/protobuf@2.13.0`, `get()`
 * resolves neither nested message types (`pkg.Msg.NestedEntry`) nor methods
 * (`pkg.Svc.Method`), both of which are legal `file_containing_symbol` inputs.
 *
 * @module
 */

import { GrpcDescriptorError } from '../errors/grpc-errors.ts';
import type {
  ConnectRuntime,
  FileDescriptorLike,
  MessageDescriptorLike,
  ServiceDescriptorLike,
} from '../interfaces/connect-runtime.ts';

/**
 * The reflection index consumed by the `ServerReflectionInfo` implementation.
 */
export interface ReflectionRegistry {
  /** Every service name the server exposes, in registration order. */
  listServices(): readonly string[];
  /**
   * The serialized `FileDescriptorProto` for a proto filename
   * (e.g. `grpc/health/v1/health.proto`), or `undefined` if unknown.
   */
  getFileByName(filename: string): Uint8Array | undefined;
  /**
   * The serialized `FileDescriptorProto` of the file declaring a
   * fully-qualified symbol, or `undefined` if unknown.
   */
  getFileContainingSymbol(symbol: string): Uint8Array | undefined;
  /**
   * The extension field numbers declared against a message type. Returns an
   * empty array for a known type with no extensions, and `undefined` when the
   * type itself is unknown — the distinction reflection reports as
   * `NOT_FOUND`.
   */
  getExtensionNumbers(typeName: string): readonly number[] | undefined;
}

/**
 * Revives a service descriptor from an embedded base64 `FileDescriptorSet`.
 *
 * @throws {GrpcDescriptorError} If the set does not declare the named service —
 *   i.e. the committed constant is truncated, swapped, or regenerated against
 *   an incompatible proto.
 */
export function reviveServiceDescriptor(
  connectRuntime: ConnectRuntime,
  base64: string,
  serviceName: string,
): ServiceDescriptorLike {
  const registry = connectRuntime.reviveDescriptorSet(base64);
  const service = connectRuntime.getService(registry, serviceName);
  if (service === undefined) {
    throw new GrpcDescriptorError(
      `the embedded descriptor set does not declare the service '${serviceName}'`,
    );
  }
  return service;
}

/** Collects a file and its transitive dependencies, de-duplicated by proto name. */
function collectFiles(
  file: FileDescriptorLike | undefined,
  seen: Map<string, FileDescriptorLike>,
): void {
  if (file === undefined || seen.has(file.proto.name)) {
    return;
  }
  seen.set(file.proto.name, file);
  for (const dependency of file.dependencies) {
    collectFiles(dependency, seen);
  }
}

/** Indexes a message and everything nested inside it. */
function indexMessage(
  message: MessageDescriptorLike,
  file: FileDescriptorLike,
  symbols: Map<string, FileDescriptorLike>,
  extensions: Map<string, number[]>,
): void {
  symbols.set(message.typeName, file);
  for (const nested of message.nestedMessages) {
    indexMessage(nested, file, symbols, extensions);
  }
  for (const nestedEnum of message.nestedEnums) {
    symbols.set(nestedEnum.typeName, file);
  }
  for (const extension of message.nestedExtensions) {
    indexExtension(extension, file, symbols, extensions);
  }
}

/** Indexes an extension by its own symbol and against the message it extends. */
function indexExtension(
  extension: { typeName: string; number: number; extendee: { typeName: string } },
  file: FileDescriptorLike,
  symbols: Map<string, FileDescriptorLike>,
  extensions: Map<string, number[]>,
): void {
  symbols.set(extension.typeName, file);
  const numbers = extensions.get(extension.extendee.typeName);
  if (numbers === undefined) {
    extensions.set(extension.extendee.typeName, [extension.number]);
  } else {
    numbers.push(extension.number);
  }
}

/**
 * Whether a type name is one the server can speak about.
 *
 * A type reached only as an extendee counts: the extension proves the server
 * knows the type exists, even when the message itself is declared in a file the
 * server does not serve.
 */
function isKnownType(
  typeName: string,
  symbols: ReadonlyMap<string, FileDescriptorLike>,
  extensions: ReadonlyMap<string, readonly number[]>,
): boolean {
  return symbols.has(typeName) || extensions.has(typeName);
}

/**
 * Builds the reflection registry.
 *
 * @param connectRuntime - Used to re-serialize each file to `FileDescriptorProto` bytes.
 * @param files - Roots to index; their transitive `dependencies` are pulled in
 *   automatically and de-duplicated, so a proto shared by two services is
 *   indexed once.
 * @param serviceNames - Service names to advertise from `list_services`, in
 *   registration order.
 */
export function buildReflectionRegistry(
  connectRuntime: ConnectRuntime,
  files: readonly (FileDescriptorLike | undefined)[],
  serviceNames: readonly string[],
): ReflectionRegistry {
  const collected = new Map<string, FileDescriptorLike>();
  for (const file of files) {
    collectFiles(file, collected);
  }

  const symbols = new Map<string, FileDescriptorLike>();
  const extensions = new Map<string, number[]>();

  for (const file of collected.values()) {
    for (const message of file.messages) {
      indexMessage(message, file, symbols, extensions);
    }
    for (const fileEnum of file.enums) {
      symbols.set(fileEnum.typeName, file);
    }
    for (const extension of file.extensions) {
      indexExtension(extension, file, symbols, extensions);
    }
    for (const service of file.services) {
      symbols.set(service.typeName, file);
      // Methods are legal `file_containing_symbol` inputs but are absent from
      // Protobuf-ES's own symbol lookup, so index them explicitly.
      for (const method of service.methods ?? []) {
        symbols.set(`${service.typeName}.${method.name}`, file);
      }
    }
  }

  /** Serializes lazily and memoizes — a file is re-serialized at most once. */
  const serialized = new Map<string, Uint8Array>();
  function serialize(file: FileDescriptorLike): Uint8Array {
    const cached = serialized.get(file.proto.name);
    if (cached !== undefined) {
      return cached;
    }
    const bytes = connectRuntime.serializeFileDescriptor(file);
    serialized.set(file.proto.name, bytes);
    return bytes;
  }

  return {
    listServices(): readonly string[] {
      return serviceNames;
    },

    getFileByName(filename: string): Uint8Array | undefined {
      const file = collected.get(filename);
      return file === undefined ? undefined : serialize(file);
    },

    getFileContainingSymbol(symbol: string): Uint8Array | undefined {
      const file = symbols.get(symbol);
      return file === undefined ? undefined : serialize(file);
    },

    getExtensionNumbers(typeName: string): readonly number[] | undefined {
      if (!isKnownType(typeName, symbols, extensions)) {
        return undefined;
      }
      return extensions.get(typeName) ?? [];
    },
  };
}
