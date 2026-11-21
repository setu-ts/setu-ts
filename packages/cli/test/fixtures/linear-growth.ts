/**
 * A growth assertion for scans that must stay linear.
 *
 * A wall-clock limit ("under two seconds") fails a linear scan on a slow or busy
 * machine and passes a quadratic one on a fast machine. Growth does neither: a
 * linear scan takes about 4 times as long on 4 times the input and a quadratic one
 * about 16 times, on any machine. One measurement can still be thrown off by a
 * burst of other work, so each attempt compares the fastest of several interleaved
 * runs, and a scan passes if any of three attempts is under the limit. A quadratic
 * scan is over it every time.
 *
 * @module
 */
import { expect } from 'vitest';

/** Between a linear scan's 4 and a quadratic scan's 16. */
const GROWTH_LIMIT = 8;
const FACTOR = 4;
const PAIRS = 5;
const ATTEMPTS = 3;

/** One attempt: the ratio of the fastest large run to the fastest small run. */
function growth(small: () => unknown, large: () => unknown): number {
  let fastestSmall = Infinity;
  let fastestLarge = Infinity;
  for (let pair = 0; pair < PAIRS; pair++) {
    let started = performance.now();
    small();
    fastestSmall = Math.min(fastestSmall, performance.now() - started);
    started = performance.now();
    large();
    fastestLarge = Math.min(fastestLarge, performance.now() - started);
  }
  // A run too fast for the timer to resolve must not divide by zero.
  return fastestLarge / Math.max(fastestSmall, 0.01);
}

/**
 * Asserts that the work `build(size)` returns grows about linearly from `small` to
 * four times `small`.
 *
 * `build` runs once per size, outside the timer, so preparing the input is not
 * measured.
 *
 * @param label - What is being measured, for the failure message
 * @param build - Returns the work to time for an input of the given size
 * @param small - The smaller input size; the larger is four times this
 */
export function expectLinearGrowth(
  label: string,
  build: (size: number) => () => unknown,
  small: number,
): void {
  const smallRun = build(small);
  const largeRun = build(small * FACTOR);
  smallRun(); // warm up
  const ratios: number[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const ratio = growth(smallRun, largeRun);
    if (ratio < GROWTH_LIMIT) return;
    ratios.push(ratio);
  }
  expect.fail(
    `${label}: ${FACTOR}x the input took ${ratios.map((ratio) => ratio.toFixed(1)).join(', ')} ` +
      `times as long in ${ATTEMPTS} attempts; a linear scan takes about ${FACTOR}, the limit is ${GROWTH_LIMIT}`,
  );
}
