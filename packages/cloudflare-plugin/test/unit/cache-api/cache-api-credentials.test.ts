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
 * The edge cache stores nothing per visitor (V13-111, Workers half), evicts by
 * its own key (V13-202), and warns once about `private=Set-Cookie` (D9).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  COOKIE_DEPENDENT_RESPONSE_STATE_KEY,
  PER_VISITOR_RESPONSE_STATE_KEY,
} from '@setu-ts/common';
import type { ILogger, IRequestContext } from '@setu-ts/common';
import { createTestContext, MockServiceRegistry } from '@setu-ts/testing';

import {
  cacheApiMiddleware,
  namesSetCookieInPrivate,
} from '../../../src/cache-api/cache-api-middleware.ts';
import type { CacheApiMiddlewareOptions } from '../../../src/cache-api/cache-api-middleware.ts';
import { cacheApiKey, purgeCacheApi } from '../../../src/cache-api/cache-api-key.ts';
import { FakeCacheApi, RecordingLogger } from '../../fakes.ts';

const URL_ = 'https://shop.test/catalog';

/** One request through the middleware; returns the context after it ran. */
async function run(
  cache: FakeCacheApi,
  request: { headers?: Record<string, string>; locale?: string },
  handler: (ctx: IRequestContext) => void,
  options?: Omit<CacheApiMiddlewareOptions, 'cache'>,
  logger?: ILogger,
): Promise<{ ctx: IRequestContext; ran: boolean }> {
  const services = new MockServiceRegistry();
  if (logger !== undefined) services.register(CAPABILITIES.LOGGER, logger);
  const ctx = createTestContext({
    request: {
      url: URL_,
      method: 'GET',
      headers: new Headers(request.headers ?? {}),
      ...(request.locale === undefined ? {} : { locale: request.locale }),
    },
    services,
  });
  let ran = false;
  await cacheApiMiddleware({ cache, ...options })(ctx, () => {
    ran = true;
    handler(ctx);
    return Promise.resolve();
  });
  return { ctx, ran };
}

const publicBody = (ctx: IRequestContext): void => {
  ctx.response.header('cache-control', 'public, max-age=60');
  ctx.response.text('shared');
};

describe('the credentialed-request rule on the store side', () => {
  it('stores a public response from a credentialed request, and one from an anonymous one', async () => {
    const cache = new FakeCacheApi();
    await run(cache, { headers: { authorization: 'Bearer t' } }, publicBody);
    expect(cache.puts).toHaveLength(1);
  });

  it.each([
    ['no Cache-Control', (ctx: IRequestContext) => ctx.response.text('x')],
    [
      'max-age without public',
      (ctx: IRequestContext) => {
        ctx.response.header('cache-control', 'max-age=60');
        ctx.response.text('x');
      },
    ],
    [
      'public but Vary: Cookie',
      (ctx: IRequestContext) => {
        ctx.response.header('cache-control', 'public, max-age=60');
        ctx.response.header('vary', 'Cookie');
        ctx.response.text('x');
      },
    ],
  ])('does not store a credentialed response with %s', async (_label, handler) => {
    const cache = new FakeCacheApi();
    await run(cache, { headers: { cookie: 'sid=1' } }, handler);
    expect(cache.puts).toEqual([]);
  });

  it('never lets the ttlSeconds default make a credentialed response storable', async () => {
    const cache = new FakeCacheApi();
    await run(cache, { headers: { cookie: 'sid=1' } }, (ctx) => ctx.response.text('x'), {
      ttlSeconds: 300,
    });
    expect(cache.puts).toEqual([]);
  });

  it('does not store a response the session plugin flagged per-visitor, even marked public', async () => {
    const cache = new FakeCacheApi();
    await run(cache, {}, (ctx) => {
      ctx.state.set(PER_VISITOR_RESPONSE_STATE_KEY, true);
      publicBody(ctx);
    });
    expect(cache.puts).toEqual([]);
  });

  it.each(['private', 'no-store', 'public, x="unclosed'])(
    "does not store Cache-Control '%s' for anyone",
    async (cacheControl) => {
      const cache = new FakeCacheApi();
      await run(cache, {}, (ctx) => {
        ctx.response.header('cache-control', cacheControl);
        ctx.response.text('x');
      });
      expect(cache.puts).toEqual([]);
    },
  );

  it('stores a cookie-dependent response only cookie-less, with Cookie added to the stored Vary', async () => {
    const cache = new FakeCacheApi();
    const handler = (ctx: IRequestContext): void => {
      ctx.state.set(COOKIE_DEPENDENT_RESPONSE_STATE_KEY, true);
      publicBody(ctx);
    };
    await run(cache, { headers: { cookie: 'theme=dark' } }, handler, { credentialCookies: [] });
    expect(cache.puts).toEqual([]);
    const anonymous = await run(cache, {}, handler);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]?.response.headers.get('vary')).toBe('Cookie');
    // The live response is not changed.
    expect(anonymous.ctx.response.snapshot().headers.get('vary')).toBeNull();
  });
});

