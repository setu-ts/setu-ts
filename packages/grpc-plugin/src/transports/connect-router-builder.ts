/**
 * Connect router builder — registers the application's services plus the
 * plugin's own health and reflection services onto a Connect router, then maps
 * every resulting `UniversalHandler` into a dispatch map keyed by full request
 * path.
 *
 * Connect's `router.service()` requires a real Protobuf-ES `DescService`: it
 * walks the method descriptors' input/output field descriptors to serialize
 * bodies. A hand-built `{ typeName, methods: {…} }` object makes Connect throw
 * `service.methods is not iterable`, and one whose messages declare no fields
 * serializes every response to `{}`. Applications therefore register generated
 * descriptors (or ones revived from an embedded `FileDescriptorSet`), and this
 * builder passes them straight through.
 *
 * @module
 */

import { normalizeBasePath } from './rpc-dispatcher.ts';
import {
  buildReflectionRegistry,
  reviveServiceDescriptor,
} from '../descriptors/descriptor-registry.ts';
import { createHealthService } from '../health/grpc-health-bridge.ts';
import { createReflectionService } from '../reflection/grpc-reflection.ts';
import type {
  ConnectRuntime,
  FileDescriptorLike,
  ServiceDescriptorLike,
} from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';
import type { IHealthService } from '@hono-enterprise/common';

/** Fully-qualified name of the built-in health service. */
const HEALTH_SERVICE_NAME = 'grpc.health.v1.Health';
/** Fully-qualified name of the built-in reflection service. */
const REFLECTION_SERVICE_NAME = 'grpc.reflection.v1.ServerReflection';

/** A service the builder registers. */
export interface ServiceEntry {
  readonly definition: unknown;
  readonly implementation?: unknown;
}

/** Inputs to {@linkcode buildConnectRouter}. */
export interface BuildConnectRouterOptions {
  readonly connectRuntime: ConnectRuntime;
  readonly basePath: string;
  readonly reflection: boolean;
  readonly health: boolean;
  readonly services: readonly ServiceEntry[];
  readonly embeddedDescriptors: EmbeddedDescriptors;
  readonly healthService: IHealthService | undefined;
}

/**
 * Builds the Connect router and the dispatch map.
 *
 * @returns The dispatch map, keyed `basePath + handler.requestPath`.
 * @throws {Error} If two registered services share a `typeName`.
 * @throws {GrpcDescriptorError} If an embedded descriptor set is unusable.
 */
export function buildConnectRouter(options: BuildConnectRouterOptions): {
  dispatchMap: Map<string, (request: Request) => Promise<Response>>;
} {
  const {
    connectRuntime,
    basePath,
    reflection,
    health,
    services,
    embeddedDescriptors,
    healthService,
  } = options;

  const normalizedBase = normalizeBasePath(basePath);
  const router = connectRuntime.createConnectRouter();

  // Application services first, so their names lead `list_services`.
  const serviceNames: string[] = [];
  const reflectionFiles: (FileDescriptorLike | undefined)[] = [];
  const seenTypeNames = new Set<string>();

  for (const entry of services) {
    const definition = entry.definition as ServiceDescriptorLike;
    if (seenTypeNames.has(definition.typeName)) {
      throw new Error(`Service '${definition.typeName}' has already been registered`);
    }
    seenTypeNames.add(definition.typeName);
    serviceNames.push(definition.typeName);
    reflectionFiles.push(definition.file);
    router.service(definition, (entry.implementation ?? {}) as Record<string, unknown>);
  }

  // The built-in health service.
  let healthDescriptor: ServiceDescriptorLike | undefined;
  if (health) {
    healthDescriptor = reviveServiceDescriptor(
      connectRuntime,
      embeddedDescriptors.healthBase64,
      HEALTH_SERVICE_NAME,
    );
    serviceNames.push(HEALTH_SERVICE_NAME);
    reflectionFiles.push(healthDescriptor.file);
  }

  // The built-in reflection service.
  let reflectionDescriptor: ServiceDescriptorLike | undefined;
  if (reflection) {
    reflectionDescriptor = reviveServiceDescriptor(
      connectRuntime,
      embeddedDescriptors.reflectionBase64,
      REFLECTION_SERVICE_NAME,
    );
    serviceNames.push(REFLECTION_SERVICE_NAME);
    reflectionFiles.push(reflectionDescriptor.file);
  }

  // Registered after the name list is complete: `Check` answers SERVICE_UNKNOWN
  // for a name the server does not serve, and reflection lists them all.
  if (healthDescriptor !== undefined) {
    router.service(healthDescriptor, createHealthService(healthService, serviceNames));
  }
  if (reflectionDescriptor !== undefined) {
    const registry = buildReflectionRegistry(connectRuntime, reflectionFiles, serviceNames);
    router.service(reflectionDescriptor, createReflectionService(registry));
  }

  const dispatchMap = new Map<string, (request: Request) => Promise<Response>>();
  for (const handler of router.handlers) {
    dispatchMap.set(
      normalizedBase + handler.requestPath,
      connectRuntime.createFetchHandler(handler),
    );
  }

  return { dispatchMap };
}
