/**
 * Adapter behaviours that differed between runtimes (M143i): Node's refused
 * upgrade response and drain start, the WebSocket ceiling report, Bun's idle
 * timeout and silent stream abort, Deno's `onError` and its HTTP/2 statement,
 * and Node's destroy-on-error stream wrapper. Driven through injected hosts;
 * the real servers are covered by `test/integration/runtime-edges-real.test.ts`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  crossClearTimeout,
  crossSetTimeout,
  crossUnrefTimer,
} from '../../src/services/cross-runtime.ts';
import { buildNodeHost, createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import type { IRequest, IResponse, ResponseSnapshot, WebSocketEventSink } from '@setu-ts/common';
import { setUpgradeIntent } from '@setu-ts/common';

import {
  rejectRawUpgrade,
  writeRawUpgradeResponse,
} from '../../src/adapters/node/node-ws-upgrader.ts';
import type { RawUpgradeSocket } from '../../src/adapters/node/node-ws-upgrader.ts';
import {
  destroyOnSourceError,
  NodeHttpAdapter,
} from '../../src/adapters/node/node-http-adapter.ts';
import type { NodeServeHost, NodeServer } from '../../src/adapters/node/node-http-adapter.ts';
import {
  abortSilentlyOnSourceError,
  BunHttpAdapter,
} from '../../src/adapters/bun/bun-http-adapter.ts';
import type { BunServeHost, BunServer } from '../../src/adapters/bun/bun-http-adapter.ts';
import { createBunWebSocketHandlers } from '../../src/adapters/bun/bun-ws-upgrader.ts';
import {
  BUN_WS_MAX_MESSAGE_BYTES,
  DENO_WS_MAX_MESSAGE_BYTES,
  WebSocketCeilingReport,
} from '../../src/adapters/shared/websocket-ceiling.ts';

/** A framework response double that only answers `snapshot()`. */
function respond(snapshot: Partial<ResponseSnapshot> & { body?: unknown } = {}): IResponse {
  const full = {
    streaming: snapshot.body instanceof ReadableStream,
    status: 200,
    headers: new Headers(),
    body: null,
    ...snapshot,
  } as ResponseSnapshot;
  return { snapshot: () => full } as unknown as IResponse;
}

const decoder = new TextDecoder();

/** A raw socket double recording what was written. */
function rawSocket(withEnd = true): RawUpgradeSocket & {
  chunks: (string | Uint8Array)[];
  ended: boolean;
  destroyed: boolean;
} {
  const socket = {
    chunks: [] as (string | Uint8Array)[],
    ended: false,
    destroyed: false,
    write(data: string | Uint8Array) {
      socket.chunks.push(data);
    },
    destroy() {
      socket.destroyed = true;
    },
    ...(withEnd
      ? {
          end() {
            socket.ended = true;
          },
        }
      : {}),
  };
  return socket;
}

/** The bytes a raw socket received, as text. */
function written(socket: { chunks: (string | Uint8Array)[] }): string {
  return socket.chunks.map((c) => (typeof c === 'string' ? c : decoder.decode(c))).join('');
}

/** A sink with a configured limit. */
function sink(maxMessageBytes?: number): WebSocketEventSink {
  return {
    ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
  };
}

/** A stream that yields one chunk and then fails. */
function failingStream(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array([97]));
        return;
      }
      controller.error(new Error('source failed'));
    },
  });
}

