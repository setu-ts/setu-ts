/**
 * Descriptor registry tests — verifies reviveDescriptorSet and buildReflectionRegistry.
 */

import { describe, it, expect, mock } from '@std/testing/bdd';
import { reviveDescriptorSet, buildReflectionRegistry } from '../../src/descriptors/descriptor-registry.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';

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

describe('DescriptorRegistry', () => {
  it('reviveDescriptorSet should decode base64 and create a FileRegistry', () => {
    // With placeholder data, this may not produce valid results but should at least attempt decoding
    const registry = reviveDescriptorSet(fakeConnectRuntime, 'aGVsbG8='); // Simple valid base64
    expect(registry).toBeDefined();
    expect(Array.isArray((registry as any).files)).toBeTrue();
  });

  it('buildReflectionRegistry should combine health, reflection, and app service descriptors', () => {
    const healthRegistry = reviveDescriptorSet(fakeConnectRuntime, EmbeddedDescriptors.healthBase64);
    const reflectionRegistry = reviveDescriptorSet(fakeConnectRuntime, EmbeddedDescriptors.reflectionBase64);
    
    const services = [];
    const combined = buildReflectionRegistry(fakeConnectRuntime, services, healthRegistry, reflectionRegistry);
    
    expect(combined).toBeDefined();
    expect((combined as any).listServices).toBeInstanceOf(Function);
  });
});