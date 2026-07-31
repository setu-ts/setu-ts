/**
 * Barrel export test — verifies that all expected symbols are exported from
 * `src/index.ts`.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  adaptConnectModule,
  CAPABILITIES,
  GrpcPlugin,
  type GrpcPluginOptions,
  GrpcRuntimeLoadError,
  GrpcService,
  GrpcUnavailableError,
  type IGrpcService,
  type RpcFetchHandler,
} from '../../src/index.ts';

describe('BarrelExports', () => {
  it('should export GrpcPlugin factory', () => {
    expect(GrpcPlugin).not.toBeNull();
    expect(typeof GrpcPlugin).toBe('function');
  });

  it('should export GrpcService class', () => {
    expect(GrpcService).not.toBeNull();
    expect(typeof GrpcService).toBe('class');
  });

  it('should export adaptConnectModule function', () => {
    expect(adaptConnectModule).not.toBeNull();
    expect(typeof adaptConnectModule).toBe('function');
  });

  it('should export GrpcUnavailableError class', () => {
    expect(GrpcUnavailableError).not.toBeNull();
    expect(() => new GrpcUnavailableError()).not.toThrow();
  });

  it('should export GrpcRuntimeLoadError class', () => {
    expect(GrpcRuntimeLoadError).not.toBeNull();
    expect(() => new GrpcRuntimeLoadError('spec', 'cmd')).not.toThrow();
  });

  it('should export GrpcPluginOptions type (checked via usage)', () => {
    // Type check is done at compile time; runtime check just ensures module loads
    const options: GrpcPluginOptions = {};
    expect(options).toBeDefined();
  });

  it('should export IGrpcService type (checked via usage)', () => {
    // This is a structural check — the import above already verifies it's exported
    const _: IGrpcService = undefined as any;
    expect(true).toBeTrue();
  });

  it('should export RpcFetchHandler type (checked via usage)', () => {
    const _: RpcFetchHandler = undefined as any;
    expect(true).toBeTrue();
  });

  it('should export CAPABILITIES from common (re-exported)', () => {
    expect(CAPABILITIES).toBeDefined();
    expect(CAPABILITIES.GRPC).toBe('grpc');
  });
});