describe('Node refused upgrade (V13-53)', () => {
  it('writes the framework response with reason, headers, cookies, length and body', () => {
    const socket = rawSocket();
    const headers = new Headers({ 'content-type': 'application/json', 'x-trace': '1' });
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    headers.set('transfer-encoding', 'chunked');
    const snapshot: ResponseSnapshot = {
      streaming: false,
      status: 401,
      headers,
      body: '{"title":"nope"}',
    };
    writeRawUpgradeResponse(socket, snapshot);
    const text = written(socket);
    expect(text.startsWith('HTTP/1.1 401 Unauthorized\r\n')).toBe(true);
    expect(text).toContain('content-type: application/json\r\n');
    expect(text).toContain('x-trace: 1\r\n');
    expect(text).toContain('set-cookie: a=1\r\nset-cookie: b=2\r\n');
    expect(text).not.toContain('transfer-encoding');
    expect(text).toContain('content-length: 16\r\nconnection: close\r\n\r\n{"title":"nope"}');
    expect(socket.ended).toBe(true);
    expect(socket.destroyed).toBe(false);
  });

  it('sends bytes and empty bodies, cancels a stream, and destroys a socket without end', async () => {
    const bytes = rawSocket(false);
    writeRawUpgradeResponse(bytes, {
      streaming: false,
      status: 403,
      headers: new Headers(),
      body: new Uint8Array([1, 2]),
    });
    expect(written(bytes)).toContain('HTTP/1.1 403 Forbidden\r\n');
    expect(written(bytes)).toContain('content-length: 2\r\n');
    expect(bytes.destroyed).toBe(true);

    const empty = rawSocket();
    writeRawUpgradeResponse(empty, {
      streaming: false,
      status: 499,
      headers: new Headers(),
      body: null,
    });
    expect(written(empty).startsWith('HTTP/1.1 499 \r\n')).toBe(true);
    expect(written(empty)).toContain('content-length: 0\r\n');

    let cancelled = false;
    const streamed = rawSocket();
    writeRawUpgradeResponse(streamed, {
      streaming: true,
      status: 401,
      headers: new Headers(),
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(written(streamed)).toContain('content-length: 0\r\n');
  });

  it('gives the fixed refusals their reason phrase', () => {
    for (const [status, reason] of [
      [500, 'Internal Server Error'],
      [501, 'Not Implemented'],
      [503, 'Service Unavailable'],
    ] as const) {
      const socket = rawSocket();
      rejectRawUpgrade(socket, status);
      expect(written(socket)).toBe(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      expect(socket.destroyed).toBe(true);
    }
  });
});

describe('Node refused upgrade socket lifetime (security audit)', () => {
  it('destroys the socket once the refusal has flushed, so a half-open client holds no descriptor', () => {
    const listeners = new Map<string, () => void>();
    const socket = Object.assign(rawSocket(), {
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
      },
    });
    writeRawUpgradeResponse(socket, {
      streaming: false,
      status: 401,
      headers: new Headers(),
      body: 'no',
    });
    expect(socket.ended).toBe(true);
    expect(socket.destroyed).toBe(false);
    listeners.get('finish')?.();
    expect(socket.destroyed).toBe(true);
  });

  it('destroys a refusal its client never reads once the socket is idle for the bound', () => {
    let idle: { ms: number; listener: () => void } | undefined;
    const socket = Object.assign(rawSocket(), {
      once() {},
      setTimeout(ms: number, listener: () => void) {
        idle = { ms, listener };
      },
    });
    writeRawUpgradeResponse(socket, {
      streaming: false,
      status: 401,
      headers: new Headers(),
      body: 'x'.repeat(1024),
    });
    expect(idle?.ms).toBe(5_000);
    expect(socket.destroyed).toBe(false);
    idle?.listener();
    expect(socket.destroyed).toBe(true);
  });

  it('answers 500 for a status no Response could carry', () => {
    for (const status of [Number.NaN, 0, 101, 199, 600, 1000, 401.5]) {
      const socket = rawSocket();
      writeRawUpgradeResponse(socket, {
        streaming: false,
        status,
        headers: new Headers(),
        body: 'x',
      });
      expect(written(socket).startsWith('HTTP/1.1 500 Internal Server Error\r\n')).toBe(true);
    }
  });
});

describe('Node drain start (V13-23)', () => {
  async function listening(
    server: NodeServer,
  ): Promise<{ adapter: NodeHttpAdapter; handle: unknown }> {
    const host: NodeServeHost = { serve: () => Promise.resolve(server) };
    const adapter = new NodeHttpAdapter(host);
    adapter.setHandler(() => respond());
    return { adapter, handle: await adapter.listen(0) };
  }

  it('calls the listener drain where it has one, else closes idle connections', async () => {
    const calls: string[] = [];
    const h2 = await listening({ close: () => {}, drain: () => calls.push('drain') });
    h2.adapter.beginDrain(h2.handle);
    const h1 = await listening({
      close: () => {},
      closeIdleConnections: () => calls.push('idle'),
    });
    h1.adapter.beginDrain(h1.handle);
    const bare = await listening({ close: () => {} });
    expect(() => bare.adapter.beginDrain(bare.handle)).not.toThrow();
    expect(calls).toEqual(['drain', 'idle']);
  });

  it('refuses a foreign handle and ignores a closed one', async () => {
    const { adapter, handle } = await listening({ close: () => {} });
    expect(() => adapter.beginDrain({})).toThrow('Invalid server handle');
    await adapter.close(handle);
    expect(() => adapter.beginDrain(handle)).not.toThrow();
  });
});

describe('failed response stream (V13-256)', () => {
  it('Node: destroys the connection and ends the body without an error', async () => {
    let destroyed = 0;
    const wrapped = destroyOnSourceError(failingStream(), () => {
      destroyed++;
    });
    const reader = wrapped.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([97]));
    expect((await reader.read()).done).toBe(true);
    expect(destroyed).toBe(1);
  });

  it('Bun: errors the body with undefined, which Bun does not print', async () => {
    const reader = abortSilentlyOnSourceError(failingStream()).getReader();
    await reader.read();
    await expect(reader.read()).rejects.toBeUndefined();
  });

  it('every wrapper passes data through, ends cleanly and forwards cancel', async () => {
    for (const wrap of [
      (body: ReadableStream<Uint8Array>) => destroyOnSourceError(body, () => {}),
      abortSilentlyOnSourceError,
    ]) {
      const done = wrap(new Blob(['ok']).stream());
      expect(await new Response(done).text()).toBe('ok');
      let cancelled = false;
      const cancellable = wrap(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
      await cancellable.cancel('gone');
      expect(cancelled).toBe(true);
    }
  });
});

describe('WebSocket ceiling report (V13-41)', () => {
  it('reports once for unlimited or above the ceiling, never at or below', () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const report = new WebSocketCeilingReport(100, 'bun', (r) => records.push(r));
    report.check(sink());
    report.check(sink(100));
    report.check(sink(50));
    expect(records).toEqual([]);
    report.check(sink(0));
    report.check(sink(500));
    expect(records).toEqual([
      {
        level: 'warn',
        msg: 'WebSocket message limit exceeds the runtime ceiling',
        configured: 0,
        ceiling: 100,
        platform: 'bun',
      },
    ]);
    const above = new WebSocketCeilingReport(100, 'deno', (r) => records.push(r));
    above.check(sink(101));
    expect(records[1]).toMatchObject({ configured: 101, platform: 'deno' });
  });

  it('survives a missing or throwing error channel', () => {
    expect(() => new WebSocketCeilingReport(1, 'bun', undefined).check(sink(0))).not.toThrow();
    const throwing = new WebSocketCeilingReport(1, 'bun', () => {
      throw new Error('no channel');
    });
    expect(() => throwing.check(sink(0))).not.toThrow();
  });

  it('states the runtime ceilings, and Bun passes its own to Bun.serve', () => {
    expect(BUN_WS_MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024);
    expect(DENO_WS_MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(createBunWebSocketHandlers().maxPayloadLength).toBe(BUN_WS_MAX_MESSAGE_BYTES);
  });
});

describe('Bun adapter', () => {
  /** A Bun host capturing the serve callback and server calls. */
  function bunHost(): {
    host: BunServeHost;
    server: BunServer & { timeouts: [Request, number][] };
    serve: () => (request: Request, server: BunServer) => unknown;
    options: () => Parameters<BunServeHost['serve']>[0];
  } {
    let captured: Parameters<BunServeHost['serve']>[0] | undefined;
    const server = {
      timeouts: [] as [Request, number][],
      stop: () => {},
      timeout(request: Request, seconds: number) {
        server.timeouts.push([request, seconds]);
      },
      upgrade: () => true,
    };
    return {
      server,
      host: {
        serve(options) {
          captured = options;
          return server;
        },
      },
      serve: () => captured!.fetch as (request: Request, server: BunServer) => unknown,
      options: () => captured!,
    };
  }

  it('turns the idle timeout off for streamed responses only (V13-42)', async () => {
    const bun = bunHost();
    const adapter = new BunHttpAdapter(bun.host);
    adapter.setHandler((request: IRequest): IResponse => {
      return request.path === '/stream'
        ? respond({ body: new Blob(['x']).stream() })
        : respond({ body: 'plain' });
    });
    await adapter.listen(0);
    expect(bun.options().websocket?.maxPayloadLength).toBe(BUN_WS_MAX_MESSAGE_BYTES);
    const fetch = bun.serve();
    const streamed = new Request('http://localhost/stream');
    await fetch(streamed, bun.server);
    await fetch(new Request('http://localhost/plain'), bun.server);
    expect(bun.server.timeouts).toEqual([[streamed, 0]]);
  });

  it('reports the ceiling at the first handshake that asks for more', async () => {
    const bun = bunHost();
    const records: Readonly<Record<string, unknown>>[] = [];
    const adapter = new BunHttpAdapter(bun.host, { reportError: (r) => records.push(r) });
    adapter.setHandler((request: IRequest): IResponse => {
      setUpgradeIntent(request, { sink: sink(0) });
      return respond();
    });
    await adapter.listen(0);
    const fetch = bun.serve();
    await fetch(new Request('http://localhost/ws'), bun.server);
    await fetch(new Request('http://localhost/ws'), bun.server);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ configured: 0, ceiling: BUN_WS_MAX_MESSAGE_BYTES });
  });
});

describe('unrefTimer: a timer that does not keep the process alive', () => {
  it('unrefs a Node timer, so the process can exit with it pending', () => {
    const handle = crossSetTimeout(() => {}, 60_000) as NodeJS.Timeout;
    try {
      expect(handle.hasRef()).toBe(true);
      crossUnrefTimer(handle);
      expect(handle.hasRef()).toBe(false);
    } finally {
      crossClearTimeout(handle);
    }
  });

  it("uses Deno.unrefTimer for Deno's numeric timer ids, and does nothing where neither exists", () => {
    const unrefed: number[] = [];
    const host = globalThis as { Deno?: unknown };
    const previous = host.Deno;
    host.Deno = { unrefTimer: (id: number) => void unrefed.push(id) };
    try {
      crossUnrefTimer(7);
      expect(unrefed).toEqual([7]);
    } finally {
      if (previous === undefined) delete host.Deno;
      else host.Deno = previous;
    }
    expect(() => crossUnrefTimer(8)).not.toThrow();
    expect(() => crossUnrefTimer(undefined)).not.toThrow();
  });

  it('is part of every runtime the shared base builds', () => {
    expect(createNodeRuntimeServices(buildNodeHost()).unrefTimer).toBe(crossUnrefTimer);
  });
});
