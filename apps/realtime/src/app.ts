import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { SsePlugin } from '@hono-enterprise/sse-plugin';

/** Builds one replica of the Redis-backed SSE composition. */
export function createRealtimeReplica(redisUrl: string): IKernelApplication {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      RealtimeBackplanePlugin({ transport: 'redis', url: redisUrl }),
      SsePlugin(),
    ],
  });
}
