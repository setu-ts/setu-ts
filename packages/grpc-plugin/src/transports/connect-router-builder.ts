/**
 * Connect router builder — registers services, health, and reflection onto a
 * Connect router using the REAL Connect API, then produces a dispatch map
 * keyed by full path.
 *
 * @module
 */

import { normalizeBasePath } from './rpc-dispatcher.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Shape of a service definition with a typeName property. */
interface ServiceDefinitionLike {
  typeName?: string;
  methods?: Record<string, unknown>;
}

/**
 * Builds a Connect router and returns a dispatch map plus the registry for
 * reflection queries.
 *
 * Uses the real Connect runtime API: createConnectRouter() + router.service()
 * + createFetchHandler() from @connectrpc/connect/protocol.
 */
export function buildConnectRouter({
  connectRuntime,
  basePath,
  reflection,
  health,
  services,
  embeddedDescriptors,
}: {
  connectRuntime: ConnectRuntime;
  basePath: string;
  reflection: boolean;
  health: boolean;
  services: Array<{
    definition: unknown;
    implementation?: unknown;
  }>;
  embeddedDescriptors: EmbeddedDescriptors;
}): {
  dispatchMap: Map<string, (request: Request) => Promise<Response>>;
  registry: unknown;
} {
  const normalizedBase = normalizeBasePath(basePath);

  // Track service type names to detect duplicates
  const typeNames = new Set<string>();
  for (const serviceDef of services) {
    const def = serviceDef.definition as ServiceDefinitionLike;
    const typeName = def.typeName;
    if (typeName) {
      if (typeNames.has(typeName)) {
        throw new Error(`Service '${typeName}' has already been registered`);
      }
      typeNames.add(typeName);
    }
  }

  // Build the real Connect router
  const router = connectRuntime.createConnectRouter();

  // Register app services with their implementations
  for (const serviceDef of services) {
    const def = serviceDef.definition as ServiceDefinitionLike;
    const typeName = def.typeName;
    if (!typeName) continue;

    const impl = serviceDef.implementation || {};
    const methods = def.methods || {};

    // Check if this is already a real DescService (has kind: 'service')
    const isRealDescService = (def as { kind?: string }).kind === 'service';

    if (isRealDescService) {
      // Pass through real DescService directly
      router.service(
        def as { typeName: string },
        impl as Record<string, (...args: unknown[]) => unknown>,
      );
    } else {
      // Build a proper DescService from the fake definition
      const serviceDesc = buildDescService(typeName, methods);
      router.service(
        serviceDesc as { typeName: string },
        impl as Record<string, (...args: unknown[]) => unknown>,
      );
    }
  }

  // Register health service if enabled
  if (health) {
    const healthServiceDesc = reviveServiceDescriptor(
      connectRuntime,
      embeddedDescriptors.healthBase64,
      'grpc.health.v1.Health',
    );
    if (healthServiceDesc) {
      router.service(healthServiceDesc as { typeName: string }, {});
    }
  }

  // Register reflection service if enabled
  if (reflection) {
    const reflectionServiceDesc = reviveServiceDescriptor(
      connectRuntime,
      embeddedDescriptors.reflectionBase64,
      'grpc.reflection.v1.ServerReflection',
    );
    if (reflectionServiceDesc) {
      router.service(reflectionServiceDesc as { typeName: string }, {});
    }
  }

  // Build the dispatch map from the router's handlers
  // Each handler is a UniversalHandler (function with requestPath property)
  // We need to convert it to a fetch handler using createFetchHandler
  const dispatchMap = new Map<string, (request: Request) => Promise<Response>>();
  for (const handler of router.handlers) {
    const requestPath = (handler as { requestPath: string }).requestPath;
    const fullPath = normalizedBase + requestPath;
    // Convert the universal handler to a fetch handler using the runtime's createFetchHandler
    const fetchHandler = connectRuntime.createFetchHandler(
      handler as unknown as (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    );
    dispatchMap.set(fullPath, fetchHandler);
  }

  // Build the reflection registry if needed
  let registry: unknown = null;
  if (reflection || health) {
    registry = buildReflectionRegistry(
      connectRuntime,
      embeddedDescriptors,
      services,
    );
  }

  return { dispatchMap, registry };
}

/**
 * Builds a proper DescService-like object from a fake service definition.
 * This ensures Connect's router can properly create handlers.
 */
function buildDescService(typeName: string, methods: Record<string, unknown>): {
  kind: 'service';
  typeName: string;
  name: string;
  file: {
    kind: 'file';
    name: string;
    dependencies: unknown[];
    enums: unknown[];
    messages: unknown[];
    extensions: unknown[];
    services: unknown[];
    deprecated: boolean;
    edition: string;
    proto: {
      name: string;
      package: string;
      dependency: string[];
      messageType: unknown[];
      enumType: unknown[];
      service: unknown[];
      extension: unknown[];
      syntax: string;
    };
    toString: () => string;
  };
  methods: Array<{
    kind: 'rpc';
    name: string;
    localName: string;
    parent: { kind: 'service'; typeName: string };
    methodKind: 'unary' | 'server_streaming' | 'client_streaming' | 'bidi_streaming';
    input: {
      kind: 'message';
      typeName: string;
      name: string;
      file: { name: string; edition: string };
      fields: unknown[];
      field: Record<string, unknown>;
      oneofs: unknown[];
      members: unknown[];
      nestedEnums: unknown[];
      nestedMessages: unknown[];
      nestedExtensions: unknown[];
      deprecated: boolean;
      proto: { name: string; oneofDecl: unknown[]; options: Record<string, unknown> };
      toString: () => string;
    };
    output: {
      kind: 'message';
      typeName: string;
      name: string;
      file: { name: string; edition: string };
      fields: unknown[];
      field: Record<string, unknown>;
      oneofs: unknown[];
      members: unknown[];
      nestedEnums: unknown[];
      nestedMessages: unknown[];
      nestedExtensions: unknown[];
      deprecated: boolean;
      proto: { name: string; oneofDecl: unknown[]; options: Record<string, unknown> };
      toString: () => string;
    };
    idempotency: 'IDEMPOTENCY_UNKNOWN';
    deprecated: boolean;
    proto: {
      name: string;
      inputType: string;
      outputType: string;
      options: Record<string, unknown>;
      clientStreaming: boolean;
      serverStreaming: boolean;
    };
    toString: () => string;
  }>;
  method: Record<string, unknown>;
  deprecated: boolean;
  proto: {
    name: string;
    method: Array<{
      name: string;
      inputType: string;
      outputType: string;
      clientStreaming: boolean;
      serverStreaming: boolean;
      options: Record<string, unknown>;
    }>;
  };
  toString: () => string;
} {
  const serviceName = typeName.split('.').pop() ?? typeName;
  const packageName = typeName.substring(0, typeName.lastIndexOf('.'));
  const fileName = `${packageName || 'example'}.proto`;

  // Create a shared file descriptor that all messages will reference
  const fileDesc = {
    kind: 'file' as const,
    name: fileName,
    dependencies: [],
    enums: [],
    messages: [],
    extensions: [],
    services: [],
    deprecated: false,
    edition: 'EDITION_PROTO3',
    proto: {
      name: typeName.replace(/\./g, '/'),
      package: packageName,
      dependency: [],
      messageType: [],
      enumType: [],
      service: [],
      extension: [],
      syntax: 'proto3',
    },
    toString: () => typeName,
  };

  const methodList = Object.keys(methods).map((methodName) => {
    const inputMsgName = `${typeName}.${methodName}Request`;
    const outputMsgName = `${typeName}.${methodName}Response`;

    const inputMsg = {
      kind: 'message' as const,
      typeName: inputMsgName,
      name: `${methodName}Request`,
      file: fileDesc as { name: string; edition: string },
      fields: [],
      field: {},
      oneofs: [],
      members: [],
      nestedEnums: [],
      nestedMessages: [],
      nestedExtensions: [],
      deprecated: false,
      proto: { name: `${methodName}Request`, oneofDecl: [], options: {} },
      toString: () => inputMsgName,
    };

    const outputMsg = {
      kind: 'message' as const,
      typeName: outputMsgName,
      name: `${methodName}Response`,
      file: fileDesc as { name: string; edition: string },
      fields: [],
      field: {},
      oneofs: [],
      members: [],
      nestedEnums: [],
      nestedMessages: [],
      nestedExtensions: [],
      deprecated: false,
      proto: { name: `${methodName}Response`, oneofDecl: [], options: {} },
      toString: () => outputMsgName,
    };

    return {
      kind: 'rpc' as const,
      name: methodName,
      localName: methodName,
      parent: null as unknown as { kind: 'service'; typeName: string },
      methodKind: 'unary' as const,
      input: inputMsg,
      output: outputMsg,
      idempotency: 'IDEMPOTENCY_UNKNOWN' as const,
      deprecated: false,
      proto: {
        name: methodName,
        inputType: inputMsgName,
        outputType: outputMsgName,
        options: {},
        clientStreaming: false,
        serverStreaming: false,
      },
      toString: () => methodName,
    };
  });

  // Set parent references for methods
  const serviceDesc = {
    kind: 'service' as const,
    typeName,
    name: serviceName,
    file: fileDesc,
    methods: methodList,
    method: Object.fromEntries(methodList.map((m) => [m.name, m])),
    deprecated: false,
    proto: {
      name: serviceName,
      method: methodList.map((m) => ({
        name: m.name,
        inputType: m.proto.inputType,
        outputType: m.proto.outputType,
        clientStreaming: m.proto.clientStreaming,
        serverStreaming: m.proto.serverStreaming,
        options: m.proto.options,
      })),
    },
    toString: () => typeName,
  };

  // Set parent references after creating the service descriptor
  for (const method of serviceDesc.methods) {
    (method as { parent: unknown }).parent = serviceDesc;
  }

  return serviceDesc;
}

/**
 * Revives a service descriptor from the embedded descriptor set.
 * Returns the DescService for the given service name, or null if not found.
 */
function reviveServiceDescriptor(
  connectRuntime: ConnectRuntime,
  base64: string,
  serviceName: string,
): unknown {
  const registry = connectRuntime.reviveDescriptorSet(base64);
  return connectRuntime.getService(registry, serviceName);
}

/**
 * Builds a reflection registry used by the gRPC reflection service.
 */
function buildReflectionRegistry(
  _connectRuntime: ConnectRuntime,
  _embeddedDescriptors: EmbeddedDescriptors,
  services: Array<{ definition: unknown; implementation?: unknown }>,
): unknown {
  return {
    files: services.map((s) => {
      const def = s.definition as ServiceDefinitionLike;
      return {
        name: def.typeName || '',
        package: '',
        methods: Object.keys(def.methods || {}),
      };
    }),
    listServices: () =>
      services.map((s) => ((s.definition as ServiceDefinitionLike)?.typeName) || ''),
    getService: (name: string) => {
      return services.find((s) => ((s.definition as ServiceDefinitionLike)?.typeName) === name);
    },
  };
}
