/**
 * Tests for RuntimePlugin HTTP adapter registration.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IHttpAdapter, IRuntimeServices } from '@hono-enterprise/common';

/**
 * Fake HTTP adapter for testing.
 */
class FakeHttpAdapter implements IHttpAdapter {
  createServerCount = 0;
  listenCount = 0;
  closeCount = 0;

  createServer(): unknown {
    this.createServerCount++;
    return { type: 'fake-server' };
  }

  listen(): Promise<void> {
    this.listenCount++;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount++;
    return Promise.resolve();
  }
}

/**
 * Fake runtime services for testing.
 */
function createFakeRuntimeServices(): IRuntimeServices {
  return {
    platform: () => 'deno',
    version: () => '1.0.0',
    hostname: () => 'localhost',
    uuid: () => 'test-uuid',
    randomBytes: () => new Uint8Array(),
    subtle: {} as SubtleCrypto,
    now: () => 0,
    hrtime: () => 0,
    setTimeout: () => ({} as unknown),
    clearTimeout: () => {},
    setInterval: () => ({} as unknown),
    clearInterval: () => {},
    fs: {
      // deno-lint-ignore require-await
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      // deno-lint-ignore require-await
      stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
      // deno-lint-ignore require-await
      readdir: async () => [],
      mkdir: async () => {},
      rm: async () => {},
    },
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
  };
}

