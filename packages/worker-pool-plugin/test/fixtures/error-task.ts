/**
 * E2E fixture task: always throws, so the test can assert the remote error
 * crosses the thread boundary as a WorkerTaskError.
 */
import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<unknown, never>(() => {
  throw new RangeError('worker says no');
});
