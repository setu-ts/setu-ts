// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HandlerResult, IRequestContext } from '@hono-enterprise/common';

import { defaultCacheKey } from '../../src/utils/cache-key.ts';

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

function fakeContext(opts: { method: string; url: string }): IRequestContext {
  const hr: HandlerResult = { __handlerResult: true };

  const respStub = {
    status: () => respStub,
    header: () => respStub,
    appendHeader: () => respStub,
    json: () => hr,
    text: () => hr,
    send: () => hr,
    redirect: () => hr,
    snapshot: () => ({ status: 200, headers: new Headers(), body: null }),
  };

  return {
    id: 'test-id',
    request: {
      method: opts.method as IRequestContext['request']['method'],
      url: opts.url,
      path: new URL(opts.url).pathname,
      headers: new Headers(),
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
  };
}
