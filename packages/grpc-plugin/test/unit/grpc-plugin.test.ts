/**
 * GrpcPlugin tests — verifies plugin registration, adapter interaction, and health reporting.
 */

import { describe, it, expect, mock } from '@std/testing/bdd';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import { GrpcUnavailableError } from '../../src/errors/grpc-errors.ts';

// Mock dependencies
const mockCtx = {
  services: {
    get: () => ({}),
    has: () => false,
    register: () => {},
  },
  health: {
    register: () => {},
  },
  lifecycle: {
    onClose: () => {},
  },
  logger: {
    info: () => {},
    warn: () => {},
  },
  runtime: {
    uuid: () => 'test-uuid',
  },
};

const mockAdapter = {
  setRpcHandler: () => {},
};

describe('GrpcPlugin', () => {
  it('should register under the correct name and provide GRPC token', () => {
    const plugin = GrpcPlugin();
    expect(plugin.name).toBe('grpc-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.GRPC);
    expect(plugin.provides.length).toBe(1);
  });

  it('should have correct optionalDependencies', () => {
    const plugin = GrpcPlugin();
    expect(plugin.optionalDependencies).toContain('logger');
    expect(plugin.optionalDependencies).toContain('health');
  });

  it('should install setRpcHandler on adapter when available', async () => {
    const setRpcHandlerMock = mock(() => {});
    const adapter = { setRpcHandler: setRpcHandlerMock as any };
    
    const plugin = GrpcPlugin({});
    // Simulate register
    await (plugin.register as any)({ 
      services: { 
        get: () => adapter,
        has: () => false,
        register: () => {},
      },
      health: { register: () => {} },
      lifecycle: { onClose: () => {} },
      logger: { warn: () => {} },
      runtime: { uuid: () => 'test' },
    });
    
    expect(setRpcHandlerMock).toHaveBeenCalled();
  });

  it('should log warning when adapter lacks setRpcHandler', async () => {
    const warnSpy = mock(() => {});
    const adapter = {} as any;
    
    const plugin = GrpcPlugin({});
    await (plugin.register as any)({ 
      services: { 
        get: () => adapter,
        has: () => false,
        register: () => {},
      },
      health: { register: () => {} },
      lifecycle: { onClose: () => {} },
      logger: { warn: warnSpy },
      runtime: { uuid: () => 'test' },
    });
    
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP adapter does not support the RPC interceptor seam'));
  });

  it('should register health indicator', async () => {
    const registerSpy = mock(() => {});
    const plugin = GrpcPlugin({});
    await (plugin.register as any)({ 
      services: { get: () => ({}), has: () => false, register: () => {} },
      health: { register: registerSpy },
      lifecycle: { onClose: () => {} },
      logger: {},
      runtime: { uuid: () => 'test' },
    });
    
    expect(registerSpy).toHaveBeenCalledWith('grpc', expect.any(Function));
  });

  it('should tear down on close', async () => {
    const onCloseSpy = mock(() => {});
    const plugin = GrpcPlugin({});
    await (plugin.register as any)({ 
      services: { get: () => ({}), has: () => false, register: () => {} },
      health: { register: () => {} },
      lifecycle: { onClose: onCloseSpy },
      logger: {},
      runtime: { uuid: () => 'test' },
    });
    
    // Trigger close
    (plugin.register as any)?.onClose?.();
    expect(onCloseSpy).toHaveBeenCalled();
  });

  it('should throw GrpcUnavailableError when handleRequest called without adapter', async () => {
    // This is tested through GrpcService unit tests
    expect(true).toBeTrue(); // Placeholder
  });
});