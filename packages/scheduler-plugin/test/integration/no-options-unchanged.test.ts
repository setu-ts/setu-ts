/**
 * No-options-unchanged (M86 §3.9) — with no behaviours configured, the
 * dispatch is byte-identical to the pre-chain behaviour: the handler is
 * invoked with the identical job object (the registered payload reference,
 * uncloned), and no promise mediation sits between the executor and the
 * handler — the handler's own return value is what the dispatch hands back,
 * and a synchronous handler completes within the call itself.
 *
 * The synchronicity is asserted at the dispatch seam itself ({@linkcode run}
 * and the wrapping helper), the only place it is observable — not by reading
 * a private field, which a refactor could silently invalidate.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, IPluginContext, IScheduler, ScheduledJob } from '@setu-ts/common';
import { SchedulerPlugin } from '../../src/plugin/scheduler-plugin.ts';
import { run, withIngressBehaviors } from '../../src/jobs/job-executor.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

/** Interval used by the `every` jobs under test (grid-aligned fires). */
const TICK_MS = 100;
/** One `every` fire lands within this advance. */
const ONE_FIRE_MS = 200;

/** A job-shaped constant for the dispatch-seam tests. */
function job(): ScheduledJob {
  return { id: 'job-1', name: 'tick', data: undefined, attempts: 1 };
}

/** Builds a minimal plugin context around the given runtime. */
function createCtx(runtime: FakeRuntime): {
  ctx: IPluginContext;
  registered: Map<string, unknown>;
} {
  const registered = new Map<string, unknown>();
  const ctx = {
    runtime,
    logger: undefined,
    services: {
      register: <T>(token: string, service: T): void => {
        registered.set(token, service);
      },
    },
    health: { register: (_name: string, _check: () => Promise<HealthCheckResult>): void => {} },
    lifecycle: { onClose: (): void => {}, onInit: (): void => {} },
  } as unknown as IPluginContext;
  return { ctx, registered };
}

describe('Scheduler zero-configuration dispatch is unchanged (M86 §3.9)', () => {
  it('hands the handler the identical job object — the registered payload reference, uncloned', async () => {
    const runtime = new FakeRuntime();
    const { ctx, registered } = createCtx(runtime);
    await SchedulerPlugin().register(ctx);

    const scheduler = registered.get('scheduler') as IScheduler;
    const seen: ScheduledJob<{ to: string }>[] = [];
    const payload = { to: 'ada@example.com' };
    await scheduler.every<{ to: string }>('send-email', TICK_MS, (job) => {
      seen.push(job);
    }, { data: payload });

    await runtime.advance(ONE_FIRE_MS);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBeTruthy();
    expect(seen[0]?.name).toBe('send-email');
    // The IDENTICAL payload reference — no cloning, no envelope in between.
    expect(seen[0]?.data).toBe(payload);
    expect(seen[0]?.attempts).toBe(1);

    // Recurring: exactly one fire per interval, nothing else changed.
    await runtime.advance(ONE_FIRE_MS);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.data).toBe(payload);
  });

  it('an explicitly empty behaviors arm dispatches identically', async () => {
    const runtime = new FakeRuntime();
    const { ctx, registered } = createCtx(runtime);
    await SchedulerPlugin({ behaviors: [] }).register(ctx);

    const scheduler = registered.get('scheduler') as IScheduler;
    let ran = false;
    await scheduler.every('plain', TICK_MS, () => {
      ran = true;
    });

    await runtime.advance(ONE_FIRE_MS);

    // An empty array is NOT "at least one behaviour": the direct path wins.
    expect(ran).toBe(true);
  });

  it('a synchronous handler completes within the run() call itself — no microtask interposed', async () => {
    const runtime = new FakeRuntime();
    let ran = false;
    const outcome = run(
      'job-1',
      'tick',
      () => {
        ran = true;
      },
      undefined,
      undefined,
      { runtime },
    );

    // The handler was invoked synchronously inside the run() call, exactly
    // as before the chain existed.
    expect(ran).toBe(true);
    await outcome;
  });

  it('withIngressBehaviors with an empty list is a byte-identical passthrough', () => {
    // Synchronous handler: the wrapper returns the handler's own void — a
    // chain would interpose a Promise here.
    let syncRan = false;
    const syncWrapped = withIngressBehaviors(() => {
      syncRan = true;
    }, []);
    const result = syncWrapped(job());
    expect(syncRan).toBe(true);
    expect(result).toBeUndefined();

    // Asynchronous handler: the handler's OWN promise is handed back as-is —
    // return-value identity, the observable form of "no promise mediation".
    const marker: Promise<void> = Promise.resolve();
    const asyncWrapped = withIngressBehaviors((_job): Promise<void> => marker, []);
    expect(asyncWrapped(job())).toBe(marker);
  });
});
