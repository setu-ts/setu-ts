/**
 * The application both fixture Workers run: a chat room on the Durable Object
 * backplane, built from the workspace sources (each `wrangler.toml` aliases the
 * `@setu-ts/*` imports to `packages/<name>/src`).
 *
 * Routes:
 * - `GET /chat?room=<name>` (WebSocket): joins the room (default `lobby`);
 *   each message is broadcast to that room except its sender.
 * - `POST /broadcast`: broadcasts the body to `lobby` from a route.
 * - `GET /size`: this isolate's `lobby` size.
 * - `GET /rooms-without-arm`: `ws.room()` on an app with no Durable Object arm.
 *
 * @module
 */
import { env, waitUntil } from 'cloudflare:workers';
import { CAPABILITIES } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { IWebSocketService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';

let booted: Promise<IKernelApplication> | undefined;
let bare: Promise<IKernelApplication> | undefined;

function build(withArm: boolean): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ env }),
      CloudflarePlugin({
        env,
        waitUntil,
        ...(withArm ? { durableObject: { binding: 'REALTIME', topic: 'chat' } } : {}),
      }),
      WebSocketPlugin({ heartbeatMs: 0 }),
    ],
  });
  const ws = (): IWebSocketService => app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
  return app.start().then(() => {
    if (!withArm) {
      app.router.get('/rooms-without-arm', {
        handler: (ctx) => {
          try {
            ws().room('lobby');
            return ctx.response.text('no error');
          } catch (error) {
            return ctx.response.status(500).text((error as Error).name);
          }
        },
      });
      return app;
    }
    ws().route('/chat', {
      onOpen: (conn, context) => {
        const room = context.query['room'] ?? 'lobby';
        conn.data.set('room', room);
        ws().room(room).add(conn);
      },
      onMessage: (conn, data) => {
        ws()
          .room(String(conn.data.get('room')))
          .broadcast(data, { except: conn });
      },
    });
    app.router.post('/broadcast', {
      handler: async (ctx) => {
        ws()
          .room('lobby')
          .broadcast(await ctx.request.text());
        return ctx.response.status(204).send();
      },
    });
    app.router.get('/size', {
      handler: (ctx) => {
        return ctx.response.text(String(ws().room('lobby').size));
      },
    });
    return app;
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/rooms-without-arm') {
      bare ??= build(false);
      return (await bare).fetch(request);
    }
    booted ??= build(true);
    return (await booted).fetch(request);
  },
};
