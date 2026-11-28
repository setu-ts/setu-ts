/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for DenoHttpAdapter — uses a fake DenoServeHost.
 *
 * @module
 */

import type { DenoServeHost, DenoServer } from '../../src/adapters/deno/deno-http-adapter.ts';
import {
  DenoHttpAdapter,
  DenoHttpServerHandle,
  isDenoHttpServerHandle,
  isMarkedSourceError,
  markSourceErrors,
} from '../../src/adapters/deno/deno-http-adapter.ts';
import { describe, expect, it } from 'vitest';
import { setUpgradeIntent } from '@setu-ts/common';
import type { IRequest, IResponse, ResponseSnapshot, WebSocketEventSink } from '@setu-ts/common';
import { DENO_WS_MAX_MESSAGE_BYTES } from '../../src/adapters/shared/websocket-ceiling.ts';
import { createTestContext } from '@setu-ts/testing';

describe('Deno socket peer', () => {
  it('reads info.remoteAddr.hostname and accepts a one-argument host', async () => {
    const handle = new DenoHttpServerHandle({
      serve: () => ({ shutdown: () => Promise.resolve() }),
    });
    let peer: string | undefined;
    handle.setHandler((request) => {
      peer = request.ip;
      return createTestContext().response;
    });
    const fetch = handle.createFetchHandler();
    for (const info of [undefined, {}, { remoteAddr: {} }]) {
      await fetch(new Request('http://localhost/'), info);
      expect(peer).toBeUndefined();
    }
    await fetch(new Request('http://localhost/'), { remoteAddr: { hostname: '::ffff:10.1.2.3' } });
    expect(peer).toBe('10.1.2.3');
  });
});

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): {
  host: DenoServeHost;
  recorded: {
    port?: number;
    hostname?: string;
    fetch?: (r: Request) => Response | Promise<Response>;
  };
} {
  const recorded: {
    port?: number;
    hostname?: string;
    fetch?: (r: Request) => Response | Promise<Response>;
  } = {};

  const host: DenoServeHost = {
    serve: (options) => {
      recorded.port = options.port;
      if (options.hostname !== undefined) {
        recorded.hostname = options.hostname;
      }
      recorded.fetch = options.fetch;

      return {
        shutdown: async () => {},
      } as unknown as DenoServer;
    },
  };

  return { host, recorded };
}

// ---------------------------------------------------------------------------
// setHandler / fetch round-trip
// ---------------------------------------------------------------------------

