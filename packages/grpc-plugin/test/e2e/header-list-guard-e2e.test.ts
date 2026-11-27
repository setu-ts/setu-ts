/** Real Node stream destruction must preserve the first refusal classification. @module */
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { connect, createServer } from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream, ServerHttp2Session } from 'node:http2';
import { isRefusedStream } from '../../src/client/call-outcome.ts';
import { guardHeaderList, headerListSize } from '../../src/client/header-list-guard.ts';
import { GrpcHeaderListTooLargeError } from '../../src/errors/grpc-errors.ts';

/**
 * Sends a header list over 64 KiB to a Node HTTP/2 server that advertises no
 * limit. Node's server refuses it itself (REFUSED_STREAM) before any `stream`
 * event. With `closing`, the client session starts closing first, as it does
 * once a peer is shutting down, so the refusal arrives on a closed session.
 */
async function refuseLargeHeaders(closing: boolean) {
  const server = createServer({ settings: { maxHeaderListSize: 4294967295 } });
  const serverSessions = new Set<ServerHttp2Session>();
  let receivedStreams = 0;
  server.on('session', (session) => {
    serverSessions.add(session);
    session.on('error', () => {});
  });
  server.on('stream', () => receivedStreams++);
  let client: ClientHttp2Session | undefined;
  let stream: ClientHttp2Stream | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No TCP address');
    const connection = connect(`http://127.0.0.1:${address.port}`);
    client = connection;
    connection.on('error', () => {});
    await once(connection, 'connect');
    const session = {
      request: () =>
        Promise.resolve(
          connection.request(
            {
              ':method': 'POST',
              ':path': '/',
              ...Object.fromEntries(
                Array.from({ length: 8 }, (_, i) => [`x-big-${i}`, 'a'.repeat(9000)]),
              ),
            },
            { endStream: false },
          ),
        ),
    };
    guardHeaderList(session);
    const request = await session.request();
    stream = request;
    const limitAtStart = connection.remoteSettings.maxHeaderListSize;
    const sentSize = headerListSize(request.sentHeaders);
    const errors: Error[] = [];
    let sessionDetachedAtError = false;
    request.on('error', (error: Error) => {
      if (errors.length === 0) sessionDetachedAtError = request.session === undefined;
      errors.push(error);
    });
    const closed = new Promise<void>((resolve) => request.once('close', resolve));
    let writeError: Error | null | undefined;
    request.write('x', (error) => {
      writeError = error;
      if (!error) request.end();
    });
    if (closing) connection.close();
    const closedBeforeRefusal = connection.closed;
    await closed;
    return {
      errors,
      writeError,
      sentSize,
      receivedStreams,
      limitAtStart,
      closedBeforeRefusal,
      sessionDetachedAtError,
      rstCode: request.rstCode,
    };
  };

  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('HTTP/2 refusal timed out')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    stream?.destroy();
    client?.destroy();
    for (const session of serverSessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Every error in the cause chain, at most five deep. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

describe.skipIf(typeof Deno !== 'undefined')('header-list guard on a real HTTP/2 stream', () => {
  it('keeps a refusal on a closing session a refused stream, and makes it the caller error on an open one', async () => {
    for (const closing of [true, false]) {
      const result = await refuseLargeHeaders(closing);
      // The server refused the list itself; the guard saw it with no known limit.
      expect(result.receivedStreams).toBe(0);
      expect(result.rstCode).toBe(7);
      expect(result.sentSize).toBeGreaterThan(65536);
      expect(result.limitAtStart).toBe(4294967295);
      // Node detaches stream.session before dispatching the error.
      expect(result.sessionDetachedAtError).toBe(true);
      expect(result.closedBeforeRefusal).toBe(closing);
      expect(result.errors).toHaveLength(1);
      const [first] = result.errors;
      // The write callback and the error event agree.
      if (result.writeError) expect(result.writeError).toBe(first);
      if (closing) {
        expect(isRefusedStream(first)).toBe(true);
        expect(first).toMatchObject({ code: 'ERR_HTTP2_STREAM_ERROR' });
        for (const cause of causeChain(first)) {
          expect(cause).not.toBeInstanceOf(GrpcHeaderListTooLargeError);
        }
      } else {
        expect(first).toBeInstanceOf(GrpcHeaderListTooLargeError);
        expect(first).toMatchObject({ size: result.sentSize, limit: 65536 });
        expect(isRefusedStream(first)).toBe(false);
      }
    }
  });
});

it.skipIf(typeof Deno !== 'undefined')(
  'sends Latin-1 headers that fit a real advertised limit',
  async () => {
    const server = createServer({ settings: { maxHeaderListSize: 1600 } });
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200 });
      stream.end('ok');
    });
    let client: ClientHttp2Session | undefined;
    try {
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No TCP address');
      client = connect(`http://127.0.0.1:${address.port}`);
      await once(client, 'remoteSettings');
      const stream = client.request({ ':path': '/', 'x-latin': 'é'.repeat(1000) });
      const errors: unknown[] = [];
      stream.on('error', (error: unknown) => errors.push(error));
      const session = { request: () => Promise.resolve(stream) };
      guardHeaderList(session);
      await session.request();
      stream.resume();
      await once(stream, 'end');
      expect(headerListSize(stream.sentHeaders)).toBeLessThan(1600);
      expect(errors).toEqual([]);
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
