import { CAPABILITIES } from '@hono-enterprise/common';
import type { ICloudflareBindings, IKvNamespace } from '@hono-enterprise/cloudflare-plugin';
import { CloudflarePlugin } from '@hono-enterprise/cloudflare-plugin';
import type { CloudflareWorkerEnv } from '@hono-enterprise/cloudflare-plugin';
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

/** Creates a Worker-compatible application with an injected KV binding. */
export function createCloudflareApp(env: CloudflareWorkerEnv): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ platform: 'cloudflare-workers', env }),
      CloudflarePlugin({ env, requireBindings: ['EXAMPLE_KV'] }),
    ],
  });
  app.router.post('/value/:key', async (ctx) => {
    const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    const kv: IKvNamespace = bindings.kv('EXAMPLE_KV');
    const input = await ctx.request.json<{ value: string }>();
    await kv.put(ctx.params.key, input.value);
    return ctx.response.status(204).send();
  });
  app.router.get('/value/:key', async (ctx) => {
    const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    const value = await bindings.kv('EXAMPLE_KV').get(ctx.params.key);
    return value === null
      ? ctx.response.status(404).json({ error: 'not found' })
      : ctx.response.json({ value });
  });
  return app;
}
