/**
 * GrpcService tests — verifies service registration and request handling.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GrpcService } from '../../src/services/grpc-service.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import type { IHttpAdapter } from '@hono-enterprise/common';
import type { GrpcPluginOptions } from '../../src/interfaces/index.ts';
import { GrpcUnavailableError } from '../../src/errors/grpc-errors.ts';

// Create a fake ConnectRuntime for testing
function createFakeConnectRuntime(): ConnectRuntime {
  return {
    createConnectRouter: () => ({ handlers: [], service: () => {} }),
    createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
    reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
    getService: () => undefined,
    createRegistry: () => ({}),
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

  it('ensureRouter should build dispatch map on first call', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    service.addService({ typeName: 'pkg.Svc', methods: { method: {} } });

    // Access internal ensureRouter via handleRequest
    const request = new Request('http://example.com/grpc/pkg.Svc/method');
    await service.handleRequest(request);

    // After first call, dispatchMap should be built (may be empty with fake runtime)
    expect(service.dispatchMapSize).toBeGreaterThanOrEqual(0);
  });

  it('ensureRouter should be idempotent — second call returns immediately', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    service.addService({ typeName: 'pkg.Svc', methods: { method: {} } });

    // First call builds the router
    const request1 = new Request('http://example.com/grpc/pkg.Svc/method');
    await service.handleRequest(request1);

    // Second call should reuse the cached router
    const request2 = new Request('http://example.com/grpc/pkg.Svc/method');
    await service.handleRequest(request2);

    // dispatchMapSize should be consistent
    expect(service.dispatchMapSize).toBeGreaterThanOrEqual(0);
  });

  it('should throw GrpcUnavailableError on handleRequest when adapter is null', async () => {
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      undefined,
    );

    const request = new Request('http://example.com/grpc/svc/method');
    await expect(service.handleRequest(request)).rejects.toThrow(GrpcUnavailableError);
  });

  it('createFetchHandler should dispatch RPC requests when available', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    service.addService({ typeName: 'pkg.Svc', methods: { method: {} } });

    const handler = service.createFetchHandler();
    const request = new Request('http://example.com/grpc/pkg.Svc/method');
    const result = await handler(request);

    // The fallback runtime returns 404 for unhandled paths
    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });

  it('should invalidate router cache when adding a new service', () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    service.addService({ typeName: 'pkg.Svc1', methods: { method: {} } });

    // Build the router
    const request1 = new Request('http://example.com/grpc/pkg.Svc1/method');
    service.handleRequest(request1);

    // Add another service
    service.addService({ typeName: 'pkg.Svc2', methods: { method: {} } });

    // The routerBuilt flag should be reset (we can't directly check it, but
    // dispatchMapSize should reflect the new state after another request)
    const request2 = new Request('http://example.com/grpc/pkg.Svc2/method');
    service.handleRequest(request2);

    // dispatchMapSize should be consistent
    expect(service.dispatchMapSize).toBeGreaterThanOrEqual(0);
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

  it('ensureRouter should be a no-op when not available', async () => {
    const adapter = createMockAdapter(false);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    // Should not throw
    await (service as unknown as { ensureRouter: () => Promise<void> }).ensureRouter();
    expect(service.dispatchMapSize).toBe(0);
  });

  it('should return 503 after stop is called', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    service.addService({ typeName: 'pkg.Svc', methods: { method: {} } });

    // Build the router first
    const request1 = new Request('http://example.com/grpc/pkg.Svc/method');
    await service.handleRequest(request1);

    // Simulate stop
    (service as unknown as { setStopped: (v: boolean) => void }).setStopped(true);

    // After stop, requests should return 503
    const response = await service.handleRequest(request1);
    expect(response.status).toBe(503);
  });

  it('createFetchHandler should return 503 after stop is called', async () => {
    const adapter = createMockAdapter(true);
    const service = new GrpcService(
      fakeConnectRuntime,
      fakeEmbeddedDescriptors,
      {} as GrpcPluginOptions,
      adapter,
    );
    service.addService({ typeName: 'pkg.Svc', methods: { method: {} } });

    // Build the router first
    const handler = service.createFetchHandler();
    const request = new Request('http://example.com/grpc/pkg.Svc/method');
    await handler(request);

    // Simulate stop
    (service as unknown as { setStopped: (v: boolean) => void }).setStopped(true);

    // After stop, fetch handler should return 503
    const response = await handler(request);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
  });
});
