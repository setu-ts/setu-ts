/**
 * Test fixture: a fake {@linkcode ConnectRuntime} plus descriptor builders.
 *
 * The fake honors the REAL runtime's contract, verified against
 * `@connectrpc/connect@2.1.2` / `@bufbuild/protobuf@2.13.0`:
 *
 * - `DescFile.name` has NO `.proto` suffix while `proto.name` retains it, so a
 *   fixture that used one name for both would hide the filename-keying bug.
 * - A universal handler answers a native `application/grpc` call with its
 *   status in the trailer, and any other call with its status in the body.
 * - `getService` returns `undefined` for an absent service rather than throwing.
 *
 * Not shipped to consumers.
 */

import type {
  ClientTransportLike,
  ConnectRouterLike,
  ConnectRuntime,
  EnumDescriptorLike,
  ExtensionDescriptorLike,
  FileDescriptorLike,
  FileRegistryLike,
  MessageDescriptorLike,
  ServiceDescriptorLike,
  UniversalHandlerLike,
  UniversalServerRequestLike,
} from '../../src/interfaces/connect-runtime.ts';

/** Builds a fake message descriptor. */
export function fakeMessage(
  typeName: string,
  nested: {
    messages?: MessageDescriptorLike[];
    enums?: EnumDescriptorLike[];
    extensions?: ExtensionDescriptorLike[];
  } = {},
): MessageDescriptorLike {
  return {
    typeName,
    nestedMessages: nested.messages ?? [],
    nestedEnums: nested.enums ?? [],
    nestedExtensions: nested.extensions ?? [],
  };
}

/** Builds a fake extension descriptor. */
export function fakeExtension(
  typeName: string,
  extendee: string,
  number: number,
): ExtensionDescriptorLike {
  return { typeName, number, extendee: { typeName: extendee } };
}

/** Builds a fake service descriptor, optionally attached to a file. */
export function fakeService(
  typeName: string,
  methodNames: string[] = [],
  file?: FileDescriptorLike,
  /**
   * Maps a proto method name to its camelCase `localName` (the property
   * Connect looks up on the implementation). Omitted when the local name
   * matches the proto name, mirroring a method like `Echo`.
   */
  localNames: Record<string, string> = {},
): ServiceDescriptorLike {
  // `exactOptionalPropertyTypes` is on: omit `file` and `localName` rather
  // than setting them to undefined.
  return {
    kind: 'service',
    typeName,
    methods: methodNames.map((name) => ({
      name,
      ...(localNames[name] !== undefined ? { localName: localNames[name] } : {}),
    })),
    ...(file === undefined ? {} : { file }),
  };
}

/**
 * Builds a fake file descriptor.
 *
 * @param protoName - The suffixed proto path (e.g. `example/echo.proto`).
 *   `name` is derived by stripping the suffix, mirroring Protobuf-ES.
 */
export function fakeFile(
  protoName: string,
  parts: {
    dependencies?: FileDescriptorLike[];
    messages?: MessageDescriptorLike[];
    enums?: EnumDescriptorLike[];
    extensions?: ExtensionDescriptorLike[];
    services?: ServiceDescriptorLike[];
  } = {},
): FileDescriptorLike {
  return {
    name: protoName.replace(/\.proto$/, ''),
    proto: { name: protoName },
    dependencies: parts.dependencies ?? [],
    messages: parts.messages ?? [],
    enums: parts.enums ?? [],
    extensions: parts.extensions ?? [],
    services: parts.services ?? [],
  };
}

/** A record of what the fake router was asked to register. */
export interface RegisteredService {
  readonly definition: ServiceDescriptorLike;
  readonly implementation: Record<string, unknown>;
}

/** The fake runtime plus the observation surface its tests assert against. */
export interface FakeConnectRuntime extends ConnectRuntime {
  /** Services registered on the router, in registration order. */
  readonly registered: RegisteredService[];
  /** Files handed to `serializeFileDescriptor`, in call order. */
  readonly serializedFiles: string[];
  /** Base64 constants passed to `reviveDescriptorSet`, in call order. */
  readonly revived: string[];
  /** Options handed to `createConnectRouter`, in call order. */
  readonly routerOptions: Record<string, unknown>[];
  /** Universal requests handed to `handleUniversal`, in call order. */
  readonly universalRequests: UniversalServerRequestLike[];
}

