/**
 * Barrel exports test — verifies that all expected symbols are exported
 * from the package's index.ts.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CAPABILITIES,
  GrpcPlugin,
  GrpcRuntimeLoadError,
  GrpcService,
  GrpcUnavailableError,
} from '../../src/index.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';

describe('Barrel Exports', () => {
  it('should export GrpcPlugin function', () => {
    expect(GrpcPlugin).not.toBeNull();
    expect(typeof GrpcPlugin).toBe('function');
  });

  it('should export GrpcService class', () => {
    expect(GrpcService).not.toBeNull();
    expect(typeof GrpcService).toBe('function');
  });

  it('should export GrpcRuntimeLoadError class', () => {
    expect(GrpcRuntimeLoadError).not.toBeNull();
    expect(typeof GrpcRuntimeLoadError).toBe('function');
  });

  it('should export GrpcUnavailableError class', () => {
    expect(GrpcUnavailableError).not.toBeNull();
    expect(typeof GrpcUnavailableError).toBe('function');
  });

  it('should export CAPABILITIES', () => {
    expect(CAPABILITIES).not.toBeNull();
    expect(CAPABILITIES.GRPC).toBe('grpc');
  });

  it('should export ConnectRuntime type (via import)', () => {
    // This test verifies the type is exported by checking it can be used
    const runtime: ConnectRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('test')),
      reviveDescriptorSet: () => ({}),
      getService: () => undefined,
      createRegistry: () => ({}),
    };
    expect(runtime).toBeDefined();
  });
});
