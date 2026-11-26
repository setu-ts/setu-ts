/**
 * The WebSocket handshake on real workerd, against a Setu app that receives
 * edge requests directly (V13-278).
 *
 * workerd invokes the Worker before it checks the handshake, so without the
 * adapter's own check a malformed one ran the route's `onOpen` and the client
 * still got 400 or 426; the open count is what tells the two apart. A
 * Worker-to-Worker socket over a service binding carries no `cf` and no key —
 * workerd builds that handshake — and must still open.
 *
 * Not covered here, and not coverable by the app: behind a gateway Worker,
 * workerd builds a fresh handshake for the subrequest, so the app sees a valid
 * key whatever the client sent (the realtime fixture's front Worker shows it).
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

  for (const entry of [
    { name: 'no key', extra: ['Sec-WebSocket-Version: 13'], status: '400 Bad Request' },
    {
      name: 'a malformed key',
      extra: ['Sec-WebSocket-Key: short', 'Sec-WebSocket-Version: 13'],
      status: '400 Bad Request',
    },
    {
      name: 'version 8',
      extra: [`Sec-WebSocket-Key: ${KEY}`, 'Sec-WebSocket-Version: 8'],
      status: '426 Upgrade Required',
    },
  ]) {
    it(
      `refuses ${entry.name} from the edge with ${entry.status}, and onOpen never runs`,
      async () => {
        const before = await text('/opens');
        const head = await handshake(entry.extra);
        await sleep(200);

        expect(head.split('\r\n')[0]).toBe(`HTTP/1.1 ${entry.status}`);
        expect(await text('/opens')).toBe(before);
      },
      CASE_TIMEOUT_MS,
    );
  }

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
