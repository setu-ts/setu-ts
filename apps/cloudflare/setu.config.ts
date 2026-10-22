import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import type { CloudflareWorkerEnv } from '@setu-ts/cloudflare-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { BINDINGS } from './src/bindings.ts';
import { registerModules } from './src/modules/index.ts';
import { CloudflareRuntimePlugin } from './src/plugins/cloudflare-runtime.plugin.ts';
import { MessagingSubscriptionsPlugin } from './src/plugins/messaging-subscriptions.plugin.ts';

/** Builds the Worker application over the platform's `env`, without starting it. */
export function createApp(env: CloudflareWorkerEnv): IKernelApplication {
  const app = createApplication({
    plugins: [
      CloudflareRuntimePlugin(env),
      CloudflarePlugin({
        env,
        requireBindings: [BINDINGS.kv, BINDINGS.queue, BINDINGS.replyInbox],
        // Publish over a Cloudflare queue; replies to requests return through a Durable Object.
        messaging: { binding: BINDINGS.queue, rpc: { binding: BINDINGS.replyInbox } },
      }),
      MessagingSubscriptionsPlugin(),
    ],
  });

  registerModules(app.router);

  return app;
}
