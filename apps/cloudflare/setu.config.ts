import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import type { CloudflareWorkerEnv } from '@setu-ts/cloudflare-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { BINDINGS, WORKER_ENV } from './src/bindings.ts';
import { registerModules } from './src/modules/index.ts';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';

/** Builds the Worker application over the platform's `env`, without starting it. */
export function createApp(env: CloudflareWorkerEnv): IKernelApplication {
  const app = createApplication({
    plugins: [
      CloudflarePlugin({
        env,
        requireBindings: [BINDINGS.kv, BINDINGS.queue, BINDINGS.replyInbox],
        // Publish over a Cloudflare queue; replies to requests return through a Durable Object.
        messaging: { binding: BINDINGS.queue, rpc: { binding: BINDINGS.replyInbox } },
      }),
      ...GENERATED_PLUGINS,
    ],
  });

  // Generated plugin factories take no arguments. Keep this invocation's env
  // in the application registry so the runtime plugin can read it at startup.
  app.services.register(WORKER_ENV, env);
  registerModules(app.router, app.services);

  return app;
}