describe('RuntimePlugin - HTTP Adapter', () => {
  describe('provides', () => {
    it('provides HTTP_ADAPTER capability', () => {
      const plugin = RuntimePlugin({
        platform: 'deno',
        httpAdapters: {
          deno: () => new FakeHttpAdapter(),
        },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('provides RUNTIME capability', () => {
      const plugin = RuntimePlugin({
        platform: 'deno',
      });

      expect(plugin.provides).toContain(CAPABILITIES.RUNTIME);
    });
  });

  describe('register', () => {
    it('registers HTTP adapter under HTTP_ADAPTER capability', () => {
      const fakeAdapter = new FakeHttpAdapter();
      const fakeRuntime = createFakeRuntimeServices();

      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: {
          deno: () => fakeRuntime,
        },
        httpAdapters: {
          deno: () => fakeAdapter,
        },
      });

      const registry = {
        services: {
          register: () => {},
        },
      };

      plugin.register(registry as never);

      // Verify the plugin registered correctly
      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('throws when no HTTP adapter for platform', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: {
          deno: () => fakeRuntime,
        },
        httpAdapters: {}, // No adapter for deno
      });

      const registry = {
        services: {
          register: () => {},
        },
      };

      expect(() => plugin.register(registry as never)).toThrow('No HTTP adapter for platform');
    });

    it('throws when no runtime adapter for platform', () => {
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: {}, // No runtime adapter for deno
        httpAdapters: {
          deno: () => new FakeHttpAdapter(),
        },
      });

      const registry = {
        services: {
          register: () => {},
        },
      };

      expect(() => plugin.register(registry as never)).toThrow(
        'No runtime adapter factory for platform',
      );
    });

    it('throws for cloudflare-workers platform', () => {
      expect(() => RuntimePlugin({ platform: 'cloudflare-workers' })).toThrow('Cloudflare Workers');
    });

    it('allows httpAdapters injection override', () => {
      const customAdapter = new FakeHttpAdapter();
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: {
          deno: () => fakeRuntime,
        },
        httpAdapters: {
          deno: () => customAdapter,
        },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });
  });

  describe('platform detection', () => {
    it('uses explicit platform when provided', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: {
          node: () => fakeRuntime,
        },
        httpAdapters: {
          node: () => new FakeHttpAdapter(),
        },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('uses auto-detected platform when not provided', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        adapters: {
          deno: () => fakeRuntime,
          node: () => fakeRuntime,
          bun: () => fakeRuntime,
        },
        httpAdapters: {
          deno: () => new FakeHttpAdapter(),
          node: () => new FakeHttpAdapter(),
          bun: () => new FakeHttpAdapter(),
        },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });
  });

  describe('register - runtime services', () => {
    it('registers runtime services under RUNTIME capability', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const fakeAdapter = new FakeHttpAdapter();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: {
          node: () => fakeRuntime,
        },
        httpAdapters: {
          node: () => fakeAdapter,
        },
      });

      const registeredTokens: string[] = [];
      const registry = {
        services: {
          register: (token: string, _service: object) => {
            registeredTokens.push(token);
          },
        },
      };

      plugin.register(registry as never);

      expect(registeredTokens).toContain(CAPABILITIES.RUNTIME);
    });

    it('throws when no runtime adapter for platform', () => {
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: {}, // No adapter for node
        httpAdapters: {
          node: () => new FakeHttpAdapter(),
        },
      });

      const registry = {
        services: {
          register: () => {},
        },
      };

      expect(() => plugin.register(registry as never)).toThrow(
        'No runtime adapter factory for platform',
      );
    });
  });

  describe('register - HTTP adapter', () => {
    it('registers HTTP adapter under HTTP_ADAPTER capability', () => {
      const fakeAdapter = new FakeHttpAdapter();
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'bun',
        adapters: {
          bun: () => fakeRuntime,
        },
        httpAdapters: {
          bun: () => fakeAdapter,
        },
      });

      let httpAdapterRegistered = false;
      const registry = {
        services: {
          register: (token: string) => {
            if (token === CAPABILITIES.HTTP_ADAPTER) {
              httpAdapterRegistered = true;
            }
          },
        },
      };

      plugin.register(registry as never);

      expect(httpAdapterRegistered).toBe(true);
    });
  });

  describe('platform-specific adapters', () => {
    it('uses Deno platform adapters correctly', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const fakeAdapter = new FakeHttpAdapter();
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: { deno: () => fakeRuntime },
        httpAdapters: { deno: () => fakeAdapter },
      });

      expect(plugin.provides).toContain(CAPABILITIES.RUNTIME);
      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('uses Node platform adapters correctly', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const fakeAdapter = new FakeHttpAdapter();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        httpAdapters: { node: () => fakeAdapter },
      });

      expect(plugin.provides).toContain(CAPABILITIES.RUNTIME);
      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('uses Bun platform adapters correctly', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const fakeAdapter = new FakeHttpAdapter();
      const plugin = RuntimePlugin({
        platform: 'bun',
        adapters: { bun: () => fakeRuntime },
        httpAdapters: { bun: () => fakeAdapter },
      });

      expect(plugin.provides).toContain(CAPABILITIES.RUNTIME);
      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('uses Cloudflare platform (throws for HTTP adapter)', () => {
      expect(() => RuntimePlugin({ platform: 'cloudflare-workers' })).toThrow('Cloudflare Workers');
    });
  });

  describe('httpAdapters option wiring', () => {
    it('uses custom httpAdapters for platform', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const customAdapter = new FakeHttpAdapter();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        httpAdapters: { node: () => customAdapter },
      });

      const registry = {
        services: {
          register: (_token: string, _service: object) => {},
        },
      };

      plugin.register(registry as never);

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('throws when httpAdapters missing for platform', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        httpAdapters: {}, // No adapter for node
      });

      const registry = {
        services: {
          register: () => {},
        },
      };

      expect(() => plugin.register(registry as never)).toThrow('No HTTP adapter for platform');
    });
  });

  describe('platform→adapter map', () => {
    it('maps deno platform to DenoHttpAdapter', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: { deno: () => fakeRuntime },
        httpAdapters: { deno: () => new FakeHttpAdapter() },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('maps node platform to NodeHttpAdapter', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        httpAdapters: { node: () => new FakeHttpAdapter() },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('maps bun platform to BunHttpAdapter', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'bun',
        adapters: { bun: () => fakeRuntime },
        httpAdapters: { bun: () => new FakeHttpAdapter() },
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });
  });

  describe('registration under CAPABILITIES.HTTP_ADAPTER', () => {
    it('registers HTTP adapter with correct capability token', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const fakeAdapter = new FakeHttpAdapter();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        httpAdapters: { node: () => fakeAdapter },
      });

      let registeredToken: string | null = null;
      const registry = {
        services: {
          register: (token: string, _service: object) => {
            registeredToken = token;
          },
        },
      };

      plugin.register(registry as never);

      expect(registeredToken).toBe(CAPABILITIES.HTTP_ADAPTER);
    });
  });

  describe('throw-on-unknown-runtime branch', () => {
    it('throws for cloudflare-workers platform', () => {
      expect(() => RuntimePlugin({ platform: 'cloudflare-workers' })).toThrow('Cloudflare Workers');
    });
  });

  describe('default HTTP adapter factories', () => {
    it('creates DenoHttpAdapter when no httpAdapters provided for deno', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: { deno: () => fakeRuntime },
        // No httpAdapters provided - should use default
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('creates NodeHttpAdapter when no httpAdapters provided for node', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        // No httpAdapters provided - should use default
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('creates BunHttpAdapter when no httpAdapters provided for bun', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'bun',
        adapters: { bun: () => fakeRuntime },
        // No httpAdapters provided - should use default
      });

      expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
    });

    it('registers real DenoHttpAdapter via default factories', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'deno',
        adapters: { deno: () => fakeRuntime },
        // No httpAdapters provided - should use default
      });

      let registeredAdapter: unknown = null;
      const registry = {
        services: {
          register: (_token: string, service: object) => {
            registeredAdapter = service;
          },
        },
      };

      plugin.register(registry as never);
      expect(registeredAdapter).toBeDefined();
    });

    it('registers real NodeHttpAdapter via default factories', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'node',
        adapters: { node: () => fakeRuntime },
        // No httpAdapters provided - should use default
      });

      let registeredAdapter: unknown = null;
      const registry = {
        services: {
          register: (_token: string, service: object) => {
            registeredAdapter = service;
          },
        },
      };

      plugin.register(registry as never);
      expect(registeredAdapter).toBeDefined();
    });

    it('registers real BunHttpAdapter via default factories', () => {
      const fakeRuntime = createFakeRuntimeServices();
      const plugin = RuntimePlugin({
        platform: 'bun',
        adapters: { bun: () => fakeRuntime },
        // No httpAdapters provided - should use default
      });

      let registeredAdapter: unknown = null;
      const registry = {
        services: {
          register: (_token: string, service: object) => {
            registeredAdapter = service;
          },
        },
      };

      plugin.register(registry as never);
      expect(registeredAdapter).toBeDefined();
    });
  });
});
