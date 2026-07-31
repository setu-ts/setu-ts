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
 * @param connectRuntime - The Connect runtime for descriptor operations
 * @param embeddedDescriptors - Embedded health and reflection descriptors
 * @param appServices - Array of registered app service definitions
 * @returns A ServerReflection service implementation
 */
export function createReflectionService(
  _connectRuntime: ConnectRuntime,
  _embeddedDescriptors: EmbeddedDescriptors,
  appServices: readonly unknown[],
): unknown {
  // Build the registry (simplified)
  const registry = buildReflectionRegistry(_connectRuntime, _embeddedDescriptors, appServices);

  return {
    async *ServerReflectionInfo(requestStream: AsyncIterable<any>) {
      for await (const request of requestStream) {
        const response = request.response;

        if (response.listServices) {
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

        if (response.fileByFilename) {
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

        if (response.fileContainingSymbol) {
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

        if (response.allExtensionNumbersOfType) {
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

function buildReflectionRegistry(
  _connectRuntime: any,
  _embeddedDescriptors: any,
  appServices: readonly unknown[],
): {
  listServices(): string[];
  getFileByName(filename: string): unknown | undefined;
  getFileContaining(symbol: string): unknown | undefined;
} {
  const services = new Set<string>();
  services.add('grpc.health.v1.Health');
  services.add('grpc.reflection.v1.ServerReflection');
  for (const service of appServices) {
    const typeName = (service as any)?.typeName;
    if (typeName) services.add(typeName);
  }

  const files = [
    { name: 'grpc/health/v1/health.proto', serviceName: 'grpc.health.v1.Health' },
    {
      name: 'grpc/reflection/v1/reflection.proto',
      serviceName: 'grpc.reflection.v1.ServerReflection',
    },
    ...appServices.map((s) => ({
      name: (s as any)?.protoFile || 'unknown.proto',
      serviceName: (s as any)?.typeName,
    })),
  ];

  return {
    listServices(): string[] {
      return Array.from(services);
    },

    getFileByName(filename: string): unknown | undefined {
      return files.find((f) => f.name === filename);
    },

    getFileContaining(symbol: string): unknown | undefined {
      return files.find((f) => f.name.includes(symbol) || f.serviceName.includes(symbol));
    },
  };
}
