/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M139b §3.3–§3.5 at the seams: the listener scheme and trailers flag in the
 * request mapping, the Node host options and trailer writer, Deno's TLS
 * pass-through, Bun's fixed scheme, and RuntimePlugin's `http2` option.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { CAPABILITIES } from '@setu-ts/common';
import type { IHttpAdapter, IRequest } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';

import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
  withListenerScheme,
} from '../../src/adapters/shared/fetch-mapping.ts';
import {
  NodeHttpAdapter,
  NodeHttpServerHandle,
  streamWithTrailers,
} from '../../src/adapters/node/node-http-adapter.ts';
import type { NodeServeHost } from '../../src/adapters/node/node-http-adapter.ts';
import { DenoHttpAdapter } from '../../src/adapters/deno/deno-http-adapter.ts';
import type { DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';
import { BunHttpServerHandle } from '../../src/adapters/bun/bun-http-adapter.ts';
import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';
import type { HttpAdapterOptions } from '../../src/adapters/shared/adapter-options.ts';

describe('withListenerScheme (V12-51)', () => {
  it.each([
    ['http://a/p?q=1', 'http', 'http://a/p?q=1'],
    ['https://a/p?q=1', 'http', 'http://a/p?q=1'],
    ['http://a:8080/p', 'https', 'https://a:8080/p'],
    ['https://a/p', 'https', 'https://a/p'],
    ['httpsx://a/p', 'http', 'http://a/p'],
    ['no-scheme', 'https', 'no-scheme'],
  ] as const)('%s on an %s listener → %s', (url, scheme, expected) => {
    expect(withListenerScheme(url, scheme)).toBe(expected);
  });

  it('returns the same string, unallocated, when the scheme already matches', () => {
    const url = 'http://host/path';
    expect(withListenerScheme(url, 'http')).toBe(url);
  });
});

describe('mapWebRequestToFrameworkRequest transport', () => {
  it('rewrites url and path under the listener scheme and sets the trailers flag', () => {
    const request = mapWebRequestToFrameworkRequest(
      new Request('https://h/x/y?z'),
      undefined,
      '10.0.0.1',
      { scheme: 'http', responseTrailers: true },
    );
    expect(request.url).toBe('http://h/x/y?z');
    expect(request.path).toBe('/x/y');
    expect(request.responseTrailers).toBe(true);
    expect(request.ip).toBe('10.0.0.1');
  });

  it('leaves an unspecified transport alone: URL as given, no trailers', () => {
    const request = mapWebRequestToFrameworkRequest(new Request('https://h/x'));
    expect(request.url).toBe('https://h/x');
    expect(request.responseTrailers).toBe(false);
  });
});

describe('mapSnapshotToWebResponse replacement body', () => {
  it('sends the replacement stream in place of a streaming body', async () => {
    const { response } = createTestContext();
    response.stream(new Response('original').body!);
    const mapped = mapSnapshotToWebResponse(response.snapshot(), new Response('wrapped').body!);
    expect(await mapped.text()).toBe('wrapped');
  });

  it('cancels the replacement on a null-body status', async () => {
    const { response } = createTestContext();
    response.status(204).stream(new Response('original').body!);
    let cancelled = false;
    const replacement = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const mapped = mapSnapshotToWebResponse(response.snapshot(), replacement);
    expect(mapped.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });
});

describe('streamWithTrailers', () => {
  it('passes chunks through and queues non-empty trailers after the last one', async () => {
    const queued: Record<string, string>[] = [];
    const stream = streamWithTrailers(
      new Response('abc').body!,
      Promise.resolve(new Headers({ 'grpc-status': '0' })),
      (fields) => queued.push({ ...fields }),
    );
    expect(await new Response(stream).text()).toBe('abc');
    expect(queued).toEqual([{ 'grpc-status': '0' }]);
  });

  it('queues nothing for empty trailers', async () => {
    const queued: unknown[] = [];
    const stream = streamWithTrailers(
      new Response('a').body!,
      Promise.resolve(new Headers()),
      (f) => queued.push(f),
    );
    await new Response(stream).text();
    expect(queued).toEqual([]);
  });

  it('errors the stream when the trailers reject, rather than ending it as success', async () => {
    const stream = streamWithTrailers(
      new Response('a').body!,
      Promise.reject(new Error('call failed')),
      () => undefined,
    );
    await expect(new Response(stream).text()).rejects.toThrow('call failed');
  });

  it('cancels the source when the client cancels', async () => {
    let reason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(r) {
        reason = r;
      },
    });
    await streamWithTrailers(source, new Promise(() => undefined), () => undefined).cancel('gone');
    expect(reason).toBe('gone');
  });
});

