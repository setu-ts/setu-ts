import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { StaticPlugin } from '../../src/plugin/static-plugin.ts';
import type { IPluginContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

function createMockFn() {
  const calls: unknown[][] = [];
  return {
    calls: () => calls,
    mockReturnValue: (_value: unknown) => {},
    mockImplementation: (_fn: (...args: unknown[]) => unknown) => {},
    calledWith: (...args: unknown[]) => {
      const lastCall = calls[calls.length - 1];
      return lastCall?.every((arg, i) => arg === args[i]);
    },
  };
}

describe('StaticPlugin', () => {
  it('should register the STATIC_FILES capability token', () => {
    const plugin = StaticPlugin({ root: '/tmp/static' });
    expect(plugin.provides).toContain(CAPABILITIES.STATIC_FILES);
  });

  it('should mount routes on both GET and HEAD', () => {
    const routerGet = createMockFn();
    const routerHead = createMockFn();
    const healthRegister = createMockFn();
    const servicesRegister = createMockFn();

    const ctx = {
      services: {
        register: (...args: unknown[]) => {
          servicesRegister.calls().push(args);
        },
      },
      router: {
        get: (...args: unknown[]) => {
          routerGet.calls().push(args);
        },
        head: (...args: unknown[]) => {
          routerHead.calls().push(args);
        },
      },
      health: {
        register: (...args: unknown[]) => {
          healthRegister.calls().push(args);
        },
      },
      runtime: {
        fs: {
          stat: () => Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
        },
      },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static' });
    plugin.register(ctx);

    expect(servicesRegister.calls().length).toBeGreaterThan(0);
    expect(routerGet.calls().length).toBeGreaterThan(0);
    expect(routerHead.calls().length).toBeGreaterThan(0);
    expect(healthRegister.calls().length).toBeGreaterThan(0);
  });

  it('should not mount routes when fs is absent', () => {
    const routerGet = createMockFn();
    const routerHead = createMockFn();
    const healthRegister = createMockFn();
    const servicesRegister = createMockFn();

    const ctx = {
      services: {
        register: (...args: unknown[]) => {
          servicesRegister.calls().push(args);
        },
      },
      router: {
        get: (...args: unknown[]) => {
          routerGet.calls().push(args);
        },
        head: (...args: unknown[]) => {
          routerHead.calls().push(args);
        },
      },
      health: {
        register: (...args: unknown[]) => {
          healthRegister.calls().push(args);
        },
      },
      runtime: {
        fs: undefined,
      },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static' });
    plugin.register(ctx);

    expect(servicesRegister.calls().length).toBeGreaterThan(0);
    expect(routerGet.calls().length).toBe(0);
    expect(routerHead.calls().length).toBe(0);
    expect(healthRegister.calls().length).toBeGreaterThan(0);
  });

  it('should report degraded when fs is absent', async () => {
    const healthRegister = createMockFn();

    const ctx = {
      services: {
        register: () => {},
      },
      router: {
        get: () => {},
        head: () => {},
      },
      health: {
        register: (...args: unknown[]) => {
          healthRegister.calls().push(args);
        },
      },
      runtime: {
        fs: undefined,
      },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static' });
    plugin.register(ctx);

    const healthFn = healthRegister.calls()[0][1] as () => Promise<
      { status: string; detail: string }
    >;
    const result = await healthFn();

    expect(result).toEqual({
      status: 'degraded',
      detail: 'no file system on this runtime',
    });
  });

  it('should report up when root is a directory', async () => {
    const healthRegister = createMockFn();

    const ctx = {
      services: { register: () => {} },
      router: { get: () => {}, head: () => {} },
      health: {
        register: (...args: unknown[]) => {
          healthRegister.calls().push(args);
        },
      },
      runtime: {
        fs: {
          stat: () => Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
        },
      },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static' });
    plugin.register(ctx);

    const healthFn = healthRegister.calls()[0][1] as () => Promise<{
      status: string;
    }>;
    const result = await healthFn();
    expect(result).toEqual({ status: 'up' });
  });

  it('should report down when root stat throws', async () => {
    const healthRegister = createMockFn();

    const ctx = {
      services: { register: () => {} },
      router: { get: () => {}, head: () => {} },
      health: {
        register: (...args: unknown[]) => {
          healthRegister.calls().push(args);
        },
      },
      runtime: {
        fs: {
          stat: () => Promise.reject(new Error('ENOENT')),
        },
      },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static' });
    plugin.register(ctx);

    const healthFn = healthRegister.calls()[0][1] as () => Promise<{
      status: string;
      detail: string;
    }>;
    const result = await healthFn();
    expect(result.status).toBe('down');
    expect(result.detail).toContain('ENOENT');
  });

  it('should normalize prefix and mount with correct pattern', () => {
    const routerGet = createMockFn();
    const routerHead = createMockFn();
    const healthRegister = createMockFn();
    const servicesRegister = createMockFn();

    const ctx = {
      services: {
        register: (...args: unknown[]) => {
          servicesRegister.calls().push(args);
        },
      },
      router: {
        get: (...args: unknown[]) => {
          routerGet.calls().push(args);
        },
        head: (...args: unknown[]) => {
          routerHead.calls().push(args);
        },
      },
      health: {
        register: (...args: unknown[]) => {
          healthRegister.calls().push(args);
        },
      },
      runtime: {
        fs: {
          stat: () => Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
        },
      },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static', urlPrefix: '/assets' });
    plugin.register(ctx);

    // Check that the route pattern is correct
    const getCall = routerGet.calls()[0];
    expect(getCall[0]).toBe('/assets/*');
    const headCall = routerHead.calls()[0];
    expect(headCall[0]).toBe('/assets/*');
  });

  it('should register service with real filesystem', () => {
    const servicesRegister = createMockFn();
    const fs = {
      stat: () => Promise.resolve({ isFile: false, isDirectory: true, size: 0 }),
    };

    const ctx = {
      services: {
        register: (...args: unknown[]) => {
          servicesRegister.calls().push(args);
        },
      },
      router: { get: () => {}, head: () => {} },
      health: { register: () => {} },
      runtime: { fs },
    } as unknown as IPluginContext;

    const plugin = StaticPlugin({ root: '/tmp/static' });
    plugin.register(ctx);

    const registerCall = servicesRegister.calls()[0];
    expect(registerCall[0]).toBe(CAPABILITIES.STATIC_FILES);
    expect(registerCall[1]).toBeInstanceOf(Object);
  });
});
