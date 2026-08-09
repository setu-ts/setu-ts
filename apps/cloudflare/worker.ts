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
    // One memoized promise covers both creation AND startup. A concurrent caller
    // awaits the same in-flight promise and never receives an unstarted application.
    // Startup failure propagates to every waiter; the source-documented retry policy
    // is a fresh Worker invocation (the promise is NOT reset on rejection).
    application = (async () => {
      const created = createCloudflareApp(env);
      await created.start();
      return created;
    })();
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
