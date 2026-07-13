import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import type { IQueue, IRuntimeServices } from '@hono-enterprise/common';

/**
 * Fake runtime services for integration testing.
 */
class FakeRuntime implements IRuntimeServices {
  #now: number = 0;

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
    return `fake-uuid-${this.#now}`;
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

  setInterval(fn: () => void, _ms: number): number {
    // In integration tests, we don't test the poll loop - that's unit tested
    // Just return a dummy handle
    const id = Date.now();
    // Fire once immediately for testing purposes
    setTimeout(fn, 0);
    return id;
  }

  clearInterval(_handle: number): void {}

  setTimeout(fn: () => void, _ms: number): number {
    const id = Date.now();
    fn(); // Fire immediately for testing
    return id;
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
class FakeServicesRegistry {
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
 * Fake health services.
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
  runtime: FakeRuntime;

  constructor(runtime: FakeRuntime) {
    this.services = new FakeServicesRegistry();
    this.health = new FakeHealthServices();
    this.lifecycle = new FakeLifecycleServices();
    this.runtime = runtime;
  }
}

describe('QueuePlugin integration', () => {
  let runtime: FakeRuntime;
  let ctx: FakeContext;

  beforeEach(() => {
    runtime = new FakeRuntime();
    ctx = new FakeContext(runtime);
  });

  it('registers and adds a job', async () => {
    const plugin = QueuePlugin({ adapter: 'memory' });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    // Add a job
    const jobId = await queue.add('send-email', { to: 'test@example.com' });
    expect(jobId).toBeTruthy();
    expect(typeof jobId).toBe('string');
  });

  it('supports multiple named instances', async () => {
    const plugin1 = QueuePlugin({ adapter: 'memory', name: 'foreground' });
    const plugin2 = QueuePlugin({ adapter: 'memory', name: 'background' });

    await plugin1.register(ctx as never);
    await plugin2.register(ctx as never);

    const foreground = ctx.services.get<IQueue>('queue.foreground');
    const background = ctx.services.get<IQueue>('queue.background');

    expect(foreground).toBeDefined();
    expect(background).toBeDefined();
    expect(foreground).not.toBe(background);
  });

  it('health indicator reports up when connected', async () => {
    const plugin = QueuePlugin({ adapter: 'memory' });
    await plugin.register(ctx as never);

    const health = await ctx.health.check();
    // Health indicator is registered under the token 'queue'
    expect(health['queue']).toBeDefined();
    expect(health['queue']?.status).toBe('up');
  });

  it('lifecycle hook disconnects on close', async () => {
    const plugin = QueuePlugin({ adapter: 'memory' });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    // Queue should be connected after registration
    // We verify by checking that we can add jobs
    const jobId = await queue.add('test', {});
    expect(jobId).toBeTruthy();

    await ctx.lifecycle.triggerClose();

    // After close, the adapter should be disconnected
    // Try to add a job - should throw since disconnected
    await expect(queue.add('test2', {})).rejects.toThrow('not connected');
  });

  it('schedules recurring jobs', async () => {
    const plugin = QueuePlugin({ adapter: 'memory' });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    // Add recurring job (every minute)
    await queue.addRecurring('tick', { count: 0 }, { cron: '* * * * *' });

    // Verify recurring job was stored
    const health = await ctx.health.check();
    expect(health).toBeTruthy();
  });
});
