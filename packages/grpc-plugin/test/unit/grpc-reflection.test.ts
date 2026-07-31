/**
 * gRPC Server Reflection tests — verifies reflection service implementation.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildReflectionRegistry,
  createReflectionService,
} from '../../src/reflection/grpc-reflection.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';

describe('GrpcReflection', () => {
  function createFakeRuntime(): ConnectRuntime {
    return {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => createFakeRuntime(),
      loadConnectModule: () => Promise.resolve(createFakeRuntime()),
      reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
      getService: () => undefined,
    };
  }

  it('should create a reflection service when reflection is enabled', () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    expect(service).toBeDefined();
  });

  it('list_services should return embedded and app services', async () => {
    // App services have typeName directly on the service object (not nested under definition)
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService' }],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as { response: { listServices: { services: string[] } } };
    expect(response.response.listServices.services).toContain('grpc.health.v1.Health');
    expect(response.response.listServices.services).toContain(
      'grpc.reflection.v1.ServerReflection',
    );
    expect(response.response.listServices.services).toContain('pkg.MyService');
  });

  it('file_by_filename should return file when found', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileByFilename: { filename: 'grpc/health/v1/health.proto' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { fileDescriptorResponse?: { descriptorFile: unknown[] } };
    };
    expect(response.response.fileDescriptorResponse).toBeDefined();
    expect(response.response.fileDescriptorResponse!.descriptorFile.length).toBeGreaterThan(0);
  });

  it('file_by_filename should return NOT_FOUND for unknown file', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileByFilename: { filename: 'unknown.proto' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { errorResponse?: { code: number; message: string } };
    };
    expect(response.response.errorResponse).toBeDefined();
    expect(response.response.errorResponse!.code).toBe(3); // NOT_FOUND
  });

  it('file_containing_symbol should return file when found', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileContainingSymbol: { symbol: 'grpc.health.v1.Health' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { fileDescriptorResponse?: { descriptorFile: unknown[] } };
    };
    expect(response.response.fileDescriptorResponse).toBeDefined();
  });

  it('file_containing_symbol should return NOT_FOUND for unknown symbol', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileContainingSymbol: { symbol: 'unknown.Symbol' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { errorResponse?: { code: number; message: string } };
    };
    expect(response.response.errorResponse).toBeDefined();
    expect(response.response.errorResponse!.code).toBe(3); // NOT_FOUND
  });

  it('all_extension_numbers_of_type should return empty list', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { allExtensionNumbersOfType: 'google.protobuf.MessageOptions' } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { extensionNumberResponse?: { numbers: number[] } };
    };
    expect(response.response.extensionNumberResponse).toBeDefined();
    expect(response.response.extensionNumberResponse!.numbers).toEqual([]);
  });

  it('unknown request should return error response', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: {} };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { errorResponse?: { code: number; message: string } };
    };
    expect(response.response.errorResponse).toBeDefined();
    expect(response.response.errorResponse!.code).toBe(3);
  });

  it('list_services should include app services with typeName', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [
        { typeName: 'pkg.ServiceA' },
        { typeName: 'pkg.ServiceB' },
      ],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as { response: { listServices: { services: string[] } } };
    expect(response.response.listServices.services).toContain('pkg.ServiceA');
    expect(response.response.listServices.services).toContain('pkg.ServiceB');
  });

  it('file_by_filename should return NOT_FOUND for empty filename', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileByFilename: { filename: '' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { errorResponse?: { code: number; message: string } };
    };
    expect(response.response.errorResponse).toBeDefined();
    expect(response.response.errorResponse!.code).toBe(3);
  });

  it('file_containing_symbol should find service by partial match', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService' }],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileContainingSymbol: { symbol: 'MyService' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { fileDescriptorResponse?: { descriptorFile: unknown[] } };
    };
    expect(response.response.fileDescriptorResponse).toBeDefined();
  });

  it('should handle app services with protoFile in reflection registry', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService', protoFile: 'pkg/my_service.proto' }],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { fileByFilename: { filename: 'pkg/my_service.proto' } } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as {
      response: { fileDescriptorResponse?: { descriptorFile: unknown[] } };
    };
    expect(response.response.fileDescriptorResponse).toBeDefined();
    expect(response.response.fileDescriptorResponse!.descriptorFile.length).toBeGreaterThan(0);
  });

  it('should handle service without typeName in reflection registry', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ methods: { echo: {} } }],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as { response: { listServices: { services: string[] } } };
    // Should have embedded services but not the app service without typeName
    expect(response.response.listServices.services).toContain('grpc.health.v1.Health');
    expect(response.response.listServices.services).toContain(
      'grpc.reflection.v1.ServerReflection',
    );
    expect(response.response.listServices.services).not.toContain('');
  });

  it('should handle empty app services array', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as { response: { listServices: { services: string[] } } };
    expect(response.response.listServices.services).toContain('grpc.health.v1.Health');
    expect(response.response.listServices.services).toContain(
      'grpc.reflection.v1.ServerReflection',
    );
  });

  it('should handle service with empty string typeName', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: '' }],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as { response: { listServices: { services: string[] } } };
    // Empty string typeName should not be added to services
    expect(response.response.listServices.services).not.toContain('');
    // But embedded services should still be there
    expect(response.response.listServices.services).toContain('grpc.health.v1.Health');
  });

  it('should handle service without typeName property', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{}],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
      })(),
    );
    const result = await generator.next();
    expect(result.done).toBe(false);
    const response = result.value as { response: { listServices: { services: string[] } } };
    // No typeName means no service added
    expect(response.response.listServices.services).not.toContain(undefined as unknown as string);
    // But embedded services should still be there
    expect(response.response.listServices.services).toContain('grpc.health.v1.Health');
  });

  it('should handle multiple request types in sequence', async () => {
    const service = createReflectionService(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService' }],
    );
    const typedService = service as {
      ServerReflectionInfo: (
        stream: AsyncIterable<{ response: unknown }>,
      ) => AsyncGenerator<unknown>;
    };
    const generator = typedService.ServerReflectionInfo(
      (async function* () {
        yield { response: { listServices: {} } };
        yield { response: { fileByFilename: { filename: 'grpc/health/v1/health.proto' } } };
        yield { response: { fileContainingSymbol: { symbol: 'pkg.MyService' } } };
        yield { response: { allExtensionNumbersOfType: 'google.protobuf.MessageOptions' } };
        yield { response: {} };
      })(),
    );

    // listServices
    let result = await generator.next();
    expect(result.done).toBe(false);
    const response1 = result.value as { response: { listServices: { services: string[] } } };
    expect(response1.response.listServices.services).toContain('pkg.MyService');

    // fileByFilename
    result = await generator.next();
    expect(result.done).toBe(false);
    const response2 = result.value as {
      response: { fileDescriptorResponse?: { descriptorFile: unknown[] } };
    };
    expect(response2.response.fileDescriptorResponse).toBeDefined();

    // fileContainingSymbol
    result = await generator.next();
    expect(result.done).toBe(false);
    const response3 = result.value as {
      response: { fileDescriptorResponse?: { descriptorFile: unknown[] } };
    };
    expect(response3.response.fileDescriptorResponse).toBeDefined();

    // allExtensionNumbersOfType
    result = await generator.next();
    expect(result.done).toBe(false);
    const response4 = result.value as {
      response: { extensionNumberResponse?: { numbers: number[] } };
    };
    expect(response4.response.extensionNumberResponse!.numbers).toEqual([]);

    // unknown request
    result = await generator.next();
    expect(result.done).toBe(false);
    const response5 = result.value as {
      response: { errorResponse?: { code: number; message: string } };
    };
    expect(response5.response.errorResponse!.code).toBe(3);
  });
});

describe('buildReflectionRegistry', () => {
  function createFakeRuntime(): ConnectRuntime {
    return {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => createFakeRuntime(),
      loadConnectModule: () => Promise.resolve(createFakeRuntime()),
      reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
      getService: () => undefined,
    };
  }

  it('should include embedded services in listServices', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const services = registry.listServices();
    expect(services).toContain('grpc.health.v1.Health');
    expect(services).toContain('grpc.reflection.v1.ServerReflection');
  });

  it('should include app services with typeName in listServices', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService' }],
    );
    const services = registry.listServices();
    expect(services).toContain('pkg.MyService');
  });

  it('should skip app services without typeName', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{}],
    );
    const services = registry.listServices();
    expect(services).not.toContain('');
    expect(services).not.toContain(undefined as unknown as string);
  });

  it('should skip app services with empty string typeName', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: '' }],
    );
    const services = registry.listServices();
    expect(services).not.toContain('');
  });

  it('should find file by name', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const file = registry.getFileByName('grpc/health/v1/health.proto');
    expect(file).toBeDefined();
  });

  it('should return undefined for unknown file name', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const file = registry.getFileByName('unknown.proto');
    expect(file).toBeUndefined();
  });

  it('should find file containing symbol by service name', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const file = registry.getFileContaining('grpc.health.v1.Health');
    expect(file).toBeDefined();
  });

  it('should find file containing symbol by proto file name', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const file = registry.getFileContaining('health.proto');
    expect(file).toBeDefined();
  });

  it('should return undefined for unknown symbol', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [],
    );
    const file = registry.getFileContaining('unknown.Symbol');
    expect(file).toBeUndefined();
  });

  it('should include app service files with protoFile', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService', protoFile: 'pkg/my_service.proto' }],
    );
    const file = registry.getFileByName('pkg/my_service.proto');
    expect(file).toBeDefined();
  });

  it('should use unknown.proto when protoFile is not provided', () => {
    const registry = buildReflectionRegistry(
      createFakeRuntime(),
      { healthBase64: 'aGVsbG8=', reflectionBase64: 'd29ybGQ=' },
      [{ typeName: 'pkg.MyService' }],
    );
    const file = registry.getFileByName('unknown.proto');
    expect(file).toBeDefined();
  });
});
