import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerOptions } from 'node:http';
import { Duplex } from 'node:stream';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { IRequest, LocalDiagnosticsListenerOptions } from '@setu-ts/common';
import {
  NodeLocalDiagnosticsListenerFactory,
  NODE_LISTENER_SERVER_OPTIONS,
  PARSER_REFUSAL_BYTES,
} from '../../src/diagnostics/node-local-diagnostics-listener.ts';
import type {
  NodeListenerHost,
  NodeListenerServer,
} from '../../src/diagnostics/node-local-diagnostics-listener.ts';
import {
  createLocalDiagnosticsListenerFactory,
  SINGLETON_HEADER_NAMES,
} from '../../src/diagnostics/local-diagnostics-listener.ts';
import { diagnosticsResponse } from '../fixtures/diagnostics-response.ts';
import { parseDiagnosticsWire } from '../fixtures/diagnostics-wire.ts';

class FakeServer extends EventEmitter implements NodeListenerServer {
  maxConnections = 0;
  maxRequestsPerSocket = -1;
  binds: [number, string][] = [];
  closeCalls = 0;
  destroyCalls = 0;
  autoListen = true;
  autoClose = true;
  listenError: Error | undefined;
  closeThrows = false;
  destroyThrows = false;
  callback: ((error?: Error) => void) | undefined;
  bound: AddressInfo | string | null = { address: '127.0.0.1', family: 'IPv4', port: 4919 };
  listen(port: number, hostname: string): void {
    this.binds.push([port, hostname]);
    if (this.listenError) throw this.listenError;
    if (this.autoListen) queueMicrotask(() => this.emit('listening'));
  }
  address(): AddressInfo | string | null {
    return this.bound;
  }
  close(callback: (error?: Error) => void): void {
    this.closeCalls++;
    this.callback = callback;
    if (this.closeThrows) throw new Error('close detail');
    if (this.autoClose) queueMicrotask(callback);
  }
  closeAllConnections(): void {
    this.destroyCalls++;
    if (this.destroyThrows) throw new Error('destroy detail');
  }
}

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  bytes: Uint8Array = new Uint8Array();
  failAt: 'head' | 'end' | undefined;
  destroyed = false;
  readonly done = Promise.withResolvers<void>();
  writeHead(status: number, headers: Record<string, string>): void {
    if (this.failAt === 'head') throw new Error('CANARY-write-head');
    this.status = status;
    this.headers = headers;
  }
  end(bytes: Uint8Array): void {
    if (this.failAt === 'end') throw new Error('CANARY-write-end');
    this.bytes = bytes;
    this.done.resolve();
  }
  destroy(): void {
    this.destroyed = true;
    this.done.resolve();
  }
}

function fixture(server = new FakeServer()) {
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  let created: ServerOptions | undefined;
  const announcements: string[] = [];
  const host: NodeListenerHost = {
    createServer(options, listener) {
      created = options;
      handler = listener;
      return server;
    },
    writeStderr: (text) => {
      announcements.push(text);
    },
  };
  return {
    server,
    announcements,
    host,
    factory: new NodeLocalDiagnosticsListenerFactory(host),
    options: () => created,
    async request(
      url: string | undefined = '/v1/status',
      rawHeaders: string[] = ['Host', '127.0.0.1:4919'],
      method?: string,
      response = new FakeResponse(),
      hostHeader: string | undefined = rawHeaders.findIndex(
        (value, index) => index % 2 === 0 && value.toLowerCase() === 'host',
      ) === -1
        ? undefined
        : rawHeaders[
            rawHeaders.findIndex(
              (value, index) => index % 2 === 0 && value.toLowerCase() === 'host',
            ) + 1
          ],
    ): Promise<FakeResponse> {
      handler(
        {
          url,
          method,
          rawHeaders,
          headers: { host: hostHeader },
          socket: { remoteAddress: '127.0.0.1' },
        } as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      );
      await response.done.promise;
      return response;
    },
  };
}

