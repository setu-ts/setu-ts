/**
 * Queue behaviour chain (M86 §3.3a/§3.4/§3.9) — every delivery builds a
 * per-item immutable `IngressContext` envelope (`kind: 'queue'`, the job
 * name, `attempt` equal to `IJob.attempts`, the delivered job as payload);
 * behaviours run in declared order and short-circuit by returning without
 * `next()`; a behaviour throw follows the processor's own failure path
 * (requeue, then `onFailed` plus the dead-letter on the final attempt).
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  IJob,
  IngressContext,
  IPluginContext,
  IQueue,
} from '@setu-ts/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { computeBackoffMs } from '../../src/retry/retry-strategy.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

/** Poll interval used by every plugin instance under test. */
const POLL_MS = 100;

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

class FakeHealthServices {
  #indicators: Map<string, () => Promise<unknown>> = new Map();

  register(name: string, indicator: () => Promise<unknown>): void {
    this.#indicators.set(name, indicator);
  }
}

class FakeLifecycleServices {
  #onCloseHandlers: Array<() => Promise<void>> = [];
  readonly initHooks: Array<() => void | Promise<void>> = [];

  onClose(handler: () => Promise<void>): void {
    this.#onCloseHandlers.push(handler);
  }

  onInit(handler: () => void | Promise<void>): void {
    this.initHooks.push(handler);
  }

  async triggerClose(): Promise<void> {
    for (const handler of this.#onCloseHandlers) {
      await handler();
    }
  }
}

interface Harness {
  readonly ctx: IPluginContext;
  readonly services: FakeServicesRegistry;
  readonly lifecycle: FakeLifecycleServices;
  readonly runtime: FakeRuntimeServices;
}

function createHarness(): Harness {
  const runtime = new FakeRuntimeServices();
  const services = new FakeServicesRegistry();
  const lifecycle = new FakeLifecycleServices();
  const ctx = {
    services,
    health: new FakeHealthServices(),
    lifecycle,
    runtime,
  } as unknown as IPluginContext;
  return { ctx, services, lifecycle, runtime };
}

/** A behaviour that records the envelope it saw, then continues the chain. */
function envelopeRecorder(into: IngressContext[]): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      into.push(ctx);
      return next();
    },
  };
}

