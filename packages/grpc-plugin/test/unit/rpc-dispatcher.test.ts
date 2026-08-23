/**
 * Unit tests for path-based RPC dispatch: base-path normalization, the
 * segment-aware prefix check, exact-match dispatch, and the fall-through
 * behavior that keeps ordinary Hono traffic untouched.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DEFAULT_BASE_PATH,
  dispatchRequest,
  isWithinBasePath,
  normalizeBasePath,
} from '../../src/transports/rpc-dispatcher.ts';

/** A dispatch map whose handler records that it ran. */
function mapWith(...paths: string[]): Map<string, (r: Request) => Promise<Response>> {
  return new Map(
    paths.map((path) => [
      path,
      () => Promise.resolve(new Response(`handled:${path}`, { status: 200 })),
    ]),
  );
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
    const response = await dispatchRequest(
      new Request('http://x/grpc/pkg.Svc/Method', { method: 'POST' }),
      map,
      '/grpc',
    );
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('handled:/grpc/pkg.Svc/Method');
  });

  it('returns null for a path outside the prefix so Hono handles it', async () => {
    const result = await dispatchRequest(
      new Request('http://x/users', { method: 'GET' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(result).toBeNull();
  });

  it('returns null for an application/json POST outside the prefix', async () => {
    // Connect's real unary content types include application/json, so
    // media-type sniffing would hijack this request. Detection is prefix-only.
    const result = await dispatchRequest(
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
    const result = await dispatchRequest(
      new Request('http://x/grpcfoo', { method: 'GET' }),
      mapWith('/grpc/pkg.Svc/Method'),
      '/grpc',
    );
    expect(result).toBeNull();
  });

  it('answers 404 for an unknown procedure inside the prefix', async () => {
    const response = await dispatchRequest(
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
    expect(
      await dispatchRequest(new Request('http://x/users'), map, ''),
    ).toBeNull();

    const hit = await dispatchRequest(
      new Request('http://x/pkg.Svc/Method', { method: 'POST' }),
      map,
      '',
    );
    expect(hit?.status).toBe(200);
  });

  it('ignores the query string when matching', async () => {
    const response = await dispatchRequest(
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
    const response = await dispatchRequest(
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
      const response = await dispatchRequest(
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
    for (
      const contentType of [
        'application/connect+json',
        'application/connect+proto',
        'application/grpc-web+json',
        'application/grpc-web+proto',
        'application/json',
      ]
    ) {
      const response = await dispatchRequest(
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
      await dispatchRequest(
        new Request('http://x/no.Such/Method', {
          method: 'POST',
          headers: { 'content-type': 'application/grpc' },
          body: new Uint8Array([0]),
        }),
        map,
        '',
      ),
    ).toBeNull();

    const miss = await dispatchRequest(
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