const options: LocalDiagnosticsListenerOptions = {
  port: 4919,
  handler: () => diagnosticsResponse(),
};

describe('Node local diagnostics listener lifecycle', () => {
  it('validates ports before server creation and uses the explicit budgets and bind', async () => {
    const f = fixture();
    for (const port of [0, 80, 1023, 65536, 1.5, NaN, Infinity]) {
      await expect(f.factory.listen({ ...options, port })).rejects.toThrow(
        'port must be an integer',
      );
    }
    expect(f.options()).toBeUndefined();
    const listener = await f.factory.listen(options);
    expect(f.options()).toEqual({
      requireHostHeader: false,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
      maxHeaderSize: 16384,
      headersTimeout: 5000,
      requestTimeout: 10000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
      maxRequestsPerSocket: 0,
      maxConnections: 32,
    });
    expect(f.server.maxConnections).toBe(32);
    expect(f.server.maxRequestsPerSocket).toBe(0);
    expect(f.server.binds).toEqual([[4919, '127.0.0.1']]);
    expect(f.server.listenerCount('error')).toBe(0);
    expect(f.server.listenerCount('listening')).toBe(0);
    expect(f.announcements).toEqual(['Listening on http://127.0.0.1:4919/\n']);
    await listener.close();
  });

  it('reserves the slot while binding and waits for listening', async () => {
    const f = fixture();
    f.server.autoListen = false;
    let resolved = false;
    const pending = f.factory.listen(options).then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await expect(f.factory.listen(options)).rejects.toThrow('already active');
    f.server.emit('listening');
    const listener = await pending;
    await expect(f.factory.listen(options)).rejects.toThrow('already active');
    await listener.close();
  });

  it('rejects a pending listen when shutdown closes it before listening', async () => {
    const f = fixture();
    f.server.autoListen = false;
    const pending = f.factory.listen(options);
    const refused = expect(pending).rejects.toThrow('closed before binding completed');
    await f.factory.closeActive();
    await refused;
    expect(f.server.listenerCount('error')).toBe(0);
    expect(f.server.listenerCount('listening')).toBe(0);
    f.server.emit('listening');
    f.server.autoListen = true;
    await (await f.factory.listen(options)).close();
  });

  for (const mode of ['event', 'throw', 'create'] as const) {
    it(`preserves a ${mode} bind failure and permits retry`, async () => {
      const f = fixture();
      const error = Object.assign(new Error('CANARY-bind'), { code: 'EADDRINUSE' });
      if (mode === 'create') {
        f.host.createServer = () => {
          throw error;
        };
      } else if (mode === 'throw') f.server.listenError = error;
      else f.server.autoListen = false;
      const pending = f.factory.listen(options);
      const refused = expect(pending).rejects.toBe(error);
      if (mode === 'event') f.server.emit('error', error);
      await refused;
      expect(f.server.listenerCount('error')).toBe(0);
      expect(f.server.listenerCount('listening')).toBe(0);
      f.host.createServer = () => f.server;
      f.server.listenError = undefined;
      f.server.autoListen = true;
      await (await f.factory.listen(options)).close();
    });
  }

  for (const bound of [null, '/socket', { address: '0.0.0.0', family: 'IPv4', port: 4919 }]) {
    it(`closes and rejects an unexpected bound address ${JSON.stringify(bound)}`, async () => {
      const f = fixture();
      f.server.bound = bound;
      await expect(f.factory.listen(options)).rejects.toThrow('did not bind 127.0.0.1');
      expect(f.server.closeCalls).toBe(1);
      expect(f.server.destroyCalls).toBe(1);
      f.server.bound = { address: '127.0.0.1', family: 'IPv4', port: 4919 };
      await (await f.factory.listen(options)).close();
    });
  }

  it('announces the actual address through onListen, and closes if the callback fails', async () => {
    const f = fixture();
    f.server.bound = { address: '127.0.0.1', family: 'IPv4', port: 4920 };
    const seen: unknown[] = [];
    await f.factory.listen({
      ...options,
      onListen: (address) => {
        seen.push(address);
      },
    });
    expect(seen).toEqual([{ hostname: '127.0.0.1', port: 4920 }]);
    expect(f.announcements).toEqual([]);
    await f.factory.closeActive();
    await expect(
      f.factory.listen({
        ...options,
        onListen: () => {
          throw new Error('announcement');
        },
      }),
    ).rejects.toThrow('announcement');
    await f.factory.closeActive();
  });

  it('uses stderr when the host does not supply a writer', async () => {
    const f = fixture();
    delete f.host.writeStderr;
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await f.factory.listen(options);
      expect(write).toHaveBeenCalledWith('Listening on http://127.0.0.1:4919/\n');
      await f.factory.closeActive();
    } finally {
      write.mockRestore();
    }
  });

  it('shares one close promise, destroys sockets immediately and releases the slot only once', async () => {
    const f = fixture();
    f.server.autoClose = false;
    const listener = await f.factory.listen(options);
    const first = listener.close();
    expect(listener.close()).toBe(first);
    expect(f.factory.closeActive()).toBe(first);
    expect(f.server.closeCalls).toBe(1);
    expect(f.server.destroyCalls).toBe(1);
    await expect(f.factory.listen(options)).rejects.toThrow('already active');
    f.server.callback!(new Error('close callback detail'));
    await first;
    const second = await f.factory.listen(options);
    f.server.callback!(); // stale callback must not free the second listener's slot
    await expect(f.factory.listen(options)).rejects.toThrow('already active');
    const closing = second.close();
    f.server.callback!();
    await closing;
    await f.factory.closeActive();
  });

  it('swallows synchronous close and destroy errors and still frees the slot', async () => {
    const f = fixture();
    f.server.closeThrows = true;
    f.server.destroyThrows = true;
    await (await f.factory.listen(options)).close();
    await (await f.factory.listen(options)).close();
    await f.factory.closeActive();
  });

  it('accepts a Node host through the platform dispatcher', async () => {
    const f = fixture();
    const factory = createLocalDiagnosticsListenerFactory('node', undefined, f.host);
    await (await factory.listen(options)).close();
  });
});

