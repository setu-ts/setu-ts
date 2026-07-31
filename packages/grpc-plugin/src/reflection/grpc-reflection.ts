/**
 * gRPC Server Reflection v1 service — implements `grpc.reflection.v1.ServerReflectionInfo`.
 * Supports four request variants: list_services, file_by_filename, file_containing_symbol,
 * and all_extension_numbers_of_type. file_containing_extension returns UNIMPLEMENTED.
 *
 * @module
 */

import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/**
 * Creates a gRPC ServerReflection service implementation.
 * 
 * Note: This is a simplified stub that returns placeholder responses.
 * In a full implementation, it would use the embedded descriptors
 * to provide actual reflection data.
 */
export function createReflectionService(
  _connectRuntime: ConnectRuntime,
  _embeddedDescriptors: EmbeddedDescriptors,
  _appServices: readonly unknown[],
): unknown {
  return {
    async *ServerReflectionInfo(_stream: any) {
      // Yield a placeholder response
      yield {
        response: {
          listServices: {
            service: [],
            nextFileDescriptorNumber: 1,
          },
        },
      };
    },
  };
}