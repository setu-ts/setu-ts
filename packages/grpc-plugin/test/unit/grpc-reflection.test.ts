/**
 * gRPC Server Reflection tests — verifies reflection service implementation.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createReflectionService } from '../../src/reflection/grpc-reflection.ts';
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
});
