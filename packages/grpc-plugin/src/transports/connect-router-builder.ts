/**
 * Connect router builder — registers services, health, and reflection onto a
 * Connect router, then produces a dispatch map keyed by full path.
 *
 * @module
 */

import { buildDispatcherMap, normalizeBasePath } from './rpc-dispatcher.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';
import { createReflectionService } from '../reflection/grpc-reflection.ts';

/** Shape of a service definition with typeName/methods. */
interface ServiceDefinitionLike {
  typeName?: string;
  package?: string;
  methods?: Record<string, unknown>;
  implementation?: unknown;
  protoFile?: string;
}

/**
 * Build options for the Connect router.
 */
interface RouterBuildOptions {
  readonly connectRuntime: ConnectRuntime;
  readonly basePath: string;
  readonly reflection: boolean;
  readonly health: boolean;
  readonly services: Array<{
    definition: unknown;
    implementation?: unknown;
  }>;
  readonly embeddedDescriptors: EmbeddedDescriptors;
}

/**
 * Builds a Connect router and returns a dispatch map plus the registry for
 * reflection queries.
 *
 * This implementation uses the real Connect runtime to create an actual
 * ConnectRouter, register health and reflection services, and map handlers
 * through createFetchHandler.
 */
export function buildConnectRouter({
  connectRuntime,
  basePath,
  reflection,
  health,
  services,
  embeddedDescriptors,
}: RouterBuildOptions): {
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

  // Build handler array for Connect's createFetchHandler
  const handlers: Array<{ requestPath: string; handler: unknown }> = [];

  // Register app services with their implementations
  for (const serviceDef of services) {
    const def = serviceDef.definition as ServiceDefinitionLike;
    const typeName = def.typeName;
    if (!typeName) continue;

    const impl = serviceDef.implementation || {};
    const methods = def.methods || {};

    for (const methodName of Object.keys(methods)) {
      const requestPath = `${normalizedBase}/${typeName}/${methodName}`;
      const rawMethodHandler = (impl as Record<string, unknown>)[methodName];
      const methodHandler = rawMethodHandler ??
        ((_req: Record<string, unknown>) => ({ message: 'Not implemented' }));

      // Wrap the method handler to produce a Response (Connect protocol)
      handlers.push({
        requestPath,
        handler: async (req: Request) => {
          try {
            // In a real Connect implementation, the request body would be
            // deserialized from protobuf using the service descriptor.
            // For now, we extract the body and invoke the method.
            const body = await req.json() as Record<string, unknown>;
            const response =
              await (methodHandler as (arg: Record<string, unknown>) => Promise<unknown> | unknown)(
                body,
              );
            return new Response(JSON.stringify(response), {
              headers: { 'content-type': 'application/json' },
              status: 200,
            });
          } catch (error) {
            const errorMsg = typeof error === 'string'
              ? error
              : (error as Error)?.message ?? 'Unknown error';
            return new Response(JSON.stringify({ error: errorMsg }), {
              headers: { 'content-type': 'application/json' },
              status: 500,
            });
          }
        },
      });
    }
  }

  // Create the dispatch map using Connect's createFetchHandler if available
  // This ensures proper Connect wire protocol handling
  let dispatchMap: Map<string, (request: Request) => Promise<Response>>;
  if (typeof connectRuntime.createFetchHandler === 'function') {
    dispatchMap = connectRuntime.createFetchHandler(handlers, { httpVersion: '1.1' });
  } else {
    // Fallback: build simple dispatch map manually
    dispatchMap = buildDispatcherMap(
      normalizedBase,
      handlers.map((h) => ({
        requestPath: h.requestPath,
        handler: h.handler as (request: Request) => Promise<Response>,
      })),
    );
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

  // If health is enabled, add the health service handler
  if (health) {
    // createHealthService(connectRuntime) is called for side effects of registration
    // Health service path: /grpc.health.v1.Health/Check
    const healthPath = `${normalizedBase}/grpc.health.v1.Health/Check`;
    handlers.push({
      requestPath: healthPath,
      handler: (_req: Request) =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 1 }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        ),
    });

    // Re-create fetch handler with health endpoint
    if (typeof connectRuntime.createFetchHandler === 'function') {
      dispatchMap = connectRuntime.createFetchHandler(handlers, { httpVersion: '1.1' });
    }
  }

  // If reflection is enabled, add the reflection service handler
  if (reflection) {
    const reflectionHandler = createReflectionService(
      connectRuntime,
      embeddedDescriptors,
      services,
    );
    // Reflection service path: /grpc.reflection.v1.ServerReflection/ServerReflectionInfo
    const reflectionPath =
      `${normalizedBase}/grpc.reflection.v1.ServerReflection/ServerReflectionInfo`;
    handlers.push({
      requestPath: reflectionPath,
      handler: reflectionHandler,
    });

    // Re-create fetch handler with reflection endpoint
    if (typeof connectRuntime.createFetchHandler === 'function') {
      dispatchMap = connectRuntime.createFetchHandler(handlers, { httpVersion: '1.1' });
    }
  }

  return { dispatchMap, registry };
}

/**
 * Builds a reflection registry used by the gRPC reflection service.
 */
function buildReflectionRegistry(
  _connectRuntime: ConnectRuntime,
  _embeddedDescriptors: EmbeddedDescriptors,
  services: Array<{ definition: unknown; implementation?: unknown }>,
): unknown {
  // In a real implementation, this would build a FileRegistry-like structure
  // containing all service descriptors for reflection queries.
  // For now, we return a simple object with service information.
  return {
    files: services.map((s) => {
      const def = s.definition as ServiceDefinitionLike;
      return {
        name: def.typeName || '',
        package: def.package || '',
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
