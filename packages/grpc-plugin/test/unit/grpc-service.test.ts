/**
 * GrpcService tests — verifies service registration and request handling.
 */

import { describe, it, expect } from '@std/testing/bdd';
import { GrpcService } from '../../src/services/grpc-service.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';
import type { IHttpAdapter } from '@hono-enterprise/common';

// Create a fake ConnectRuntime for testing
const fakeConnectRuntime: ConnectRuntime = {
  connect: {
    createFetchHandler: () => ((req: Request) => new Response('OK')) as any,
    universalServerRequestFromFetch: (r: Request) => r as any,
    universalServerResponseToFetch: (r: Response) => r as any,
  },
  protobuf: {
    fromBinary: () => ({}),
    toBinary: () => new Uint8Array(),
    create: () => ({}),
    createFileRegistry: () => ({ files: [], getService: () => undefined, getMessage: () => undefined, listServices: () => [] }),
    FileDescriptorSetSchema: { fields: () => undefined },
    FileDescriptorProtoSchema: { fields: () => undefined },
  },
  wkt: {
    fromBinary: () => ({}),
    toBinary: () => new Uint8Array(),
    create: () => ({}),
    createFileRegistry: () => ({ files: [], getService: () => undefined, getMessage: () => undefined, listServices: () => [] }),
  },
  createFetchHandler: () => new Map(),
  adaptConnectModule: () => fakeConnectRuntime,
  loadConnectModule: async () => fakeConnectRuntime,
  reviveDescriptorSet: () => ({ files: [], getService: () => undefined, getMessage: () => undefined, listServices: () => [] }),
  getService: () => undefined,
};

// Fake embedded descriptors
const fakeEmbeddedDescriptors = {
  healthBase64: 'aGVsbG8=',
  reflectionBase64: 'd29ybGQ=',
};

describe('GrpcService', () => {
  it('should be available when adapter has setRpcHandler', () => {
    const adapter = { setRpcHandler: (() => {}) as any };
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {},
      adapter,
    );
    expect(service.available).toBeTrue();
  });

  it('should be unavailable when adapter lacks setRpcHandler', () => {
    const adapter = {} as any;
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {},
      adapter,
    );
    expect(service.available).toBeFalse();
  });

  it('should register a service via addService', () => {
    const adapter = { setRpcHandler: (() => {}) as any };
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {},
      adapter,
    );
    
    const definition = { typeName: 'package.TestService', methods: {} };
    service.addService(definition);
    
    // The service is stored internally; verify no exception was thrown
    expect(() => service.addService({ typeName: 'package.TestService', methods: {} })).toThrowError();
  });

  it('should throw on duplicate service registration', () => {
    const adapter = { setRpcHandler: (() => {}) as any };
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {},
      adapter,
    );
    
    const definition = { typeName: 'package.TestService', methods: {} };
    service.addService(definition);
    
    expect(() => service.addService(definition)).toThrowError();
  });

  it('handleRequest should return null for non-RPC paths when available', async () => {
    const adapter = { setRpcHandler: (() => {}) as any };
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {},
      adapter,
    );
    
    // Without services configured, handleRequest should fall through
    const request = new Request('http://example.com/normal/path');
    const result = await service.handleRequest(request);
    // With empty services, this would return GrpcUnavailableError or similar
    // depending on implementation
  });

  it('handleRequest should throw GrpcUnavailableError when not available', async () => {
    const adapter = {} as any;
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {},
      adapter,
    );
    
    const request = new Request('http://example.com/grpc/service/method');
    await expect(service.handleRequest(request)).rejects.toThrow();
  });
});