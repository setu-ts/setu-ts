/**
 * Manages decoding of embedded FileDescriptorSets and building reflection registries.
 *
 * @module
 */

import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Shape of a service definition with a typeName property. */
interface ServiceDefinitionLike {
  typeName?: string;
  methods?: Record<string, unknown>;
}

/**
 * Revives a FileDescriptorSet from base64-encoded data using the ConnectRuntime.
 *
 * @param connectRuntime - The ConnectRuntime providing Protobuf-ES utilities
 * @param base64 - Base64-encoded FileDescriptorSet
 * @returns A FileRegistry-like structure containing the revived descriptors
 */
export function reviveDescriptorSet(
  connectRuntime: ConnectRuntime,
  base64: string,
): unknown {
  return connectRuntime.reviveDescriptorSet(base64);
}

/**
 * Builds a reflection registry from app services and embedded descriptors.
 *
 * The registry supports querying by service name, file name, and symbol names
 * for server reflection.
 *
 * @param connectRuntime - The ConnectRuntime for descriptor operations
 * @param embeddedDescriptors - The embedded health and reflection descriptors
 * @param appServices - Array of app service definitions (with .file property)
 * @returns A registry object with getService, listServices, and reflection methods
 */
export function buildReflectionRegistry(
  connectRuntime: ConnectRuntime,
  embeddedDescriptors: EmbeddedDescriptors,
  appServices: readonly unknown[],
): unknown {
  // Start with the embedded descriptors (health + reflection services)
  const healthRegistry = reviveDescriptorSet(connectRuntime, embeddedDescriptors.healthBase64);
  const reflectionRegistry = reviveDescriptorSet(
    connectRuntime,
    embeddedDescriptors.reflectionBase64,
  );

  /** Helper to safely access getService from a registry object. */
  function safeGetService(registry: unknown, name: string): unknown {
    if (typeof registry !== 'object' || registry === null) {
      return undefined;
    }
    const obj = registry as Record<string, unknown>;
    const getService = obj.getService;
    if (typeof getService === 'function') {
      return getService(name);
    }
    return undefined;
  }

  // Build a combined registry that includes app services' files and their dependencies
  const combinedRegistry = {
    files: [] as unknown[],
    getService(name: string) {
      // Check embedded services first
      if (name === 'grpc.health.v1.Health') {
        return safeGetService(healthRegistry, name);
      }
      if (name === 'grpc.reflection.v1.ServerReflection') {
        return safeGetService(reflectionRegistry, name);
      }
      // Check app services
      for (const service of appServices) {
        const svc = service as Record<string, unknown>;
        const def = svc.definition as ServiceDefinitionLike | undefined;
        if (def?.typeName === name) {
          return service;
        }
      }
      return undefined;
    },
    listServices(): string[] {
      const services = new Set<string>();
      // Add embedded services
      services.add('grpc.health.v1.Health');
      services.add('grpc.reflection.v1.ServerReflection');
      // Add app services
      for (const service of appServices) {
        const svc = service as Record<string, unknown>;
        const def = svc.definition as ServiceDefinitionLike | undefined;
        const typeName = def?.typeName;
        if (typeof typeName === 'string' && typeName) {
          services.add(typeName);
        }
      }
      return Array.from(services);
    },
  };

  return combinedRegistry;
}
