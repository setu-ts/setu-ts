import { createScheduledHandler, WorkersCron } from '@hono-enterprise/cloudflare-plugin';
import type { CloudflareWorkerEnv, IScheduledController } from '@hono-enterprise/cloudflare-plugin';
import { createCloudflareApp } from './src/app.ts';

interface WorkerEnvironment extends CloudflareWorkerEnv {
  readonly EXAMPLE_KV: object;
}

let application: Promise<ReturnType<typeof createCloudflareApp>> | undefined;
const cron = new WorkersCron().on('*/5 * * * *', () => Promise.resolve());

async function app(env: WorkerEnvironment): Promise<ReturnType<typeof createCloudflareApp>> {
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
  scheduled(controller: IScheduledController): Promise<void> {
    return createScheduledHandler(cron)(controller);
  },
};
