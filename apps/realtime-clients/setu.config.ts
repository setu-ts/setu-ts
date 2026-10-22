import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SsePlugin } from '@setu-ts/sse-plugin';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { registerModules } from './src/modules/index.ts';
import { IdleSocketPlugin } from './src/plugins/idle-socket.plugin.ts';

/**
 * Builds the server every realtime-client runtime check drives, without starting it.
 *
 * The heartbeat and idle timings are short so a check finishes in milliseconds.
 */
export function createApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      SsePlugin({ heartbeatMs: 10, retryMs: 1, scalingNotice: false }),
      WebSocketPlugin({ heartbeatMs: 20, idleTimeoutMs: 60, scalingNotice: false }),
      IdleSocketPlugin(),
    ],
  });

  registerModules(app.router);

  return app;
}