describe('Node adapter http2 seams', () => {
  /** A host that records what `serve()` was given and answers one fake server. */
  function recordingHost(): NodeServeHost & { options: any[] } {
    const options: any[] = [];
    return {
      options,
      serve: (given) => {
        options.push(given);
        return Promise.resolve({ close() {} });
      },
    };
  }

  it.each([
    ['true', true],
    ['TLS', { key: 'k', cert: 'c' }],
  ] as const)('passes http2 (%s) to the serve host', async (_name, http2) => {
    const host = recordingHost();
    const adapter = new NodeHttpAdapter(host, undefined, { http2 });
    await adapter.listen(0);
    expect(host.options[0].http2).toEqual(http2);
  });

  it('passes no http2 key when unset', async () => {
    const host = recordingHost();
    await new NodeHttpAdapter(host).listen(0);
    expect('http2' in host.options[0]).toBe(false);
  });

  /** Serves one request through a handle and reports what the handler saw. */
  async function served(
    options: HttpAdapterOptions | undefined,
    url: string,
    env: any,
  ): Promise<{ request: IRequest; response: Response }> {
    const handle = new NodeHttpServerHandle(undefined, options);
    let seen: IRequest | undefined;
    handle.setHandler((request) => {
      seen = request;
      const { response } = createTestContext();
      response.stream(new Response('body').body!, {
        trailers: Promise.resolve(new Headers({ 'grpc-status': '0' })),
      });
      return response;
    });
    const response = await handle.createFetchHandler()(new Request(url), env);
    return { request: seen!, response };
  }

  it('an h2 request on a TLS listener: https scheme, trailers flag, trailers written', async () => {
    const queued: Record<string, string>[] = [];
    const env = {
      incoming: { httpVersion: '2.0', socket: { remoteAddress: '10.0.0.9' } },
      outgoing: { writeHead: () => undefined, addTrailers: (f: any) => queued.push(f) },
    };
    const { request, response } = await served(
      { http2: { key: 'k', cert: 'c' } },
      'http://h/a',
      env,
    );
    expect(request.url).toBe('https://h/a');
    expect(request.ip).toBe('10.0.0.9');
    expect(request.responseTrailers).toBe(true);
    expect(await response.text()).toBe('body');
    expect(queued).toEqual([{ 'grpc-status': '0' }]);
  });

  it('an HTTP/1.1 request writes no trailers, even where the response could', async () => {
    const queued: unknown[] = [];
    const env = {
      incoming: { httpVersion: '1.1' },
      outgoing: { writeHead: () => undefined, addTrailers: (f: unknown) => queued.push(f) },
    };
    const { request, response } = await served(undefined, 'https://h/a', env);
    expect(request.url).toBe('http://h/a');
    expect(request.responseTrailers).toBe(false);
    await response.text();
    expect(queued).toEqual([]);
  });

  it('an h2 request whose response has no addTrailers is not offered trailers', async () => {
    const env = { incoming: { httpVersion: '2.0' }, outgoing: { writeHead: () => undefined } };
    const { request } = await served({ http2: true }, 'http://h/a', env);
    expect(request.responseTrailers).toBe(false);
  });

  it('an in-process fetch keeps its own URL and is offered no trailers', async () => {
    const { request } = await served({ http2: { key: 'k', cert: 'c' } }, 'http://h/a', undefined);
    expect(request.url).toBe('http://h/a');
    expect(request.responseTrailers).toBe(false);
  });
});

