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
