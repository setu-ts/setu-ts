/**
 * M139b §3.4: the shared-port cleartext listener — preface classification,
 * routing on real sockets, the preface bound, error resilience and the peer
 * address recorded for HTTP/2.
 *
 * @module
 */
import { connect as netConnect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { connect as http2Connect } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyPreface,
  createCleartextHttp2Server,
  PREFACE_TIMEOUT_MS,
  replayingDuplex,
} from '../../src/adapters/node/node-http2-listener.ts';
import type { CleartextHttp2Server } from '../../src/adapters/node/node-http2-listener.ts';
import { PEER_ADDRESS, peerAddressOf } from '../../src/adapters/node/node-peer.ts';

const PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
/** An empty SETTINGS frame: the first frame a client must send after the preface. */
const EMPTY_SETTINGS = Uint8Array.from([0, 0, 0, 4, 0, 0, 0, 0, 0]);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let server: CleartextHttp2Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** Starts a listener answering `<httpVersion> <recorded peer>`. */
async function start(prefaceTimeoutMs?: number): Promise<{ port: number }> {
  server = createCleartextHttp2Server(
    (incoming, outgoing) => {
      outgoing.end(`${incoming.httpVersion} ${peerAddressOf(incoming as never) ?? 'none'}`);
    },
    prefaceTimeoutMs === undefined ? undefined : { prefaceTimeoutMs },
  );
  const net = server.net;
  await new Promise<void>((resolve) => net.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port };
}

/** Opens a raw socket and resolves once connected. */
function raw(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Resolves with everything a socket receives until it closes, and when. */
function drain(socket: Socket, startedAt: number): Promise<{ text: string; ms: number }> {
  return new Promise((resolve) => {
    let text = '';
    socket.on('data', (chunk: Uint8Array) => (text += new TextDecoder().decode(chunk)));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve({ text, ms: performance.now() - startedAt }));
  });
}

/** One HTTP/2 GET over a fresh prior-knowledge session. */
function h2Get(port: number, path = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(`http://127.0.0.1:${port}`);
    session.on('error', reject);
    const stream = session.request({ ':path': path });
    let body = '';
    stream.on('data', (chunk: Uint8Array) => (body += new TextDecoder().decode(chunk)));
    stream.on('end', () => {
      session.close();
      resolve(body);
    });
    stream.on('error', reject);
    stream.end();
  });
}

describe('classifyPreface', () => {
  const preface = bytes(PREFACE);
  it.each([
    ['empty', new Uint8Array(0), 'pending'],
    ['a matching prefix', preface.subarray(0, 10), 'pending'],
    ['23 matching bytes', preface.subarray(0, 23), 'pending'],
    ['exactly the preface', preface, 'http2'],
    ['the preface and a frame', new Uint8Array([...preface, ...EMPTY_SETTINGS]), 'http2'],
    ['an HTTP/1.1 request line', bytes('GET / HTTP/1.1\r\n'), 'http1'],
    ['POST, which shares the first byte', bytes('POST / HTTP/1.1\r\n'), 'http1'],
    ['PRI with an HTTP/1.1 version', bytes('PRI * HTTP/1.1\r\n'), 'http1'],
  ] as const)('%s → %s', (_name, input, verdict) => {
    expect(classifyPreface(input)).toBe(verdict);
  });
});