describe('deno-http-adapter | setHandler/fetch', () => {
  it('stores handler; fetch round-trips', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // eslint-disable-next-line require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers({ 'x-den': 'ok' }),
          body: 'deno',
        }),
      } as any;
    });

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-den')).toBe('ok');
  });

  it('fetch without setHandler returns 500', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// listen calls host.serve with correct options
// ---------------------------------------------------------------------------

describe('deno-http-adapter | listen', () => {
  it('calls host.serve with port/hostname/fetch', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // eslint-disable-next-line require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
    });

    const handle = await adapter.listen(3000, '0.0.0.0');

    expect(recorded.fetch).toBeDefined();
    expect(recorded.port).toBe(3000);
    expect(recorded.hostname).toBe('0.0.0.0');
    expect(isDenoHttpServerHandle(handle)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// close calls server.shutdown
// ---------------------------------------------------------------------------

describe('deno-http-adapter | close', () => {
  it('waits for the 1000 ms grace while shutdown is pending and observes a later rejection', async () => {
    const shutdown = Promise.withResolvers<void>();
    const handle = new DenoHttpServerHandle({
      serve: () => ({ shutdown: () => shutdown.promise }),
    });
    handle.server = { shutdown: () => shutdown.promise };
    const adapter = new DenoHttpAdapter();
    const started = performance.now();
    await adapter.close(handle);
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(handle.server).toBe(null);
    shutdown.reject(new Error('shutdown failed'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('returns promptly when shutdown rejects or resolves before the grace', async () => {
    for (const rejects of [false, true]) {
      const adapter = new DenoHttpAdapter({
        serve: () => ({
          shutdown: () =>
            rejects ? Promise.reject(new Error('shutdown failed')) : Promise.resolve(),
        }),
      });
      const handle = await adapter.listen(3000);
      const started = performance.now();
      await adapter.close(handle);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('calls server.shutdown on valid handle', async () => {
    let shutdownCalled = false;
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // eslint-disable-next-line require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
    });

    const handle = await adapter.listen(3000);

    (handle as DenoHttpServerHandle).server = {
      // eslint-disable-next-line require-await
      shutdown: async () => {
        shutdownCalled = true;
      },
    } as unknown as DenoServer;

    await adapter.close(handle);
    expect(shutdownCalled).toBe(true);
  });

  it('close with null server is a no-op', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // eslint-disable-next-line require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
    });

    const handle = await adapter.listen(3000);
    (handle as DenoHttpServerHandle).server = null;

    await adapter.close(handle);
  });
});

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

describe('deno-http-adapter | isDenoHttpServerHandle', () => {
  it('accepts valid handles', () => {
    expect(
      isDenoHttpServerHandle(
        new DenoHttpServerHandle({ serve: () => ({ shutdown: () => Promise.resolve() }) }),
      ),
    ).toBe(true);
  });

  it('rejects invalid handles', () => {
    expect(isDenoHttpServerHandle({} as any)).toBe(false);
  });
});

it('uses the native default host with an ephemeral port and startup callback', async () => {
  const { defaultDenoServeHost } = await import('../../src/adapters/deno/deno-http-adapter.ts');
  let address: { hostname: string; port: number } | undefined;
  const server = defaultDenoServeHost.serve({
    port: 0,
    onListen: (value) => {
      address = value;
    },
    fetch: () => new Response('default-host'),
  });
  try {
    expect(address!.hostname).toBe('0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${address!.port}/`);
    expect(await response.text()).toBe('default-host');
  } finally {
    await server.shutdown();
  }
  const request = new Request('http://127.0.0.1/ordinary-http');
  expect(() => defaultDenoServeHost.upgradeWebSocket!(request)).toThrow();
  expect(() => defaultDenoServeHost.upgradeWebSocket!(request, { protocol: 'chat' })).toThrow();
});
it('refuses foreign server handles on close', async () => {
  await expect(new DenoHttpAdapter().close({})).rejects.toThrow('Invalid server handle');
});

// ---------------------------------------------------------------------------
// M143i: stream failure, WebSocket ceiling and the HTTP/2 drain statement
// ---------------------------------------------------------------------------

/** A sink with a configured message limit. */
function m143iSink(maxMessageBytes?: number): WebSocketEventSink {
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

describe('Deno failed response stream (V13-256)', () => {
  it('Deno: marks a body error so onError stays quiet, and wraps a primitive', async () => {
    const reader = markSourceErrors(failingStream()).getReader();
    await reader.read();
    const error = await reader.read().catch((e: unknown) => e);
    expect(isMarkedSourceError(error)).toBe(true);
    expect(isMarkedSourceError(new Error('other'))).toBe(false);
    expect(isMarkedSourceError('text')).toBe(false);

    const primitive = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error('plain');
      },
    });
    const wrappedError = await markSourceErrors(primitive)
      .getReader()
      .read()
      .catch((e: unknown) => e);
    expect(wrappedError).toBeInstanceOf(Error);
    expect(isMarkedSourceError(wrappedError)).toBe(true);
  });
});

describe('Deno adapter: M143i', () => {
  /** A Deno host capturing serve options. */
  function denoHost(): {
    host: DenoServeHost;
    options: () => Parameters<DenoServeHost['serve']>[0];
  } {
    let captured: Parameters<DenoServeHost['serve']>[0] | undefined;
    return {
      host: {
        serve(options) {
          captured = options;
          return { shutdown: () => Promise.resolve() };
        },
        upgradeWebSocket: () => ({
          socket: new EventTarget() as never,
          response: new Response(null, { status: 200 }),
        }),
      },
      options: () => captured!,
    };
  }

  it('keeps a body error quiet in onError and reports any other error', async () => {
    const deno = denoHost();
    const records: Readonly<Record<string, unknown>>[] = [];
    const adapter = new DenoHttpAdapter(deno.host, { reportError: (r) => records.push(r) });
    adapter.setHandler(() => respond({ body: failingStream() }));
    await adapter.listen(0);
    const response = await deno.options().fetch(new Request('http://localhost/'));
    const bodyError = await response.text().catch((e: unknown) => e);
    const onError = deno.options().onError!;
    expect((await onError(bodyError)).status).toBe(500);
    expect(records).toEqual([]);
    expect((await onError(new Error('handler threw'))).status).toBe(500);
    expect(records).toEqual([
      expect.objectContaining({ level: 'error', msg: 'Deno.serve handler failed' }),
    ]);
  });

  it('states once at listen that a draining Deno server sends no GOAWAY, only with HTTP/2', async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const plain = new DenoHttpAdapter(denoHost().host, { reportError: (r) => records.push(r) });
    await plain.listen(0);
    expect(records).toEqual([]);
    const h2 = new DenoHttpAdapter(denoHost().host, {
      http2: true,
      reportError: (r) => records.push(r),
    });
    await h2.listen(0);
    expect(records).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(String(records[0]?.['msg'])).toContain('GOAWAY');
    const throwing = new DenoHttpAdapter(denoHost().host, {
      http2: true,
      reportError: () => {
        throw new Error('no channel');
      },
    });
    await expect(throwing.listen(0)).resolves.toBeDefined();
    expect('beginDrain' in throwing).toBe(false);
  });

  it('reports the ceiling at the first handshake that asks for more', async () => {
    const deno = denoHost();
    const records: Readonly<Record<string, unknown>>[] = [];
    const adapter = new DenoHttpAdapter(deno.host, { reportError: (r) => records.push(r) });
    adapter.setHandler((request: IRequest): IResponse => {
      setUpgradeIntent(request, { sink: m143iSink(DENO_WS_MAX_MESSAGE_BYTES + 1) });
      return respond();
    });
    await adapter.listen(0);
    await deno.options().fetch(
      new Request('http://localhost/ws', {
        headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
      }),
    );
    expect(records).toEqual([
      expect.objectContaining({ configured: DENO_WS_MAX_MESSAGE_BYTES + 1, platform: 'deno' }),
    ]);
  });
});
