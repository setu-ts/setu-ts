/**
 * GrpcPlugin tests — verifies plugin registration, adapter interaction, and health reporting.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';

describe('GrpcPlugin', () => {
  it('should register under the correct name and provide GRPC token', () => {
    const plugin = GrpcPlugin();
    expect(plugin.name).toBe('grpc-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.GRPC);
  });

  it('should have correct optionalDependencies', () => {
    const plugin = GrpcPlugin();
    expect(plugin.optionalDependencies).toContain('logger');
    expect(plugin.optionalDependencies).toContain('health');
  });

  it('should default to NORMAL priority', () => {
    const plugin = GrpcPlugin();
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });

  it('should accept custom options', () => {
    const plugin = GrpcPlugin({
      basePath: '/custom-grpc',
      reflection: false,
      health: false,
    });
    expect(plugin.name).toBe('grpc-plugin');
  });

  it('register should produce an async function', () => {
    const plugin = GrpcPlugin();
    expect(typeof plugin.register).toBe('function');
    // The register method is async; we just verify it exists
    expect(plugin.register).toBeDefined();
  });

  it('register should warn when adapter lacks setRpcHandler', async () => {
    const warnLogs: string[] = [];
    const mockContext = {
      services: {
        get: () => ({
          setHandler: () => {},
          fetch: () => {},
          listen: () => {},
          close: () => {},
          // No setRpcHandler
        }),
        register: () => {},
      },
      logger: {
        warn: (msg: string) => warnLogs.push(msg),
      },
      health: {
        register: () => {},
      },
      lifecycle: {
        onClose: () => {},
      },
    } as unknown as import('@hono-enterprise/common').IPluginContext;

    const plugin = GrpcPlugin();
    await plugin.register(mockContext);

    expect(warnLogs.length).toBe(1);
    expect(warnLogs[0]).toContain('RPC interceptor seam');
  });

  it('register should register health indicator', async () => {
    const registeredIndicators: Array<{ name: string; fn: () => Promise<unknown> }> = [];
    const mockContext = {
      services: {
        get: () => ({
          setHandler: () => {},
          fetch: () => {},
          listen: () => {},
          close: () => {},
          setRpcHandler: () => {},
        }),
        register: () => {},
      },
      logger: {
        warn: () => {},
      },
      health: {
        register: (name: string, fn: () => Promise<unknown>) => {
          registeredIndicators.push({ name, fn });
        },
      },
      lifecycle: {
        onClose: () => {},
      },
    } as unknown as import('@hono-enterprise/common').IPluginContext;

    const plugin = GrpcPlugin();
    await plugin.register(mockContext);

    expect(registeredIndicators.length).toBe(1);
    expect(registeredIndicators[0].name).toBe('grpc');
    const result = (await registeredIndicators[0].fn()) as {
      status: string;
      data: { available: boolean };
    };
    expect(result.status).toBe('up');
    expect(result.data.available).toBe(true);
  });

  it('register should call setRpcHandler when adapter supports it', async () => {
    let rpcHandler: ((request: Request) => Promise<Response | null>) | null = null;
    const mockContext = {
      services: {
        get: () => ({
          setHandler: () => {},
          fetch: () => {},
          listen: () => {},
          close: () => {},
          setRpcHandler: (handler: (request: Request) => Promise<Response | null>) => {
            rpcHandler = handler;
          },
        }),
        register: () => {},
      },
      logger: {
        warn: () => {},
      },
      health: {
        register: () => {},
      },
      lifecycle: {
        onClose: () => {},
      },
    } as unknown as import('@hono-enterprise/common').IPluginContext;

    const plugin = GrpcPlugin();
    await plugin.register(mockContext);

    expect(rpcHandler).toBeDefined();
    expect(typeof rpcHandler).toBe('function');
  });

  it('register should use custom connectModule from options', async () => {
    const customRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => customRuntime,
      loadConnectModule: () => Promise.resolve(customRuntime),
      reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
      getService: () => undefined,
    };
    const rpcHandlers: Array<(request: Request) => Promise<Response | null>> = [];
    const mockContext = {
      services: {
        get: () => ({
          setHandler: () => {},
          fetch: () => {},
          listen: () => {},
          close: () => {},
          setRpcHandler: (handler: (request: Request) => Promise<Response | null>) => {
            rpcHandlers.push(handler);
          },
        }),
        register: () => {},
      },
      logger: {
        warn: () => {},
      },
      health: {
        register: () => {},
      },
      lifecycle: {
        onClose: () => {},
      },
    } as unknown as import('@hono-enterprise/common').IPluginContext;

    const plugin = GrpcPlugin({ connectModule: customRuntime as never });
    await plugin.register(mockContext);

    expect(rpcHandlers.length).toBe(1);
  });

  it('register should pass options to GrpcService', async () => {
    const customRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => customRuntime,
      loadConnectModule: () => Promise.resolve(customRuntime),
      reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
      getService: () => undefined,
    };
    const registeredServices: Array<{ token: string; service: unknown }> = [];
    const mockContext = {
      services: {
        get: () => ({
          setHandler: () => {},
          fetch: () => {},
          listen: () => {},
          close: () => {},
          setRpcHandler: () => {},
        }),
        register: (token: string, service: unknown) => {
          registeredServices.push({ token, service });
        },
      },
      logger: {
        warn: () => {},
      },
      health: {
        register: () => {},
      },
      lifecycle: {
        onClose: () => {},
      },
    } as unknown as import('@hono-enterprise/common').IPluginContext;

    const plugin = GrpcPlugin({
      basePath: '/custom',
      reflection: false,
      health: false,
      connectModule: customRuntime as never,
    });
    await plugin.register(mockContext);

    expect(registeredServices.length).toBe(1);
    expect(registeredServices[0].token).toBe('grpc');
  });

  it('register should call lifecycle.onClose', async () => {
    const customRuntime = {
      createConnectRouter: () => ({ handlers: [], service: () => {} }),
      createFetchHandler: () => () => Promise.resolve(new Response('Not Found', { status: 404 })),
      adaptConnectModule: () => customRuntime,
      loadConnectModule: () => Promise.resolve(customRuntime),
      reviveDescriptorSet: () => ({ files: [], getService: () => undefined, listServices: [] }),
      getService: () => undefined,
    };
    const onCloseCalls: Array<() => void> = [];
    const mockContext = {
      services: {
        get: () => ({
          setHandler: () => {},
          fetch: () => {},
          listen: () => {},
          close: () => {},
          setRpcHandler: () => {},
        }),
        register: () => {},
      },
      logger: {
        warn: () => {},
      },
      health: {
        register: () => {},
      },
      lifecycle: {
        onClose: (fn: () => void) => {
          onCloseCalls.push(fn);
        },
      },
    } as unknown as import('@hono-enterprise/common').IPluginContext;

    const plugin = GrpcPlugin({ connectModule: customRuntime as never });
    await plugin.register(mockContext);

    expect(onCloseCalls.length).toBe(1);
  });
});
