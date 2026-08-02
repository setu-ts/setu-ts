/**
 * Structural facades and ports for the Connect-ES runtime.
 *
 * These are NOT exported from `src/index.ts` — they form an internal port that
 * adapts the lazy-loaded Connect modules without introducing a hard dependency
 * on `@connectrpc/connect` or `@bufbuild/protobuf` in the plugin's type graph
 * (AI_GUIDELINES §12.2; the `adaptWsModule` precedent in M46).
 *
 * Every member below exists because a real code path reads it — the port is
 * sized to the plugin's needs, not to the libraries' surface.
 *
 * @module
 */

/** A Protobuf-ES `DescEnum`, seen structurally. */
export interface EnumDescriptorLike {
  readonly typeName: string;
}

/** A Protobuf-ES `DescExtension`, seen structurally. */
export interface ExtensionDescriptorLike {
  readonly typeName: string;
  /** The extension's field number, reported by `all_extension_numbers_of_type`. */
  readonly number: number;
  /** The message this extension extends. */
  readonly extendee: { readonly typeName: string };
}

/**
 * A Protobuf-ES `DescMessage`, seen structurally.
 *
 * The nested collections matter: neither `FileRegistry.get()` nor
 * `getService()` resolves a nested type (verified against
 * `@bufbuild/protobuf@2.13.0` — `get('pkg.Msg.NestedEntry')` returns
 * `undefined`), so the reflection symbol index walks these itself.
 */
export interface MessageDescriptorLike {
  readonly typeName: string;
  readonly nestedMessages: readonly MessageDescriptorLike[];
  readonly nestedEnums: readonly EnumDescriptorLike[];
  readonly nestedExtensions: readonly ExtensionDescriptorLike[];
}

/** A Protobuf-ES `DescMethod`, seen structurally. */
export interface MethodDescriptorLike {
  /** The proto method name, e.g. `Check` (not the camelCase `localName`). */
  readonly name: string;
}

/**
 * A Protobuf-ES `DescService`, seen structurally. Real descriptors carry
 * `kind: 'service'`; the plugin reads `typeName` for routing and dedup, `file`
 * when building the reflection registry, and `methods` for symbol indexing.
 */
export interface ServiceDescriptorLike {
  readonly kind?: string;
  readonly typeName: string;
  readonly file?: FileDescriptorLike;
  readonly methods?: readonly MethodDescriptorLike[];
}

/**
 * A Protobuf-ES `DescFile`, seen structurally.
 *
 * `name` is the proto path WITHOUT the `.proto` suffix, while `proto.name`
 * retains it — verified against `@bufbuild/protobuf@2.13.0`, where
 * `getFile('grpc/reflection/v1/reflection.proto')` resolves but
 * `getFile('grpc/reflection/v1/reflection')` returns `undefined`. Reflection
 * clients send the suffixed form, so `proto.name` is the key the registry
 * indexes by.
 */
export interface FileDescriptorLike {
  /** Proto path without the `.proto` suffix (e.g. `grpc/health/v1/health`). */
  readonly name: string;
  /** The raw `FileDescriptorProto`; `proto.name` retains the `.proto` suffix. */
  readonly proto: { readonly name: string };
  /** Files this one imports, already resolved to descriptors. */
  readonly dependencies: readonly FileDescriptorLike[];
  readonly messages: readonly MessageDescriptorLike[];
  readonly enums: readonly EnumDescriptorLike[];
  readonly extensions: readonly ExtensionDescriptorLike[];
  readonly services: readonly ServiceDescriptorLike[];
}

/** A Protobuf-ES `FileRegistry`, seen structurally. */
export interface FileRegistryLike {
  /** Every file in the revived descriptor set. */
  readonly files: Iterable<FileDescriptorLike>;
  getService(name: string): ServiceDescriptorLike | undefined;
}

/** A Connect `UniversalHandler`, seen structurally. */
export interface UniversalHandlerLike {
  /** The procedure path without prefixes, e.g. `/pkg.Svc/Method`. */
  readonly requestPath: string;
}

/** A Connect `ConnectRouter`, seen structurally. */
export interface ConnectRouterLike {
  readonly handlers: readonly UniversalHandlerLike[];
  service(
    service: ServiceDescriptorLike,
    implementation: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): unknown;
}

/**
 * Internal port produced by the Connect runtime loader. The plugin never
 * imports `@connectrpc/connect` or `@bufbuild/protobuf` directly; everything
 * downstream of the loader consumes this port.
 */
export interface ConnectRuntime {
  /** Creates a new `ConnectRouter` for registering services. */
  createConnectRouter(): ConnectRouterLike;

  /**
   * Adapts a Connect `UniversalHandler` into a fetch handler. The result
   * retains `requestPath`, so the dispatch map is built from the handlers
   * themselves with no parallel bookkeeping.
   */
  createFetchHandler(handler: UniversalHandlerLike): (request: Request) => Promise<Response>;

  /**
   * Revives a base64 `FileDescriptorSet` into a `FileRegistry`.
   *
   * `createFileRegistry` is the only `@bufbuild/protobuf` entry point that
   * resolves service descriptors from a serialized descriptor set.
   *
   * @throws {GrpcDescriptorError} If the bytes are not a valid `FileDescriptorSet`.
   */
  reviveDescriptorSet(base64: string): FileRegistryLike;

  /** Looks a service descriptor up in a revived registry. */
  getService(registry: FileRegistryLike, serviceName: string): ServiceDescriptorLike | undefined;

  /**
   * Re-serializes a file descriptor to `FileDescriptorProto` bytes — the wire
   * payload of a reflection `file_descriptor_response`.
   */
  serializeFileDescriptor(file: FileDescriptorLike): Uint8Array;
}
