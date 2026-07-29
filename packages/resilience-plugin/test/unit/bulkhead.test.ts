import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Bulkhead } from '../../src/patterns/bulkhead.ts';
import { BulkheadFullError } from '../../src/errors.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => Promise.resolve();

async function expectReject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('Bulkhead', () => {
  it('runs a call and returns to zero in-flight after it settles', async () => {
    const b = new Bulkhead({ maxConcurrent: 1 });
    const result = await b.run(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(b.active).toBe(0);
  });

  it('runs up to maxConcurrent concurrently, queues the next, and sheds overflow', async () => {
    const b = new Bulkhead({ maxConcurrent: 2, maxQueue: 1 });
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const d3 = deferred<string>();

    const p1 = b.run(() => d1.promise);
    const p2 = b.run(() => d2.promise);
    expect(b.active).toBe(2);

    const p3 = b.run(() => d3.promise); // queued (queue length now 1)

    // Concurrency saturated AND queue full → overflow is shed.
    const err = await expectReject(b.run(() => Promise.resolve('overflow')));
    expect(err instanceof BulkheadFullError).toBe(true);

    // Free a slot → the queued call is promoted into it.
    d1.resolve('a');
    expect(await p1).toBe('a');
    await tick;

    d3.resolve('c');
    expect(await p3).toBe('c');
    d2.resolve('b');
    expect(await p2).toBe('b');

    await Promise.all([p1, p2, p3]);
    expect(b.active).toBe(0);
  });

  it('sheds immediately when maxQueue defaults to 0', async () => {
    const b = new Bulkhead({ maxConcurrent: 1 });
    const d1 = deferred<string>();
    const p1 = b.run(() => d1.promise);
    expect(b.active).toBe(1);

    const err = await expectReject(b.run(() => Promise.resolve('x')));
    expect(err instanceof BulkheadFullError).toBe(true);

    d1.resolve('done');
    expect(await p1).toBe('done');
    expect(b.active).toBe(0);
  });
});

describe('Bulkhead cancellation', () => {
  it('rejects without queueing when the signal is already aborted', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    let calls = 0;

    let caught: unknown;
    try {
      await bulkhead.run(() => {
        calls++;
        return Promise.resolve('x');
      }, controller.signal);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(reason);
    expect(calls).toBe(0);
    expect(bulkhead.active).toBe(0);
  });

  it('rejects a queued waiter on abort and never runs its protected call', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 2 });
    const gate = Promise.withResolvers<string>();
    let queuedCalls = 0;

    // Occupy the only slot.
    const holder = bulkhead.run(() => gate.promise);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bulkhead.active).toBe(1);

    const controller = new AbortController();
    const queued = bulkhead.run(() => {
      queuedCalls++;
      return Promise.resolve('should never run');
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bulkhead.queued).toBe(1);

    const reason = new Error('caller went away');
    controller.abort(reason);

    let caught: unknown;
    try {
      await queued;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(reason);
    // The defect this closes: a cancelled waiter used to keep its queue slot
    // and eventually execute.
    expect(queuedCalls).toBe(0);
    expect(bulkhead.queued).toBe(0);

    gate.resolve('done');
    await holder;
    expect(bulkhead.active).toBe(0);
  });

  it('frees queue depth immediately so a later waiter is admitted', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 1 });
    const gate = Promise.withResolvers<string>();
    const holder = bulkhead.run(() => gate.promise);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const controller = new AbortController();
    const abandoned = bulkhead.run(() => Promise.resolve('a'), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bulkhead.queued).toBe(1);

    controller.abort(new Error('gone'));
    await expect(abandoned).rejects.toThrow('gone');

    // Depth was released synchronously, so this does NOT hit BulkheadFullError.
    const admitted = bulkhead.run(() => Promise.resolve('b'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bulkhead.queued).toBe(1);

    gate.resolve('done');
    await holder;
    expect(await admitted).toBe('b');
  });

  it('hands the protected call a live signal when none is supplied', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1 });
    let seen: boolean | undefined;
    await bulkhead.run((signal) => {
      seen = signal.aborted;
      return Promise.resolve('ok');
    });
    expect(seen).toBe(false);
  });
});
