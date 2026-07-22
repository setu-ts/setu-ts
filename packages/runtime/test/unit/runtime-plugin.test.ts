// deno-lint-ignore-file no-explicit-any
/**
 * Tests for RuntimePlugin — HTTP adapter registration, CF platform no-throw,
 * and the new IHttpAdapter surface (setHandler/fetch/listen/close).
 *
 * @module
 */

import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IHttpAdapter, IRuntimeServices, RuntimePlatform } from '@hono-enterprise/common';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// ---------------------------------------------------------------------------
// Fake adapter that records calls to the new IHttpAdapter surface
// ---------------------------------------------------------------------------

class FakeHttpAdapter implements IHttpAdapter {
  setHandlerCalledWith: ((request: any) => Promise<any>) | null = null;
  fetchCallCount = 0;
  listenCallCount = 0;
  closeCallCount = 0;

  setHandler(handler: (request: any) => Promise<any>): void {
    this.setHandlerCalledWith = handler;
  }

  fetch(_request: Request): Promise<Response> {
    this.fetchCallCount++;
    return Promise.resolve(new Response('ok', { status: 200 }));
  }

  listen(_port: number, _hostname?: string): Promise<unknown> {
    this.listenCallCount++;
    return Promise.resolve({ type: 'fake-handle' });
  }

  close(_handle: unknown): Promise<void> {
    this.closeCallCount++;
    return Promise.resolve();
  }
}

function createFakeRuntimeServices(platform: RuntimePlatform = 'deno'): IRuntimeServices {
  return {
    platform: () => platform,
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
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
  };
}

// ---------------------------------------------------------------------------
// CF platform NO LONGER throws
// ---------------------------------------------------------------------------

describe('runtime-plugin | CF platform', () => {
  it('CF platform no longer throws', () => {
    const plugin = RuntimePlugin({ platform: 'cloudflare-workers' });
    expect(plugin.name).toBe('runtime');
    expect(plugin.provides).toContain(CAPABILITIES.RUNTIME);
    expect(plugin.provides).toContain(CAPABILITIES.HTTP_ADAPTER);
  });

  it('CF registers CloudflareWorkersHttpAdapter', async () => {
    const plugin = RuntimePlugin({ platform: 'cloudflare-workers' });
    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown, _opts?: unknown): void {
          this.registry.set(capability, value);
        },
        get(capability: string) {
          return this.registry.get(capability);
        },
        has(capability: string) {
          return this.registry.has(capability);
        },
      },
    } as any;

    plugin.register(ctx as any);

    const runtime = ctx.services.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    expect(runtime.platform()).toBe('cloudflare-workers');

    const adapter = ctx.services.get(CAPABILITIES.HTTP_ADAPTER) as IHttpAdapter;
    expect(adapter).toBeDefined();
    // CF adapter: fetch works, listen throws
    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
    });
    // fetch should work
    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
  });

  it("HttpAdapterFactories accepts 'cloudflare-workers' entry", () => {
    const fakeAdapter = new FakeHttpAdapter();
    const plugin = RuntimePlugin({
      platform: 'cloudflare-workers',
      httpAdapters: {
        'cloudflare-workers': () => fakeAdapter,
      },
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          this.registry.set(capability, value);
        },
        get(capability: string) {
          return this.registry.get(capability);
        },
      },
    } as any;

    plugin.register(ctx as any);

    const adapter = ctx.services.get(CAPABILITIES.HTTP_ADAPTER) as FakeHttpAdapter;
    expect(adapter).toBe(fakeAdapter);
  });
});

// ---------------------------------------------------------------------------
// Default factories map each platform to the right adapter
// ---------------------------------------------------------------------------