describe('Deno adapter TLS and scheme', () => {
  function recordingHost(): DenoServeHost & { options: any[]; fetch: () => any } {
    const options: any[] = [];
    return {
      options,
      fetch: () => options[0].fetch,
      serve: (given) => {
        options.push(given);
        return { shutdown: () => Promise.resolve() };
      },
    };
  }

  it('passes cert and key to Deno.serve, and serves https URLs', async () => {
    const host = recordingHost();
    const adapter = new DenoHttpAdapter(host, { http2: { key: 'K', cert: 'C' } });
    let seen: IRequest | undefined;
    adapter.setHandler((request) => {
      seen = request;
      return createTestContext().response;
    });
    await adapter.listen(0);
    expect(host.options[0].cert).toBe('C');
    expect(host.options[0].key).toBe('K');
    await host.fetch()(new Request('http://h/a'), { remoteAddr: { hostname: '10.0.0.3' } });
    expect(seen!.url).toBe('https://h/a');
    expect(seen!.ip).toBe('10.0.0.3');
  });

  it('http2: true passes nothing, and a served request is http whatever it claims', async () => {
    const host = recordingHost();
    const adapter = new DenoHttpAdapter(host, { http2: true });
    let seen: IRequest | undefined;
    adapter.setHandler((request) => {
      seen = request;
      return createTestContext().response;
    });
    await adapter.listen(0);
    expect('cert' in host.options[0]).toBe(false);
    await host.fetch()(new Request('https://h/a'), {});
    expect(seen!.url).toBe('http://h/a');
    expect(seen!.responseTrailers).toBe(false);
    await adapter.fetch(new Request('https://h/b'));
    expect(seen!.url).toBe('https://h/b');
  });
});

describe('Bun.serve scheme', () => {
  it('a served request is http whatever its request line claims', async () => {
    const handle = new BunHttpServerHandle();
    let seen: IRequest | undefined;
    handle.setHandler((request) => {
      seen = request;
      return createTestContext().response;
    });
    await handle.createServeCallback()(new Request('https://h/a'), { stop() {} });
    expect(seen!.url).toBe('http://h/a');
  });
});

describe('RuntimePlugin http2', () => {
  /** Registers the plugin against a map and returns what the adapter factory got. */
  function register(options: Parameters<typeof RuntimePlugin>[0]): {
    chosen: string;
    adapterOptions: HttpAdapterOptions | undefined;
  } {
    let chosen = '';
    let adapterOptions: HttpAdapterOptions | undefined;
    const factory =
      (name: string) =>
      (given?: HttpAdapterOptions): IHttpAdapter => {
        chosen = name;
        adapterOptions = given;
        return {} as IHttpAdapter;
      };
    const plugin = RuntimePlugin({
      ...options,
      adapters: {
        node: () => ({}) as any,
        bun: () => ({}) as any,
        deno: () => ({}) as any,
        'cloudflare-workers': () => ({}) as any,
      },
      httpAdapters: {
        node: factory('node'),
        bun: factory('bun'),
        deno: factory('deno'),
        'cloudflare-workers': factory('cloudflare-workers'),
      },
    });
    const registry = new Map<string, unknown>();
    plugin.register({
      lifecycle: { onClose: () => undefined },
      services: {
        register: (capability: string, value: unknown) => registry.set(capability, value),
        get: (capability: string) => registry.get(capability),
        has: (capability: string) => registry.has(capability),
      },
    } as any);
    expect(registry.has(CAPABILITIES.HTTP_ADAPTER)).toBe(true);
    return { chosen, adapterOptions };
  }

  it('threads http2 to the adapter', () => {
    expect(register({ platform: 'node', http2: true }).adapterOptions?.http2).toBe(true);
  });

  it('omits the key when unset', () => {
    expect('http2' in (register({ platform: 'node' }).adapterOptions ?? {})).toBe(false);
  });

  it('serves Bun through the Node adapter while http2 is set, and Bun.serve otherwise', () => {
    expect(register({ platform: 'bun', http2: true }).chosen).toBe('node');
    expect(register({ platform: 'bun' }).chosen).toBe('bun');
  });

  it('keeps Deno and Workers on their own adapters', () => {
    expect(register({ platform: 'deno', http2: true }).chosen).toBe('deno');
    expect(register({ platform: 'cloudflare-workers', http2: true }).chosen).toBe(
      'cloudflare-workers',
    );
  });

  it.each([
    ['an empty key', { key: '', cert: 'c' }],
    ['an empty cert', { key: 'k', cert: '' }],
    ['a non-string key', { key: 1, cert: 'c' }],
    ['a non-string cert', { key: 'k', cert: undefined }],
  ])('refuses %s without echoing the key', (_name, http2) => {
    let thrown: unknown;
    try {
      RuntimePlugin({ http2: http2 as any });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain('"k"');
  });
});