describe('createCleartextHttp2Server', () => {
  it('reports no address before it is bound', () => {
    server = createCleartextHttp2Server(() => undefined);
    expect(server.address()).toBeNull();
  });

  it('serves HTTP/1.1 and h2c on one port, recording the h2c peer', async () => {
    const { port } = await start();
    const h1 = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(h1).toBe('1.1 127.0.0.1');
    expect(await h2Get(port)).toMatch(/^2\.0 (::ffff:)?127\.0\.0\.1$/);
  });

  it('routes a preface that arrives split across chunks to HTTP/2', async () => {
    const { port } = await start();
    const socket = await raw(port);
    const received = new Promise<Uint8Array>((resolve) =>
      socket.once('data', (chunk: Uint8Array) => resolve(chunk)),
    );
    socket.write(bytes(PREFACE.slice(0, 7)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.write(new Uint8Array([...bytes(PREFACE.slice(7)), ...EMPTY_SETTINGS]));
    const first = await received;
    // The server's first frame is its own SETTINGS (type 0x04).
    expect(first[3]).toBe(4);
    socket.destroy();
  });

  it('routes at the first byte that differs from the preface', async () => {
    const { port } = await start();
    const socket = await raw(port);
    const done = drain(socket, performance.now());
    socket.end('GET /x HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect((await done).text).toMatch(/^HTTP\/1\.1 200[\s\S]*1\.1 127\.0\.0\.1$/);
  });

  it('closes a connection that never finishes the preface, at the bound', async () => {
    const { port } = await start(150);
    const socket = await raw(port);
    const started = performance.now();
    const done = drain(socket, started);
    socket.write('PRI');
    const { text, ms } = await done;
    expect(text).toBe('');
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(2_000);
  });

  it('keeps the default bound at 10 s', () => {
    expect(PREFACE_TIMEOUT_MS).toBe(10_000);
  });

  it('survives clients that vanish before and after routing', async () => {
    const { port } = await start();
    const early = await raw(port);
    early.write('P');
    early.destroy();

    const session = http2Connect(`http://127.0.0.1:${port}`);
    session.on('error', () => undefined);
    const stream = session.request({ ':path': '/' });
    stream.on('error', () => undefined);
    session.destroy();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('1.1 127.0.0.1');
    expect(await h2Get(port)).toMatch(/^2\.0 /);
  });

  it('forwards upgrade to the HTTP/1.1 side', async () => {
    const { port } = await start();
    const seen: string[] = [];
    server!.on('upgrade', ((request: { headers: Record<string, string> }, socket: Socket) => {
      seen.push(request.headers['upgrade']!);
      socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    }) as never);
    const socket = await raw(port);
    const done = drain(socket, performance.now());
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    expect((await done).text).toMatch(/^HTTP\/1\.1 101/);
    expect(seen).toEqual(['websocket']);
  });

  it('stops accepting connections once closed', async () => {
    const { port } = await start();
    server!.close();
    server = undefined;
    await expect(raw(port)).rejects.toThrow();
  });
});

describe('peerAddressOf', () => {
  it('prefers the recorded peer, then the socket, then nothing', () => {
    expect(
      peerAddressOf({ [PEER_ADDRESS]: '10.0.0.1', socket: { remoteAddress: '10.0.0.2' } }),
    ).toBe('10.0.0.1');
    expect(peerAddressOf({ socket: { remoteAddress: '10.0.0.2' } })).toBe('10.0.0.2');
    expect(peerAddressOf({})).toBeUndefined();
    expect(peerAddressOf(undefined)).toBeUndefined();
  });
});

describe('replayingDuplex', () => {
  /** A connected server-side socket and its client. */
  async function socketPair(): Promise<{ accepted: Socket; client: Socket; close: () => void }> {
    const { createServer } = await import('node:net');
    const tcp = createServer();
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const acceptedPromise = new Promise<Socket>((resolve) => tcp.once('connection', resolve));
    const client = await raw((tcp.address() as AddressInfo).port);
    const accepted = await acceptedPromise;
    return { accepted, client, close: () => tcp.close() };
  }

  it('replays the head, then the socket, and writes back through it', async () => {
    const { accepted, client, close } = await socketPair();
    const duplex = replayingDuplex(accepted, bytes('head-'));
    const echoed = new Promise<string>((resolve) =>
      client.once('data', (chunk: Uint8Array) => resolve(new TextDecoder().decode(chunk))),
    );
    duplex.write('back');
    expect(await echoed).toBe('back');
    client.write('tail');
    let read = '';
    for await (const chunk of duplex) {
      read += new TextDecoder().decode(chunk as Uint8Array);
      if (read === 'head-tail') break;
    }
    expect(read).toBe('head-tail');
    client.destroy();
    close();
  });

  it('pauses the socket under backpressure', async () => {
    const { accepted, client, close } = await socketPair();
    const duplex = replayingDuplex(accepted, new Uint8Array(0));
    let paused = false;
    const pause = accepted.pause.bind(accepted);
    accepted.pause = (): Socket => {
      paused = true;
      return pause();
    };
    // Nothing reads the duplex, so its buffer fills past the high-water mark.
    client.write(new Uint8Array(256 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(paused).toBe(true);
    duplex.destroy();
    client.destroy();
    close();
  });

  it('a socket error destroys the duplex without crashing, and end and close propagate', async () => {
    const { accepted, client, close } = await socketPair();
    const duplex = replayingDuplex(accepted, new Uint8Array(0));
    const closed = new Promise<void>((resolve) => duplex.once('close', () => resolve()));
    accepted.emit('error', new Error('reset by peer'));
    await closed;
    expect(duplex.destroyed).toBe(true);
    client.destroy();
    close();
  });

  it('ends the readable side when the client ends', async () => {
    const { accepted, client, close } = await socketPair();
    const duplex = replayingDuplex(accepted, new Uint8Array(0));
    const ended = new Promise<void>((resolve) => duplex.once('end', () => resolve()));
    duplex.resume();
    client.end();
    await ended;
    duplex.end();
    close();
  });
});
