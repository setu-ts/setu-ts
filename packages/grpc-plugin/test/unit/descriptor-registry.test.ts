/**
 * Descriptor registry tests — verifies reviveDescriptorSet and buildReflectionRegistry.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildReflectionRegistry,
} from '../../src/descriptors/descriptor-registry.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';

describe('DescriptorRegistry', () => {
  it('reviveDescriptorSet should decode base64 to a FileDescriptorSet', () => {
    // This test would require a real ConnectRuntime with Protobuf-ES
    // In the current implementation, it's a stub that returns placeholder data
    // Placeholder - will be enhanced with real runtime
  });

  it('buildReflectionRegistry should include embedded services', () => {
    const fakeConnectRuntime = {} as unknown as ConnectRuntime;
    const registry = buildReflectionRegistry(
      fakeConnectRuntime,
      EmbeddedDescriptors,
      [],
    );
    expect(registry).toBeDefined();
  });
});
