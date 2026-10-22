import { defineWorkerTask } from '@setu-ts/runtime/worker';

/** Busy-waits for the given number of milliseconds and returns how long it ran. */
defineWorkerTask<number, number>((milliseconds) => {
  const started = performance.now();
  while (performance.now() - started < milliseconds) {
    // Deliberately CPU-bound: yielding here would not prove the work left the main thread.
  }
  return performance.now() - started;
});
