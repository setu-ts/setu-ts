/**
 * Real-worker e2e fixture: doubles a number and tags the payload so the test
 * can prove the work happened on the worker side.
 */
import { defineWorkerTask } from '../../src/worker/define-worker-task.ts';

defineWorkerTask<{ n: number }, { doubled: number; from: string }>((input) => ({
  doubled: input.n * 2,
  from: 'worker',
}));
