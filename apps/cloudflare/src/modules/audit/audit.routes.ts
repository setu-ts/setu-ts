import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IRequestContext, IRouterApi } from '@setu-ts/common';
import { AUDIT_TOPIC, DOUBLE_TOPIC } from '../../bindings.ts';

function broker(ctx: IRequestContext): IMessageBroker {
  return ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
}

/** Registers a publish over the Cloudflare queue and a request/reply through a Durable Object. */
export function registerAuditRoutes(router: IRouterApi): void {
  router.post('/publish/:note', async (ctx) => {
    await broker(ctx).publish(AUDIT_TOPIC, { note: ctx.params.note });
    return ctx.response.status(202).send();
  });

  router.get('/double/:n', async (ctx) => {
    const answer = await broker(ctx).request<number, number>(DOUBLE_TOPIC, Number(ctx.params.n), {
      timeoutMs: 20_000,
    });
    return ctx.response.json({ answer });
  });
}
