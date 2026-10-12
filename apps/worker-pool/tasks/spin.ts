import { defineWorkerTask } from '@setu-ts/runtime/worker';

/** Deliberately CPU-bound application work; executes on a worker thread. */
export function spin(ms: number): number {
  const started = performance.now();
  while (performance.now() - started < ms) {
    // Busy work is intentional: yielding here would not prove thread isolation.
  }
  return performance.now() - started;
}

defineWorkerTask<number, number>(spin);
