/**
 * The WebSocket handshake on real workerd, against a Setu app that receives
 * edge requests directly (V13-278).
 *
 * A valid client handshake opens, and a Worker-to-Worker socket over a service
 * binding — no `cf`, no key, workerd builds that handshake — must still open
 * (the adapter's pre-check skips it).
 *
 * The pre-check itself cannot be shown here: wrangler dev puts its proxy
 * Worker in front, so the app receives a subrequest with a handshake workerd
 * rebuilt — `cf` set, a fresh valid key — whatever the client sent, and the
 * same holds behind any gateway Worker. One case pins that, so a wrangler
 * change shows up. The pre-check is proven by websocket-plugin's
 * `workers-handshake-refusal.test.ts` (a kernel app with a fake
 * `WebSocketPair`); whether production Cloudflare hands the Worker the
 * client's own headers is unverified (no account).
 *
 * Guarded like the other workerd e2e suites: skipped off CI when the `wrangler`
 * binary cannot run, failed on CI.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'workerd-handshake');
const wrangler = join(here, '..', '..', 'node_modules', '.bin', 'wrangler');

const onCi = process.env['CI'] === 'true';
const hasWrangler = spawnSync(wrangler, ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !hasWrangler && !onCi;

const CASE_TIMEOUT_MS = 120_000;
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

let dev: ChildProcess | undefined;
let output = '';
let port = 0;

/** A free local port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** GETs a path as text. */
async function text(path: string): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}${path}`)).text();
}

/** Sends one raw handshake and resolves with the response head. */
function handshake(extra: readonly string[]): Promise<string> {
  const lines = [
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    ...extra,
  ];
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let reply = '';
    socket.on('data', (chunk: Buffer) => {
      reply += chunk.toString('latin1');
      if (reply.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(reply.slice(0, reply.indexOf('\r\n\r\n')));
      }
    });
    socket.on('error', reject);
  });
}

describe.skipIf(skip)('the WebSocket handshake on workerd (V13-278)', () => {
  beforeAll(async () => {
    port = await freePort();
    dev = spawn(wrangler, ['dev', '--ip', '127.0.0.1', '--port', String(port)], {
      cwd: fixture,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    dev.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    dev.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const deadline = Date.now() + 90_000;
    while (!output.includes('Ready on')) {
      if (Date.now() > deadline) throw new Error(`wrangler dev:\n${output.slice(-3000)}`);
      await sleep(25);
    }
  }, CASE_TIMEOUT_MS);

  afterAll(() => {
    if (dev?.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  });

  it(
    'local dev rebuilds a client handshake: the app receives cf and a fresh valid key, not the one sent',
    async () => {
      // Pins the limit the adapter's pre-check works within. wrangler dev puts
      // its proxy Worker in front, so the app sees a subrequest whose
      // handshake workerd generated, whatever the client sent; the pre-check
      // cannot act here or behind a gateway Worker. If this ever fails, local
      // dev started passing the client's own headers through.
      await handshake(['Sec-WebSocket-Key: short', 'Sec-WebSocket-Version: 13']);
      await sleep(200);
      const seen = JSON.parse(await text('/last-handshake')) as {
        cf: boolean;
        key: string | null;
        version: string | null;
      };

      expect(seen.cf).toBe(true);
      expect(seen.key).not.toBe('short');
      expect(seen.key).toMatch(/^[+/0-9A-Za-z]{22}==$/);
      expect(seen.version).toBe('13');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'opens a valid client handshake from the edge',
    async () => {
      const before = Number(await text('/opens'));
      const head = await handshake([`Sec-WebSocket-Key: ${KEY}`, 'Sec-WebSocket-Version: 13']);
      await sleep(200);

      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
      expect(Number(await text('/opens'))).toBe(before + 1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "opens Cloudflare's documented Worker-to-Worker socket, Upgrade alone with no Connection",
    async () => {
      const before = Number(await text('/opens'));
      const status = await text('/self-socket?upgrade-only');
      await sleep(200);

      expect(status).toBe('101');
      expect(Number(await text('/opens'))).toBe(before + 1);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'opens a Worker-to-Worker socket over a service binding: no cf and no key, still 101',
    async () => {
      const before = Number(await text('/opens'));
      const status = await text('/self-socket');
      await sleep(200);

      expect(status).toBe('101');
      expect(Number(await text('/opens'))).toBe(before + 1);
    },
    CASE_TIMEOUT_MS,
  );
});
