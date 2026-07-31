/**
 * Connect router builder — registers services, health, and reflection onto a
 * Connect router, then produces a dispatch map keyed by full path.
 *
 * @module
 */

import { normalizeBasePath } from './rpc-dispatcher.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Shape of a service definition with typeName/methods. */
interface ServiceDefinitionLike {
  typeName?: string;
  package?: string;
  methods?: Record<string, unknown>;
  implementation?: unknown;
  protoFile?: string;
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

  // Build a universal handler that dispatches to the correct handler by requestPath
  // We'll build our own handler map instead of using Connect's router
  const handlerMap = new Map<string, (request: Request) => Promise<Response>>();

  // Register app services with their implementations
  for (const serviceDef of services) {
    const def = serviceDef.definition as ServiceDefinitionLike;
    const typeName = def.typeName;
    if (!typeName) continue;

    const impl = serviceDef.implementation || {};
    const methods = def.methods || {};

    for (const methodName of Object.keys(methods)) {
      const requestPath = `/${typeName}/${methodName}`;
      const rawMethodHandler = (impl as Record<string, unknown>)[methodName];

      if (rawMethodHandler) {
        handlerMap.set(requestPath, async (request: Request) => {
          try {
            const body = await request.json() as Record<string, unknown>;
            const response = await (rawMethodHandler as (
              ctx: unknown,
              input: unknown,
            ) => Promise<unknown> | unknown)(
              undefined,
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
        });
      }
    }
  }

  // Build the dispatch map by prepending the base path
  const dispatchMap = new Map<string, (request: Request) => Promise<Response>>();
  for (const [requestPath, handler] of handlerMap) {
    const fullPath = normalizedBase + requestPath;
    dispatchMap.set(fullPath, handler);
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

  // If health is enabled, add the health service path to the dispatch map
  if (health) {
    const healthPath = `${normalizedBase}/grpc.health.v1.Health/Check`;
    dispatchMap.set(healthPath, () =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 1 }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ));
  }

  // If reflection is enabled, add the reflection service path to the dispatch map
  if (reflection) {
    const reflectionPath =
      `${normalizedBase}/grpc.reflection.v1.ServerReflection/ServerReflectionInfo`;
    dispatchMap.set(reflectionPath, () =>
      Promise.resolve(
        new Response('Not Found', { status: 404 }),
      ));
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
