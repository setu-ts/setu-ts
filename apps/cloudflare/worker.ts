import { createScheduledHandler, WorkersCron } from '@setu-ts/cloudflare-plugin';
import type { CloudflareWorkerEnv, IScheduledController } from '@setu-ts/cloudflare-plugin';
import { createCloudflareApp } from './src/app.ts';
import type { IKernelApplication } from '@setu-ts/kernel';

interface WorkerEnvironment extends CloudflareWorkerEnv {
  readonly EXAMPLE_KV: {
    put(key: string, value: string): Promise<void>;
  };
}

let scheduledRuns = 0;
const cron = new WorkersCron().on('*/5 * * * *', () => {
  scheduledRuns += 1;
  return Promise.resolve();
});

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response>;
}

export function createWorkerHandler(
  createApp: (env: WorkerEnvironment) => IKernelApplication = createCloudflareApp,
): WorkerHandler {
  let application: Promise<IKernelApplication> | undefined;
  const app = (env: WorkerEnvironment): Promise<IKernelApplication> => {
    if (application === undefined) {
      // Rejection is deliberately cached for the lifetime of this isolate. All
      // concurrent and later callers observe the same startup failure, and no
      // request reaches fetch on a partially initialized application.
      application = (async () => {
        const created = createApp(env);
        await created.start();
        return created;
      })();
    }
    return application;
  };

  return {
    fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
      return app(env).then((created) => created.fetch(request));
    },
  };
}

const workerHandler = createWorkerHandler();

export default {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    return workerHandler.fetch(request, env);
  },
  async scheduled(
    controller: IScheduledController,
    env: WorkerEnvironment,
  ): Promise<void> {
    await createScheduledHandler(cron)(controller);
    await env.EXAMPLE_KV.put('scheduled-runs', String(scheduledRuns));
  },
};
