import { HealthPlugin } from '@setu-ts/health-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';

/** Builds an application whose task modules share one worker slot, without starting it. */
export function createApp(): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      // `details` makes `/health` show the pool's budget, which is hidden by default.
      HealthPlugin({ details: true }),
      WorkerPoolPlugin({ maxWorkers: 1 }),
    ],
  });
}
