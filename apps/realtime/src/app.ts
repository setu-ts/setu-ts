import { CAPABILITIES } from '@setu-ts/common';
import type { ISseService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SsePlugin } from '@setu-ts/sse-plugin';

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
