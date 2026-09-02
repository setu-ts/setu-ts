/**
 * No-options-unchanged (M86 §3.9/§3.4) — with no behaviours configured, the
 * dispatch is byte-identical to the pre-chain behaviour: the processor is
 * invoked with the identical job object (the enqueued payload reference,
 * uncloned), and no promise mediation sits between the worker and the
 * processor — a synchronous processor failure is caught in the SAME
 * synchronous execution, with the requeue decision made before the next
 * statement.
 *
 * The synchronicity is asserted at the dispatch seam itself ({@linkcode
 * runJob} and the wrapping helper), the only place it is observable — not by
 * reading a private field, which a refactor could silently invalidate.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IJob, IQueue } from '@setu-ts/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { runJob, withIngressBehaviors } from '../../src/processors/job-processor.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

/** Poll interval used by every plugin instance under test. */
const POLL_MS = 100;

/** The settle calls runJob made, in order. */
type Events = string[];

interface RecordingAdapter {
  readonly events: Events;
  ack(name: string, id: string, claimToken: string): Promise<void>;
  requeue(
    name: string,
    id: string,
    availableAtMs: number,
    attempts: number,
    claimToken: string,
  ): Promise<void>;
  deadLetter(name: string, id: string, nowMs: number, claimToken: string): Promise<void>;
}

/** An adapter that records every settle call, synchronously, in order. */
function createRecordingAdapter(): RecordingAdapter {
  const events: Events = [];
  return {
    events,
    // Non-async ON PURPOSE: the record must happen synchronously inside the
    // call, which is what the same-execution assertions below observe.
    ack(_name: string, id: string, _claimToken: string): Promise<void> {
      events.push(`ack:${id}`);
      return Promise.resolve();
    },
    requeue(
      _name: string,
      id: string,
      _availableAtMs: number,
      attempts: number,
      _claimToken: string,
    ): Promise<void> {
      events.push(`requeue:${id}:${attempts}`);
      return Promise.resolve();
    },
    deadLetter(_name: string, id: string, _nowMs: number, _claimToken: string): Promise<void> {
      events.push(`dead-letter:${id}`);
      return Promise.resolve();
    },
  };
}

/** A stored job as the worker would hold it after `reserve`. */
function storedJob(): {
  id: string;
  name: string;
  data: { n: number };
  attempts: number;
  maxAttempts: number;
  availableAtMs: number;
} {
  return {
    id: 'job-1',
    name: 'sync',
    data: { n: 1 },
    attempts: 1,
    maxAttempts: 2,
    availableAtMs: 0,
  };
}

describe('Queue zero-configuration dispatch is unchanged (M86 §3.9)', () => {
  it('hands the processor the identical job object — the enqueued payload reference, uncloned', async () => {
    const runtime = new FakeRuntimeServices();
    const registered = new Map<string, unknown>();
    const ctx = {
      runtime,
      services: {
        has: (): boolean => false,
        get: <T>(token: string): T => {
          throw new Error(`no service for ${token}`);
        },
        register: <T>(token: string, service: T): void => {
          registered.set(token, service);
        },
      },
      health: { register: (): void => {} },
      lifecycle: { onClose: (): void => {}, onInit: (): void => {} },
    };
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS });
    await plugin.register(ctx as never);

    const queue = registered.get('queue') as IQueue;
    const seen: IJob<{ to: string }>[] = [];
    queue.process<{ to: string }>('send-email', (job) => {
      seen.push(job);
    });

    const payload = { to: 'ada@example.com' };
    const jobId = await queue.add('send-email', payload);
    await runtime.advanceMs(POLL_MS * 2);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(jobId);
    expect(seen[0]?.name).toBe('send-email');
    // The IDENTICAL payload reference — no cloning, no envelope in between.
    expect(seen[0]?.data).toBe(payload);
    expect(seen[0]?.attempts).toBe(1);

    // Acked: further poll ticks do not redeliver it.
    await runtime.advanceMs(POLL_MS * 5);
    expect(seen).toHaveLength(1);
  });

  it('an explicitly empty behaviors arm dispatches identically', async () => {
    const runtime = new FakeRuntimeServices();
    const registered = new Map<string, unknown>();
    const ctx = {
      runtime,
      services: {
        has: (): boolean => false,
        get: <T>(token: string): T => {
          throw new Error(`no service for ${token}`);
        },
        register: <T>(token: string, service: T): void => {
          registered.set(token, service);
        },
      },
      health: { register: (): void => {} },
      lifecycle: { onClose: (): void => {}, onInit: (): void => {} },
    };
    const plugin = QueuePlugin({ adapter: 'memory', pollIntervalMs: POLL_MS, behaviors: [] });
    await plugin.register(ctx as never);

    const queue = registered.get('queue') as IQueue;
    let ran = false;
    queue.process('plain', () => {
      ran = true;
    });

    await queue.add('plain', {});
    await runtime.advanceMs(POLL_MS * 2);

    // An empty array is NOT "at least one behaviour": the direct path wins.
    expect(ran).toBe(true);
  });

  it('a synchronous processor failure is caught in the same synchronous execution — no chain interposed', async () => {
    const adapter = createRecordingAdapter();
    let ran = false;
    const outcome = runJob(
      new FakeRuntimeServices(),
      adapter,
      storedJob(),
      (job) => {
        expect(job.id).toBe('job-1');
        ran = true;
        throw new Error('sync boom');
      },
    );

    // Ran AND settled the retry BEFORE the next statement: the failure path
    // is reachable synchronously, exactly as before the chain existed. A
    // chain interposed here would turn the synchronous throw into a
    // rejection, deferring this requeue decision by a microtask.
    expect(ran).toBe(true);
    expect(adapter.events).toEqual(['requeue:job-1:2']);
    await outcome;
  });

  it('withIngressBehaviors with an empty list is a byte-identical passthrough', async () => {
    const adapter = createRecordingAdapter();
    const wrapped = withIngressBehaviors(() => {
      throw new Error('sync boom');
    }, []);

    const outcome = runJob(new FakeRuntimeServices(), adapter, storedJob(), wrapped);

    // The empty-chain wrapper adds no mediation: same synchronous catch.
    expect(adapter.events).toEqual(['requeue:job-1:2']);
    await outcome;
  });

  it('a synchronous processor completes and acks with no mediation', async () => {
    const adapter = createRecordingAdapter();
    const job = storedJob();
    const payload = job.data;
    let seen: IJob<{ n: number }> | undefined;

    await runJob(new FakeRuntimeServices(), adapter, job, (delivered) => {
      seen = delivered;
    });

    // The processor received the job runJob built — the same data reference,
    // and the ack carries the job's id as the fallback claim token.
    expect(seen?.data).toBe(payload);
    expect(seen?.attempts).toBe(1);
    expect(adapter.events).toEqual(['ack:job-1']);
  });
});