describe('the credentialed-request rule on the lookup side', () => {
  /** Seeds one entry with the given headers. */
  async function seeded(headers: Record<string, string>): Promise<FakeCacheApi> {
    const cache = new FakeCacheApi();
    await cache.put(URL_, new Response('stored', { headers }));
    return cache;
  }

  it('serves an anonymous request any entry', async () => {
    const cache = await seeded({ 'cache-control': 'max-age=60' });
    const { ran } = await run(cache, {}, publicBody);
    expect(ran).toBe(false);
  });

  it('serves a credentialed request only a public entry that does not vary on a credential', async () => {
    const shared = await seeded({ 'cache-control': 'public, max-age=60' });
    expect((await run(shared, { headers: { authorization: 'Bearer t' } }, publicBody)).ran).toBe(
      false,
    );

    for (const headers of [
      { 'cache-control': 'max-age=60' },
      { 'cache-control': 'public, max-age=60', vary: 'Authorization' },
    ]) {
      const cache = await seeded(headers);
      expect((await run(cache, { headers: { authorization: 'Bearer t' } }, publicBody)).ran).toBe(
        true,
      );
      // The entry stays for the requests it suits.
      expect(cache.entries.has(URL_)).toBe(true);
    }
  });

  it('never serves an entry varying on Cookie to a request carrying any cookie, named or not', async () => {
    const entry = { 'cache-control': 'max-age=60', vary: 'Cookie' };
    const named = await run(await seeded(entry), { headers: { cookie: 'ab=1' } }, publicBody, {
      credentialCookies: ['sid'],
    });
    const nameless = await run(await seeded(entry), { headers: { cookie: 'x' } }, publicBody, {
      credentialCookies: [],
    });
    const anonymous = await run(await seeded(entry), {}, publicBody);
    expect([named.ran, nameless.ran, anonymous.ran]).toEqual([true, true, false]);
  });

  it('with credentialCookies, an unnamed cookie is not a credential for a non-varying entry', async () => {
    const cache = await seeded({ 'cache-control': 'max-age=60' });
    const { ran } = await run(cache, { headers: { cookie: 'ab=1' } }, publicBody, {
      credentialCookies: ['sid'],
    });
    expect(ran).toBe(false);
  });
});

