/** Signals entry into the handler before blocking, so abort tests prove running cancellation. */
import { defineWorkerTask } from '@setu-ts/runtime/worker';

defineWorkerTask<{ state: SharedArrayBuffer; waitMs: number }, string>(({ state, waitMs }) => {
  const flags = new Int32Array(state);
  Atomics.store(flags, 0, 1);
  if (waitMs > 0) Atomics.wait(flags, 1, 0, waitMs);
  return 'done';
});
