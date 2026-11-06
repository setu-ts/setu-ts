import { unusedPort } from '../../../../test/node-helpers.ts';
/**
 * End to end: a real Node listener refuses a cross-site WebSocket handshake
 * with `403` before the handshake completes, and still upgrades same-origin,
 * listed and header-less (non-browser) clients.
 *
 * The handshake is sent with `node:http` so the exact status of a refusal is
 * observable (`response`) as distinct from an accepted upgrade (`upgrade`).
 */
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { REQUEST_ORIGIN_STATE_KEY } from '@setu-ts/common';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { WebSocketPlugin } from '../../src/index.ts';
import type { WebSocketPluginOptions } from '../../src/index.ts';

const LISTED = 'https://app.example.com';

/** Sends one handshake; resolves `'upgraded'` or the refusal status. */
function handshake(
  port: number,
  origin?: string,
  extra: Record<string, string> = {},
): Promise<'upgraded' | number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(origin === undefined ? {} : { origin }),
        ...extra,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve('upgraded');
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(
  options: WebSocketPluginOptions,
  publish?: string,
): Promise<{ port: number; opens: () => number; stop: () => Promise<void> }> {
  let opens = 0;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      WebSocketPlugin({
        ...options,
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
  if (publish !== undefined) {
    // What IP security publishes for a trusted proxy's forwarded host.
    app.middleware.add(
      async (ctx, next) => {
        ctx.state.set(REQUEST_ORIGIN_STATE_KEY, { protocol: 'https', host: publish });
        await next();
      },
      { priority: 10, name: 'published-origin' },
    );
  }
  const port = await unusedPort();
  await app.start({ port });
  return { port, opens: () => opens, stop: () => app.stop() };
}

describe('WebSocket Origin check on a real listener', () => {
  it('refuses another site with 403 and never opens it', async () => {
    const server = await serve({ allowedOrigins: [LISTED] });
    try {
      expect(await handshake(server.port, 'https://evil.example')).toBe(403);
      expect(server.opens()).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('upgrades a same-origin page, a listed origin and a client with no Origin', async () => {
    const server = await serve({ allowedOrigins: [LISTED] });
    try {
      expect(await handshake(server.port, `http://127.0.0.1:${server.port}`)).toBe('upgraded');
      expect(await handshake(server.port, LISTED)).toBe('upgraded');
      expect(await handshake(server.port)).toBe('upgraded');
    } finally {
      await server.stop();
    }
  });

  it('compares against the origin a trusted proxy published', async () => {
    const server = await serve({}, 'public.example');
    try {
      expect(await handshake(server.port, 'https://public.example')).toBe('upgraded');
      // The internal address is no longer this app's origin.
      expect(await handshake(server.port, `http://127.0.0.1:${server.port}`)).toBe(403);
    } finally {
      await server.stop();
    }
  });

  // The real IP security, not a stand-in: a trusted TLS-terminating proxy's
  // forwarded host and protocol become the public origin, and the same
  // headers from an untrusted peer change nothing.
  for (const trusted of [true, false]) {
    it(`uses a forwarded origin only from a trusted proxy (trusted=${String(trusted)})`, async () => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          HttpSecurityPlugin({
            ipSecurity: { trustProxy: true, trustedProxies: [trusted ? '127.0.0.1' : '10.9.9.9'] },
          }),
          WebSocketPlugin({
            routes: [{ path: '/ws', handlers: {} }],
          }),
        ],
      });
      const port = await unusedPort();
      await app.start({ port });
      try {
        const forwarded = {
          'x-forwarded-for': '203.0.113.9',
          'x-forwarded-host': 'public.example',
          'x-forwarded-proto': 'https',
        };
        expect(await handshake(port, 'https://public.example', forwarded)).toBe(
          trusted ? 'upgraded' : 403,
        );
        expect(await handshake(port, `http://127.0.0.1:${port}`, forwarded)).toBe(
          trusted ? 403 : 'upgraded',
        );
        expect(await handshake(port, 'https://evil.example', forwarded)).toBe(403);
      } finally {
        await app.stop();
      }
    });
  }

  it('upgrades any origin with checkOrigin: false', async () => {
    const server = await serve({ checkOrigin: false });
    try {
      expect(await handshake(server.port, 'https://evil.example')).toBe('upgraded');
    } finally {
      await server.stop();
    }
  });

  it("refuses a browser-shaped WebSocket client's cross-site Origin", async () => {
    const server = await serve({});
    try {
      // Node's WebSocket sends a custom Origin through its non-standard
      // `headers` option, the shape a browser handshake has.
      const Ctor = WebSocket as unknown as new (
        url: string,
        init: { headers: Record<string, string> },
      ) => WebSocket;
      const socket = new Ctor(`ws://127.0.0.1:${server.port}/ws`, {
        headers: { origin: 'https://evil.example' },
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.onopen = () => resolve('open');
        socket.onerror = () => resolve('error');
      });
      expect(outcome).toBe('error');
      expect(server.opens()).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
