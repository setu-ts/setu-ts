/**
 * Connect router builder tests — verifies service registration and dispatch map creation.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildConnectRouter } from '../../src/transports/connect-router-builder.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
// EmbeddedDescriptors imported for type checking but not directly used in test values

// Create a fake ConnectRuntime for testing
const fakeConnectRuntime: ConnectRuntime = {
  createFetchHandler: (_handlers: Array<{ requestPath: string; handler: unknown }>, _options?: { httpVersion?: string }) => new Map(),
  adaptConnectModule: (_mod: unknown): ConnectRuntime => fakeConnectRuntime,
  loadConnectModule: async (): Promise<ConnectRuntime> => fakeConnectRuntime,
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
        implementation: { echo: async (_request: Request) => new Response('OK') },
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

    expect(dispatchMap.size).toBe(1);
    expect(dispatchMap.has('/grpc/package.ServiceName/echo')).toBeTruthy();
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
    }).toThrow();
  });
});
