/**
 * `ProcessOptions.concurrency` is a committed option, so the helper honouring
 * it has to actually bound overlap — the failure mode is silent, since a queue
 * that ignores the limit still processes every message.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { runBounded } from '../../../src/queues/bounded-map.ts';

/** Tracks how many calls were in flight at once. */
function tracker(): {
  readonly run: (item: number) => Promise<void>;
  readonly order: number[];
  peak(): number;
} {
  let inFlight = 0;
  let peak = 0;
  const order: number[] = [];

  return {
    order,
    peak: () => peak,
    run: async (item: number): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // A real await, so overlap is observable rather than collapsed by the
      // microtask queue resolving everything in registration order.
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(item);
      inFlight -= 1;
    },
  };
}

describe('runBounded', () => {
  it('never overlaps at a limit of 1, and preserves order', async () => {
    const track = tracker();
    await runBounded([1, 2, 3, 4], 1, track.run);

    expect(track.peak()).toBe(1);
    expect(track.order).toEqual([1, 2, 3, 4]);
  });

  it('peaks at exactly the limit when there is more work than lanes', async () => {
    const track = tracker();
    await runBounded([1, 2, 3, 4, 5, 6, 7], 3, track.run);

    expect(track.peak()).toBe(3);
    expect(track.order).toHaveLength(7);
  });

  it('runs everything at once when the limit is at or above the item count', async () => {
    const track = tracker();
    await runBounded([1, 2, 3], 5, track.run);

    expect(track.peak()).toBe(3);
  });

  it('treats a limit below 1 as 1 rather than stalling', async () => {
    const track = tracker();
    await runBounded([1, 2], 0, track.run);

    expect(track.peak()).toBe(1);
    expect(track.order).toEqual([1, 2]);
  });

  it('floors a fractional limit', async () => {
    const track = tracker();
    await runBounded([1, 2, 3, 4], 2.9, track.run);

    expect(track.peak()).toBe(2);
  });

  it('still runs every item after one throws, then rethrows the first failure', async () => {
    // The whole point of the held-back rethrow: `Promise.all` would abandon
    // items 3 and 4, leaving those messages neither acked nor retried.
    const seen: number[] = [];
    await expect(
      runBounded([1, 2, 3, 4], 1, (item) => {
        seen.push(item);
        return item === 2 ? Promise.reject(new Error('boom')) : Promise.resolve();
      }),
    ).rejects.toThrow('boom');

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('rethrows the FIRST failure when several items throw', async () => {
    await expect(
      runBounded(
        [1, 2, 3],
        1,
        (item) =>
          item === 1
            ? Promise.reject(new Error('first'))
            : item === 3
            ? Promise.reject(new Error('third'))
            : Promise.resolve(),
      ),
    ).rejects.toThrow('first');
  });

  it('does nothing for an empty list', async () => {
    let calls = 0;
    await runBounded([], 4, () => {
      calls += 1;
      return Promise.resolve();
    });

    expect(calls).toBe(0);
  });
});
