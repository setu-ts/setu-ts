/**
 * A client's malformed WebSocket handshake gets the same answer on every
 * runtime (V13-276): Node's `ws` rules, which Deno's adapter now applies itself.
 *
 * Runs on a real server on whichever runtime executes it — Node on the Node
 * lane, Deno on the Deno lane — and sends raw handshakes, so the answer is the
 * one a client sees on the wire. The table is the measured behaviour per case.
 * Bun answers its own handshake (it sends 426 for a version mismatch); the
 * Workers adapter's own check is `workers-handshake-refusal.test.ts` and the
 * Workers e2e (a missing key, before `onOpen`); the adapter-side
 * platform faults are `handshake-platform-faults.test.ts` in the runtime package.
 *
 * @module
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createServer } from 'node:net';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { WebSocketPlugin } from '../../src/index.ts';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

/** One handshake: its extra headers and the status and headers a client must get. */
interface Case {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly version?: string;
  /** Whether the handshake sends `Connection: Upgrade` (default: it does). */
  readonly connection?: false;
}

/** The client-fault arm, the same on Node and Deno. */
const CASES: readonly Case[] = [
  // RFC 6455 needs `Connection: Upgrade`; without it this is no upgrade, so the
  // WebSocket route does not match. Only a Worker-to-Worker call on Workers is
  // treated otherwise (workers-handshake-refusal.test.ts).
  {
    name: 'Upgrade without Connection: not an upgrade',
    headers: { key: KEY, version: '13' },
    connection: false,
    status: 404,
  },
  { name: 'a valid handshake', headers: { key: KEY, version: '13' }, status: 101 },
  { name: 'version 8, which ws accepts', headers: { key: KEY, version: '8' }, status: 101 },
  { name: 'no key', headers: { version: '13' }, status: 400 },
  { name: 'a key that is not 16 bytes', headers: { key: 'short', version: '13' }, status: 400 },
  {
    name: 'a key without its padding',
    headers: { key: 'dGhlIHNhbXBsZSBub25jZQ', version: '13' },
    status: 400,
  },
  { name: 'no version', headers: { key: KEY }, status: 400, version: '13, 8' },
  { name: 'version 7', headers: { key: KEY, version: '7' }, status: 400, version: '13, 8' },
  {
    name: 'a version that is not a number',
    headers: { key: KEY, version: 'x' },
    status: 400,
    version: '13, 8',
  },
];

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

/** Sends one raw handshake and resolves with the response head. */
function handshake(port: number, headers: Case['headers'], connection = true): Promise<string> {
  const lines = [
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    ...(connection ? ['Connection: Upgrade'] : []),
    ...(headers['key'] === undefined ? [] : [`Sec-WebSocket-Key: ${headers['key']}`]),
    ...(headers['version'] === undefined ? [] : [`Sec-WebSocket-Version: ${headers['version']}`]),
  ];
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let head = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no response head; got ${JSON.stringify(head)}`));
    }, 5000);
    socket.on('data', (chunk: Uint8Array) => {
      head += new TextDecoder().decode(chunk);
      if (head.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(head.slice(0, head.indexOf('\r\n\r\n')));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The status code and lower-cased headers of a response head. */
function parse(head: string): { status: number; headers: Map<string, string> } {
  const [statusLine = '', ...rest] = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of rest) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(statusLine.split(' ')[1]), headers };
}

describe('a malformed handshake is refused the same way on every runtime (V13-276)', () => {
  let app: IKernelApplication;
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    app = createApplication({
      plugins: [
        RuntimePlugin(),
        WebSocketPlugin({ routes: [{ path: '/ws', handlers: { onOpen: () => {} } }] }),
      ],
    });
    await app.start({ port, hostname: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.stop();
  });

  for (const entry of CASES) {
    it(`${entry.name}: ${String(entry.status)}`, async () => {
      const { status, headers } = parse(
        await handshake(port, entry.headers, entry.connection !== false),
      );

      expect(status).toBe(entry.status);
      if (entry.version !== undefined) {
        expect(headers.get('sec-websocket-version')).toBe(entry.version);
      }
    });
  }
});
