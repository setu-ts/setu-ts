/**
 * Sets flag 0 on entry, blocks for `waitMs`, then sets flag 2: a test that
 * aborts during the wait proves termination by flag 2 staying 0.
 */
import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<{ state: SharedArrayBuffer; waitMs: number }, string>(({ state, waitMs }) => {
  const flags = new Int32Array(state);
  Atomics.store(flags, 0, 1);
  if (waitMs > 0) Atomics.wait(flags, 1, 0, waitMs);
  // Reached only by a worker that was not terminated during the wait.
  Atomics.store(flags, 2, 1);
  return 'done';
});
