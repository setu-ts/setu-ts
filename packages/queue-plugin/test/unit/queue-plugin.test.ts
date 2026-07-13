import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import type { IQueue, IRuntimeServices } from '@hono-enterprise/common';

/**
 * Fake runtime for testing.
 */
class FakeRuntime implements IRuntimeServices {
  #now: number = Date.now();

  platform(): 'deno' | 'node' | 'bun' | 'cloudflare-workers' {
    return 'deno';
  }

  version(): string {
    return '1.0.0';
  }

  hostname(): string {
    return 'localhost';
  }

  now(): number {
    return this.#now;
  }

  uuid(): string {
    return 'fake-uuid';
  }

  randomBytes(_length: number): Uint8Array {
    return new Uint8Array(0);
  }

  get subtle(): SubtleCrypto {
    throw new Error('Not implemented');
  }

  hrtime(): number {
    return this.#now;
  }

  setInterval(_fn: () => void, _ms: number): number {
    return 1;
  }

  clearInterval(_handle: number): void {}

  setTimeout(_fn: () => void, _ms: number): number {
    return 1;
  }

  clearTimeout(_handle: number): void {}

  get env(): Readonly<Record<string, string | undefined>> {
    return {};
  }

  exit(_code?: number): never {
    throw new Error('Exit called');
  }
}

/**
 * Fake services registry.
 */
// Fake services that satisfies the minimal needs of QueuePlugin tests
export class FakeServicesRegistry {
  #services: Map<string, unknown> = new Map();

  register<T>(token: string, service: T): void {
    this.#services.set(token, service);
  }

  get<T>(token: string): T {
    const service = this.#services.get(token);
    if (!service) {
      throw new Error(`Service not found: ${token}`);
    }
    return service as T;
  }

  has(token: string): boolean {
    return this.#services.has(token);
  }
}

/**
 * Fake health indicator registry.
 */
class FakeHealthServices {
  #indicators: Map<string, () => Promise<{ status: string; data: unknown }>> = new Map();

  register(name: string, indicator: () => Promise<{ status: string; data: unknown }>): void {
    this.#indicators.set(name, indicator);
  }

  async check(): Promise<Record<string, { status: string; data: unknown }>> {
    const result: Record<string, { status: string; data: unknown }> = {};
    for (const [name, indicator] of this.#indicators.entries()) {
      result[name] = await indicator();
    }
    return result;
  }
}

/**
 * Fake lifecycle services.
 */
class FakeLifecycleServices {
  #onCloseHandlers: Array<() => Promise<void>> = [];

  onClose(handler: () => Promise<void>): void {
    this.#onCloseHandlers.push(handler);
  }

  async triggerClose(): Promise<void> {
    for (const handler of this.#onCloseHandlers) {
      await handler();
    }
  }
}

/**
 * Fake context.
 */
class FakeContext {
  services: FakeServicesRegistry;
  health: FakeHealthServices;
  lifecycle: FakeLifecycleServices;

  constructor() {
    this.services = new FakeServicesRegistry();
    this.health = new FakeHealthServices();
    this.lifecycle = new FakeLifecycleServices();
  }

  get runtime(): IRuntimeServices {
    return new FakeRuntime();
  }
}

describe('QueuePlugin', () => {
  it('returns a plugin with name and provides', () => {
    const plugin = QueuePlugin({ adapter: 'memory' });

    expect(plugin.name).toBe('queue-plugin');
    expect(plugin.provides).toContain('queue');
    expect(plugin.version).toBe('0.1.0');
  });

  it('registers a QueueService under CAPABILITIES.QUEUE', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin({ adapter: 'memory' });

    await plugin.register(ctx as never);

    expect(ctx.services.has('queue')).toBe(true);
    const queue = ctx.services.get<IQueue>('queue');
    expect(queue).toBeDefined();
    expect(typeof queue.add).toBe('function');
    expect(typeof queue.process).toBe('function');
    expect(typeof queue.addRecurring).toBe('function');
  });

  it('builds MemoryQueue when adapter is memory', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin({ adapter: 'memory' });

    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');
    expect(queue).toBeDefined();
  });

  it('builds RedisQueue when adapter is redis', async () => {
    // Use a fake Redis client to avoid needing a real Redis connection
    const fakeClient = {
      zadd: () => 0,
      zrangebyscore: () => [],
      zrem: () => 0,
      hset: () => 0,
      hget: () => null,
      hdel: () => 0,
      del: () => 0,
      quit: () => Promise.resolve(),
      connect: () => Promise.resolve(),
    };
    const ctx = new FakeContext();
    const plugin = QueuePlugin({
      adapter: 'redis',
      url: 'redis://localhost:6379',
      client: fakeClient as never,
    });

    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');
    expect(queue).toBeDefined();
  });

  it('throws on unknown adapter', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin({ adapter: 'unknown' as never });

    await expect(plugin.register(ctx as never)).rejects.toThrow('Unknown queue adapter');
  });

  it('registers health indicator', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin({ adapter: 'memory' });

    await plugin.register(ctx as never);

    const health = await ctx.health.check();
    expect(health.queue).toBeDefined();
    expect(health.queue.status).toBe('up');
  });

  it('registers onClose handler', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin({ adapter: 'memory' });

    await plugin.register(ctx as never);

    // Trigger close
    await ctx.lifecycle.triggerClose();

    // Should complete without error
  });

  it('supports named instances', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin({ adapter: 'memory', name: 'background' });

    await plugin.register(ctx as never);

    // Should register under queue.background
    expect(ctx.services.has('queue.background')).toBe(true);
    const queue = ctx.services.get<IQueue>('queue.background');
    expect(queue).toBeDefined();
  });

  it('uses default options', async () => {
    const ctx = new FakeContext();
    const plugin = QueuePlugin();

    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');
    expect(queue).toBeDefined();
  });
});