describe('the private=Set-Cookie warning (D9)', () => {
  const setCookieHandler = (ctx: IRequestContext): void => {
    ctx.response.header('cache-control', 'private=Set-Cookie, max-age=60');
    ctx.response.header('set-cookie', 'a=1');
    ctx.response.text('x');
  };

  it('warns once per middleware instance, naming the path only, and stores nothing', async () => {
    const cache = new FakeCacheApi();
    const logger = new RecordingLogger();
    const middleware = cacheApiMiddleware({ cache });
    for (let i = 0; i < 2; i++) {
      const services = new MockServiceRegistry();
      services.register(CAPABILITIES.LOGGER, logger);
      const ctx = createTestContext({
        request: { url: `${URL_}?secret=1`, method: 'GET' },
        services,
      });
      await middleware(ctx, () => {
        setCookieHandler(ctx);
        return Promise.resolve();
      });
    }
    expect(cache.puts).toEqual([]);
    const warns = logger.records.filter((r) => r.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('private=Set-Cookie is not stored in the edge cache');
    expect(JSON.stringify(warns[0]?.meta)).not.toContain('secret');
  });

  it('does not consume the warning when no logger is registered', async () => {
    const cache = new FakeCacheApi();
    const logger = new RecordingLogger();
    const middleware = cacheApiMiddleware({ cache });
    const bare = createTestContext({ request: { url: URL_, method: 'GET' } });
    await middleware(bare, () => {
      setCookieHandler(bare);
      return Promise.resolve();
    });
    const services = new MockServiceRegistry();
    services.register(CAPABILITIES.LOGGER, logger);
    const logged = createTestContext({ request: { url: URL_, method: 'GET' }, services });
    await middleware(logged, () => {
      setCookieHandler(logged);
      return Promise.resolve();
    });
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(1);
  });

  it('does not warn for a plain private response', async () => {
    const cache = new FakeCacheApi();
    const logger = new RecordingLogger();
    await run(
      cache,
      {},
      (ctx) => {
        ctx.response.header('cache-control', 'private');
        ctx.response.text('x');
      },
      undefined,
      logger,
    );
    expect(logger.records).toEqual([]);
  });

  it.each([
    ['private=Set-Cookie', true],
    ['PRIVATE=set-cookie', true],
    ['private="X-A, Set-Cookie"', true],
    ['private = "set-cookie"', true],
    ['private', false],
    ['private="x-a"', false],
    ['x="private=set-cookie"', false],
    ['private="set-cookie', false],
    ['public, x="a\\"b", private=set-cookie', true],
  ])("detects Set-Cookie in private's field list: %s → %s", (cacheControl, expected) => {
    expect(namesSetCookieInPrivate(cacheControl)).toBe(expected);
  });

  it('reads no header as no warning', () => {
    expect(namesSetCookieInPrivate(null)).toBe(false);
  });
});

describe('evicting the edge cache (V13-202)', () => {
  it('builds the same key the middleware stores under', async () => {
    const cache = new FakeCacheApi();
    await run(cache, { locale: 'de' }, publicBody);
    expect(cache.puts[0]?.key).toBe(cacheApiKey({ url: URL_, locale: 'de' }));
    expect(cacheApiKey({ url: URL_ })).toBe(URL_);
    expect(cacheApiKey({ url: `${URL_}#frag` })).toBeUndefined();
    expect(cacheApiKey({ url: 'not a url' })).toBeUndefined();
    expect(cacheApiKey({ url: URL_, tenant: 'acme' })).toBe(`${URL_}?setu-cache-tenant=acme`);
  });

  it('a HIT, then purgeCacheApi, then a MISS with the new body, per locale', async () => {
    const cache = new FakeCacheApi();
    let body = 'v1';
    const handler = (ctx: IRequestContext): void => {
      ctx.response.header('cache-control', 'public, max-age=60');
      ctx.response.text(body);
    };
    await run(cache, { locale: 'en' }, handler);
    await run(cache, { locale: 'de' }, handler);
    expect((await run(cache, { locale: 'en' }, handler)).ran).toBe(false);

    body = 'v2';
    expect(await purgeCacheApi({ url: URL_, locales: ['en', 'de', 'fr'] }, { cache })).toBe(2);

    const after = await run(cache, { locale: 'en' }, handler);
    expect(after.ran).toBe(true);
  });

  it('evicts the no-locale entry by default, skips an unkeyable URL, and is a no-op off Workers', async () => {
    const cache = new FakeCacheApi();
    await run(cache, {}, publicBody);
    expect(await purgeCacheApi({ url: URL_, tenant: 'acme' }, { cache })).toBe(0);
    expect(await purgeCacheApi({ url: `${URL_}#x` }, { cache })).toBe(0);
    expect(await purgeCacheApi({ url: URL_ }, { cache })).toBe(1);
    expect(await purgeCacheApi({ url: URL_ })).toBe(0);
  });
});
