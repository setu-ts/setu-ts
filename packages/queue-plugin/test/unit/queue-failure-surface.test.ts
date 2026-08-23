/**
 * X8-4 — a job that exhausts its retries becoming visible.
 *
 * The register's finding: a dead-lettered job was invisible through every
 * surface the framework offers. `IQueue` has `add`/`process`/`addRecurring` and
 * nothing else — no `getJob`, no failure callback, no dead-letter accessor —
 * the health indicator's entire payload was `{"adapter":"RedisQueue"}`, and
 * `/metrics` carried no queue series at all. Work disappeared, and the only way
 * to discover it was to open a Redis client.
 *
 * Three surfaces close it, and they answer different questions: `onFailed` is
 * the programmatic notice, the counter is the alertable signal, and the health
 * payload's depths are the DURABLE view a per-process counter cannot give after
 * a restart.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IJob, IRuntimeServices } from '@setu-ts/common';
import { runJob } from '../../src/processors/job-processor.ts';
import type { JobOutcome } from '../../src/processors/job-processor.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';

/** A runtime whose only member these tests reach is the wall clock. */
const runtime = { now: () => 1_700_000_000_000 } as unknown as IRuntimeServices;

/** Records which settle path the runner took. */
function makeAdapter() {
  const calls = { ack: 0, requeue: 0, deadLetter: 0 };
  return {
    calls,
    ack: () => {
      calls.ack++;
      return Promise.resolve();
    },
    requeue: () => {
      calls.requeue++;
      return Promise.resolve();
    },
    deadLetter: () => {
      calls.deadLetter++;
      return Promise.resolve();
    },
  };
}

/** A stored job on its `attempts`-th delivery out of `maxAttempts`. */
function job(attempts: number, maxAttempts = 3): StoredJob {
  return {
    id: 'job-1',
    name: 'thumbnail',
    data: { key: 'photo.png' },
    attempts,
    maxAttempts,
    availableAtMs: 0,
  };
}

describe('ProcessOptions.onFailed (X8-4)', () => {
  it('should fire once on the FINAL attempt, carrying the job and the error', async () => {
    const adapter = makeAdapter();
    const seen: { job: IJob; error: unknown }[] = [];
    const boom = new Error('thumbnailer exploded');

    await runJob(
      runtime,
      adapter,
      job(3),
      () => {
        throw boom;
      },
      undefined,
      {
        onFailed: (failed, error) => {
          seen.push({ job: failed, error });
        },
      },
    );

    expect(adapter.calls.deadLetter).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.error).toBe(boom);
    expect(seen[0]!.job).toEqual({
      id: 'job-1',
      name: 'thumbnail',
      data: { key: 'photo.png' },
      attempts: 3,
    });
  });

  it('should NOT fire on an attempt that will be retried', async () => {
    // The register asks for "after the final attempt". Firing per attempt would
    // make the callback a flakiness signal rather than a lost-work one, and a
    // caller could not tell the two apart without a flag.
    const adapter = makeAdapter();
    let fired = 0;

    await runJob(
      runtime,
      adapter,
      job(1),
      () => {
        throw new Error('transient');
      },
      undefined,
      { onFailed: () => void fired++ },
    );

    expect(adapter.calls.requeue).toBe(1);
    expect(fired).toBe(0);
  });

  it('should NOT fire when the job succeeds', async () => {
    const adapter = makeAdapter();
    let fired = 0;

    await runJob(runtime, adapter, job(1), () => {}, undefined, { onFailed: () => void fired++ });

    expect(adapter.calls.ack).toBe(1);
    expect(fired).toBe(0);
  });

  it('should fire BEFORE the dead-letter, so a compensating handler still sees the job', async () => {
    const order: string[] = [];
    const adapter = {
      ack: () => Promise.resolve(),
      requeue: () => Promise.resolve(),
      deadLetter: () => {
        order.push('deadLetter');
        return Promise.resolve();
      },
    };

    await runJob(
      runtime,
      adapter,
      job(3),
      () => {
        throw new Error('x');
      },
      undefined,
      { onFailed: () => void order.push('onFailed') },
    );

    expect(order).toEqual(['onFailed', 'deadLetter']);
  });

  it('should still dead-letter when the callback THROWS, and report the callback failure', async () => {
    // Losing the job as well as the notification is strictly worse than losing
    // the notification.
    const adapter = makeAdapter();
    const reported: string[] = [];

    await runJob(
      runtime,
      adapter,
      job(3),
      () => {
        throw new Error('original');
      },
      (message) => reported.push(message),
      {
        onFailed: () => {
          throw new Error('callback exploded');
        },
      },
    );

    expect(adapter.calls.deadLetter).toBe(1);
    expect(reported).toContain('queue onFailed callback threw');
  });

  it('should still dead-letter when the callback REJECTS', async () => {
    // An async callback is the common case, and an unawaited rejection would
    // escape as an unhandled rejection rather than being reported.
    const adapter = makeAdapter();
    const reported: string[] = [];

    await runJob(
      runtime,
      adapter,
      job(3),
      () => {
        throw new Error('original');
      },
      (message) => reported.push(message),
      {
        onFailed: () => Promise.reject(new Error('async callback exploded')),
      },
    );

    expect(adapter.calls.deadLetter).toBe(1);
    expect(reported).toContain('queue onFailed callback threw');
  });
});

describe('job outcome sink (X8-4)', () => {
  it('should report exactly one outcome per settled job', async () => {
    const outcomes: { name: string; outcome: JobOutcome }[] = [];
    const sink = {
      onOutcome: (name: string, outcome: JobOutcome) => outcomes.push({ name, outcome }),
    };

    await runJob(runtime, makeAdapter(), job(1), () => {}, undefined, sink);
    await runJob(
      runtime,
      makeAdapter(),
      job(1),
      () => {
        throw new Error('x');
      },
      undefined,
      sink,
    );
    await runJob(
      runtime,
      makeAdapter(),
      job(3),
      () => {
        throw new Error('x');
      },
      undefined,
      sink,
    );

    expect(outcomes).toEqual([
      { name: 'thumbnail', outcome: 'completed' },
      { name: 'thumbnail', outcome: 'retried' },
      { name: 'thumbnail', outcome: 'dead_lettered' },
    ]);
  });

  it('should not let a THROWING sink lose the job', async () => {
    // An instrument write is a throwing call — a metrics service validates its
    // labels and is a replaceable capability — so observing the work must never
    // be able to prevent it settling (the M45b review finding).
    const adapter = makeAdapter();
    const reported: string[] = [];

    await runJob(runtime, adapter, job(1), () => {}, (message) => reported.push(message), {
      onOutcome: () => {
        throw new Error('metrics backend refused');
      },
    });

    expect(adapter.calls.ack).toBe(1);
    expect(reported).toContain('queue outcome sink threw');
  });
});
