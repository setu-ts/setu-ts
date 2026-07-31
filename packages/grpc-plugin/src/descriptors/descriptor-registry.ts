/**
 * Manages decoding of embedded FileDescriptorSets and building reflection registries.
 *
 * @module
 */

import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

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

  // Build a combined registry that includes app services' files and their dependencies
  const combinedRegistry = {
    files: [],
    getService(name: string) {
      // Check embedded services first
      if (name === 'grpc.health.v1.Health') {
        return (healthRegistry as any)?.getService?.(name);
      }
      if (name === 'grpc.reflection.v1.ServerReflection') {
        return (reflectionRegistry as any)?.getService?.(name);
      }
      // Check app services
      for (const service of appServices) {
        if ((service as any)?.typeName === name) {
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
        const typeName = (service as any)?.typeName;
        if (typeName) services.add(typeName);
      }
      return Array.from(services);
    },
  };

  return combinedRegistry;
}
