/**
 * Scheduler behaviour chain (M86 §3.4/§3.10) — every fire builds a per-item
 * immutable `IngressContext` envelope (`kind: 'scheduler'`, the job name, the
 * 1-based `attempt`, the delivered `ScheduledJob` as payload); behaviours run
 * in declared order INSIDE the distributed lock; a behaviour that returns
 * without `next()` short-circuits the handler; a behaviour throw is retried
 * per the job's `RetryOptions`, exactly as a handler throw is.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  IngressContext,
  IPluginContext,
  IScheduler,
  ScheduledJob,
} from '@setu-ts/common';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';
import { run, withIngressBehaviors } from '../../src/jobs/job-executor.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
// Declared against the BARREL: IDistributedLock and the option/entry types are
// package surface, and dropping an export must fail this file's type-check.
import type { IDistributedLock, SchedulerPluginOptions } from '../../src/index.ts';

/** Interval used by every `every` job under test (grid-aligned fires). */
const TICK_MS = 100;
/** One `every` fire lands within this advance. */
const ONE_FIRE_MS = 200;
/** The earliest minute boundary a `'* * * * *'` cron can reach from start. */
const CRON_FIRE_MS = 45_000;

interface Harness {
  readonly scheduler: IScheduler;
  readonly runtime: FakeRuntime;
}

