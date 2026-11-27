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
 * - `GET /opens`: how many `/chat` connections this isolate has opened.
 * - `GET /rooms-without-arm`: `ws.room()` on an app with no Durable Object arm.
 * - `POST /iso/publish?id=<id>`: publishes one frame on this isolate's own
 *   `DurableObjectBackplane` (the isolate-level path `sse-plugin` uses).
 * - `GET /iso/stats`: that backplane's socket opens, hub POSTs, warnings, and
 *   the ids it received from other isolates.
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
import { CloudflarePlugin, DurableObjectBackplane } from '@setu-ts/cloudflare-plugin';
import type { IDurableObjectNamespace } from '@setu-ts/cloudflare-plugin';
import type { ILogger, LogMetadata } from '@setu-ts/common';

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
        opens++;
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
    app.router.get('/opens', {
      handler: (ctx) => {
        return ctx.response.text(String(opens));
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

/** `/chat` connections this isolate has opened, for the handshake e2e. */
let opens = 0;

/** What this isolate's own backplane did, for the isolate-publish e2e. */
const iso = { opens: 0, posts: 0, warnings: [] as string[], received: [] as string[] };
let isoBackplane: DurableObjectBackplane | undefined;

/** A logger that records warnings and drops the rest. */
const isoLogger: ILogger = {
  level: 'warn',
  fatal: () => {},
  error: () => {},
  warn: (message: string, metadata?: LogMetadata) => {
    iso.warnings.push(`${message} ${JSON.stringify(metadata ?? {})}`);
  },
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => isoLogger,
};

/**
 * This isolate's backplane, over a namespace that counts what reaches the hub:
 * an upgrade is one socket open, a POST is one hub publish.
 */
function isolateBackplane(): DurableObjectBackplane {
  if (isoBackplane !== undefined) return isoBackplane;
  const real = (env as unknown as { REALTIME: IDurableObjectNamespace }).REALTIME;
  const counted: IDurableObjectNamespace = {
    idFromName: (name) => real.idFromName(name),
    get: (id) => {
      const stub = real.get(id);
      return {
        fetch: (input, init) => {
          if (init?.method === 'POST') iso.posts++;
          else iso.opens++;
          return stub.fetch(input, init);
        },
      };
    },
  };
  isoBackplane = new DurableObjectBackplane(counted, {
    origin: crypto.randomUUID(),
    binding: 'REALTIME',
    topic: 'iso',
    logger: () => isoLogger,
    waitUntil,
  });
  void isoBackplane.subscribe((frame) => {
    iso.received.push(frame.data);
  });
  return isoBackplane;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/iso/publish') {
      await isolateBackplane().publish({
        kind: 'sse-channel',
        origin: isolateBackplane().origin,
        name: 'news',
        data: url.searchParams.get('id') ?? '',
      });
      return new Response(null, { status: 204 });
    }
    if (path === '/iso/stats') {
      return Response.json(iso);
    }
    if (path === '/rooms-without-arm') {
      bare ??= build(false);
      return (await bare).fetch(request);
    }
    booted ??= build(true);
    return (await booted).fetch(request);
  },
};
