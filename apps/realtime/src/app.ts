import { CAPABILITIES } from '@hono-enterprise/common';
import type { ISseService } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { SsePlugin } from '@hono-enterprise/sse-plugin';

/** Builds one replica of the Redis-backed SSE composition. */
export function createRealtimeReplica(redisUrl: string): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      RealtimeBackplanePlugin({ transport: 'redis', url: redisUrl }),
      SsePlugin(),
    ],
  });
  app.router.get('/events', (ctx) => {
    const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
    const connection = sse.open(ctx);
    sse.channel('news').add(connection);
    return connection.result;
  });
  app.router.post('/publish', async (ctx) => {
    const payload = await ctx.request.json<{ message: string }>();
    ctx.services.get<ISseService>(CAPABILITIES.SSE).channel('news').publish({
      data: payload.message,
    });
    return ctx.response.status(204).send();
  });
  return app;
}