async function createHarness(options?: SchedulerPluginOptions): Promise<Harness> {
  const runtime = new FakeRuntime();
  const registered = new Map<string, unknown>();
  const ctx = {
    runtime,
    // `logger` is OMITTED, not `undefined`: optional property under
    // `exactOptionalPropertyTypes`.
    services: {
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: { register: (): void => {} },
    lifecycle: { onClose: (): void => {}, onInit: (): void => {} },
  } as unknown as IPluginContext;
  const plugin = SchedulerPlugin({ ...(options ?? {}) });
  await plugin.register(ctx);
  const scheduler = registered.get('scheduler');
  if (scheduler === undefined) {
    throw new Error('plugin did not register the scheduler service');
  }
  return { scheduler: scheduler as IScheduler, runtime };
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

/** A lock that always grants, recording every acquire/release into a log. */
class RecordingLock implements IDistributedLock {
  readonly log: string[];

  constructor(log: string[]) {
    this.log = log;
  }

  acquire(_key: string, _ttlMs: number): Promise<string | null> {
    this.log.push('acquire');
    return Promise.resolve('token');
  }

  release(_key: string, _token: string): Promise<void> {
    this.log.push('release');
    return Promise.resolve();
  }
}

/** A lock that refuses every acquire — another replica holds everything. */
class RefusingLock implements IDistributedLock {
  acquireAttempts = 0;

  acquire(_key: string, _ttlMs: number): Promise<string | null> {
    this.acquireAttempts++;
    return Promise.resolve(null);
  }

  release(_key: string, _token: string): Promise<void> {
    return Promise.resolve();
  }
}

/** A lock whose backend is unreachable. */
class ThrowingLock implements IDistributedLock {
  acquire(_key: string, _ttlMs: number): Promise<string | null> {
    return Promise.reject(new Error('lock backend down'));
  }

  release(_key: string, _token: string): Promise<void> {
    return Promise.resolve();
  }
}

describe('SchedulerPlugin behaviour chain (M86 §3.4/§3.10)', () => {
  it('builds a per-item envelope: kind scheduler, the job name, 1-based attempt, the job as payload', async () => {
    const envelopes: IngressContext[] = [];
    const seen: ScheduledJob<{ to: string }>[] = [];
    const { runtime } = await createHarness({
      behaviors: [envelopeRecorder(envelopes)],
      jobs: [
        {
          trigger: 'every',
          name: 'send-email',
          intervalMs: TICK_MS,
          handler: (job) => {
            seen.push(job as ScheduledJob<{ to: string }>);
          },
          data: { to: 'ada@example.com' },
        },
      ],
    });

    await runtime.advance(ONE_FIRE_MS);

    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope?.kind).toBe('scheduler');
    expect(envelope?.name).toBe('send-email');
    expect(envelope?.attempt).toBe(1);
    // The payload is THE job object the handler received — not a copy.
    expect(envelope?.payload).toBe(seen[0]);
    expect(seen[0]?.data).toEqual({ to: 'ada@example.com' });
  });

  it('runs behaviours in declared order, and every behaviour sees the same envelope', async () => {
    const order: string[] = [];
    const firstSeen: IngressContext[] = [];
    const secondSeen: IngressContext[] = [];
    const { scheduler, runtime } = await createHarness({
      behaviors: [
        envelopeRecorderWithLabel(firstSeen, order, 'first'),
        envelopeRecorderWithLabel(secondSeen, order, 'second'),
      ],
    });
    await scheduler.every('ordered', TICK_MS, () => {});

    await runtime.advance(ONE_FIRE_MS);

    // Declared order equals execution order.
    expect(order).toEqual(['first', 'second']);
    // Both behaviours observed the SAME envelope instance.
    expect(firstSeen).toHaveLength(1);
    expect(secondSeen).toHaveLength(1);
    expect(secondSeen[0]).toBe(firstSeen[0]);
  });

  it('the chain runs INSIDE the distributed lock — acquires precede it, the release follows it (§3.10)', async () => {
    const events: string[] = [];
    const { scheduler, runtime } = await createHarness({
      distributedLock: { lock: new RecordingLock(events) },
      behaviors: [
        {
          handle(_ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
            events.push('behavior');
            return next();
          },
        },
      ],
    });
    await scheduler.every('locked', TICK_MS, () => {
      events.push('handler');
    });

    await runtime.advance(ONE_FIRE_MS);

    // One fire, one exact sequence: the fire-slot acquire AND the
    // overlap-mutex acquire both happened BEFORE the behaviour ran, and the
    // mutex release AFTER the handler settled — the chain executed inside the
    // held lock, not around it.
    expect(events).toEqual(['acquire', 'acquire', 'behavior', 'handler', 'release']);
  });

  it('a lock that refuses runs NEITHER the handler NOR any behaviour (§3.10)', async () => {
    const lock = new RefusingLock();
    let behaviorRan = false;
    let handlerRan = false;
    const { scheduler, runtime } = await createHarness({
      distributedLock: { lock },
      behaviors: [
        {
          handle(_ctx: IngressContext, _next: () => Promise<void>): void | Promise<void> {
            behaviorRan = true;
          },
        },
      ],
    });
    await scheduler.every('contended', TICK_MS, () => {
      handlerRan = true;
    });

    // Several fires' worth of ticks: every acquire is refused, and nothing
    // behind the lock — handler or behaviour — ever runs.
    await runtime.advance(ONE_FIRE_MS * 5);
    expect(lock.acquireAttempts).toBeGreaterThan(0);
    expect(behaviorRan).toBe(false);
    expect(handlerRan).toBe(false);
  });

  it('an unreachable lock backend also runs neither the handler nor any behaviour', async () => {
    let behaviorRan = false;
    let handlerRan = false;
    const { scheduler, runtime } = await createHarness({
      distributedLock: { lock: new ThrowingLock() },
      behaviors: [
        {
          handle(_ctx: IngressContext, _next: () => Promise<void>): void | Promise<void> {
            behaviorRan = true;
          },
        },
      ],
    });
    await scheduler.every('unreachable', TICK_MS, () => {
      handlerRan = true;
    });

    await runtime.advance(ONE_FIRE_MS * 5);
    expect(behaviorRan).toBe(false);
    expect(handlerRan).toBe(false);
  });

  it('a short-circuiting behaviour skips the handler; the schedule keeps firing', async () => {
    let handlerRan = false;
    const { scheduler, runtime } = await createHarness({
      behaviors: [{
        handle(_ctx: IngressContext, _next: () => Promise<void>): void | Promise<void> {
          // Return WITHOUT calling next(): the chain must stop here.
        },
      }],
    });
    await scheduler.every('gated', TICK_MS, () => {
      handlerRan = true;
    });

    // Several fires: the handler never runs, and the chain resolves normally
    // so the recurring schedule is untouched.
    await runtime.advance(ONE_FIRE_MS * 3);
    expect(handlerRan).toBe(false);
  });

  it('a behaviour throw is retried per RetryOptions, not swallowed', async () => {
    // Driven at the executor seam ({@linkcode run} + the wrapped handler) —
    // the exact dispatch the service's `#runWithLock` reaches inside the
    // lock — because the executor's backoff timer must be fired by the test
    // while the run is in flight.
    const runtime = new FakeRuntime();
    const envelopes: IngressContext[] = [];
    let handlerRan = false;
    const behaviour: IIngressBehavior = {
      handle(ctx: IngressContext, _next: () => Promise<void>): void | Promise<void> {
        envelopes.push(ctx);
        throw new Error('behaviour exploded');
      },
    };
    const wrapped = withIngressBehaviors(() => {
      handlerRan = true;
    }, [behaviour]);

    const outcome = run(
      'job-1',
      'boom',
      wrapped,
      undefined,
      { limit: 2, delay: 50, backoff: 'fixed' },
      { runtime },
    );

    // Attempt 1 ran synchronously inside the call; the handler never did.
    expect(envelopes.map((e) => e.attempt)).toEqual([1]);
    expect(handlerRan).toBe(false);

    // The executor's catch — which schedules the fixed 50ms backoff timer —
    // resumes one microtask after the call returns; flush it so the timer
    // exists before the advance snapshots its firing set.
    await Promise.resolve();

    // Firing the backoff runs attempt 2 — `limit` — and the error propagates
    // OUT of the executor: the retry machinery retried the behaviour throw,
    // it did not swallow it.
    await runtime.advance(50);
    await expect(outcome).rejects.toThrow('behaviour exploded');

    // Attempt 2 went back through the chain with a FRESH per-item envelope.
    expect(envelopes.map((e) => e.attempt)).toEqual([1, 2]);
    expect(envelopes[0]).not.toBe(envelopes[1]);
    expect(handlerRan).toBe(false);
  });

  it('a behaviour under the chain still lets the handler see the fire when it calls next()', async () => {
    const seen: ScheduledJob[] = [];
    const { scheduler, runtime } = await createHarness({
      behaviors: [envelopeRecorder([])],
    });
    await scheduler.every('passthrough', TICK_MS, (job) => {
      seen.push(job);
    });

    await runtime.advance(ONE_FIRE_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('passthrough');
  });

  it('wraps cron and delay registrations too — imperative calls included', async () => {
    const envelopes: IngressContext[] = [];
    const seen: string[] = [];
    const { scheduler, runtime } = await createHarness({
      behaviors: [envelopeRecorder(envelopes)],
    });
    await scheduler.cron('cron-job', '* * * * *', (job) => {
      seen.push(job.name);
    });
    await scheduler.delay('delay-job', TICK_MS, (job) => {
      seen.push(job.name);
    });

    await runtime.advance(ONE_FIRE_MS);
    await runtime.advance(CRON_FIRE_MS);

    expect(seen).toContain('cron-job');
    expect(seen).toContain('delay-job');
    // Every registration is wrapped, imperative calls included — each fire
    // went through the chain under its own envelope.
    expect(envelopes.map((e) => e.name).sort()).toEqual(['cron-job', 'delay-job']);
    expect(envelopes.every((e) => e.kind === 'scheduler')).toBe(true);
  });
});
