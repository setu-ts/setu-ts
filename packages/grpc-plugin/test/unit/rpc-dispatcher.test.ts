/**
 * Unit tests for path-based RPC dispatch: base-path normalization, the
 * segment-aware prefix check, exact-match dispatch, and the fall-through
 * behavior that keeps ordinary Hono traffic untouched.
 */

import { describe, expect, it } from 'vitest';
import type { RpcTransport } from '@setu-ts/common';
import {
  DEFAULT_BASE_PATH,
  dispatchRequest,
  streamingSides,
  isWithinBasePath,
  normalizeBasePath,
} from '../../src/transports/rpc-dispatcher.ts';
import type { DispatchEntry } from '../../src/transports/rpc-dispatcher.ts';

/** A dispatch map whose entries answer `handled:<path>` (Connect) or `native:<path>`. */
function mapWith(...paths: string[]): Map<string, DispatchEntry> {
  return new Map(
    paths.map((path) => [
      path,
      {
        fetch: () => Promise.resolve(new Response(`handled:${path}`, { status: 200 })),
        native: () =>
          Promise.resolve({
            response: new Response(`native:${path}`),
            streaming: true,
            trailers: Promise.resolve(new Headers({ 'grpc-status': '0' })),
          }),
        streamsRequest: false,
        streamsResponse: path.endsWith('Stream'),
      },
    ]),
  );
}

/** The response of a dispatch, as the pre-M139b tests read it; `null` falls through. */
async function dispatchResponse(
  request: Request,
  map: Map<string, DispatchEntry>,
  basePath: string,
  transport?: RpcTransport,
): Promise<Response | null> {
  const reply = await dispatchRequest(request, map, basePath, transport);
  return reply?.response ?? null;
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

describe('dispatchRequest', () => {
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

describe('dispatchRequest — native gRPC refusal (M70i §3.3)', () => {
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

describe('dispatchRequest — M139b replies', () => {
  it('serves native gRPC through the trailers path when the transport carries them', async () => {
    const reply = await dispatchRequest(
      new Request('http://x/pkg.Svc/Method', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc' },
      }),
      mapWith('/pkg.Svc/Method'),
      '',
      { trailers: true },
    );
    expect(await reply!.response.text()).toBe('native:/pkg.Svc/Method');
    expect((await reply!.trailers!).get('grpc-status')).toBe('0');
  });

  it('refuses native gRPC on a transport without trailers, as a buffered reply', async () => {
    const reply = await dispatchRequest(
      new Request('http://x/pkg.Svc/Method', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc' },
      }),
      mapWith('/pkg.Svc/Method'),
      '',
      { trailers: false },
    );
    expect(reply!.response.headers.get('grpc-status')).toBe('12');
    expect(reply!.streaming).toBe(false);
  });

  it('marks a Connect reply streaming exactly when the procedure streams its response', async () => {
    const map = mapWith('/pkg.Svc/Method', '/pkg.Svc/Stream');
    const unary = await dispatchRequest(
      new Request('http://x/pkg.Svc/Method', { method: 'POST' }),
      map,
      '',
    );
    const stream = await dispatchRequest(
      new Request('http://x/pkg.Svc/Stream', { method: 'POST' }),
      map,
      '',
    );
    expect(unary!.streaming).toBe(false);
    expect(stream!.streaming).toBe(true);
  });

  it('answers a 404 reply under a non-root base path', async () => {
    const reply = await dispatchRequest(
      new Request('http://x/grpc/pkg.Svc/Nope', { method: 'POST' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(reply!.response.status).toBe(404);
    expect(reply!.streaming).toBe(false);
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

describe('dispatchRequest — the transport signal (M139b)', () => {
  function recordingEntry(seen: { fetch: unknown[]; native: unknown[] }): DispatchEntry {
    return {
      fetch: (_request, signal) => {
        seen.fetch.push(signal);
        return Promise.resolve(new Response('ok'));
      },
      native: (_request, signal) => {
        seen.native.push(signal);
        return Promise.resolve({ response: new Response('ok'), streaming: true });
      },
      streamsRequest: false,
      streamsResponse: false,
    };
  }

  it.each([
    ['application/connect+proto', 'fetch'],
    ['application/grpc', 'native'],
  ] as const)('hands a %s call the signal (%s entry point)', async (contentType, side) => {
    const seen = { fetch: [] as unknown[], native: [] as unknown[] };
    const signal = new AbortController().signal;
    await dispatchRequest(
      new Request('http://x/pkg.Svc/M', {
        method: 'POST',
        headers: { 'content-type': contentType },
      }),
      new Map([['/pkg.Svc/M', recordingEntry(seen)]]),
      '',
      { trailers: true, signal },
    );
    expect(seen[side]).toEqual([signal]);
  });

  it('hands no signal when the transport is absent', async () => {
    const seen = { fetch: [] as unknown[], native: [] as unknown[] };
    await dispatchRequest(
      new Request('http://x/pkg.Svc/M', { method: 'POST' }),
      new Map([['/pkg.Svc/M', recordingEntry(seen)]]),
      '',
    );
    expect(seen.fetch).toEqual([undefined]);
  });
});
