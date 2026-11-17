/**
 * M139b §3.3–§3.5 end to end on the real Node default host: `http2: true`
 * (cleartext, shared port) and `http2: { key, cert }` (TLS) serve HTTP/1.1 and
 * HTTP/2, keep WebSocket upgrades, write trailers only on HTTP/2, report the
 * real client address, and take the scheme from the listener (V12-51).
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { connect as http2Connect } from 'node:http2';
import type { ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { setUpgradeIntent } from '@setu-ts/common';
import type { IRequest, IResponse, ServerHandle } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';

import { NodeHttpAdapter } from '../../src/index.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/tls/${name}`, import.meta.url), 'utf8');
const TLS = { key: fixture('localhost-key.pem'), cert: fixture('localhost-cert.pem') };

const describeNode = describe.skipIf(typeof Deno !== 'undefined');

interface Running {
  adapter: NodeHttpAdapter;
  handle: ServerHandle;
  port: number;
}

let running: Running | undefined;

afterEach(async () => {
  if (running !== undefined) await running.adapter.close(running.handle);
  running = undefined;
});

/**
 * Starts an adapter whose handler answers `<url> <ip> <responseTrailers>`,
 * streams with trailers on `/trailers`, and accepts a WebSocket on `/ws`.
 */
async function start(http2: true | typeof TLS): Promise<Running> {
  const adapter = new NodeHttpAdapter(undefined, undefined, { http2 });
  // The kernel sets a router whenever WebSockets are registered; the adapter
  // attaches its `upgrade` listener only then. The decision itself is the
  // handler's (`setUpgradeIntent` below), so this router never decides.
  adapter.setUpgradeRouter(() => Promise.resolve(null));
  adapter.setHandler((request: IRequest): IResponse | Promise<IResponse> => {
    const { response } = createTestContext();
    if (request.headers.get('upgrade') === 'websocket') {
      setUpgradeIntent(request, {
        sink: {
          onOpen: () => undefined,
          onMessage: () => undefined,
          onClose: () => undefined,
          onError: () => undefined,
        },
      });
      response.status(101).send();
      return response;
    }
    if (request.path === '/bulk') {
      // Buffers the request body and answers with as many bytes, so a client
      // with several large requests in flight fills the session's memory.
      // It waits before reading, as a busy handler would, so the uploads sit in
      // the server's session meanwhile.
      return new Promise((resolve) => setTimeout(resolve, 300))
        .then(() => request.bytes())
        .then((body) => {
          response.send(new Uint8Array(body.length));
          return response;
        });
    }
    if (request.path === '/trailers') {
      response.stream(new Response('streamed').body!, {
        trailers: Promise.resolve(new Headers({ 'grpc-status': '0', 'grpc-message': 'ok' })),
      });
      return response;
    }
    response.text(`${request.url} ${request.ip ?? 'none'} ${String(request.responseTrailers)}`);
    return response;
  });
  const handle = await adapter.listen(0, '127.0.0.1');
  const server = (handle as unknown as { server: { address(): { port: number } } }).server;
  running = { adapter, handle, port: server.address().port };
  return running;
}

/** One HTTP/2 request; resolves with headers, body and trailers. */
function h2(
  session: ClientHttp2Session,
  headers: OutgoingHttpHeaders,
): Promise<{ body: string; trailers: IncomingHttpHeaders | undefined }> {
  return new Promise((resolve, reject) => {
    const stream = session.request(headers);
    let body = '';
    let trailers: IncomingHttpHeaders | undefined;
    stream.on('data', (chunk: Uint8Array) => (body += new TextDecoder().decode(chunk)));
    stream.on('trailers', (received) => (trailers = received));
    stream.on('end', () => resolve({ body, trailers }));
    stream.on('error', reject);
    stream.end();
  });
}

