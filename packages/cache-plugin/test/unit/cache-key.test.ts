// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HandlerResult, IRequestContext, ITenant } from '@setu-ts/common';

import {
  composeCacheKey,
  defaultCacheKey,
  tenantSegment,
  varySegment,
} from '../../src/utils/cache-key.ts';

describe('defaultCacheKey', () => {
  it('produces method:url key', () => {
    const ctx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    expect(defaultCacheKey(ctx)).toBe('GET:http://localhost/api/users');
  });

  it('varies by HTTP method', () => {
    const getCtx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    const postCtx = fakeContext({ method: 'POST', url: 'http://localhost/api/users' });

    expect(defaultCacheKey(getCtx)).not.toBe(defaultCacheKey(postCtx));
    expect(defaultCacheKey(postCtx)).toBe('POST:http://localhost/api/users');
  });

  it('varies by query string', () => {
    const ctx1 = fakeContext({ method: 'GET', url: 'http://localhost/api/users?page=1' });
    const ctx2 = fakeContext({ method: 'GET', url: 'http://localhost/api/users?page=2' });

    expect(defaultCacheKey(ctx1)).toBe('GET:http://localhost/api/users?page=1');
    expect(defaultCacheKey(ctx2)).toBe('GET:http://localhost/api/users?page=2');
    expect(defaultCacheKey(ctx1)).not.toBe(defaultCacheKey(ctx2));
  });

  it('produces identical keys for identical requests', () => {
    const ctx1 = fakeContext({ method: 'GET', url: 'http://localhost/api/data?q=test' });
    const ctx2 = fakeContext({ method: 'GET', url: 'http://localhost/api/data?q=test' });

    expect(defaultCacheKey(ctx1)).toBe(defaultCacheKey(ctx2));
  });
});

describe('tenantSegment', () => {
  it('is empty when no tenant is resolved', () => {
    const ctx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    expect(tenantSegment(ctx)).toBe('');
  });

  it('is length-prefixed when a tenant is resolved', () => {
    const ctx = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'acme' },
    });
    expect(tenantSegment(ctx)).toBe('t:4:acme|');
  });

  it('varies by tenant id', () => {
    const acme = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'acme' },
    });
    const globex = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'globex' },
    });
    expect(tenantSegment(acme)).not.toBe(tenantSegment(globex));
  });
});

describe('varySegment', () => {
  it('is empty when no vary function is supplied', () => {
    const ctx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    expect(varySegment(ctx)).toBe('');
  });

  it('appends each value length-prefixed, in order', () => {
    const ctx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    const segment = varySegment(ctx, () => ['en', 'beta']);
    expect(segment).toBe('v:2:en|v:4:beta|');
  });

  it('is empty for an empty value list', () => {
    const ctx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    expect(varySegment(ctx, () => [])).toBe('');
  });
});

describe('composeCacheKey', () => {
  it('is byte-identical to the default key with no tenant and no vary', () => {
    const ctx = fakeContext({ method: 'GET', url: 'http://localhost/api/users' });
    expect(composeCacheKey(ctx)).toBe(defaultCacheKey(ctx));
  });

  it('prepends the tenant segment to the default key', () => {
    const ctx = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'acme' },
    });
    expect(composeCacheKey(ctx)).toBe(`t:4:acme|GET:http://localhost/api/users`);
  });

  it('applies the tenant segment around a custom base key too', () => {
    const ctx = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'acme' },
    });
    expect(composeCacheKey(ctx, 'custom-key')).toBe('t:4:acme|custom-key');
  });

  it('orders tenant, vary, then base', () => {
    const ctx = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'acme' },
    });
    const key = composeCacheKey(ctx, undefined, () => ['en']);
    expect(key).toBe('t:4:acme|v:2:en|GET:http://localhost/api/users');
  });

  it('separates two tenants on the same route', () => {
    const acme = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'acme' },
    });
    const globex = fakeContext({
      method: 'GET',
      url: 'http://localhost/api/users',
      tenant: { id: 'globex' },
    });
    expect(composeCacheKey(acme)).not.toBe(composeCacheKey(globex));
  });

  it('cannot be forged by a tenant id containing a separator and digit prefix', () => {
    // A tenant literally named `4:acme|GET:/x` must not produce the key of
    // tenant `acme` on route `GET:/x`: the length prefix makes the boundary
    // unambiguous.
    const acme = fakeContext({
      method: 'GET',
      url: 'http://localhost/x',
      tenant: { id: 'acme' },
    });
    const forged = fakeContext({
      method: 'GET',
      url: 'http://localhost/x',
      tenant: { id: '4:acme|GET:/x' },
    });
    expect(composeCacheKey(acme)).toBe('t:4:acme|GET:http://localhost/x');
    expect(composeCacheKey(forged)).toBe('t:13:4:acme|GET:/x|GET:http://localhost/x');
    expect(composeCacheKey(acme)).not.toBe(composeCacheKey(forged));
  });
});

function fakeContext(opts: {
  method: string;
  url: string;
  tenant?: ITenant;
}): IRequestContext {
  const hr: HandlerResult = { __handlerResult: true };

  const respStub = {
    status: () => respStub,
    header: () => respStub,
    appendHeader: () => respStub,
    json: () => hr,
    text: () => hr,
    send: () => hr,
    redirect: () => hr,
    stream: () => hr,
    snapshot: () =>
      ({
        streaming: false,
        status: 200,
        headers: new Headers(),
        body: null,
      }) as import('@setu-ts/common').ResponseSnapshot,
  };

  const _abort = new AbortController();

  return {
    id: 'test-id',
    request: {
      method: opts.method as IRequestContext['request']['method'],
      url: opts.url,
      path: new URL(opts.url).pathname,
      headers: new Headers(),
      ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
      json: async <T = unknown>() => ({} as T),
      text: async () => '',
      bytes: async () => new Uint8Array(0),
    },
    response: respStub,
    services: {
      has: () => false,
      get: () => null as never,
      getAll: () => [],
      register: () => {},
      registerFactory: () => {},
      unregister: () => false,
    },
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
    signal: _abort.signal,
  };
}
