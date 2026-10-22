import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, ISseService } from '@setu-ts/common';

/** The SSE channel every replica's subscribers join. */
export const NEWS_CHANNEL = 'news';

/**
 * Registers the news stream and its publish route.
 *
 * A message published on any replica reaches subscribers on every replica,
 * because the channel publishes through the realtime backplane.
 */
export function registerNewsRoutes(router: IRouterApi): void {
  router.get('/events', (ctx) => {
    const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
    const connection = sse.open(ctx);
    sse.channel(NEWS_CHANNEL).add(connection);
    return connection.result;
  });

  router.post('/publish', async (ctx) => {
    const { message } = await ctx.request.json<{ message: string }>();
    ctx.services
      .get<ISseService>(CAPABILITIES.SSE)
      .channel(NEWS_CHANNEL)
      .publish({ data: message });
    return ctx.response.status(204).send();
  });
}
