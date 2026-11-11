/**
 * Unit tests for path-based RPC dispatch: base-path normalization, the
 * segment-aware prefix check, exact-match dispatch, and the fall-through
 * behavior that keeps ordinary Hono traffic untouched.
 */

import { describe, expect, it } from 'vitest';
import type { RpcReply, RpcTransport } from '@setu-ts/common';
import {
  DEFAULT_BASE_PATH,
  dispatchRpc,
  streamingSides,
  isWithinBasePath,
  normalizeBasePath,
} from '../../src/transports/rpc-dispatcher.ts';
import type { DispatchEntry } from '../../src/transports/rpc-dispatcher.ts';
import type { UniversalServerRequestLike } from '../../src/interfaces/connect-runtime.ts';
import { callFromRequest, responseFromReply } from '../../src/transports/rpc-call.ts';

async function* chunks(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/**
 * A dispatch map whose universal handlers answer `handled:<path>`, with a
 * `grpc-status: 0` trailer that only the native path carries through.
 */
function mapWith(...paths: string[]): Map<string, DispatchEntry> {
  return new Map(
    paths.map((path) => [
      path,
      {
        handle: () =>
          Promise.resolve({
            status: 200,
            header: new Headers({ 'x-handled': 'yes' }),
            body: chunks(`handled:${path}`),
            trailer: new Headers({ 'grpc-status': '0' }),
          }),
        streamsRequest: false,
        streamsResponse: path.endsWith('Stream'),
      },
    ]),
  );
}

/** A dispatch of a fetch `Request`, as `handleRequest` makes it. */
async function dispatchReply(
  request: Request,
  map: Map<string, DispatchEntry>,
  basePath: string,
  transport?: RpcTransport,
): Promise<RpcReply | null> {
  return dispatchRpc(await callFromRequest(request, false), map, basePath, transport);
}

/** The response of a dispatch, as the pre-M139b tests read it; `null` falls through. */
async function dispatchResponse(
  request: Request,
  map: Map<string, DispatchEntry>,
  basePath: string,
  transport?: RpcTransport,
): Promise<Response | null> {
  const reply = await dispatchReply(request, map, basePath, transport);
  return reply === null ? null : responseFromReply(reply);
}

describe('normalizeBasePath', () => {
  it('defaults to the root (M70i: DEFAULT_BASE_PATH is the single home)', () => {
    // The constant is the one value both the default parameter and
    // GrpcService read; pinning it here is what makes the default root.
    expect(DEFAULT_BASE_PATH).toBe('/');
    expect(normalizeBasePath()).toBe('');
  });

  it('normalizes with and without a trailing slash identically', () => {
    expect(normalizeBasePath('/grpc')).toBe('/grpc');
    expect(normalizeBasePath('/grpc/')).toBe('/grpc');
    expect(normalizeBasePath('grpc')).toBe('/grpc');
    expect(normalizeBasePath('grpc/')).toBe('/grpc');
    expect(normalizeBasePath('  /grpc/  ')).toBe('/grpc');
  });

  it('normalizes a root base path to the empty string, not to a slash', () => {
    // '/' would produce a double-slashed dispatch key ('//pkg.Svc/Method')
    // that no request could ever match.
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('')).toBe('');
  });

  it('preserves a multi-segment base path', () => {
    expect(normalizeBasePath('/api/rpc/')).toBe('/api/rpc');
  });
});

describe('isWithinBasePath', () => {
  it('accepts the base path itself and any path below it', () => {
    expect(isWithinBasePath('/grpc', '/grpc')).toBe(true);
    expect(isWithinBasePath('/grpc/pkg.Svc/Method', '/grpc')).toBe(true);
  });

  it('rejects a path that merely shares the prefix as a substring', () => {
    // The regression this exists to prevent: a bare startsWith would claim
    // '/grpcfoo' and shadow an ordinary Hono route.
    expect(isWithinBasePath('/grpcfoo', '/grpc')).toBe(false);
    expect(isWithinBasePath('/grpc-admin', '/grpc')).toBe(false);
  });

  it('treats every path as within a root base path', () => {
    expect(isWithinBasePath('/anything', '')).toBe(true);
  });
});