/** Options for {@linkcode createFakeConnectRuntime}. */
export interface FakeConnectRuntimeOptions {
  /** Services resolvable by name from any revived descriptor set. */
  readonly services?: readonly ServiceDescriptorLike[];
  /** Request paths the router reports; defaults to one per registered service. */
  readonly requestPaths?: readonly string[];
  /** Makes `reviveDescriptorSet` throw, standing in for corrupt bytes. */
  readonly reviveThrows?: boolean;
  /** `methodKind` per request path; unlisted paths carry no `method` (unary). */
  readonly methodKinds?: Readonly<Record<string, string>>;
}

/**
 * Creates a fake {@linkcode ConnectRuntime} for unit tests that must not reach
 * the network.
 */
export function createFakeConnectRuntime(
  options: FakeConnectRuntimeOptions = {},
): FakeConnectRuntime {
  const registered: RegisteredService[] = [];
  const serializedFiles: string[] = [];
  const revived: string[] = [];
  const routerOptions: Record<string, unknown>[] = [];
  const universalRequests: UniversalServerRequestLike[] = [];
  const byName = new Map((options.services ?? []).map((s) => [s.typeName, s]));

  const router: ConnectRouterLike = {
    get handlers(): readonly UniversalHandlerLike[] {
      if (options.requestPaths !== undefined) {
        return options.requestPaths.map((requestPath) => {
          const methodKind = options.methodKinds?.[requestPath];
          return methodKind === undefined
            ? { requestPath }
            : { requestPath, method: { methodKind } };
        });
      }
      return registered.map((r) => ({ requestPath: `/${r.definition.typeName}/Method` }));
    },
    service(definition, implementation) {
      registered.push({ definition, implementation });
      return router;
    },
  };

  return {
    registered,
    serializedFiles,
    revived,
    routerOptions,
    universalRequests,

    createConnectRouter(options?: Record<string, unknown>) {
      routerOptions.push(options ?? {});
      return router;
    },

    handleUniversal(handler: UniversalHandlerLike, request: UniversalServerRequestLike) {
      universalRequests.push(request);
      if (
        !/^application\/grpc(\+(proto|json))?(;|$)/.test(request.header.get('content-type') ?? '')
      ) {
        // Connect and gRPC-Web: the status travels in the body.
        const text = async function* (): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode(`handled:${handler.requestPath}`);
        };
        return Promise.resolve({
          status: 200,
          header: new Headers({ 'content-type': 'text/plain;charset=UTF-8' }),
          body: text(),
        });
      }
      // One message, then the call's status in the trailer — the shape a
      // native gRPC reply has once Connect's universal handler ends.
      const trailer = new Headers();
      async function* body(): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode(`universal:${handler.requestPath}`);
        trailer.set('grpc-status', '0');
      }
      return Promise.resolve({
        status: 200,
        header: new Headers({ 'content-type': 'application/grpc+proto' }),
        body: body(),
        trailer,
      });
    },

    reviveDescriptorSet(base64: string): FileRegistryLike {
      revived.push(base64);
      if (options.reviveThrows === true) {
        throw new Error('corrupt descriptor set');
      }
      const files = [...byName.values()]
        .map((s) => s.file)
        .filter((f): f is FileDescriptorLike => f !== undefined);
      return {
        files,
        getService: (name: string) => byName.get(name),
      };
    },

    getService(registry: FileRegistryLike, serviceName: string) {
      return registry.getService(serviceName);
    },

    serializeFileDescriptor(file: FileDescriptorLike): Uint8Array {
      serializedFiles.push(file.proto.name);
      return new TextEncoder().encode(`fd:${file.proto.name}`);
    },

    // The client side (§3.12): a client is the pair it was built from, and an
    // `Unavailable` error is a `FakeUnavailableError`.
    createClient(service: unknown, transport: ClientTransportLike): unknown {
      return { service, transport };
    },

    unavailable(message: string): Error {
      return new FakeUnavailableError(message);
    },

    isUnavailable(error: unknown): boolean {
      return error instanceof FakeUnavailableError;
    },
  };
}

/** The fake runtime's `Unavailable` error. */
export class FakeUnavailableError extends Error {
  readonly code = 14;
}
