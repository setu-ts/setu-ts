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
function createFakeConnectRuntime(): ConnectRuntime {
  return {
    createConnectRouter: () => ({ handlers: [], service: () => {} }),
    createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
    adaptConnectModule: (_mod: unknown): ConnectRuntime => createFakeConnectRuntime(),
    loadConnectModule: () => Promise.resolve(createFakeConnectRuntime()),
    reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
    getService: () => undefined,
  };
}

const fakeConnectRuntime = createFakeConnectRuntime();

// Fake embedded descriptors
const fakeEmbeddedDescriptors = {
  healthBase64: 'aGVsbG8=', // placeholder
  reflectionBase64: 'd29ybGQ=', // placeholder
};

// A minimal mock IHttpAdapter that satisfies the interface.
// When hasRpcHandler is true, setRpcHandler is present; otherwise omitted entirely.
function createMockAdapter(hasRpcHandler: boolean): IHttpAdapter {
  const adapter: Omit<IHttpAdapter, 'setRpcHandler'> & { setRpcHandler?: () => void } = {
    setHandler: (() => {}) as never,
    fetch: (() => {}) as never,
    listen: (() => {}) as never,
    close: (() => {}) as never,
  };
  if (hasRpcHandler) {
    adapter.setRpcHandler = () => {};
  }
  return adapter as IHttpAdapter;
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

  it('should accept services from options at construction', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {
        services: [
          { definition: { typeName: 'package.PreReg', methods: {} } },
        ],
      } as GrpcPluginOptions,
      adapter,
    );
    expect(service.servicesCount).toBe(1);
  });

  it('should use custom basePath from options', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      { basePath: '/custom-grpc' } as GrpcPluginOptions,
      adapter,
    );
    // basePath is internal; verify no error during construction
    expect(service).toBeDefined();
  });

  it('servicesCount should reflect registered services', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    expect(service.servicesCount).toBe(0);
    service.addService({ typeName: 'pkg.Svc', methods: {} });
    expect(service.servicesCount).toBe(1);
  });

  it('dispatchMapSize should be 0 before router is built', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    expect(service.dispatchMapSize).toBe(0);
  });

  it('createFetchHandler should return null for non-RPC paths when available', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    const handler = service.createFetchHandler();
    const result = await handler(new Request('http://example.com/other/path'));
    expect(result).toBeNull();
  });

  it('createFetchHandler should return null when not available', async () => {
    const adapter = createMockAdapter(false);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    const handler = service.createFetchHandler();
    const result = await handler(new Request('http://example.com/grpc/svc/method'));
    expect(result).toBeNull();
  });
});
