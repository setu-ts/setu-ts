import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RealtimeBackplanePlugin } from '@setu-ts/realtime-backplane-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { registerModules } from './src/modules/index.ts';

/** Builds one replica of the Redis-backed SSE application, without starting it. */
export function createApp(redisUrl: string): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      RealtimeBackplanePlugin({ transport: 'redis', url: redisUrl }),
      SsePlugin(),
    ],
  });

  registerModules(app.router);

  return app;
}
