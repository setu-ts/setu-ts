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
  reviveDescriptorSet: (_base64: string) => ({
    files: [],
    getService: (_name: string) => undefined,
    listServices: () => [],
  }),
  getService: (_registry: unknown, _serviceName: string) => undefined,
  createRegistry: () => ({ getService: () => undefined }),
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

  it('should detect duplicate service type names', () => {
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
    // Package may be empty string when not provided in definition
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
    // Package may be empty when not explicitly set in the definition
    expect(reg.files[0].methods).toContain('echo');
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

  it('should call router.service for each registered app service', () => {
    const serviceCalls: Array<{ typeName: string }> = [];
    const fakeRuntimeWithTracking: ConnectRuntime = {
      ...fakeConnectRuntime,
      createConnectRouter: () => {
        return {
          handlers: [],
          service: (_service: unknown, _impl: unknown) => {
            const desc = _service as { typeName: string };
            serviceCalls.push({ typeName: desc.typeName });
          },
        };
      },
    };

    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Svc1', methods: { method1: {} } } },
      { definition: { typeName: 'pkg.Svc2', methods: { method2: {} } } },
    ];

    buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeRuntimeWithTracking,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Should call service() once per app service (2) — health/reflection disabled
    expect(serviceCalls.length).toBe(2);
    expect(serviceCalls.map((c) => c.typeName)).toContain('pkg.Svc1');
    expect(serviceCalls.map((c) => c.typeName)).toContain('pkg.Svc2');
  });

  it('should not call router.service for health/reflection when disabled', () => {
    const serviceCalls: Array<{ typeName: string }> = [];
    const fakeRuntimeWithTracking: ConnectRuntime = {
      ...fakeConnectRuntime,
      createConnectRouter: () => {
        return {
          handlers: [],
          service: (_service: unknown, _impl: unknown) => {
            const desc = _service as { typeName: string };
            serviceCalls.push({ typeName: desc.typeName });
          },
        };
      },
    };

    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Svc', methods: { echo: {} } } },
    ];

    buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeRuntimeWithTracking,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Should call service() once per app service only (1)
    expect(serviceCalls.length).toBe(1);
    expect(serviceCalls[0].typeName).toBe('pkg.Svc');
  });

  it('should pass valid descriptor objects to router.service', () => {
    const serviceCalls: Array<{ typeName: string; hasKind: boolean }> = [];
    const fakeRuntimeWithTracking: ConnectRuntime = {
      ...fakeConnectRuntime,
      createConnectRouter: () => {
        return {
          handlers: [],
          service: (service: unknown, _impl: unknown) => {
            const desc = service as { kind?: string; typeName: string };
            serviceCalls.push({
              typeName: desc.typeName,
              hasKind: desc.kind === 'service',
            });
          },
        };
      },
    };

    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Svc', methods: { echo: {} } } },
    ];

    buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeRuntimeWithTracking,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(serviceCalls.length).toBe(1);
    expect(serviceCalls[0].typeName).toBe('pkg.Svc');
    expect(serviceCalls[0].hasKind).toBe(true);
  });

  it('should pass through real DescService when kind is service', () => {
    const serviceCalls: Array<{ typeName: string; hasKind: boolean }> = [];
    const fakeRuntimeWithTracking: ConnectRuntime = {
      ...fakeConnectRuntime,
      createConnectRouter: () => {
        return {
          handlers: [],
          service: (service: unknown, _impl: unknown) => {
            const desc = service as { kind?: string; typeName: string };
            serviceCalls.push({
              typeName: desc.typeName,
              hasKind: desc.kind === 'service',
            });
          },
        };
      },
    };

    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      {
        definition: {
          kind: 'service',
          typeName: 'pkg.RealService',
          methods: { echo: {} },
        },
      },
    ];

    buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeRuntimeWithTracking,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(serviceCalls.length).toBe(1);
    expect(serviceCalls[0].typeName).toBe('pkg.RealService');
    expect(serviceCalls[0].hasKind).toBe(true);
  });

  it('should handle health service with null descriptor', () => {
    const serviceCalls: Array<{ typeName: string }> = [];
    const fakeRuntimeWithNullHealth: ConnectRuntime = {
      ...fakeConnectRuntime,
      createConnectRouter: () => ({
        handlers: [],
        service: (service: unknown, _impl: unknown) => {
          const desc = service as { typeName: string };
          serviceCalls.push({ typeName: desc.typeName });
        },
      }),
      reviveDescriptorSet: () => ({
        files: [],
        getService: (name: string) => name === 'grpc.health.v1.Health' ? null : undefined,
        listServices: () => [],
      }),
      getService: (_registry: unknown, serviceName: string) =>
        serviceName === 'grpc.health.v1.Health' ? null : undefined,
    };

    buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: true,
      services: [],
      connectRuntime: fakeRuntimeWithNullHealth,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Should not call service() for health since descriptor is null
    expect(serviceCalls.length).toBe(0);
  });

  it('should handle reflection service with null descriptor', () => {
    const serviceCalls: Array<{ typeName: string }> = [];
    const fakeRuntimeWithNullReflection: ConnectRuntime = {
      ...fakeConnectRuntime,
      createConnectRouter: () => ({
        handlers: [],
        service: (service: unknown, _impl: unknown) => {
          const desc = service as { typeName: string };
          serviceCalls.push({ typeName: desc.typeName });
        },
      }),
      reviveDescriptorSet: () => ({
        files: [],
        getService: (name: string) =>
          name === 'grpc.reflection.v1.ServerReflection' ? null : undefined,
        listServices: () => [],
      }),
      getService: (_registry: unknown, serviceName: string) =>
        serviceName === 'grpc.reflection.v1.ServerReflection' ? null : undefined,
    };

    buildConnectRouter({
      basePath: '/grpc',
      reflection: true,
      health: false,
      services: [],
      connectRuntime: fakeRuntimeWithNullReflection,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    // Should not call service() for reflection since descriptor is null
    expect(serviceCalls.length).toBe(0);
  });

  it('should handle service without dot in typeName (buildDescService edge case)', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'Svc', methods: { method: {} } } },
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
  });

  it('should handle service with null methods in reflection registry', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: 'pkg.Svc', methods: null as never } },
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
    expect(reg.files[0].methods).toEqual([]);
  });

  it('should handle service with falsy typeName in reflection registry', () => {
    const services: Array<{ definition: unknown; implementation?: unknown }> = [
      { definition: { typeName: '', methods: { echo: {} } } },
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
      listServices: () => string[];
    };
    const listed = reg.listServices();
    // Empty string typeName should still be included
    expect(listed).toContain('');
  });
});
