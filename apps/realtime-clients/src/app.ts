import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext, ISseService, IWebSocketService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';

let eventCount = 0;
let resumedWith: string | null = null;

/** Builds the real server used by every realtime-client runtime exercise. */
export function createRealtimeClientApp() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SsePlugin({ heartbeatMs: 10, retryMs: 1, scalingNotice: false }),
      WebSocketPlugin({
        heartbeatMs: 20,
        idleTimeoutMs: 60,
        scalingNotice: false,
      }),
      RealtimeRoutePlugin(),
    ],
  });

  app.router.get('/events', (ctx) => {
    if (ctx.request.headers.get('authorization') !== 'Bearer smoke-token') {
      return ctx.response.status(401).send();
    }
    eventCount += 1;
    resumedWith = ctx.request.headers.get('last-event-id');
    const connection = ctx.services.get<ISseService>(CAPABILITIES.SSE).open(
      ctx,
    );
    connection.send({
      id: String(eventCount),
      event: 'score',
      data: { eventCount },
    });
    setTimeout(() => connection.close(), 25);
    return connection.result;
  });

  app.router.get('/resume', (ctx) => ctx.response.json({ resumedWith }));

  return app;
}

/** Registers the socket route after WebSocketPlugin has supplied its capability. */
function RealtimeRoutePlugin(): IPlugin {
  return {
    name: 'realtime-client-smoke-routes',
    version: '0.1.0',
    dependencies: ['websocket-plugin'],
    register(context: IPluginContext): void {
      context.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET).route(
        '/ws/idle',
        { onOpen: () => {} },
      );
    },
  };
}
