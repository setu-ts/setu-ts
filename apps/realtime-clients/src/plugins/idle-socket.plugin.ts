import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IWebSocketService } from '@setu-ts/common';
import { IDLE_SOCKET_PATH } from '../contract.ts';

/** Registers a WebSocket route that never sends, once `WebSocketPlugin` has registered. */
export function IdleSocketPlugin(): IPlugin {
  return {
    name: 'idle-socket',
    version: '0.1.0',
    dependencies: ['websocket-plugin'],
    register(ctx): void {
      ctx.services
        .get<IWebSocketService>(CAPABILITIES.WEBSOCKET)
        .route(IDLE_SOCKET_PATH, { onOpen: () => {} });
    },
  };
}
