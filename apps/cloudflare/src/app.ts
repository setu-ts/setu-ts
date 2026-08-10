import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IPlugin, IPluginContext } from '@setu-ts/common';
import type { ICloudflareBindings, IKvNamespace } from '@setu-ts/cloudflare-plugin';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import type { CloudflareWorkerEnv } from '@setu-ts/cloudflare-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { CloudflareRuntimePlugin } from './cloudflare-runtime-plugin.ts';

/**
 * Registers the subscriptions and responders the `queue` export dispatches into.
 *
 * A plugin rather than a call in `createCloudflareApp`, because `IApplication`
 * exposes no lifecycle hook application code can register on — anything needing
 * a resolved capability has to be a plugin option or a plugin. Registering here
 * also means the registrations exist before the first `queue` invocation, which
 * is a DIFFERENT invocation from the `fetch` that published.
 */
function MessagingSubscriptions(): IPlugin {
  return {
    name: 'messaging-subscriptions',
    version: '0.0.0',
    dependencies: ['cloudflare-plugin'],

    async register(ctx: IPluginContext): Promise<void> {
      const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      const bindings = ctx.services.get<ICloudflareBindings>(
        CAPABILITIES.CLOUDFLARE,
      );

      await broker.subscribe<{ note: string }>(
        'audit.logged',
        async (message) => {
          // Written to KV so the smoke can observe a delivery that happened in a
          // DIFFERENT invocation of this Worker.
          await bindings.kv('EXAMPLE_KV').put('last-audit', message.note);
        },
      );
      await broker.respond<number, number>('double', (n) => n * 2);
    },
  };
}

/** Creates a Worker-compatible application with an injected KV binding. */
export function createCloudflareApp(
  env: CloudflareWorkerEnv,
): IKernelApplication {
  const app = createApplication({
    plugins: [
      CloudflareRuntimePlugin(env),
      CloudflarePlugin({
        env,
        requireBindings: ['EXAMPLE_KV', 'MESSAGES', 'REPLY_INBOX'],
        // Both halves of M59: publish/subscribe over a real Cloudflare queue,
        // and request/respond whose reply comes back through a real Durable
        // Object. Neither can be proven by a fake — the queue delivery is a
        // separate Worker invocation, and the reply crosses isolates.
        messaging: { binding: 'MESSAGES', rpc: { binding: 'REPLY_INBOX' } },
      }),
      MessagingSubscriptions(),
    ],
  });

  const broker = (): IMessageBroker => app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

  app.router.post('/publish/:note', async (ctx) => {
    await broker().publish('audit.logged', { note: ctx.params.note });
    return ctx.response.status(202).send();
  });

  app.router.get('/double/:n', async (ctx) => {
    const answer = await broker().request<number, number>(
      'double',
      Number(ctx.params.n),
      { timeoutMs: 20_000 },
    );
    return ctx.response.json({ answer });
  });

  app.router.post('/value/:key', async (ctx) => {
    const bindings = ctx.services.get<ICloudflareBindings>(
      CAPABILITIES.CLOUDFLARE,
    );
    const kv: IKvNamespace = bindings.kv('EXAMPLE_KV');
    const input = await ctx.request.json<{ value: string }>();
    await kv.put(ctx.params.key, input.value);
    return ctx.response.status(204).send();
  });
  app.router.get('/value/:key', async (ctx) => {
    const bindings = ctx.services.get<ICloudflareBindings>(
      CAPABILITIES.CLOUDFLARE,
    );
    const value = await bindings.kv('EXAMPLE_KV').get(ctx.params.key);
    return value === null
      ? ctx.response.status(404).json({ error: 'not found' })
      : ctx.response.json({ value });
  });
  return app;
}
