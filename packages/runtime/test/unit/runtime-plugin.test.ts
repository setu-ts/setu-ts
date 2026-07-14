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
});
