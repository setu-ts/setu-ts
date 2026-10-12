import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';

/** Builds an unstarted application sharing one worker slot between modules. */
export function createWorkerPoolApp(): IKernelApplication {
  return createApplication({
    plugins: [RuntimePlugin(), HealthPlugin(), WorkerPoolPlugin({ maxWorkers: 1 })],
  });
}