describe('Node local diagnostics request mapping table', () => {
  const rows = [
    { target: '/v1/status', expected: 'http://127.0.0.1:4919/v1/status' },
    { target: '/v1/./status', expected: 'http://127.0.0.1:4919/v1/./status' },
    { target: '/x/../v1/status', expected: 'http://127.0.0.1:4919/x/../v1/status' },
    { target: '/v1\\status', expected: 'http://127.0.0.1:4919/v1\\status' },
    { target: '/v1/status?', expected: 'http://127.0.0.1:4919/v1/status?' },
    { target: '/v1/status#x', expected: 'http://127.0.0.1:4919/v1/status#x' },
    { target: 'http://evil.example/v1/status', expected: null },
    { target: '*', expected: null },
    { target: '127.0.0.1:4919', expected: null },
  ];
  for (const { target, expected } of rows) {
    it(`maps or refuses ${target} without URL normalization`, async () => {
      const f = fixture();
      const seen: IRequest[] = [];
      await f.factory.listen({
        ...options,
        handler: (request) => {
          seen.push(request);
          return diagnosticsResponse();
        },
      });
      const result = await f.request(target);
      expect(result.status).toBe(expected === null ? 400 : 200);
      expect(seen.map((request) => request.url)).toEqual(expected === null ? [] : [expected]);
      if (expected !== null) {
        expect(seen[0]!.ip).toBe('127.0.0.1');
        expect(seen[0]!.raw?.url).toBe('http://127.0.0.1:4919/');
      }
      await f.factory.closeActive();
    });
  }

  const badHeaders: string[][] = [
    [],
    ['Host', '127.0.0.1:4919', 'bad\u0000name', 'CANARY'],
    ['Host', '127.0.0.1:4919', 'x-value', 'bad\r\nCANARY'],
    ['Host', '127.0.0.1:4919', 'Transfer-Encoding', 'identity'],
    ['Host', '127.0.0.1:4919', 'Content-Length', '1'],
    ...SINGLETON_HEADER_NAMES.map((name) => [
      'Host',
      '127.0.0.1:4919',
      name,
      'a',
      name.toUpperCase(),
      'b',
    ]),
    ['Host', '127.0.0.1:4919', 'X-Setu-Session', 'a, b'],
  ];
  for (const headers of badHeaders) {
    it(`refuses headers ${JSON.stringify(headers)} before invoking the handler`, async () => {
      const f = fixture();
      let called = false;
      await f.factory.listen({
        ...options,
        handler: () => {
          called = true;
          return diagnosticsResponse();
        },
      });
      const result = await f.request('/v1/status', headers);
      expect(result.status).toBe(400);
      expect(new TextDecoder().decode(result.bytes)).toBe(
        '{"version":1,"error":"invalid-request"}',
      );
      expect(result.headers).toMatchObject({
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-length': String(result.bytes.length),
      });
      expect(called).toBe(false);
      await f.factory.closeActive();
    });
  }

  it('coalesces ordinary duplicate headers and defaults an absent method', async () => {
    const f = fixture();
    const seen: IRequest[] = [];
    await f.factory.listen({
      ...options,
      handler: (request) => {
        seen.push(request);
        return diagnosticsResponse();
      },
    });
    await f.request(
      '/v1/status',
      ['Host', '127.0.0.1:4919', 'x-proof', 'one', 'x-proof', 'two', 'Content-Length', '0'],
      undefined,
    );
    expect(seen[0]!.headers.get('x-proof')).toBe('one, two');
    expect(seen[0]!.method).toBe('GET');
    await f.request('/v1/status', ['Host', 'evil.example/../x']);
    expect(seen[1]!.url).toBe('http://evil.example/../x/v1/status');
    const invalidMethod = await f.request('/v1/status', ['Host', '127.0.0.1:4919'], 'CONNECT');
    expect(invalidMethod.status).toBe(400);
    await f.factory.closeActive();
  });

  for (const mode of ['throw', 'snapshot-throw', 'stream', 'invalid-status'] as const) {
    it(`answers unavailable for ${mode} without revealing error text`, async () => {
      const f = fixture();
      await f.factory.listen({
        ...options,
        handler: () => {
          if (mode === 'throw') throw new Error('CANARY-handler');
          if (mode === 'snapshot-throw')
            return {
              ...diagnosticsResponse(),
              snapshot: () => {
                throw new Error('CANARY-snapshot');
              },
            };
          return diagnosticsResponse(
            mode === 'stream'
              ? {
                  streaming: true,
                  status: 200,
                  headers: new Headers(),
                  body: new ReadableStream<Uint8Array>(),
                }
              : { streaming: false, status: 999, headers: new Headers(), body: 'CANARY-body' },
          );
        },
      });
      const result = await f.request();
      expect(result.status).toBe(503);
      expect(new TextDecoder().decode(result.bytes)).toBe('{"version":1,"error":"unavailable"}');
      await f.factory.closeActive();
    });
  }

  for (const failAt of ['head', 'end'] as const) {
    it(`swallows a ${failAt} write failure`, async () => {
      const f = fixture();
      await f.factory.listen(options);
      const outgoing = new FakeResponse();
      outgoing.failAt = failAt;
      expect(
        (await f.request('/v1/status', ['Host', '127.0.0.1:4919'], 'GET', outgoing)).destroyed,
      ).toBe(true);
      await f.factory.closeActive();
    });
  }
  it('swallows an asynchronous response error', async () => {
    const f = fixture();
    await f.factory.listen(options);
    const response = await f.request();
    response.emit('error', new Error('CANARY-async-write'));
    response.emit('error', new Error('CANARY-late-write'));
    expect(response.destroyed).toBe(true);
    await f.factory.closeActive();
  });
});

