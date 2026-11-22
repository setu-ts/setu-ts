/**
 * M143i on the real Node server (`@hono/node-server`): a refused upgrade
 * carries the framework response (V13-53), `HEAD` answers with the `GET`'s
 * headers (V13-113), a failed response stream is logged once and never
 * printed raw or written into the body (V13-256), the drain sends HTTP/2
 * GOAWAY while in-flight work finishes (V13-23), and `ctx.defer` runs once
 * whether the client reads to the end or leaves (V13-200).
 *
 * @module
 */
import { connect as http2Connect } from 'node:http2';
import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin, IRequest, IResponse, LogMetadata } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';

import { NodeHttpAdapter, RuntimePlugin } from '../../src/index.ts';
import { unusedPort } from '../../../../test/node-helpers.ts';

const encoder = new TextEncoder();

/** Lines a logger plugin captured. */
type Line = { level: string; message: string; metadata: LogMetadata | undefined };

/** A logger plugin recording every line. */
function capturing(lines: Line[]): IPlugin {
  const record =
    (level: string) =>
    (message: string, metadata?: LogMetadata): void => {
      lines.push({ level, message, metadata });
    };
  const logger: ILogger = {
    level: 'trace',
    fatal: record('fatal'),
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    child: () => logger,
  };
  return {
    name: 'capture',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx) {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

/** Sends raw bytes and collects the reply until the server closes. */
function raw(port: number, request: string, waitMs = 1_500): Promise<string> {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(request));
    let reply = '';
    socket.on('data', (chunk) => {
      reply += chunk.toString('latin1');
    });
    const done = (): void => resolve(reply);
    socket.on('close', done);
    socket.on('error', done);
    setTimeout(() => {
      socket.destroy();
    }, waitMs);
  });
}

const apps: IKernelApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  vi.restoreAllMocks();
});

/** Starts an application on a fresh port. */
async function serve(
  setup: (app: IKernelApplication) => void,
  plugins: IPlugin[] = [],
  runtimeOptions: Parameters<typeof RuntimePlugin>[0] = {},
): Promise<number> {
  const port = await unusedPort();
  const app = createApplication({ plugins: [RuntimePlugin(runtimeOptions), ...plugins] });
  setup(app);
  await app.start({ port, hostname: '127.0.0.1', drainTimeoutMs: 5_000 });
  apps.push(app);
  return port;
}

describe('a refused upgrade on Node (V13-53)', () => {
  it('answers with the framework response, as Bun and Deno do', async () => {
    const port = await unusedPort();
    const adapter = new NodeHttpAdapter();
    // An installed router is what attaches Node's raw `upgrade` listener.
    adapter.setUpgradeRouter(() => Promise.resolve(null));
    adapter.setHandler((_request: IRequest): IResponse => {
      const headers = new Headers({ 'content-type': 'application/problem+json' });
      const body = '{"title":"Unauthorized","status":401}';
      return {
        snapshot: () => ({ streaming: false, status: 401, headers, body }),
      } as unknown as IResponse;
    });
    const handle = await adapter.listen(port, '127.0.0.1');
    try {
      const reply = await raw(
        port,
        'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      expect(reply.startsWith('HTTP/1.1 401 Unauthorized\r\n')).toBe(true);
      expect(reply).toContain('content-type: application/problem+json');
      expect(reply.endsWith('{"title":"Unauthorized","status":401}')).toBe(true);
    } finally {
      await adapter.close(handle);
    }
  });
});

describe('a client that resets a refused upgrade (security audit)', () => {
  it('cannot crash the process, whether it resets after the refusal or while it is decided', async () => {
    const crashes: unknown[] = [];
    const onCrash = (error: unknown): void => {
      crashes.push(error);
    };
    process.on('uncaughtException', onCrash);
    const port = await unusedPort();
    const adapter = new NodeHttpAdapter();
    adapter.setUpgradeRouter(() => Promise.resolve(null));
    adapter.setHandler(async (request: IRequest): Promise<IResponse> => {
      if (request.headers.get('x-slow') === '1') {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const headers = new Headers();
      return {
        snapshot: () => ({ streaming: false, status: 401, headers, body: 'no' }),
      } as unknown as IResponse;
    });
    const handle = await adapter.listen(port, '127.0.0.1');
    const upgrade = (slow: boolean): string =>
      `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${
        slow ? 'x-slow: 1\r\n' : ''
      }Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const reset = (slow: boolean): Promise<void> =>
      new Promise((resolve) => {
        const socket = netConnect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => {
          socket.write(upgrade(slow));
          if (slow) setTimeout(() => socket.resetAndDestroy(), 30);
        });
        socket.on('data', () => socket.resetAndDestroy());
        socket.on('error', () => {});
        socket.on('close', () => resolve());
      });
    try {
      for (let i = 0; i < 5; i++) await Promise.all([reset(false), reset(true)]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(crashes).toEqual([]);
      const reply = await raw(port, upgrade(false));
      expect(reply.startsWith('HTTP/1.1 401 Unauthorized\r\n')).toBe(true);
    } finally {
      process.off('uncaughtException', onCrash);
      await adapter.close(handle);
    }
  });
});

describe('HEAD on a real server (V13-113)', () => {
  it('answers a GET route with its content-length and no body', async () => {
    const port = await serve((app) => {
      app.router.get('/doc', (ctx) => {
        return ctx.response.json({ hello: 'world' });
      });
    });
    const get = await fetch(`http://127.0.0.1:${port}/doc`);
    const getLength = get.headers.get('content-length');
    expect(getLength).not.toBeNull();
    await get.text();
    const head = await fetch(`http://127.0.0.1:${port}/doc`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(getLength);
    expect(await head.text()).toBe('');
  });
});

describe('a failed response stream on Node (V13-256)', () => {
  it('logs once through the logger, prints nothing, and cuts the response off', async () => {
    const lines: Line[] = [];
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const announced = vi.spyOn(console, 'info').mockImplementation(() => {});
    const port = await serve(
      (app) => {
        app.router.get('/broken', (ctx) => {
          let sent = false;
          return ctx.response.stream(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sent) {
                  sent = true;
                  controller.enqueue(encoder.encode('first'));
                  return;
                }
                controller.error(new Error('source failed'));
              },
            }),
          );
        });
      },
      [capturing(lines)],
    );
    const reply = await raw(port, 'GET /broken HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(reply.startsWith('HTTP/1.1 200')).toBe(true);
    expect(reply).not.toContain('source failed');
    // A clean chunked end would be `0\r\n\r\n`; the connection is destroyed instead.
    expect(reply.endsWith('0\r\n\r\n')).toBe(false);
    expect(printed).not.toHaveBeenCalled();
    expect(announced).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.message === 'Response stream failed')).toHaveLength(1);
  });
});

