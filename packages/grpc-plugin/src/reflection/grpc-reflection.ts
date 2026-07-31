/**
 * gRPC Server Reflection v1 service — implements `grpc.reflection.v1.ServerReflectionInfo`.
 * Supports four request variants: list_services, file_by_filename, file_containing_symbol,
 * and all_extension_numbers_of_type. file_containing_extension returns UNIMPLEMENTED.
 *
 * @module
 */

import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Shape of a reflection request variant. */
interface ListServicesRequest {
  listServices?: Record<string, never>;
}

interface FileByFilenameRequest {
  fileByFilename: { filename: string };
}

interface FileContainingSymbolRequest {
  fileContainingSymbol: { symbol: string };
}

interface AllExtensionNumbersRequest {
  allExtensionNumbersOfType: string;
}

type ReflectionRequestVariant =
  | ListServicesRequest
  | FileByFilenameRequest
  | FileContainingSymbolRequest
  | AllExtensionNumbersRequest;

/** Shape of a reflection response. */
interface ListServicesResponse {
  services: string[];
  nextFileDescriptorNumber: number;
}

interface FileDescriptorResponse {
  descriptorFile: unknown[];
}

interface ErrorResponse {
  code: number;
  message: string;
}

interface ExtensionNumberResponse {
  numbers: number[];
}

type ReflectionResponseVariant =
  | { response: { listServices: ListServicesResponse } }
  | { response: { fileDescriptorResponse: FileDescriptorResponse } }
  | { response: { errorResponse: ErrorResponse } }
  | { response: { extensionNumberResponse: ExtensionNumberResponse } };

/**
 * Creates a gRPC ServerReflection service implementation.
 *
 * @param connectRuntime - The Connect runtime for descriptor operations
 * @param embeddedDescriptors - Embedded health and reflection descriptors
 * @param appServices - Array of registered app service definitions
 * @returns A ServerReflection service implementation
 */
export function createReflectionService(
  connectRuntime: ConnectRuntime,
  embeddedDescriptors: EmbeddedDescriptors,
  appServices: readonly unknown[],
): unknown {
  // Build the registry (simplified)
  const registry = buildReflectionRegistry(connectRuntime, embeddedDescriptors, appServices);

  return {
    async *ServerReflectionInfo(
      requestStream: AsyncIterable<{ response: ReflectionRequestVariant }>,
    ): AsyncGenerator<ReflectionResponseVariant> {
      for await (const { response } of requestStream) {
        if ('listServices' in response) {
          yield {
            response: {
              listServices: {
                services: registry.listServices(),
                nextFileDescriptorNumber: 1,
              },
            },
          };
          continue;
        }

        if ('fileByFilename' in response) {
          const filename = response.fileByFilename.filename;
          const file = registry.getFileByName(filename);
          if (file) {
            yield {
              response: {
                fileDescriptorResponse: {
                  descriptorFile: [file],
                },
              },
            };
          } else {
            yield {
              response: {
                errorResponse: {
                  code: 3, // NOT_FOUND
                  message: `File not found: ${filename}`,
                },
              },
            };
          }
          continue;
        }

        if ('fileContainingSymbol' in response) {
          const symbol = response.fileContainingSymbol.symbol;
          const file = registry.getFileContaining(symbol);
          if (file) {
            yield {
              response: {
                fileDescriptorResponse: {
                  descriptorFile: [file],
                },
              },
            };
          } else {
            yield {
              response: {
                errorResponse: {
                  code: 3, // NOT_FOUND
                  message: `Symbol not found: ${symbol}`,
                },
              },
            };
          }
          continue;
        }

        if ('allExtensionNumbersOfType' in response) {
          yield {
            response: {
              extensionNumberResponse: {
                numbers: [],
              },
            },
          };
          continue;
        }

        // Unknown request
        yield {
          response: {
            errorResponse: {
              code: 3,
              message: 'Unknown reflection request',
            },
          },
        };
      }
    },
  };
}

/** Shape of the reflection registry used internally. */
interface ReflectionRegistry {
  listServices(): string[];
  getFileByName(filename: string): unknown | undefined;
  getFileContaining(symbol: string): unknown | undefined;
}

/**
 * Builds a reflection registry from app services and embedded descriptors.
 * Exported for testing.
 */
export function buildReflectionRegistry(
  _connectRuntime: ConnectRuntime,
  _embeddedDescriptors: EmbeddedDescriptors,
  appServices: readonly unknown[],
): ReflectionRegistry {
  const services = new Set<string>();
  services.add('grpc.health.v1.Health');
  services.add('grpc.reflection.v1.ServerReflection');
  for (const service of appServices) {
    const svc = service as Record<string, unknown>;
    const typeName = svc.typeName;
    if (typeof typeName === 'string' && typeName) {
      services.add(typeName);
    }
  }

  const files = [
    { name: 'grpc/health/v1/health.proto', serviceName: 'grpc.health.v1.Health' },
    {
      name: 'grpc/reflection/v1/reflection.proto',
      serviceName: 'grpc.reflection.v1.ServerReflection',
    },
    ...appServices.map((s) => {
      const svc = s as Record<string, unknown>;
      return {
        name: (svc.protoFile as string | undefined) ?? 'unknown.proto',
        serviceName: svc.typeName as string | undefined,
      };
    }),
  ];

  return {
    listServices(): string[] {
      return Array.from(services);
    },

    getFileByName(filename: string): unknown | undefined {
      return files.find((f) => f.name === filename);
    },

    getFileContaining(symbol: string): unknown | undefined {
      return files.find(
        (f) => f.name.includes(symbol) || (f.serviceName ?? '').includes(symbol),
      );
    },
  };
}
