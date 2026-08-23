/**
 * Real-worker fixture for the X8-7 exit signal: wires itself with
 * `defineWorkerTask`, answers the first request, and then ends its OWN thread.
 *
 * `process.exit()` rather than `self.close()` because this fixture is spawned
 * through `node:worker_threads` — the only host that reports an exit on a
 * runtime CI runs (see `worker-exit-real.test.ts`). Ending the thread raises no
 * `'error'`, which is exactly why `onError` cannot stand in for `onExit`.
 */
import process from 'node:process';
import { defineWorkerTask } from '../../src/worker/define-worker-task.ts';

defineWorkerTask<{ n: number }, { doubled: number }>((input) => {
  // Leave after the reply has been posted, so the test observes a settled task
  // followed by a thread that is simply gone.
  setTimeout(() => process.exit(0), 50);
  return { doubled: input.n * 2 };
});