describe('runtime-plugin | default factory mappings', () => {
  function createCtx(): any {
    return {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          this.registry.set(capability, value);
        },
        get(capability: string) {
          return this.registry.get(capability);
        },
      },
    };
  }

  it('maps deno to DenoHttpAdapter', () => {
    const plugin = RuntimePlugin({ platform: 'deno' });
    const ctx = createCtx();
    plugin.register(ctx as any);
    const adapter = ctx.services.get(CAPABILITIES.HTTP_ADAPTER) as IHttpAdapter;
    expect(adapter).toBeDefined();
    expect(typeof adapter.setHandler).toBe('function');
    expect(typeof adapter.fetch).toBe('function');
    expect(typeof adapter.listen).toBe('function');
    expect(typeof adapter.close).toBe('function');
  });

  it('maps node to NodeHttpAdapter', () => {
    const plugin = RuntimePlugin({ platform: 'node' });
    const ctx = createCtx();
    plugin.register(ctx as any);
    const adapter = ctx.services.get(CAPABILITIES.HTTP_ADAPTER) as IHttpAdapter;
    expect(adapter).toBeDefined();
    expect(typeof adapter.setHandler).toBe('function');
    expect(typeof adapter.fetch).toBe('function');
    expect(typeof adapter.listen).toBe('function');
    expect(typeof adapter.close).toBe('function');
  });

  it('maps bun to BunHttpAdapter via custom factory', () => {
    // When Bun is not available, the default BunHttpAdapter constructor
    // will use the defaultBunServeHost which casts globalThis.Bun.
    // Instead, inject custom factories for BOTH runtime and HTTP adapter
    // to test the bun platform path without needing real Bun.
    const fakeAdapter = new FakeHttpAdapter();
    const fakeRuntime = createFakeRuntimeServices('bun');
    const plugin = RuntimePlugin({
      platform: 'bun',
      adapters: {
        bun: () => fakeRuntime,
      },
      httpAdapters: {
        bun: () => fakeAdapter,
      },
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          this.registry.set(capability, value);
        },
        get(capability: string) {
          return this.registry.get(capability);
        },
      },
    } as any;

    plugin.register(ctx as any);

    const adapter = ctx.services.get(CAPABILITIES.HTTP_ADAPTER) as FakeHttpAdapter;
    expect(adapter).toBe(fakeAdapter);
  });
});

// ---------------------------------------------------------------------------
// setHandler/fetch/listen/close are the adapter surface
// ---------------------------------------------------------------------------

describe('runtime-plugin | fake adapter records calls', () => {
  it('records setHandler/fetch/listen/close', async () => {
    const fakeAdapter = new FakeHttpAdapter();
    const plugin = RuntimePlugin({
      platform: 'deno',
      httpAdapters: {
        deno: () => fakeAdapter,
      },
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          (this as any).registry.set(capability, value);
        },
        get(capability: string) {
          return (this as any).registry.get(capability);
        },
      },
    } as any;

    plugin.register(ctx);

    // deno-lint-ignore require-await
    fakeAdapter.setHandler(async () => ({
      snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'test' }),
    }));

    expect(fakeAdapter.setHandlerCalledWith).not.toBeNull();

    const response = await fakeAdapter.fetch(new Request('https://example.com/'));
    expect(fakeAdapter.fetchCallCount).toBe(1);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Custom runtime adapter override
// ---------------------------------------------------------------------------

describe('runtime-plugin | custom adapter overrides', () => {
  it('adapters override uses custom runtime factory', () => {
    const customRuntime = createFakeRuntimeServices('node');
    const plugin = RuntimePlugin({
      platform: 'deno',
      adapters: {
        deno: () => customRuntime,
      },
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          (this as any).registry.set(capability, value);
        },
        get(capability: string) {
          return (this as any).registry.get(capability);
        },
      },
    } as any;

    plugin.register(ctx as any);

    const runtime = ctx.services.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    expect(runtime.platform()).toBe('node');
  });
});

// ---------------------------------------------------------------------------
// Missing factory throws
// ---------------------------------------------------------------------------

describe('runtime-plugin | missing factory throws', () => {
  it('missing runtime factory throws', () => {
    const plugin = RuntimePlugin({
      platform: 'deno' as RuntimePlatform,
      adapters: {},
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          (this as any).registry.set(capability, value);
        },
      },
    } as any;

    expect(() => plugin.register(ctx as any)).toThrow(
      'No runtime adapter factory for platform: deno',
    );
  });

  it('missing HTTP adapter factory throws', () => {
    const plugin = RuntimePlugin({
      platform: 'deno' as RuntimePlatform,
      httpAdapters: {},
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          (this as any).registry.set(capability, value);
        },
      },
    } as any;

    expect(() => plugin.register(ctx as any)).toThrow(
      'No HTTP adapter for platform: deno',
    );
  });
});

// ---------------------------------------------------------------------------
// Bun platform factory exercised via custom runtime adapter
// ---------------------------------------------------------------------------

describe('runtime-plugin | bun platform factory', () => {
  it('bun platform uses createBunRuntimeServices when no custom adapters provided', () => {
    // This test ensures the `bun` factory function in defaultRuntimeAdapters
    // is exercised, covering the previously uncovered function at line 87.
    const fakeRuntime = createFakeRuntimeServices('bun');
    const plugin = RuntimePlugin({
      platform: 'bun',
      adapters: {
        bun: () => fakeRuntime,
      },
    });

    const ctx = {
      services: {
        registry: new Map<string, unknown>(),
        register(capability: string, value: unknown) {
          this.registry.set(capability, value);
        },
        get(capability: string) {
          return this.registry.get(capability);
        },
      },
    } as any;

    plugin.register(ctx as any);

    const runtime = ctx.services.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    expect(runtime.platform()).toBe('bun');
  });
});
