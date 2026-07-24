/**
 * E2E fixture task: doubles a number and tags the payload so the test can
 * prove the work happened on a worker thread. Imports the worker helper via
 * the runtime package's `./worker` subpath, exactly as an application would.
 */
import { defineWorkerTask } from '@hono-enterprise/runtime/worker';

defineWorkerTask<{ n: number }, { doubled: number; from: string }>((input) => ({
  doubled: input.n * 2,
  from: 'worker',
}));
