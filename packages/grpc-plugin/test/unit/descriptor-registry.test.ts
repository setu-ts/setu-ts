/**
 * Descriptor registry tests — verifies reviveDescriptorSet and buildReflectionRegistry.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildReflectionRegistry,
  reviveDescriptorSet,
} from '../../src/descriptors/descriptor-registry.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';

describe('DescriptorRegistry', () => {
  it('reviveDescriptorSet should delegate to connectRuntime.reviveDescriptorSet', () => {
    let called = false;
    const fakeConnectRuntime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => fakeConnectRuntime,
      loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
      reviveDescriptorSet: (base64: string) => {
        called = true;
        expect(base64).toBe('dGVzdA==');
        return { files: [], getService: () => undefined, listServices: [] };
      },
      getService: () => undefined,
    };
    const result = reviveDescriptorSet(fakeConnectRuntime, 'dGVzdA==');
    expect(called).toBe(true);
    expect(result).toBeDefined();
  });

  it('buildReflectionRegistry should include embedded services', () => {
    const fakeConnectRuntime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => fakeConnectRuntime,
      loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
      reviveDescriptorSet: () => ({
        files: [],
        getService: () => undefined,
        listServices: () => [],
      }),
      getService: () => undefined,
    };
    const registry = buildReflectionRegistry(
      fakeConnectRuntime,
      EmbeddedDescriptors,
      [],
    );
    expect(registry).toBeDefined();
    // Verify the registry has the expected structure
    const reg = registry as Record<string, unknown>;
    expect(typeof reg.listServices).toBe('function');
    expect(typeof reg.getService).toBe('function');
    // Should include embedded services
    const services = (reg.listServices as () => string[])();
    expect(services).toContain('grpc.health.v1.Health');
    expect(services).toContain('grpc.reflection.v1.ServerReflection');
  });

  it('buildReflectionRegistry should include app services', () => {
    const fakeConnectRuntime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => fakeConnectRuntime,
      loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
      reviveDescriptorSet: () => ({
        files: [],
        getService: () => undefined,
        listServices: () => [],
      }),
      getService: () => undefined,
    };
    // App services have definition property with typeName inside
    const registry = buildReflectionRegistry(
      fakeConnectRuntime,
      EmbeddedDescriptors,
      [
        { definition: { typeName: 'pkg.MyService' } },
        { definition: { typeName: 'pkg.OtherService' } },
      ],
    );
    const reg = registry as Record<string, unknown>;
    const services = (reg.listServices as () => string[])();
    expect(services).toContain('pkg.MyService');
    expect(services).toContain('pkg.OtherService');
  });

  it('buildReflectionRegistry getService should find app services', () => {
    const fakeConnectRuntime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => fakeConnectRuntime,
      loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
      reviveDescriptorSet: () => ({
        files: [],
        getService: () => undefined,
        listServices: () => [],
      }),
      getService: () => undefined,
    };
    const registry = buildReflectionRegistry(
      fakeConnectRuntime,
      EmbeddedDescriptors,
      [
        { definition: { typeName: 'pkg.MyService' } },
      ],
    );
    const reg = registry as Record<string, unknown>;
    const service = (reg.getService as (name: string) => unknown)('pkg.MyService');
    expect(service).toBeDefined();
  });

  it('buildReflectionRegistry getService should return undefined for unknown service', () => {
    const fakeConnectRuntime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => fakeConnectRuntime,
      loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
      reviveDescriptorSet: () => ({
        files: [],
        getService: () => undefined,
        listServices: () => [],
      }),
      getService: () => undefined,
    };
    const registry = buildReflectionRegistry(
      fakeConnectRuntime,
      EmbeddedDescriptors,
      [],
    );
    const reg = registry as Record<string, unknown>;
    const service = (reg.getService as (name: string) => unknown)('unknown.Service');
    expect(service).toBeUndefined();
  });

  it('buildReflectionRegistry getService should find embedded health service', () => {
    const fakeConnectRuntime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => fakeConnectRuntime,
      loadConnectModule: () => Promise.resolve(fakeConnectRuntime),
      reviveDescriptorSet: () => ({
        files: [],
        getService: () => ({ kind: 'service' }),
        listServices: () => [],
      }),
      getService: () => undefined,
    };
    const registry = buildReflectionRegistry(
      fakeConnectRuntime,
      EmbeddedDescriptors,
      [],
    );
    const reg = registry as Record<string, unknown>;
    const service = (reg.getService as (name: string) => unknown)('grpc.health.v1.Health');
    expect(service).toBeDefined();
  });
});
