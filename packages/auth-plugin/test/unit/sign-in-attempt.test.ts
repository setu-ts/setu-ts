/**
 * The bounded provider round trip behind every sign-in exchange (M100c F8):
 * the timeout holds even when the seam ignores its abort signal.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@setu-ts/common';

import { attempt } from '../../src/sign-in/routes.ts';

/** A runtime whose timers fire on the next macrotask, whatever the delay. */
function instantTimers(): { runtime: IRuntimeServices; cleared: number[] } {
  const cleared: number[] = [];
  let next = 0;
  const runtime = {
    setTimeout: (fn: () => void) => {
      const id = ++next;
      setTimeout(fn, 0);
      return id;
    },
    clearTimeout: (id: unknown) => {
      cleared.push(id as number);
    },
  } as unknown as IRuntimeServices;
  return { runtime, cleared };
}

describe('sign-in attempt()', () => {
  it('answers null when a seam ignores the signal and never settles', async () => {
    const { runtime, cleared } = instantTimers();
    let sawAbort = false;
    const outcome = await attempt(runtime, 10_000, (signal) => {
      signal.addEventListener('abort', () => (sawAbort = true));
      return new Promise<string>(() => {});
    });
    expect(outcome).toBeNull();
    expect(sawAbort).toBe(true);
    expect(cleared.length).toBe(1);
  });

  it('passes a settled value through and maps a throw to null', async () => {
    const { runtime } = instantTimers();
    expect(await attempt(runtime, 10_000, () => Promise.resolve('ok'))).toBe('ok');
    expect(await attempt(runtime, 10_000, () => Promise.reject(new Error('down')))).toBeNull();
  });
});
