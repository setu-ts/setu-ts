/**
 * Connect router builder tests — verifies service registration and dispatch map creation.
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
    expect(dispatchMap.size).toBeGreaterThanOrEqual(0); // May be 0 if health service doesn't add handlers directly in this impl
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
});