describe('QueuePlugin behaviour chain (M86 §3.3a/§3.4)', () => {
  it('builds a per-item envelope: kind queue, the job name, attempt, and the job as payload', async () => {
    const { ctx, services, runtime } = createHarness();
    const envelopes: IngressContext[] = [];
    const seen: IJob<{ to: string }>[] = [];
    const plugin = QueuePlugin({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      behaviors: [envelopeRecorder(envelopes)],
    });
    await plugin.register(ctx);

    const queue = services.get<IQueue>('queue');
    queue.process<{ to: string }>('send-email', (job) => {
      seen.push(job);
    });

    const payload = { to: 'ada@example.com' };
    await queue.add('send-email', payload);
    await runtime.advanceMs(POLL_MS * 2);

    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope?.kind).toBe('queue');
    expect(envelope?.name).toBe('send-email');
    expect(envelope?.attempt).toBe(1);
    // The payload is THE job object the processor received — not a copy.
    expect(envelope?.payload).toBe(seen[0]);
    expect(seen[0]?.data).toBe(payload);
  });

  it('runs behaviours in declared order, and every behaviour sees the same envelope', async () => {
    const { ctx, services, runtime } = createHarness();
    const order: string[] = [];
    const firstSeen: IngressContext[] = [];
    const secondSeen: IngressContext[] = [];
    const plugin = QueuePlugin({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      behaviors: [
        envelopeRecorderWithLabel(firstSeen, order, 'first'),
        envelopeRecorderWithLabel(secondSeen, order, 'second'),
      ],
    });
    await plugin.register(ctx);

    const queue = services.get<IQueue>('queue');
    queue.process('ordered', () => {});
    await queue.add('ordered', {});
    await runtime.advanceMs(POLL_MS * 2);

    // Declared order equals execution order.
    expect(order).toEqual(['first', 'second']);
    // Both behaviours observed the SAME envelope instance.
    expect(firstSeen).toHaveLength(1);
    expect(secondSeen).toHaveLength(1);
    expect(secondSeen[0]).toBe(firstSeen[0]);
  });

  it('under concurrency: 2, two in-flight jobs see two distinct envelope instances', async () => {
    const { ctx, services, runtime } = createHarness();
    const envelopes: IngressContext[] = [];
    const plugin = QueuePlugin({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      behaviors: [envelopeRecorder(envelopes)],
    });
    await plugin.register(ctx);

    const queue = services.get<IQueue>('queue');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.process('parallel', () => gate, { concurrency: 2 });

    const payloadA = { n: 1 };
    const payloadB = { n: 2 };
    await queue.add('parallel', payloadA);
    await queue.add('parallel', payloadB);
    await runtime.advanceMs(POLL_MS * 2);

    // Both jobs are in flight at once, and each was handed its OWN envelope.
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).not.toBe(envelopes[1]);
    // Each envelope carries its OWN job — payload A on one, payload B on the
    // other, never a shared instance.
    const datas = envelopes.map((e) => (e.payload as IJob<{ n: number }>).data);
    expect(datas).toContain(payloadA);
    expect(datas).toContain(payloadB);
    expect(new Set(datas).size).toBe(2);

    // Settle both jobs.
    release();
    await runtime.advanceMs(POLL_MS * 3);
  });

  it('a short-circuiting behaviour skips the processor; the job is acknowledged, not retried', async () => {
    const { ctx, services, runtime } = createHarness();
    let processorRan = false;
    const plugin = QueuePlugin({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      behaviors: [{
        handle(_ctx: IngressContext, _next: () => Promise<void>): void | Promise<void> {
          // Return WITHOUT calling next(): the chain must stop here.
        },
      }],
    });
    await plugin.register(ctx);

    const queue = services.get<IQueue>('queue');
    queue.process('gated', () => {
      processorRan = true;
    });
    await queue.add('gated', {});

    // Several poll ticks: the processor never runs, and the acked job is
    // never redelivered.
    await runtime.advanceMs(POLL_MS * 5);
    expect(processorRan).toBe(false);
  });

  it('a behaviour throw follows the retry path; onFailed fires on the final attempt', async () => {
    const { ctx, services, runtime } = createHarness();
    const behaviourError = new Error('behaviour exploded');
    const envelopes: IngressContext[] = [];
    const failedJobs: IJob[] = [];
    const failedErrors: unknown[] = [];
    let processorRan = false;
    const plugin = QueuePlugin({
      adapter: 'memory',
      pollIntervalMs: POLL_MS,
      behaviors: [{
        handle(ctx: IngressContext, _next: () => Promise<void>): void | Promise<void> {
          envelopes.push(ctx);
          throw behaviourError;
        },
      }],
      processors: [{
        name: 'boom',
        processor: () => {
          processorRan = true;
        },
        options: {
          onFailed: (job, error) => {
            failedJobs.push(job);
            failedErrors.push(error);
          },
        },
      }],
    });
    await plugin.register(ctx);

    const queue = services.get<IQueue>('queue');
    await queue.add('boom', {}, { maxAttempts: 2 });

    // First delivery: the chain sees attempt 1, the throw is retried.
    await runtime.advanceMs(POLL_MS * 2);
    expect(envelopes.map((e) => e.attempt)).toEqual([1]);
    expect(processorRan).toBe(false);
    expect(failedJobs).toHaveLength(0);

    // Backoff for the second attempt is computeBackoffMs(2) = 2000ms.
    await runtime.advanceMs(computeBackoffMs(2) + POLL_MS * 2);

    // The second delivery went back through the chain with a fresh envelope
    // carrying attempt 2, the processor still never ran, and the FINAL
    // attempt fired onFailed with the job and the behaviour's error.
    expect(envelopes.map((e) => e.attempt)).toEqual([1, 2]);
    expect(processorRan).toBe(false);
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0]?.attempts).toBe(2);
    expect(failedErrors[0]).toBe(behaviourError);

    // Dead-lettered: no third delivery.
    await runtime.advanceMs(POLL_MS * 4);
    expect(envelopes).toHaveLength(2);
  });
});

/** An {@linkcode envelopeRecorder} that also records its execution label. */
function envelopeRecorderWithLabel(
  into: IngressContext[],
  order: string[],
  label: string,
): IIngressBehavior {
  return {
    handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
      into.push(ctx);
      order.push(label);
      return next();
    },
  };
}
