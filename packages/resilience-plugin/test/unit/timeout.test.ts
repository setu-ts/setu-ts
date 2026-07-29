import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { runWithTimeout } from '../../src/patterns/timeout.ts';
import { TimeoutError } from '../../src/errors.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('runWithTimeout', () => {
  it('returns the value when fn settles before the deadline and clears the timer', async () => {
    const runtime = new FakeRuntime();
    const result = await runWithTimeout(() => Promise.resolve('fast'), 1000, runtime);
    expect(result).toBe('fast');
    // The deadline was armed with the requested ms.
    expect(runtime.armedDelays).toEqual([1000]);
    // Let any (cleared) macrotask drain — no unhandled rejection must surface.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('propagates the fn error when it rejects before the deadline', async () => {
    const runtime = new FakeRuntime();
    let caught: unknown;
    try {
      await runWithTimeout(() => Promise.reject(new Error('inner')), 1000, runtime);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('inner');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('rejects with TimeoutError when fn never settles before the deadline', async () => {
    const runtime = new FakeRuntime();
    let caught: unknown;
    try {
      await runWithTimeout(() => new Promise<string>(() => {}), 5, runtime);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof TimeoutError).toBe(true);
    expect(runtime.armedDelays).toEqual([5]);
  });
});

describe('runWithTimeout cancellation', () => {
  it('aborts the signal it handed the call, using the TimeoutError as the reason', async () => {
    const runtime = new FakeRuntime();
    let observed: AbortSignal | undefined;
    let caught: unknown;
    try {
      await runWithTimeout(
        (signal) => {
          observed = signal;
          return new Promise<string>(() => {});
        },
        5,
        runtime,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof TimeoutError).toBe(true);
    expect(observed?.aborted).toBe(true);
    // One error identity: what the caller catches is what `signal.reason` holds.
    expect(observed?.reason).toBe(caught);
  });

  it('leaves the signal unaborted when the call settles in time', async () => {
    const runtime = new FakeRuntime();
    let observed: AbortSignal | undefined;
    const result = await runWithTimeout(
      (signal) => {
        observed = signal;
        return Promise.resolve('fast');
      },
      1000,
      runtime,
    );
    expect(result).toBe('fast');
    expect(observed?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('links an outer abort through to the protected call with the caller reason', async () => {
    const runtime = new FakeRuntime();
    const outer = new AbortController();
    let observed: AbortSignal | undefined;

    const pending = runWithTimeout(
      (signal) => {
        observed = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      10_000,
      runtime,
      outer.signal,
    );

    const reason = new Error('caller cancelled');
    outer.abort(reason);

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(observed?.aborted).toBe(true);
    expect(caught).toBe(reason);
  });

  it('aborts immediately when the outer signal was already aborted', async () => {
    const runtime = new FakeRuntime();
    const outer = new AbortController();
    outer.abort(new Error('already gone'));
    let seenAbortedAtEntry: boolean | undefined;

    const result = await runWithTimeout(
      (signal) => {
        seenAbortedAtEntry = signal.aborted;
        return Promise.resolve('ran anyway');
      },
      1000,
      runtime,
      outer.signal,
    );

    // The call is still invoked, but it is handed an already-aborted signal, so
    // a signal-aware call short-circuits rather than starting real work.
    expect(seenAbortedAtEntry).toBe(true);
    expect(result).toBe('ran anyway');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
