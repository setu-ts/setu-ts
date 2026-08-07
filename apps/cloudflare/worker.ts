import { createScheduledHandler, WorkersCron } from '@setu-ts/cloudflare-plugin';
import type { CloudflareWorkerEnv, IScheduledController } from '@setu-ts/cloudflare-plugin';
import { createCloudflareApp } from './src/app.ts';

interface WorkerEnvironment extends CloudflareWorkerEnv {
  readonly EXAMPLE_KV: {
    put(key: string, value: string): Promise<void>;
  };
}

let application: Promise<ReturnType<typeof createCloudflareApp>> | undefined;
let scheduledRuns = 0;
const cron = new WorkersCron().on('*/5 * * * *', () => {
  scheduledRuns += 1;
  return Promise.resolve();
});

async function app(
  env: WorkerEnvironment,
): Promise<ReturnType<typeof createCloudflareApp>> {
  if (application === undefined) {
    application = Promise.resolve(createCloudflareApp(env));
    const created = await application;
    await created.start();
  }
  return await application;
}

export default {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    return app(env).then((created) => created.fetch(request));
  },
  async scheduled(
    controller: IScheduledController,
    env: WorkerEnvironment,
  ): Promise<void> {
    await createScheduledHandler(cron)(controller);
    await env.EXAMPLE_KV.put('scheduled-runs', String(scheduledRuns));
  },
};
