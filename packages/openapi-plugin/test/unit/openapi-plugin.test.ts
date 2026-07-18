/**
 * Tests for OpenApiPlugin.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IApplication, IPluginContext } from '@hono-enterprise/common';
import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import { Router } from '@hono-enterprise/kernel';

describe('OpenApiPlugin', () => {
  let ctx: IPluginContext;
  let router: Router;

  beforeEach(() => {
    router = new Router();
    const serviceRegistry = {
      register: () => {},
      registerFactory: () => {},
      get: () => {
        throw new Error('not implemented');
      },
      getAll: () => [],
      has: () => false,
      unregister: () => {},
    };

    ctx = {
      services: serviceRegistry,
      middleware: {
        add: () => {},
      },
      router,
      environment: {
        validate: () => {},
      },
      health: {
        register: () => {},
      },
      metrics: {
        register: () => {},
      },
      lifecycle: {
        onInit: () => {},
        onShutdown: () => {},
      },
      runtime: {
        now: () => 0,
        hrtime: () => 0,
        platform: () => 'node',
        version: () => '18.0.0',
        hostname: () => 'localhost',
        uuid: () => 'test-uuid',
        randomBytes: () => new Uint8Array(32),
        subtle: {} as Crypto['subtle'],
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
        setInterval: globalThis.setInterval.bind(globalThis),
        clearInterval: globalThis.clearInterval.bind(globalThis),
        env: {},
        exit: (() => {
          throw new Error('exit called');
        }) as () => never,
        fs: {} as IPluginContext['runtime']['fs'],
      },
      app: {
        router,
        services: serviceRegistry,
        middleware: {
          add: () => {},
        },
        register: () => {},
        start: async () => {},
        stop: async () => {},
      } as unknown as IApplication,
    } as unknown as IPluginContext;
  });

  it('should return an IPlugin with correct name', () => {
    const plugin = OpenApiPlugin();

    expect(plugin.name).toBe('openapi-plugin');
  });

  it('should provide the openapi capability', () => {
    const plugin = OpenApiPlugin();

    expect(plugin.provides).toContain(CAPABILITIES.OPENAPI);
  });

  it('should register spec endpoint at default path', async () => {
    const plugin = OpenApiPlugin();

    await plugin.register(ctx);

    // Check that the spec route was registered
    const matched = router.match('GET', '/openapi.json');
    expect(matched).not.toBeNull();
  });

  it('should register UI endpoint at default path when swagger is true', async () => {
    const plugin = OpenApiPlugin({ swagger: true });

    await plugin.register(ctx);

    // Check that the UI route was registered
    const matched = router.match('GET', '/docs');
    expect(matched).not.toBeNull();
  });

  it('should not register UI endpoint when swagger is false', async () => {
    const plugin = OpenApiPlugin({ swagger: false });

    await plugin.register(ctx);

    // Check that the UI route was NOT registered
    const matched = router.match('GET', '/docs');
    expect(matched).toBeNull();
  });

  it('should use custom endpoint when provided', async () => {
    const plugin = OpenApiPlugin({
      swagger: true,
      endpoint: '/api-docs',
    });

    await plugin.register(ctx);

    const matched = router.match('GET', '/api-docs');
    expect(matched).not.toBeNull();
  });

  it('should use custom specEndpoint when provided', async () => {
    const plugin = OpenApiPlugin({
      specEndpoint: '/api/spec.json',
    });

    await plugin.register(ctx);

    const matched = router.match('GET', '/api/spec.json');
    expect(matched).not.toBeNull();
  });

  it('should have priority defined', () => {
    const plugin = OpenApiPlugin();

    expect(plugin.priority).toBeDefined();
    expect(typeof plugin.priority).toBe('number');
  });
});