describe('dispatchRpc', () => {
  it('dispatches an exact requestPath match', async () => {
    const map = mapWith('/grpc/pkg.Svc/Method');
    const response = await dispatchResponse(
      new Request('http://x/grpc/pkg.Svc/Method', { method: 'POST' }),
      map,
      '/grpc',
    );
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('handled:/grpc/pkg.Svc/Method');
  });

  it('returns null for a path outside the prefix so Hono handles it', async () => {
    const result = await dispatchResponse(
      new Request('http://x/users', { method: 'GET' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(result).toBeNull();
  });

  it('returns null for an application/json POST outside the prefix', async () => {
    // Connect's real unary content types include application/json, so
    // media-type sniffing would hijack this request. Detection is prefix-only.
    const result = await dispatchResponse(
      new Request('http://x/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"ada"}',
      }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(result).toBeNull();
  });

  it('returns null for a prefix-adjacent path rather than 404-ing it', async () => {
    const result = await dispatchResponse(
      new Request('http://x/grpcfoo', { method: 'GET' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(result).toBeNull();
  });

  it('answers 404 for an unknown procedure inside the prefix', async () => {
    const response = await dispatchResponse(
      new Request('http://x/grpc/pkg.Svc/Missing', { method: 'POST' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(response?.status).toBe(404);
  });

  it('falls through instead of 404-ing on a miss under a root base path', async () => {
    // At the root, "unknown procedure" is indistinguishable from "ordinary
    // application route" — 404-ing would take the whole application down.
    const map = mapWith('/pkg.Svc/Method');
    expect(await dispatchResponse(new Request('http://x/users'), map, '')).toBeNull();

    const hit = await dispatchResponse(
      new Request('http://x/pkg.Svc/Method', { method: 'POST' }),
      map,
      '',
    );
    expect(hit?.status).toBe(200);
  });

  it('ignores the query string when matching', async () => {
    const response = await dispatchResponse(
      new Request('http://x/grpc/pkg.Svc/Method?trace=1', { method: 'POST' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(response?.status).toBe(200);
  });
});

describe('dispatchRpc — native gRPC refusal (M70i §3.3)', () => {
  it('refuses a matched native application/grpc request with Trailers-Only UNIMPLEMENTED', async () => {
    const map = mapWith('/pkg.Svc/Method');
    const response = await dispatchResponse(
      new Request('http://x/pkg.Svc/Method', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc' },
        body: new Uint8Array([0, 0, 0, 0, 1]),
      }),
      map,
      '',
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('application/grpc');
    expect(response?.headers.get('grpc-status')).toBe('12');
    expect(response?.headers.get('grpc-message')).toContain('Connect');
    expect(await response!.text()).toBe('');
  });

  it('refuses native +proto and +json at a non-root base path too', async () => {
    const map = mapWith('/grpc/pkg.Svc/Method');
    for (const contentType of ['application/grpc+proto', 'application/grpc+json']) {
      const response = await dispatchResponse(
        new Request('http://x/grpc/pkg.Svc/Method', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: new Uint8Array([0]),
        }),
        map,
        '/grpc',
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get('grpc-status')).toBe('12');
    }
  });

  it('lets Connect and gRPC-Web content types reach the handler', async () => {
    const map = mapWith('/pkg.Svc/Method');
    for (const contentType of [
      'application/connect+json',
      'application/connect+proto',
      'application/grpc-web+json',
      'application/grpc-web+proto',
      'application/json',
    ]) {
      const response = await dispatchResponse(
        new Request('http://x/pkg.Svc/Method', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: '{}',
        }),
        map,
        '',
      );
      expect(response?.status).toBe(200);
      expect(await response!.text()).toBe('handled:/pkg.Svc/Method');
    }
  });

  it('does not refuse an unmatched path even with a native content type', async () => {
    // Refusal is for MATCHED procedures only; an unknown path under a root
    // base falls through to Hono, and under a prefix answers the plain 404.
    const map = mapWith('/pkg.Svc/Method');
    expect(
      await dispatchResponse(
        new Request('http://x/no.Such/Method', {
          method: 'POST',
          headers: { 'content-type': 'application/grpc' },
          body: new Uint8Array([0]),
        }),
        map,
        '',
      ),
    ).toBeNull();

    const miss = await dispatchResponse(
      new Request('http://x/grpc/no.Such/Method', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc' },
        body: new Uint8Array([0]),
      }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(miss?.status).toBe(404);
  });
});

describe('dispatchRpc — M139b replies', () => {
  it('serves native gRPC through the trailers path when the transport carries them', async () => {
    const reply = await dispatchReply(
      new Request('http://x/pkg.Svc/Method', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc' },
      }),
      mapWith('/pkg.Svc/Method'),
      '',
      { trailers: true },
    );
    expect(reply!.body).toBeInstanceOf(ReadableStream);
    expect(await responseFromReply(reply!).text()).toBe('handled:/pkg.Svc/Method');
    expect((await reply!.trailers!).get('grpc-status')).toBe('0');
  });

  it('refuses native gRPC on a transport without trailers, as a buffered reply', async () => {
    const reply = await dispatchReply(
      new Request('http://x/pkg.Svc/Method', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc' },
      }),
      mapWith('/pkg.Svc/Method'),
      '',
      { trailers: false },
    );
    expect(reply!.headers.get('grpc-status')).toBe('12');
    expect(reply!.body).toBeNull();
    expect(reply!.body).not.toBeInstanceOf(ReadableStream);
  });

  it('marks a Connect reply streaming exactly when the procedure streams its response', async () => {
    const map = mapWith('/pkg.Svc/Method', '/pkg.Svc/Stream');
    const unary = await dispatchReply(
      new Request('http://x/pkg.Svc/Method', { method: 'POST' }),
      map,
      '',
    );
    const stream = await dispatchReply(
      new Request('http://x/pkg.Svc/Stream', { method: 'POST' }),
      map,
      '',
    );
    expect(unary!.body).not.toBeInstanceOf(ReadableStream);
    expect(unary!.body).toEqual(new TextEncoder().encode('handled:/pkg.Svc/Method'));
    expect(unary!.headers.get('x-handled')).toBe('yes');
    expect(stream!.body).toBeInstanceOf(ReadableStream);
    expect(stream!.body).toBeInstanceOf(ReadableStream);
    expect(stream!.trailers).toBeUndefined();
  });

  it('answers a 404 reply under a non-root base path', async () => {
    const reply = await dispatchReply(
      new Request('http://x/grpc/pkg.Svc/Nope', { method: 'POST' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(reply!.status).toBe(404);
    expect(await responseFromReply(reply!).text()).toBe('Not Found');
    expect(reply!.body).not.toBeInstanceOf(ReadableStream);
  });
});

describe('streamingSides', () => {
  it.each([
    ['unary', false, false],
    ['server_streaming', false, true],
    ['client_streaming', true, false],
    ['bidi_streaming', true, true],
    [undefined, false, false],
  ] as const)('%s → request %s, response %s', (kind, request, response) => {
    expect(streamingSides(kind)).toEqual({ streamsRequest: request, streamsResponse: response });
  });
});

describe('dispatchRpc — the universal request (M139b §3.11)', () => {
  function recordingMap(seen: UniversalServerRequestLike[]): Map<string, DispatchEntry> {
    return new Map([
      [
        '/pkg.Svc/M',
        {
          handle: (request) => {
            seen.push(request);
            return Promise.resolve({ status: 200 });
          },
          streamsRequest: false,
          streamsResponse: false,
        },
      ],
    ]);
  }

  it.each(['application/connect+proto', 'application/grpc'])(
    'hands a %s call the transport signal and the call fields',
    async (contentType) => {
      const seen: UniversalServerRequestLike[] = [];
      const signal = new AbortController().signal;
      const headers = new Headers({ 'content-type': contentType });
      const reply = await dispatchRpc(
        {
          method: 'POST',
          url: 'http://x/pkg.Svc/M?q=1',
          path: '/pkg.Svc/M',
          headers,
          body: new Uint8Array([7]),
        },
        recordingMap(seen),
        '',
        { trailers: true, signal },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.signal).toBe(signal);
      expect(seen[0]!.header).toBe(headers);
      expect(seen[0]!.url).toBe('http://x/pkg.Svc/M?q=1');
      expect(seen[0]!.httpVersion).toBe('');
      const body: number[] = [];
      for await (const chunk of seen[0]!.body) body.push(...chunk);
      expect(body).toEqual([7]);
      expect(reply!.status).toBe(200);
    },
  );

  it('hands no signal when the transport is absent, and a bodyless reply is null', async () => {
    const seen: UniversalServerRequestLike[] = [];
    const reply = await dispatchRpc(
      {
        method: 'POST',
        url: 'http://x/pkg.Svc/M',
        path: '/pkg.Svc/M',
        headers: new Headers(),
        body: new Uint8Array(),
      },
      recordingMap(seen),
      '',
    );
    expect('signal' in seen[0]!).toBe(false);
    expect(reply!.body).toBeNull();
    expect(reply!.body).not.toBeInstanceOf(ReadableStream);
  });

  it('matches on the call path, not on the URL', async () => {
    const seen: UniversalServerRequestLike[] = [];
    const reply = await dispatchRpc(
      {
        method: 'POST',
        url: 'http://x/elsewhere',
        path: '/pkg.Svc/M',
        headers: new Headers(),
        body: new Uint8Array(),
      },
      recordingMap(seen),
      '',
    );
    expect(reply).not.toBeNull();
    expect(seen).toHaveLength(1);
  });
});