describe('cleanup when a Node client leaves or reads to the end (V13-200)', () => {
  it('runs a deferred cleanup once, after the last chunk, for a full read', async () => {
    const events: string[] = [];
    const port = await serve((app) => {
      app.router.get('/full', (ctx) => {
        ctx.defer?.(() => {
          events.push('cleanup');
        });
        let n = 0;
        return ctx.response.stream(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              n++;
              events.push(`chunk ${n}`);
              controller.enqueue(encoder.encode(`chunk ${n}\n`));
              if (n === 3) controller.close();
            },
          }),
        );
      });
    });
    const text = await (await fetch(`http://127.0.0.1:${port}/full`)).text();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(text).toBe('chunk 1\nchunk 2\nchunk 3\n');
    expect(events).toEqual(['chunk 1', 'chunk 2', 'chunk 3', 'cleanup']);
  });

  it('runs it once when the client leaves mid-stream', async () => {
    let cleaned = 0;
    const port = await serve((app) => {
      app.router.get('/endless', (ctx) => {
        ctx.defer?.(() => {
          cleaned++;
        });
        return ctx.response.stream(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.enqueue(encoder.encode('tick\n'));
            },
          }),
        );
      });
    });
    await raw(port, 'GET /endless HTTP/1.1\r\nHost: x\r\n\r\n', 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cleaned).toBe(1);
  });
});

describe('the drain sends HTTP/2 GOAWAY (V13-23)', () => {
  it('tells a connected client to go away while its in-flight stream finishes', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = await unusedPort();
    const app = createApplication({ plugins: [RuntimePlugin({ http2: true })] });
    app.router.get('/slow', async (ctx) => {
      await held;
      return ctx.response.text('finished');
    });
    await app.start({ port, hostname: '127.0.0.1', drainTimeoutMs: 5_000 });
    const session = http2Connect(`http://127.0.0.1:${port}`);
    try {
      const goaway = new Promise<void>((resolve) => session.once('goaway', () => resolve()));
      const stream = session.request({ ':path': '/slow' });
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      const ended = new Promise<void>((resolve) => stream.on('end', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stopping = app.stop();
      await goaway;
      // A stream opened after GOAWAY is refused without reaching a handler.
      const refused = await new Promise<string>((resolve) => {
        try {
          const late = session.request({ ':path': '/slow' });
          late.on('error', (error: NodeJS.ErrnoException) => resolve(String(error.code)));
          late.on('response', () => resolve('answered'));
        } catch (error) {
          resolve(String((error as NodeJS.ErrnoException).code));
        }
      });
      expect(refused).not.toBe('answered');
      release();
      await ended;
      expect(body).toBe('finished');
      await stopping;
    } finally {
      session.destroy();
    }
  });
});
