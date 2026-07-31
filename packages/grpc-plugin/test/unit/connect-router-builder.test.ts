/**
 * Connect router builder tests — verifies service registration, dispatch map creation,
 * health/reflection paths, and duplicate detection.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildConnectRouter } from '../../src/transports/connect-router-builder.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';

const fakeConnectRuntime: ConnectRuntime = {
  createConnectRouter: () => ({ handlers: [], service: () => {} }),
  createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
  adaptConnectModule: (_mod: unknown): ConnectRuntime => fakeConnectRuntime,
  loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
  reviveDescriptorSet: (_base64: string) => ({
    files: [],
    getService: (_name: string) => undefined,
    listServices: () => [],
  }),
  getService: (_registry: unknown, _serviceName: string) => undefined,
};

// Fake embedded descriptors
const fakeEmbeddedDescriptors = {
  healthBase64: 'aGVsbG8=', // placeholder
  reflectionBase64: 'd29ybGQ=', // placeholder
};

describe('ConnectRouterBuilder', () => {
  it('should build a dispatch map with registered services', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'package.ServiceName', methods: { echo: {} } },
        implementation: { echo: (_request: Request) => Promise.resolve(new Response('OK')) },
      },
    ];

    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(dispatchMap).toBeDefined();
    expect(typeof dispatchMap.get).toBe('function');
  });

  it('should register health service when health option is true', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: true,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Health Check would be registered at /grpc.health.v1.Health/Check
    const healthPath = '/grpc/grpc.health.v1.Health/Check';
    const healthHandler = dispatchMap.get(healthPath);
    expect(healthHandler).toBeDefined();
    expect(typeof healthHandler).toBe('function');
  });

  it('should register reflection service when reflection option is true', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Reflection would be registered
    const reflectionPath = '/grpc/grpc.reflection.v1.ServerReflection/ServerReflectionInfo';
    const reflectionHandler = dispatchMap.get(reflectionPath);
    expect(reflectionHandler).toBeDefined();
    expect(typeof reflectionHandler).toBe('function');
  });

  it('should reject duplicate service type names', () => {
    // Pass proper shape with definition property containing typeName
    const services = [
      { definition: { typeName: 'package.Service' }, implementation: {} },
      { definition: { typeName: 'package.Service' }, implementation: {} },
    ];

    expect(() => {
      buildConnectRouter({
        basePath: '/grpc',
        reflection: false,
        health: false,
        services,
        connectRuntime: fakeConnectRuntime,
        embeddedDescriptors: fakeEmbeddedDescriptors,
      });
    }).toThrow('has already been registered');
  });

  it('should build a reflection registry when reflection or health is enabled', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.MyService', methods: { echo: {} } } },
    ];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: true,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(registry).toBeDefined();
    const reg = registry as {
      listServices: () => string[];
      getService: (name: string) => unknown;
    };
    const listedServices = reg.listServices();
    expect(listedServices).toContain('pkg.MyService');
  });

  it('should not build reflection registry when both reflection and health are false', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(registry).toBeNull();
  });

  it('should normalize basePath correctly', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { method: {} } },
        implementation: { method: () => ({}) },
      },
    ];

    // Test with trailing slash
    const { dispatchMap: map1 } = buildConnectRouter({
      basePath: '/grpc/',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Test without trailing slash
    const { dispatchMap: map2 } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Both should have the same keys
    expect(map1.size).toBe(map2.size);
  });

  it('should handle service without typeName gracefully', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { methods: { echo: {} } } },
    ];

    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(dispatchMap).toBeDefined();
    expect(dispatchMap.size).toBe(0);
  });

  it('should handle service with empty methods', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Empty', methods: {} } },
    ];

    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(dispatchMap).toBeDefined();
    expect(dispatchMap.size).toBe(0);
  });

  it('should return dispatch map with correct paths for multiple services', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc1', methods: { method1: {} } },
        implementation: { method1: () => ({}) },
      },
      {
        definition: { typeName: 'pkg.Svc2', methods: { method2: {} } },
        implementation: { method2: () => ({}) },
      },
    ];

    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(dispatchMap.size).toBe(2);
    expect(dispatchMap.has('/grpc/pkg.Svc1/method1')).toBe(true);
    expect(dispatchMap.has('/grpc/pkg.Svc2/method2')).toBe(true);
  });

  it('should build reflection registry with service details', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: {
          typeName: 'pkg.Svc',
          package: 'pkg',
          methods: { method1: {}, method2: {} },
        },
      },
    ];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(registry).toBeDefined();
    const reg = registry as {
      files: Array<{ name: string; package: string; methods: string[] }>;
      listServices: () => string[];
      getService: (name: string) => unknown;
    };

    expect(reg.files.length).toBe(1);
    expect(reg.files[0].name).toBe('pkg.Svc');
    expect(reg.files[0].package).toBe('pkg');
    expect(reg.files[0].methods).toEqual(['method1', 'method2']);

    const listed = reg.listServices();
    expect(listed).toContain('pkg.Svc');

    const found = reg.getService('pkg.Svc');
    expect(found).toBeDefined();
  });

  it('should handle service with empty typeName in reflection registry', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { methods: { echo: {} } } },
    ];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(registry).toBeDefined();
    const reg = registry as { files: unknown[] };
    expect(reg.files.length).toBe(1);
  });

  it('should handle service with undefined methods', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Svc' } },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(dispatchMap).toBeDefined();
    expect(dispatchMap.size).toBe(0);
  });

  it('buildReflectionRegistry should include package in file metadata', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: {
          typeName: 'pkg.MyService',
          package: 'my.package',
          methods: { echo: {} },
        },
      },
    ];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const reg = registry as {
      files: Array<{ name: string; package: string; methods: string[] }>;
    };
    expect(reg.files.length).toBe(1);
    expect(reg.files[0].package).toBe('my.package');
  });

  it('getService on reflection registry should find service by name', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.MyService', methods: { echo: {} } },
        implementation: { echo: () => ({}) },
      },
    ];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const reg = registry as {
      getService: (name: string) => unknown;
    };
    const found = reg.getService('pkg.MyService');
    expect(found).toBeDefined();
    expect((found as { definition: { typeName: string } }).definition.typeName).toBe(
      'pkg.MyService',
    );
  });

  it('getService on reflection registry should return undefined for unknown service', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [];
    const { registry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const reg = registry as {
      getService: (name: string) => unknown;
    };
    const found = reg.getService('unknown.Service');
    expect(found).toBeUndefined();
  });

  it('should handle handler error and return 500', async () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { fail: {} } },
        implementation: {
          fail: () => {
            throw new Error('boom');
          },
        },
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const handler = dispatchMap.get('/grpc/pkg.Svc/fail');
    expect(handler).toBeDefined();
    const response = await handler!(
      new Request('http://localhost/grpc/pkg.Svc/fail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(500);
    const body = JSON.parse(await response.text());
    expect(body.error).toContain('boom');
  });

  it('should handle handler with string error message', async () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { fail: {} } },
        implementation: {
          fail: () => {
            throw 'string error';
          },
        },
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const handler = dispatchMap.get('/grpc/pkg.Svc/fail');
    expect(handler).toBeDefined();
    const response = await handler!(
      new Request('http://localhost/grpc/pkg.Svc/fail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(500);
    const body = JSON.parse(await response.text());
    expect(body.error).toBe('string error');
  });

  it('should handle handler with unknown error type', async () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { fail: {} } },
        implementation: {
          fail: () => {
            throw null;
          },
        },
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const handler = dispatchMap.get('/grpc/pkg.Svc/fail');
    expect(handler).toBeDefined();
    const response = await handler!(
      new Request('http://localhost/grpc/pkg.Svc/fail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(500);
    const body = JSON.parse(await response.text());
    expect(body.error).toBe('Unknown error');
  });

  it('should handle service with falsy implementation', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { method: {} } },
        implementation: null as never,
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // No handler should be registered since implementation is null/falsy
    expect(dispatchMap.size).toBe(0);
  });

  it('should handle service with falsy methods', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Svc', methods: null as never } },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // No handler should be registered since methods is null/falsy
    expect(dispatchMap.size).toBe(0);
  });

  it('should handle method with no handler in implementation', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { method: {} } },
        implementation: { otherMethod: () => ({}) },
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // No handler should be registered since the method is not in implementation
    expect(dispatchMap.size).toBe(0);
  });

  it('should use provided implementation when truthy', async () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { echo: {} } },
        implementation: {
          echo: (_ctx: unknown, input: Record<string, unknown>) => ({ result: input.message }),
        },
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const handler = dispatchMap.get('/grpc/pkg.Svc/echo');
    expect(handler).toBeDefined();
    const response = await handler!(
      new Request('http://localhost/grpc/pkg.Svc/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text());
    expect(body.result).toBe('hello');
  });

  it('should use provided methods when truthy', async () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: { typeName: 'pkg.Svc', methods: { ping: {} } },
        implementation: { ping: () => ({ pong: true }) },
      },
    ];
    const { dispatchMap } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    const handler = dispatchMap.get('/grpc/pkg.Svc/ping');
    expect(handler).toBeDefined();
    const response = await handler!(
      new Request('http://localhost/grpc/pkg.Svc/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(await response.text());
    expect(body.pong).toBe(true);
  });
});
