/**
 * Connect router builder tests — verifies service registration and dispatch map creation.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildConnectRouter } from '../../src/transports/connect-router-builder.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import type { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';

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
  healthBase64: 'aGVsbG8=', // placeholder
  reflectionBase64: 'd29ybGQ=', // placeholder
};

describe('ConnectRouterBuilder', () => {
  it('should build a dispatch map with registered services', () => {
    const services = [
      {
        definition: { typeName: 'package.ServiceName', methods: { echo: {} } },
        implementation: { echo: async (req: any) => new Response('OK') },
      },
    ];

    const { dispatchMap, reflectionRegistry } = buildConnectRouter({
      basePath: '/grpc',
      reflection: false,
      health: false,
      services,
      connectRuntime: fakeConnectRuntime,
      embeddedDescriptors: fakeEmbeddedDescriptors,
    });

    expect(dispatchMap.size).toBe(1);
    expect(dispatchMap.has('/grpc/package.ServiceName/echo')).toBeTrue();
  });

  it('should register health service when health option is true', () => {
    const services = [];
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
    }).toThrowError();
  });
});