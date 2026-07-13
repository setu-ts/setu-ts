import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import type { IJob, IQueue } from '@hono-enterprise/common';

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
  runtime: FakeRuntimeServices;

  constructor(runtime: FakeRuntimeServices) {
    this.services = new FakeServicesRegistry();
    this.health = new FakeHealthServices();
    this.lifecycle = new FakeLifecycleServices();
    this.runtime = runtime;
  }
}

/** Poll interval used by every plugin instance under test. */
const POLL_MS = 100;

describe('QueuePlugin integration', () => {
  let runtime: FakeRuntimeServices;
  let ctx: FakeContext;

  beforeEach(() => {
    runtime = new FakeRuntimeServices();
    ctx = new FakeContext(runtime);
  });

  it('registers and adds a job', async () => {
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    const jobId = await queue.add('send-email', { to: 'test@example.com' });
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);
  });

  it('delivers the job to its processor and acks it (no re-delivery)', async () => {
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    const delivered: IJob<{ to: string }>[] = [];
    queue.process<{ to: string }>('send-email', (job) => {
      delivered.push(job);
    });

    const jobId = await queue.add('send-email', { to: 'ada@example.com' });
    await runtime.advanceMs(POLL_MS * 2);

    expect(delivered.length).toBe(1);
    expect(delivered[0]?.id).toBe(jobId);
    expect(delivered[0]?.name).toBe('send-email');
    expect(delivered[0]?.data).toEqual({ to: 'ada@example.com' });
    expect(delivered[0]?.attempts).toBe(1);

    // An acked job leaves the queue: further poll ticks must not redeliver it.
    await runtime.advanceMs(POLL_MS * 5);
    expect(delivered.length).toBe(1);
  });

  it('retries a failing job with backoff, then dead-letters it at maxAttempts', async () => {
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    const attempts: number[] = [];
    queue.process('failing-job', (job) => {
      attempts.push(job.attempts);
      throw new Error('processor failed');
    });

    await queue.add('failing-job', {}, { maxAttempts: 2 });

    // First delivery.
    await runtime.advanceMs(POLL_MS * 2);
    expect(attempts).toEqual([1]);

    // Backoff for the second attempt is computeBackoffMs(2) = 2000ms.
    await runtime.advanceMs(2000 + POLL_MS * 2);
    expect(attempts).toEqual([1, 2]);

    // At maxAttempts the job is dead-lettered, never delivered again.
    await runtime.advanceMs(30_000);
    expect(attempts).toEqual([1, 2]);
  });

  it('enqueues a recurring job on its cron tick and processes it', async () => {
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    const ticks: IJob<{ count: number }>[] = [];
    queue.process<{ count: number }>('tick', (job) => {
      ticks.push(job);
    });

    await queue.addRecurring('tick', { count: 0 }, { cron: '* * * * *' });

    // Nothing is due before the next minute boundary.
    expect(ticks.length).toBe(0);

    // Advance past the next cron fire time; the recurring loop enqueues a
    // concrete job and the worker loop delivers it to the same-name processor.
    await runtime.advanceMs(120_000);

    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]?.name).toBe('tick');
    expect(ticks[0]?.data).toEqual({ count: 0 });
  });

  it('supports multiple named instances under distinct tokens', async () => {
    const plugin1 = QueuePlugin({ adapter: 'memory', name: 'foreground', pollIntervalMs: POLL_MS });
    const plugin2 = QueuePlugin({ adapter: 'memory', name: 'background', pollIntervalMs: POLL_MS });

    await plugin1.register(ctx as never);
    await plugin2.register(ctx as never);

    const foreground = ctx.services.get<IQueue>('queue.foreground');
    const background = ctx.services.get<IQueue>('queue.background');

    expect(foreground).toBeDefined();
    expect(background).toBeDefined();
    expect(foreground).not.toBe(background);

    // Each instance keeps its own jobs: a processor on one never sees the
    // other's work.
    const seen: string[] = [];
    foreground.process('work', () => {
      seen.push('foreground');
    });
    background.process('work', () => {
      seen.push('background');
    });

    await foreground.add('work', {});
    await runtime.advanceMs(POLL_MS * 2);

    expect(seen).toEqual(['foreground']);
  });

  it('registers a health indicator per instance under its own token', async () => {
    const plugin = QueuePlugin({ adapter: 'memory', name: 'background', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const health = await ctx.health.check();
    expect(health['queue.background']).toBeDefined();
    expect(health['queue.background']?.status).toBe('up');
    expect(health['queue.background']?.data).toEqual({ adapter: 'MemoryQueue' });
  });

  it('lifecycle hook disconnects the queue on close', async () => {
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const queue = ctx.services.get<IQueue>('queue');

    const jobId = await queue.add('test', {});
    expect(jobId).toBeTruthy();

    await ctx.lifecycle.triggerClose();

    // The adapter is disconnected, so further enqueues fail.
    await expect(queue.add('test2', {})).rejects.toThrow('not connected');

    // The health indicator reports the queue as down once closed.
    const health = await ctx.health.check();
    expect(health['queue']?.status).toBe('down');
  });
});
