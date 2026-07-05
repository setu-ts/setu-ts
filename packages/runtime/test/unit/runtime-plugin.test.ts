import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';

import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';
import { detectRuntime } from '../../src/detector/runtime-detector.ts';

// Minimal fake service registry for testing register()
function createFakeRegistry() {
  const services = new Map<string, unknown>();
  return {
    register(token: string, service: unknown) {
      services.set(token, service);
    },
    get<T>(token: string): T {
      return services.get(token) as T;
    },
    has(token: string) {
      return services.has(token);
    },
  };
}

function createFakeContext() {
  const registry = createFakeRegistry();
  return {
    services: registry,
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
    },
    lifecycle: {
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as unknown,
  };
}

function createFakeRuntime(platform: 'deno' | 'node' | 'bun'): IRuntimeServices {
  return {
    platform: () => platform,
    version: () => '1.0.0-fake',
    hostname: () => 'fake-host',
    uuid: () => 'fake-uuid',
    randomBytes: (n: number) => new Uint8Array(n),
    subtle: crypto.subtle,
    now: () => 1000,
    hrtime: () => 1,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    env: {},
    exit: () => {
      throw new Error('exit');
    },
  };
}

describe('RuntimePlugin', () => {
  it('has name "runtime"', () => {
    const plugin = RuntimePlugin({ platform: 'deno' });
    expect(plugin.name).toBe('runtime');
  });

  it('has version "0.1.0"', () => {
    const plugin = RuntimePlugin({ platform: 'deno' });
    expect(plugin.version).toBe('0.1.0');
  });

  it('provides CAPABILITIES.RUNTIME', () => {
    const plugin = RuntimePlugin({ platform: 'deno' });
    expect(plugin.provides).toContain(CAPABILITIES.RUNTIME);
  });

  it('has HIGHEST priority', () => {
    const plugin = RuntimePlugin({ platform: 'deno' });
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.HIGHEST);
  });

  it('registers runtime services under CAPABILITIES.RUNTIME', () => {
    const fakeRuntime = createFakeRuntime('deno');
    const plugin = RuntimePlugin({
      platform: 'deno',
      adapters: { deno: () => fakeRuntime },
    });
    const ctx = createFakeContext();
    plugin.register(ctx as never);

    expect(ctx.services.has(CAPABILITIES.RUNTIME)).toBe(true);
    const services = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    expect(services.platform()).toBe('deno');
  });

  it('honors forced platform option (node)', () => {
    const fakeRuntime = createFakeRuntime('node');
    const plugin = RuntimePlugin({
      platform: 'node',
      adapters: { node: () => fakeRuntime },
    });
    const ctx = createFakeContext();
    plugin.register(ctx as never);

    const services = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    expect(services.platform()).toBe('node');
  });

  it('honors forced platform option (bun)', () => {
    const fakeRuntime = createFakeRuntime('bun');
    const plugin = RuntimePlugin({
      platform: 'bun',
      adapters: { bun: () => fakeRuntime },
    });
    const ctx = createFakeContext();
    plugin.register(ctx as never);

    const services = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    expect(services.platform()).toBe('bun');
  });

  it('throws when platform is cloudflare-workers', () => {
    expect(() => RuntimePlugin({ platform: 'cloudflare-workers' })).toThrow(
      'Cloudflare Workers runtime is not yet supported',
    );
  });

  it('defaults to detected runtime when no platform specified', () => {
    const fakeRuntime = createFakeRuntime('deno');
    const plugin = RuntimePlugin({
      adapters: { deno: () => fakeRuntime },
    });
    const ctx = createFakeContext();
    plugin.register(ctx as never);

    const services = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    expect(services.platform()).toBe(detectRuntime());
  });

  it('throws if no adapter factory is registered for the platform', () => {
    const plugin = RuntimePlugin({
      platform: 'deno',
      adapters: {},
    });
    const ctx = createFakeContext();
    expect(() => plugin.register(ctx as never)).toThrow(
      'No adapter factory for platform: deno',
    );
  });

  it('registers Node services via default adapters', () => {
    const plugin = RuntimePlugin({ platform: 'node' });
    const ctx = createFakeContext();
    plugin.register(ctx as never);

    expect(ctx.services.has(CAPABILITIES.RUNTIME)).toBe(true);
    const services = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    expect(services.platform()).toBe('node');
  });
});
