import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, IRouterApi } from '@setu-ts/common';
import type { ICloudflareBindings, IKvNamespace } from '@setu-ts/cloudflare-plugin';
import { BINDINGS } from '../../bindings.ts';

function kv(ctx: IRequestContext): IKvNamespace {
  return ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE).kv(BINDINGS.kv);
}

/** Registers routes that read and write the KV namespace by key. */
export function registerValuesRoutes(router: IRouterApi): void {
  router.group('/value', (routes) => {
    routes.post('/:key', async (ctx) => {
      const { value } = await ctx.request.json<{ value: string }>();
      await kv(ctx).put(ctx.params.key, value);
      return ctx.response.status(204).send();
    });

    routes.get('/:key', async (ctx) => {
      const value = await kv(ctx).get(ctx.params.key);
      return value === null
        ? ctx.response.status(404).json({ error: 'not found' })
        : ctx.response.json({ value });
    });
  });
}
