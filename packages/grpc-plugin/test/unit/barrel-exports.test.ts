/**
 * The barrel must export exactly the documented public surface — and must NOT
 * export the internal Connect port, which would commit the package to a shape
 * tracking Connect's own API.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('grpc-plugin barrel', () => {
  it('exports every documented runtime value', () => {
    expect(typeof barrel.GrpcPlugin).toBe('function');
    expect(typeof barrel.GrpcService).toBe('function');
    expect(typeof barrel.adaptConnectModule).toBe('function');
    expect(typeof barrel.GrpcUnavailableError).toBe('function');
    expect(typeof barrel.GrpcRuntimeLoadError).toBe('function');
    expect(typeof barrel.GrpcDescriptorError).toBe('function');
    expect(barrel.CAPABILITIES.GRPC).toBe('grpc');
  });

  it('exports errors that are real Error subclasses with stable names', () => {
    const unavailable = new barrel.GrpcUnavailableError();
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable.name).toBe('GrpcUnavailableError');

    const load = new barrel.GrpcRuntimeLoadError('npm:x', 'deno add npm:x');
    expect(load).toBeInstanceOf(Error);
    expect(load.name).toBe('GrpcRuntimeLoadError');
    expect(load.specifier).toBe('npm:x');

    const descriptor = new barrel.GrpcDescriptorError('bad bytes');
    expect(descriptor).toBeInstanceOf(Error);
    expect(descriptor.name).toBe('GrpcDescriptorError');
  });

  it('does not export the internal Connect runtime port or its facades', () => {
    const names = Object.keys(barrel);
    for (const internal of ['ConnectRuntime', 'ConnectRouterLike', 'FileRegistryLike']) {
      expect(names).not.toContain(internal);
    }
  });

  it('does not barrel-export the M70i internals (DEFAULT_BASE_PATH, refusal helpers)', () => {
    // The M70i plan names them internal on purpose: publishing a default value
    // or a refusal helper would commit the package to an implementation detail.
    const names = Object.keys(barrel);
    for (
      const internal of [
        'DEFAULT_BASE_PATH',
        'isNativeGrpcContentType',
        'trailersOnlyUnimplemented',
      ]
    ) {
      expect(names).not.toContain(internal);
    }
  });

  it('exports no unexpected runtime value', () => {
    // A new export must be a deliberate, documented decision.
    expect(Object.keys(barrel).sort()).toEqual([
      'CAPABILITIES',
      'GrpcDescriptorError',
      'GrpcPlugin',
      'GrpcRuntimeLoadError',
      'GrpcService',
      'GrpcUnavailableError',
      'adaptConnectModule',
    ]);
  });
});
