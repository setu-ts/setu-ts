/**
 * Connect router builder — registers real Protobuf-ES {@linkcode DescService}
 * values (app services plus the revived health/reflection services) onto a
 * Connect router, then produces a dispatch map keyed by full request path.
 *
 * Connect's `router.service()` REQUIRES a real `DescService` — its `methods`
 * must be an array of method descriptors whose `input`/`output` carry real
 * field descriptors, because Connect serializes a response by walking those
 * fields. Hand-built objects with empty-field messages serialize to `{}` (the
 * empty-body bug this module was refactored to eliminate), and plain
 * `{ typeName, methods: {...} }` objects make Connect throw
 * `service.methods is not iterable`. Applications therefore register generated
 * `DescService` values (or ones revived from an embedded `FileDescriptorSet`),
 * and this builder passes them straight through to Connect.
 *
 * @module
 */

import { normalizeBasePath } from './rpc-dispatcher.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Structural shape of a service definition the builder reads for routing/reflection. */
interface ServiceDefinitionLike {
  /** Fully-qualified service name, e.g. `"package.Service"`. */
  typeName?: string;
  /** Discriminator — real Protobuf-ES descriptors carry `kind: 'service'`. */
  kind?: string;
  /**
   * Method descriptors. For a real `DescService` this is an array of method
   * descriptors; legacy structural definitions may use a record.
   */
  methods?: Array<{ name?: string; localName?: string }> | Record<string, unknown>;
}

/** A service entry the builder consumes. */
interface ServiceEntry {
  definition: unknown;
  implementation?: unknown;
}

/**
 * Builds a Connect router and returns a dispatch map plus a best-effort
 * reflection registry.
 *
 * Uses the real Connect runtime API: `createConnectRouter()` +
 * `router.service()` + `createFetchHandler()` from `@connectrpc/connect`.
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
  services: ReadonlyArray<ServiceEntry>;
  embeddedDescriptors: EmbeddedDescriptors;
}): {
  dispatchMap: Map<string, (request: Request) => Promise<Response>>;
  registry: unknown;
} {
  const normalizedBase = normalizeBasePath(basePath);

  // Detect duplicate service type names up front (defensive — GrpcService also guards).
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

  const router = connectRuntime.createConnectRouter();

  // Register each app service. The definition MUST be a real Protobuf-ES
  // DescService (kind: 'service'); Connect walks its method descriptors to
  // serialize request/response bodies.
  for (const serviceDef of services) {
    const def = serviceDef.definition as ServiceDefinitionLike;
    if (!def.typeName) continue;
    const impl = (serviceDef.implementation ?? {}) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    router.service(serviceDef.definition as { typeName: string }, impl);
  }

  // Register the built-in Health service (revived from the embedded descriptor set).
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

  // Register the built-in Server Reflection service (revived from the embedded descriptor set).
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

  // Build the dispatch map keyed by `basePath + requestPath`. Each Connect
  // `UniversalHandler` carries a `requestPath` (e.g. `/pkg.Svc/Method`); the
  // runtime's `createFetchHandler` adapts it to a fetch `(Request) => Response`.
  const dispatchMap = new Map<string, (request: Request) => Promise<Response>>();
  for (const handler of router.handlers) {
    const requestPath = (handler as { requestPath: string }).requestPath;
    const fullPath = normalizedBase + requestPath;
    const fetchHandler = connectRuntime.createFetchHandler(
      handler as unknown as (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    );
    dispatchMap.set(fullPath, fetchHandler);
  }

  // Best-effort reflection registry (names only — actual reflection answers are
  // produced by the dedicated reflection service). Computed when health or
  // reflection is enabled so callers can enumerate registered services.
  let registry: unknown = null;
  if (reflection || health) {
    registry = buildReflectionRegistry(services);
  }

  return { dispatchMap, registry };
}

/**
 * Extracts method names from a service's `methods`, tolerating both a real
 * `DescService` (array of method descriptors) and a legacy record shape.
 */
function extractMethodNames(methods: ServiceDefinitionLike['methods']): string[] {
  if (Array.isArray(methods)) {
    return methods.map((m) => m.localName ?? m.name ?? '').filter((n) => n.length > 0);
  }
  if (methods && typeof methods === 'object') {
    return Object.keys(methods as Record<string, unknown>);
  }
  return [];
}

/**
 * Revives a real DescService from an embedded base64 FileDescriptorSet.
 * Returns the DescService for the given service name, or `undefined` if absent.
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
 * Builds a best-effort reflection registry from the registered app services.
 * Used to enumerate service names and methods for server reflection.
 */
function buildReflectionRegistry(services: ReadonlyArray<ServiceEntry>): unknown {
  return {
    files: services.map((s) => {
      const def = s.definition as ServiceDefinitionLike;
      return {
        name: def.typeName ?? '',
        package: '',
        methods: extractMethodNames(def.methods),
      };
    }),
    listServices: () =>
      services.map((s) => (s.definition as ServiceDefinitionLike)?.typeName ?? ''),
    getService: (name: string) =>
      services.find((s) => (s.definition as ServiceDefinitionLike)?.typeName === name),
  };
}