describe('Raw diagnostics response fixture', () => {
  it('retains the wire while decoding chunk sizes as bytes, including UTF-8', () => {
    const raw =
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\né\r\n4\r\n🙂\r\n0\r\n\r\n';
    const response = parseDiagnosticsWire(raw);
    expect(response.raw).toBe(raw);
    expect(response.status).toBe(200);
    expect(response.body).toBe('é🙂');
  });
  for (const body of ['x\r\n', '6\r\nshort', '6\r\nserved\r\n', '0\r\n']) {
    it(`rejects an incomplete or invalid chunked reply ${JSON.stringify(body)}`, () => {
      expect(() =>
        parseDiagnosticsWire(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`),
      ).toThrow();
    });
  }
});

describe('Node parser refusal bytes', () => {
  for (const [event, busy] of [
    ['connect', false],
    ['upgrade', false],
    ['connect', true],
  ] as const) {
    it(`refuses the native ${event} event, busy=${busy}, without handing it to the protocol`, async () => {
      const f = fixture();
      let calls = 0;
      await f.factory.listen({
        ...options,
        handler: () => {
          calls++;
          return diagnosticsResponse();
        },
      });
      const chunks: Buffer[] = [];
      const socket = new Duplex({
        read() {},
        write(chunk: Buffer | string, encoding: BufferEncoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
          callback();
        },
      });
      const request = new IncomingMessage(socket as Socket);
      request.method = event === 'connect' ? 'CONNECT' : 'GET';
      request.url = event === 'connect' ? '127.0.0.1:4919' : '/v1/status';
      request.httpVersionMajor = 1;
      request.httpVersionMinor = 1;
      request.httpVersion = '1.1';
      if (busy) new ServerResponse(request).assignSocket(socket as Socket);
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      f.server.emit(event, request, socket);
      await closed;
      const wire = Buffer.concat(chunks).toString();
      if (busy) {
        expect(wire).toBe('');
      } else {
        const parsed = parseDiagnosticsWire(wire);
        expect(parsed.status).toBe(400);
        expect(parsed.body).toBe('{"version":1,"error":"invalid-request"}');
        expect(wire).toContain('HTTP/1.1 400 Bad Request\r\n');
        expect(wire.toLowerCase()).toContain('content-length: 39\r\n');
        expect(wire).toContain('\r\n\r\n{"version":1,"error":"invalid-request"}');
      }
      expect(calls).toBe(0);
      await f.factory.closeActive();
    });
  }

  for (const [writable, code, throws] of [
    [true, 'HPE_HEADER_OVERFLOW', false],
    [true, 'ERR_HTTP_REQUEST_TIMEOUT', false],
    [false, 'HPE_INVALID_METHOD', false],
    [true, 'ECONNRESET', false],
    [true, 'HPE_INVALID_METHOD', true],
  ] as const) {
    it(`handles ${code}, writable=${writable}, throws=${throws}`, async () => {
      const f = fixture();
      await f.factory.listen(options);
      let written = '';
      let destroyed = 0;
      const socket = {
        writable,
        end(bytes: string, callback: () => void) {
          if (throws) throw new Error('CANARY-write');
          written = bytes;
          callback();
        },
        destroy() {
          destroyed++;
        },
      } as unknown as Socket;
      f.server.emit('clientError', Object.assign(new Error('CANARY-parser'), { code }), socket);
      expect(written).toBe(
        writable && code !== 'ECONNRESET' && !throws ? PARSER_REFUSAL_BYTES : '',
      );
      expect(PARSER_REFUSAL_BYTES).toBe(
        'HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
      );
      expect(destroyed).toBe(1);
      expect(NODE_LISTENER_SERVER_OPTIONS.insecureHTTPParser).toBe(false);
      await f.factory.closeActive();
    });
  }
});
