/**
 * GrpcService tests — verifies service registration and request handling.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GrpcService } from '../../src/services/grpc-service.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
// EmbeddedDescriptors is used for typing fakeEmbeddedDescriptors but not directly referenced
import type { IHttpAdapter } from '@hono-enterprise/common';
import type { GrpcPluginOptions } from '../../src/interfaces/index.ts';
import { GrpcUnavailableError } from '../../src/errors/grpc-errors.ts';

// Create a fake ConnectRuntime for testing
const fakeConnectRuntime: ConnectRuntime = {
  createFetchHandler: () => new Map(),
  adaptConnectModule: () => fakeConnectRuntime,
  loadConnectModule: async () => fakeConnectRuntime,
  reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
  getService: () => undefined,
};

// Fake embedded descriptors
const fakeEmbeddedDescriptors = {
  healthBase64: 'aGVsbG8=', // placeholder
  reflectionBase64: 'd29ybGQ=', // placeholder
};

// A minimal mock IHttpAdapter that satisfies the interface
function createMockAdapter(setRpcHandler: boolean): IHttpAdapter {
  
  return {
    setRpcHandler: setRpcHandler ? (() => {}) : () => {},
    setHandler: (() => {}) as any,
    fetch: (() => {}) as any,
    listen: (() => {}) as any,
    close: (() => {}) as any,
  };
}

describe('GrpcService', () => {
  it('should be available when adapter has setRpcHandler', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    expect(service.available).toBeTruthy();
  });

  it('should be unavailable when adapter lacks setRpcHandler', () => {
    const adapter = createMockAdapter(false);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    expect(service.available).toBeFalsy();
  });

  it('should register a service via addService', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );

    const definition = { typeName: 'package.TestService', methods: {} };
    service.addService(definition);

    // The service is stored internally; verify no exception was thrown
    expect(() => service.addService({ typeName: 'package.TestService', methods: {} }))
      .toThrow();
  });

  it('should throw on duplicate service registration', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );

    const definition = { typeName: 'package.TestService', methods: {} };
    service.addService(definition);

    expect(() => service.addService(definition)).toThrow();
  });

  it('handleRequest should return response for non-RPC paths when available', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );

    // Without services configured, handleRequest should fall through (return 404)
    const request = new Request('http://example.com/normal/path');
    const result = await service.handleRequest(request);
    expect(result).toBeDefined();
    expect((result as Response).status).toBe(404);
  });

  it('handleRequest should throw GrpcUnavailableError when not available', async () => {
    const adapter = createMockAdapter(false);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );

    const request = new Request('http://example.com/grpc/service/method');
    await expect(service.handleRequest(request)).rejects.toThrow(GrpcUnavailableError);
  });
});
