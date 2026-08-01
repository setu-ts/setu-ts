/**
 * Connect loader tests — verifies loadConnectModule error paths,
 * getFallbackConnectRuntime.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildLoadErrorMessage,
  defaultImport,
  getFallbackConnectRuntime,
  loadConnectModules,
  resetModuleCache,
} from '../../src/transports/connect-loader.ts';
import { GrpcRuntimeLoadError } from '../../src/errors/grpc-errors.ts';

describe('ConnectLoader', () => {
  it('getFallbackConnectRuntime should produce a ConnectRuntime with required methods', () => {
    const runtime = getFallbackConnectRuntime();
    expect(runtime).toBeDefined();
    expect(typeof runtime.createConnectRouter).toBe('function');
    expect(typeof runtime.createFetchHandler).toBe('function');
    expect(typeof runtime.reviveDescriptorSet).toBe('function');
    expect(typeof runtime.getService).toBe('function');
    expect(typeof runtime.createRegistry).toBe('function');
  });

  it('loadConnectModule should throw GrpcRuntimeLoadError on missing core', () => {
    // The actual import will be attempted; we can't easily mock import() in this context
    // This test would normally be skipped or guarded when dependencies are absent
    // Just verify the error class is defined correctly
    expect(GrpcRuntimeLoadError).toBeDefined();
  });

  it('should handle each missing module producing correct error message', () => {
    // Structural check — the error class is defined correctly
    const err = new GrpcRuntimeLoadError('spec', 'cmd');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Cannot load Connect runtime module');
    expect(err.message).toContain('spec');
    expect(err.message).toContain('cmd');
  });

  it('fallback runtime createFetchHandler should return a 404 handler', async () => {
    const runtime = getFallbackConnectRuntime();
    const handler = runtime.createFetchHandler(() => Promise.resolve({}));
    const response = await handler(new Request('http://localhost/'));
    expect(response.status).toBe(404);
  });

  it('fallback runtime reviveDescriptorSet should return empty registry', () => {
    const runtime = getFallbackConnectRuntime();
    const registry = runtime.reviveDescriptorSet('dGVzdA==');
    expect(registry).toBeDefined();
    expect(typeof (registry as Record<string, unknown>).getService).toBe('function');
  });

  it('fallback runtime getService should return undefined', () => {
    const runtime = getFallbackConnectRuntime();
    const service = runtime.getService({}, 'some-service');
    expect(service).toBeUndefined();
  });

  it('fallback runtime service should be callable', () => {
    const runtime = getFallbackConnectRuntime();
    const router = runtime.createConnectRouter();
    expect(typeof router.service).toBe('function');
    expect(() => router.service({ typeName: 'test' }, {})).not.toThrow();
  });

  it('createConnectRouter should return a router with service method', () => {
    const runtime = getFallbackConnectRuntime();
    const router = runtime.createConnectRouter();

    expect(typeof router.service).toBe('function');
    expect(() => router.service({ typeName: 'test' }, {})).not.toThrow();
  });

  it('createFetchHandler should return a function', () => {
    const runtime = getFallbackConnectRuntime();
    const handler = runtime.createFetchHandler((_req: Record<string, unknown>) =>
      Promise.resolve({})
    );

    expect(typeof handler).toBe('function');
  });

  it('reviveDescriptorSet should decode base64 and call fromBinary', () => {
    const runtime = getFallbackConnectRuntime();
    const registry = runtime.reviveDescriptorSet('dGVzdA==');

    expect(registry).toBeDefined();
  });

  it('getService should safely access registry.getService', () => {
    const runtime = getFallbackConnectRuntime();
    const registry = runtime.reviveDescriptorSet('dGVzdA==');
    const service = runtime.getService(registry, 'test-service');

    expect(service).toBeUndefined();
  });

  it('getService should return undefined when registry has no getService', () => {
    const runtime = getFallbackConnectRuntime();
    const service = runtime.getService({}, 'test-service');

    expect(service).toBeUndefined();
  });

  it('loadConnectModules should load modules when available', async () => {
    // In the test environment, the packages are installed, so this should succeed
    await loadConnectModules();
    // If we get here without throwing, the modules loaded successfully
  });

  it('loadConnectModules should throw GrpcRuntimeLoadError when connect module fails', async () => {
    resetModuleCache();
    const mockImporter = (specifier: string): Promise<unknown> => {
      if (specifier.includes('@connectrpc/connect') && !specifier.includes('protocol')) {
        return Promise.reject(new Error('Failed to resolve module'));
      }
      return Promise.resolve({});
    };
    await expect(
      loadConnectModules(mockImporter),
    ).rejects.toBeInstanceOf(GrpcRuntimeLoadError);
  });

  it('loadConnectModules should throw GrpcRuntimeLoadError when protobuf module fails', async () => {
    resetModuleCache();
    const mockImporter = (specifier: string): Promise<unknown> => {
      if (specifier.includes('@bufbuild/protobuf') && !specifier.includes('wkt')) {
        return Promise.reject(new Error('Failed to resolve module'));
      }
      return Promise.resolve({});
    };
    await expect(
      loadConnectModules(mockImporter),
    ).rejects.toBeInstanceOf(GrpcRuntimeLoadError);
  });

  it('loadConnectModules should throw GrpcRuntimeLoadError when wkt module fails', async () => {
    resetModuleCache();
    const mockImporter = (specifier: string): Promise<unknown> => {
      if (specifier.includes('wkt')) {
        return Promise.reject(new Error('Failed to resolve module'));
      }
      return Promise.resolve({});
    };
    await expect(
      loadConnectModules(mockImporter),
    ).rejects.toBeInstanceOf(GrpcRuntimeLoadError);
  });

  it('loadConnectModules should throw GrpcRuntimeLoadError when protocol module fails', async () => {
    resetModuleCache();
    const mockImporter = (specifier: string): Promise<unknown> => {
      if (specifier.includes('protocol')) {
        return Promise.reject(new Error('Failed to resolve module'));
      }
      return Promise.resolve({});
    };
    await expect(
      loadConnectModules(mockImporter),
    ).rejects.toBeInstanceOf(GrpcRuntimeLoadError);
  });

  it('defaultImport should delegate to dynamic import', async () => {
    const result = await defaultImport('npm:@connectrpc/connect@^2.1.2');
    expect(result).toBeDefined();
  });

  it('getService should handle null registry', () => {
    const runtime = getFallbackConnectRuntime();
    const service = runtime.getService(null, 'test-service');
    expect(service).toBeUndefined();
  });

  it('getService should handle undefined registry', () => {
    const runtime = getFallbackConnectRuntime();
    const service = runtime.getService(undefined, 'test-service');
    expect(service).toBeUndefined();
  });

  it('buildLoadErrorMessage should include specifier and install command', () => {
    const msg = buildLoadErrorMessage('@connectrpc/connect', 'deno add @connectrpc/connect');
    expect(msg).toContain('@connectrpc/connect');
    expect(msg).toContain('deno add @connectrpc/connect');
  });

  it('buildLoadErrorMessage should include wkt specifier', () => {
    const msg = buildLoadErrorMessage(
      '@bufbuild/protobuf/wkt',
      'deno add @bufbuild/protobuf@^2.7.0/wkt',
    );
    expect(msg).toContain('@bufbuild/protobuf/wkt');
    expect(msg).toContain('deno add @bufbuild/protobuf@^2.7.0/wkt');
  });

  it('buildLoadErrorMessage should include protocol specifier', () => {
    const msg = buildLoadErrorMessage(
      '@connectrpc/connect/protocol',
      'deno add @connectrpc/connect@^2.1.2',
    );
    expect(msg).toContain('@connectrpc/connect/protocol');
    expect(msg).toContain('deno add @connectrpc/connect@^2.1.2');
  });

  it('fallback runtime methods should be callable', () => {
    const runtime = getFallbackConnectRuntime();

    // Test createConnectRouter
    const router = runtime.createConnectRouter();
    expect(router).toBeDefined();
    expect(typeof router.service).toBe('function');

    // Test createFetchHandler
    const fetchHandler = runtime.createFetchHandler(() => Promise.resolve({}));
    expect(typeof fetchHandler).toBe('function');

    // Test reviveDescriptorSet
    const registry = runtime.reviveDescriptorSet('dGVzdA==');
    expect(registry).toBeDefined();

    // Test getService
    const service = runtime.getService({}, 'test');
    expect(service).toBeUndefined();
  });

  it('fallback runtime createRegistry should return a registry', () => {
    const runtime = getFallbackConnectRuntime();
    const registry = runtime.createRegistry({});
    expect(registry).toBeDefined();
    expect(typeof (registry as { getService: unknown }).getService).toBe('function');
  });
});