/** Writes a raw HTTP/1.1 request and resolves with the whole reply. */
function rawHttp1(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.end(request));
    let text = '';
    socket.on('data', (chunk: Uint8Array) => (text += new TextDecoder().decode(chunk)));
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
  });
}

/** Completes a real WebSocket handshake and resolves once open. */
function wsOpens(url: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    socket.on('open', () => {
      socket.close();
      resolve(true);
    });
    socket.on('error', reject);
  });
}

describeNode('NodeHttpAdapter http2: true (cleartext, shared port)', () => {
  it('serves HTTP/1.1 with no trailers and the real peer', async () => {
    const { port } = await start(true);
    const body = await (await fetch(`http://127.0.0.1:${port}/a`)).text();
    expect(body).toBe(`http://127.0.0.1:${port}/a 127.0.0.1 false`);
  });

  it('serves h2c with trailers available and the real peer (not the hidden wrapper socket)', async () => {
    const { port } = await start(true);
    const session = http2Connect(`http://127.0.0.1:${port}`);
    try {
      const { body } = await h2(session, { ':path': '/b' });
      expect(body).toBe(`http://127.0.0.1:${port}/b 127.0.0.1 true`);
    } finally {
      session.close();
    }
  });

  it('writes trailers on HTTP/2 and only there', async () => {
    const { port } = await start(true);
    const session = http2Connect(`http://127.0.0.1:${port}`);
    try {
      const { body, trailers } = await h2(session, { ':path': '/trailers' });
      expect(body).toBe('streamed');
      expect(trailers?.['grpc-status']).toBe('0');
      expect(trailers?.['grpc-message']).toBe('ok');
    } finally {
      session.close();
    }
    const h1 = await rawHttp1(
      port,
      'GET /trailers HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n',
    );
    expect(h1).toContain('streamed');
    expect(h1).not.toContain('grpc-status');
  });

  it('an HTTP/1.1 request line claiming HTTP/2.0 is offered no trailers', async () => {
    // node:http parses the line as version 2.0, and its response has
    // addTrailers: neither makes it an HTTP/2 stream.
    const { port } = await start(true);
    const reply = await rawHttp1(port, 'GET /c HTTP/2.0\r\nHost: a\r\nConnection: close\r\n\r\n');
    expect(reply).toMatch(/ false$/);
    expect(reply).not.toMatch(/ true$/);
  });

  it('a client cannot choose the scheme (V12-51)', async () => {
    const { port } = await start(true);
    const session = http2Connect(`http://127.0.0.1:${port}`);
    try {
      const { body } = await h2(session, {
        ':path': '/c',
        ':scheme': 'https',
        ':authority': `127.0.0.1:${port}`,
      });
      expect(body.startsWith(`http://127.0.0.1:${port}/c `)).toBe(true);
    } finally {
      session.close();
    }
    const h1 = await rawHttp1(
      port,
      `GET https://127.0.0.1:${port}/d HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    expect(h1).toContain(`http://127.0.0.1:${port}/d `);
    expect(h1).not.toContain('https://');
  });

  it('keeps WebSocket upgrades', async () => {
    const { port } = await start(true);
    expect(await wsOpens(`ws://127.0.0.1:${port}/ws`)).toBe(true);
  });
});

describeNode('NodeHttpAdapter http2: { key, cert } (TLS)', () => {
  it('negotiates h2 with trailers available, and an https URL', async () => {
    const { port } = await start(TLS);
    const session = http2Connect(`https://localhost:${port}`, { ca: TLS.cert });
    try {
      const { body } = await h2(session, { ':path': '/e' });
      expect(body).toBe(`https://localhost:${port}/e 127.0.0.1 true`);
      const streamed = await h2(session, { ':path': '/trailers' });
      expect(streamed.trailers?.['grpc-status']).toBe('0');
    } finally {
      session.close();
    }
  });

  it('serves HTTP/1.1 over TLS on the same port', async () => {
    const { port } = await start(TLS);
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpsRequest(
        // Node's https client offers no h2, so the server falls back to HTTP/1.1.
        { host: 'localhost', port, path: '/f', ca: TLS.cert },
        (response) => {
          let text = '';
          response.on('data', (chunk: Uint8Array) => (text += new TextDecoder().decode(chunk)));
          response.on('end', () => resolve(text));
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(body).toBe(`https://localhost:${port}/f 127.0.0.1 false`);
  });

  it('keeps WebSocket upgrades', async () => {
    const { port } = await start(TLS);
    expect(await wsOpens(`wss://localhost:${port}/ws`)).toBe(true);
  });
});

/** Sends `count` uploads of `bytes` at once on one session; resolves each reply's status and size. */
function bulk(session: ClientHttp2Session, count: number, bytes: number): Promise<string[]> {
  const payload = new Uint8Array(bytes);
  return Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<string>((resolve) => {
          const stream = session.request({ ':method': 'POST', ':path': '/bulk' });
          let status = 0;
          let size = 0;
          stream.on('response', (headers) => (status = Number(headers[':status'])));
          stream.on('data', (chunk: Uint8Array) => (size += chunk.length));
          stream.on('end', () => resolve(`${status} ${size}`));
          stream.on('error', (error: Error & { code?: string }) => resolve(error.message));
          stream.end(payload);
        }),
    ),
  );
}

describeNode('NodeHttpAdapter http2 session memory (M139b)', () => {
  // Measured 2026-11-11: sixteen 1 MB exchanges reset with ENHANCE_YOUR_CALM
  // came from the CLIENT's session cap (Node's 10 MB default), not the
  // server's. HTTP/2 flow control stops a client sending more than its window
  // before the server reads, so even a handler that waits before reading keeps
  // the server under its cap. This guards the large-exchange path; the client
  // cap is raised so only the server is exercised.
  const expected = Array.from({ length: 16 }, () => `200 ${1024 * 1024}`);

  it('serves sixteen 1 MB exchanges in flight on one cleartext session', async () => {
    const { port } = await start(true);
    // The client's own cap is raised too, so only the server's is under test.
    const session = http2Connect(`http://127.0.0.1:${port}`, { maxSessionMemory: 64 });
    try {
      expect(await bulk(session, 16, 1024 * 1024)).toEqual(expected);
    } finally {
      session.close();
    }
  });

  it('serves sixteen 1 MB exchanges in flight on one TLS session', async () => {
    const { port } = await start(TLS);
    const session = http2Connect(`https://localhost:${port}`, {
      ca: TLS.cert,
      maxSessionMemory: 64,
    });
    try {
      expect(await bulk(session, 16, 1024 * 1024)).toEqual(expected);
    } finally {
      session.close();
    }
  });
});

describeNode('NodeHttpAdapter http2 bind failure', () => {
  it.each([
    ['cleartext', true],
    ['TLS', TLS],
  ] as const)('%s rejects with the bind error when the port is taken', async (_name, http2) => {
    const { port } = await start(true);
    const second = new NodeHttpAdapter(undefined, undefined, { http2 });
    second.setHandler(() => createTestContext().response);
    await expect(second.listen(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describeNode('NodeHttpAdapter http2 shutdown', () => {
  it.each([
    ['cleartext', true, (port: number) => http2Connect(`http://127.0.0.1:${port}`)],
    ['TLS', TLS, (port: number) => http2Connect(`https://localhost:${port}`, { ca: TLS.cert })],
  ] as const)(
    '%s: close() sends GOAWAY to a session the client keeps open',
    async (_name, http2, connect) => {
      const started = await start(http2);
      const session = connect(started.port);
      try {
        await h2(session, { ':path': '/open' });
        const goaway = new Promise<void>((resolve) => session.once('goaway', () => resolve()));
        await started.adapter.close(started.handle);
        running = undefined;
        await goaway;
      } finally {
        session.destroy();
      }
    },
  );
});
