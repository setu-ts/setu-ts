/**
 * The WebSocket handshake on real workerd (V13-278): a Setu app that receives
 * edge requests directly.
 *
 * Routes:
 * - `GET /ws` (WebSocket): counts each connection that opens.
 * - `GET /opens`: how many `/ws` connections have opened in this isolate.
 * - `GET /last-handshake`: what the Worker itself received on the last `/ws`
 *   request — whether `cf` was set, and its `Sec-WebSocket-Key` and version.
 * - `GET /self-socket`: opens a socket to this Worker's own `/ws` over the
 *   `SELF` service binding, the way one Worker calls another — `Upgrade` and
 *   `Connection` only, no key — and answers the status.
 *
 * @module
 */
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '@setu-ts/websocket-plugin';

interface Env {
  readonly SELF: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** The client half workerd puts on a 101 from `fetch`. */
interface UpgradedSocket {
  accept(): void;
  close(code?: number): void;
}

let opens = 0;
let lastHandshake: { cf: boolean; key: string | null; version: string | null } | undefined;
let booted: Promise<IKernelApplication> | undefined;

/** Builds the app once per isolate. */
async function build(): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ platform: 'cloudflare-workers' }),
      WebSocketPlugin({
        routes: [
          {
            path: '/ws',
            handlers: {
              onOpen: () => {
                opens++;
              },
            },
          },
        ],
      }),
    ],
  });
  app.router.get('/opens', { handler: (ctx) => ctx.response.text(String(opens)) });
  await app.start();
  return app;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/ws') {
      lastHandshake = {
        cf: (request as Request & { cf?: unknown }).cf !== undefined,
        key: request.headers.get('sec-websocket-key'),
        version: request.headers.get('sec-websocket-version'),
      };
    }
    if (path === '/last-handshake') return Response.json(lastHandshake ?? null);
    if (path === '/self-socket') {
      const response = await env.SELF.fetch('https://self/ws', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      });
      const socket = (response as Response & { webSocket?: UpgradedSocket | null }).webSocket;
      if (socket) {
        socket.accept();
        socket.close(1000);
      }
      return new Response(String(response.status));
    }
    booted ??= build();
    return (await booted).fetch(request);
  },
};
