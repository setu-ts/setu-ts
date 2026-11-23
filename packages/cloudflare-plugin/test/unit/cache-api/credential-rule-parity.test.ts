import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * One credential rule for both response caches (V13-111): every row runs
 * through `cache-plugin`'s `cacheMiddleware` and this package's
 * `cacheApiMiddleware`, and both must reach the same outcome — stored or not,
 * and served from cache or not. Outcomes only, never refusal reasons.
 *
 * Excluded, because only `cacheMiddleware` has them: coalescing on the
 * cookie-less path, and the streaming refusal through the coalescer.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  COOKIE_DEPENDENT_RESPONSE_STATE_KEY,
  PER_VISITOR_RESPONSE_STATE_KEY,
} from '@setu-ts/common';
import type { ICacheStore, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { createTestContext, MockServiceRegistry } from '@setu-ts/testing';
import { cacheMiddleware } from '@setu-ts/cache-plugin';

import { cacheApiMiddleware } from '../../../src/cache-api/cache-api-middleware.ts';
import { FakeCacheApi } from '../../fakes.ts';

/** A Map-backed `ICacheStore`, enough for `cacheMiddleware`. */
class MapStore implements ICacheStore {
  readonly #map = new Map<string, unknown>();
  /** How many writes reached the store. */
  sets = 0;
  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.#map.get(key) as T | undefined) ?? null);
  }
  set<T>(key: string, value: T): Promise<void> {
    this.sets++;
    this.#map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#map.delete(key));
  }
  has(key: string): Promise<boolean> {
    return Promise.resolve(this.#map.has(key));
  }
  clear(): Promise<void> {
    this.#map.clear();
    return Promise.resolve();
  }
}

interface Row {
  readonly name: string;
  /** The M143a test the row mirrors (cache-plugin `cache-middleware` tests). */
  readonly mirrors: string;
  /** Request headers of the request that may store. */
  readonly storeRequest: Record<string, string>;
  /** Response headers the handler sets, and state flags it raises. */
  readonly response: Record<string, string>;
  readonly flags?: readonly string[];
  /** Request headers of the second request, which may be served from cache. */
  readonly readRequest: Record<string, string>;
  readonly credentialCookies?: readonly string[];
  readonly stored: boolean;
  readonly served: boolean;
}

const ROWS: readonly Row[] = [
  {
    name: 'anonymous public response, anonymous reader',
    mirrors: 'stores and replays a cacheable response',
    storeRequest: {},
    response: { 'cache-control': 'public, max-age=60' },
    readRequest: {},
    stored: true,
    served: true,
  },
  {
    name: 'private response',
    mirrors: 'never stores private or no-store',
    storeRequest: {},
    response: { 'cache-control': 'private, max-age=60' },
    readRequest: {},
    stored: false,
    served: false,
  },
  {
    name: 'no-store response',
    mirrors: 'never stores private or no-store',
    storeRequest: {},
    response: { 'cache-control': 'no-store' },
    readRequest: {},
    stored: false,
    served: false,
  },
  {
    name: 'per-visitor flag after a public header',
    mirrors: 'never stores a response flagged per-visitor',
    storeRequest: {},
    response: { 'cache-control': 'public, max-age=60' },
    flags: [PER_VISITOR_RESPONSE_STATE_KEY],
    readRequest: {},
    stored: false,
    served: false,
  },
  {
    name: 'credentialed request, response without public',
    mirrors: 'stores a credentialed response only when it says public',
    storeRequest: { authorization: 'Bearer t' },
    response: { 'cache-control': 'max-age=60' },
    readRequest: { authorization: 'Bearer t' },
    stored: false,
    served: false,
  },
  {
    name: 'credentialed request, public response',
    mirrors: 'stores a credentialed public response',
    storeRequest: { authorization: 'Bearer t' },
    response: { 'cache-control': 'public, max-age=60' },
    readRequest: { authorization: 'Bearer u' },
    stored: true,
    served: true,
  },
  {
    name: 'anonymous non-public entry, credentialed reader',
    mirrors: 'serves a credentialed request only a public entry',
    storeRequest: {},
    response: { 'cache-control': 'max-age=60' },
    readRequest: { cookie: 'sid=1' },
    stored: true,
    served: false,
  },
  {
    name: 'entry varying on Cookie, reader with an uncounted cookie',
    mirrors: 'never serves a Cookie-varying entry to a request carrying any cookie',
    storeRequest: {},
    response: { 'cache-control': 'public, max-age=60', vary: 'Cookie' },
    readRequest: { cookie: 'ab=1' },
    credentialCookies: ['sid'],
    stored: true,
    served: false,
  },
  {
    name: 'cookie-dependent response from a request with a cookie',
    mirrors: 'stores a cookie-dependent response only cookie-less',
    storeRequest: { cookie: 'ab=1' },
    response: { 'cache-control': 'public, max-age=60' },
    flags: [COOKIE_DEPENDENT_RESPONSE_STATE_KEY],
    readRequest: {},
    credentialCookies: [],
    stored: false,
    served: false,
  },
  {
    name: 'cookie-dependent response stored cookie-less, cookie reader',
    mirrors: 'serves a cookie-dependent entry only to a cookie-less request',
    storeRequest: {},
    response: { 'cache-control': 'public, max-age=60' },
    flags: [COOKIE_DEPENDENT_RESPONSE_STATE_KEY],
    readRequest: { cookie: 'ab=1' },
    credentialCookies: [],
    stored: true,
    served: false,
  },
  {
    name: 'Set-Cookie response',
    mirrors: 'never stores a response with Set-Cookie',
    storeRequest: {},
    response: { 'cache-control': 'public, max-age=60', 'set-cookie': 'a=1' },
    readRequest: {},
    stored: false,
    served: false,
  },
];

/** Runs one request through `middleware`; reports whether the handler ran. */
async function request(
  middleware: MiddlewareFunction,
  services: MockServiceRegistry,
  headers: Record<string, string>,
  row: Row,
): Promise<boolean> {
  const ctx: IRequestContext = createTestContext({
    request: { url: 'https://shop.test/catalog', method: 'GET', headers: new Headers(headers) },
    services,
  });
  let ran = false;
  await middleware(ctx, () => {
    ran = true;
    for (const flag of row.flags ?? []) ctx.state.set(flag, true);
    for (const [name, value] of Object.entries(row.response)) {
      ctx.response.header(name, value);
    }
    ctx.response.text('body');
    return Promise.resolve();
  });
  return ran;
}

/** Store then read through one middleware; returns the two outcomes. */
async function outcome(
  kind: 'cacheMiddleware' | 'cacheApiMiddleware',
  row: Row,
): Promise<{ stored: boolean; served: boolean }> {
  const services = new MockServiceRegistry();
  const store = new MapStore();
  const edge = new FakeCacheApi();
  services.register(CAPABILITIES.CACHE, store);
  const options =
    row.credentialCookies === undefined ? {} : { credentialCookies: row.credentialCookies };
  const middleware =
    kind === 'cacheMiddleware'
      ? cacheMiddleware(options)
      : cacheApiMiddleware({ cache: edge, ...options });
  await request(middleware, services, row.storeRequest, row);
  const stored = kind === 'cacheMiddleware' ? store.sets > 0 : edge.puts.length > 0;
  const ran = await request(middleware, services, row.readRequest, row);
  return { stored, served: !ran };
}

describe('one credential rule for cacheMiddleware and cacheApiMiddleware', () => {
  it.each(ROWS)('$name', async (row) => {
    const shared = await outcome('cacheMiddleware', row);
    const edge = await outcome('cacheApiMiddleware', row);
    expect({ row: row.mirrors, ...edge }).toEqual({ row: row.mirrors, ...shared });
    expect(edge).toEqual({ stored: row.stored, served: row.served });
  });
});
