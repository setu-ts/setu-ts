/**
 * Test fixture: a fake {@linkcode ConnectRuntime} plus descriptor builders.
 *
 * The fake honors the REAL runtime's contract, verified against
 * `@connectrpc/connect@2.1.2` / `@bufbuild/protobuf@2.13.0`:
 *
 * - `DescFile.name` has NO `.proto` suffix while `proto.name` retains it, so a
 *   fixture that used one name for both would hide the filename-keying bug.
 * - `createFetchHandler`'s result retains `requestPath`.
 * - `getService` returns `undefined` for an absent service rather than throwing.
 *
 * Not shipped to consumers.
 */

import type {
  ConnectRouterLike,
  ConnectRuntime,
  EnumDescriptorLike,
  ExtensionDescriptorLike,
  FileDescriptorLike,
  FileRegistryLike,
  MessageDescriptorLike,
  ServiceDescriptorLike,
  UniversalHandlerLike,
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
): ServiceDescriptorLike {
  // `exactOptionalPropertyTypes` is on: omit `file` rather than setting it to
  // undefined.
  return {
    kind: 'service',
    typeName,
    methods: methodNames.map((name) => ({ name })),
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
}

/** Options for {@linkcode createFakeConnectRuntime}. */
export interface FakeConnectRuntimeOptions {
  /** Services resolvable by name from any revived descriptor set. */
  readonly services?: readonly ServiceDescriptorLike[];
  /** Request paths the router reports; defaults to one per registered service. */
  readonly requestPaths?: readonly string[];
  /** Makes `reviveDescriptorSet` throw, standing in for corrupt bytes. */
  readonly reviveThrows?: boolean;
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
  const byName = new Map((options.services ?? []).map((s) => [s.typeName, s]));

  const router: ConnectRouterLike = {
    get handlers(): readonly UniversalHandlerLike[] {
      if (options.requestPaths !== undefined) {
        return options.requestPaths.map((requestPath) => ({ requestPath }));
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

    createConnectRouter: () => router,

    createFetchHandler(handler: UniversalHandlerLike) {
      const fetchHandler = (_request: Request): Promise<Response> =>
        Promise.resolve(new Response(`handled:${handler.requestPath}`, { status: 200 }));
      // The real `createFetchHandler` returns Object.assign(fn, uHandler).
      return Object.assign(fetchHandler, handler);
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
  };
}
