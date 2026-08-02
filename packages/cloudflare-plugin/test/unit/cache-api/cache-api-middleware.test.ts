/**
 * The edge cache middleware, driven over a real `IRequestContext` so the
 * short-circuit, the streaming guard, and the header contract are exercised
 * against the committed response surface rather than a stand-in.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IRequestContext, IServiceRegistry } from '@hono-enterprise/common';
import { createTestContext, MockServiceRegistry } from '@hono-enterprise/testing';

import { cacheApiMiddleware } from '../../../src/cache-api/cache-api-middleware.ts';
import type { ICloudflareBindings } from '../../../src/bindings/binding-registry.ts';
import type { ICacheApi } from '../../../src/cache-api/cache-api.ts';
import { FakeCacheApi, RecordingLogger } from '../../fakes.ts';

/** A bindings service whose `waitUntil` records rather than extends anything. */
function bindingsWithWaitUntil(sink: Promise<unknown>[]): ICloudflareBindings {
  return {
    has: () => false,
    names: () => [],
    vars: () => ({}),
    get: <T>(): T => {
      throw new Error('not used');
    },
    kv: () => {
      throw new Error('not used');
    },
    r2: () => {
      throw new Error('not used');
    },
    d1: () => {
      throw new Error('not used');
    },
    queue: () => {
      throw new Error('not used');
    },
    service: () => {
      throw new Error('not used');
    },
    durableObject: () => {
      throw new Error('not used');
    },
    waitUntil: (promise): void => {
      sink.push(promise);
    },
  };
}

/** A context for one request, optionally carrying the bindings capability. */
function contextFor(
  url: string,
  options?: { readonly method?: string; readonly services?: IServiceRegistry },
): IRequestContext {
  return createTestContext({
    request: { url, method: (options?.method ?? 'GET') as 'GET' },
    ...(options?.services === undefined ? {} : { services: options.services }),
  });
}

/** A registry carrying the Cloudflare bindings service. */
function registryWithBindings(sink: Promise<unknown>[]): IServiceRegistry {
  const registry = new MockServiceRegistry();
  registry.register(CAPABILITIES.CLOUDFLARE, bindingsWithWaitUntil(sink));
  return registry;
}

describe('cacheApiMiddleware — miss', () => {
  it('runs the handler, stores the response, and marks the response MISS', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/catalog');
    let handlerRan = false;

    await cacheApiMiddleware({ cache })(ctx, () => {
      handlerRan = true;
      ctx.response.json({ items: 2 });
      return Promise.resolve();
    });

    expect(handlerRan).toBe(true);
    expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('MISS');
    expect(cache.puts.map((put) => put.key)).toEqual(['https://example.test/catalog']);
    expect(await cache.puts[0]?.response.json()).toEqual({ items: 2 });
  });

  it('keys on the full request URL, so the query string participates', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/search?q=hono&page=2');

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(cache.matches).toEqual(['https://example.test/search?q=hono&page=2']);
    expect(cache.puts.at(0)?.key).toBe('https://example.test/search?q=hono&page=2');
  });

  it('honours a custom key function on BOTH the read and the write', async () => {
    // One implementation, two call sites: a key used only on the read would
    // store under a key nothing ever looks up.
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/a?ignored=1');

    await cacheApiMiddleware({ cache, key: () => 'https://example.test/stable' })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(cache.matches).toEqual(['https://example.test/stable']);
    expect(cache.puts.at(0)?.key).toBe('https://example.test/stable');
  });

  it('stores a BYTE body, copied into an ArrayBuffer-backed view', async () => {
    // `snapshot().body` may be backed by a SharedArrayBuffer, which BodyInit
    // rejects — so the bytes are copied rather than passed straight through.
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/logo.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.header('content-type', 'image/png').send(bytes);
      return Promise.resolve();
    });

    expect(cache.puts).toHaveLength(1);
    const stored = cache.puts[0]?.response as Response;
    expect(stored.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  });

  it('stores a response with no body without throwing', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/empty');

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.send();
      return Promise.resolve();
    });

    expect(cache.puts).toHaveLength(1);
    expect(await cache.puts[0]?.response.text()).toBe('');
  });
});

describe('cacheApiMiddleware — hit', () => {
  it('replays the cached status, headers and body WITHOUT calling next()', async () => {
    // The mandatory short-circuit assertion: a hit must make the handler
    // unreachable, not merely be overwritten by it afterwards.
    const cache = new FakeCacheApi();
    await cache.put(
      'https://example.test/catalog',
      new Response('{"items":2}', {
        status: 203,
        headers: { 'content-type': 'application/json', 'x-origin': 'edge' },
      }),
    );

    // The seeding put above counts, so the write-back assertion below compares
    // against this baseline rather than zero.
    const putsAfterSeeding = cache.puts.length;

    const ctx = contextFor('https://example.test/catalog');
    let handlerRan = false;

    await cacheApiMiddleware({ cache })(ctx, () => {
      handlerRan = true;
      ctx.response.json({ items: 999 });
      return Promise.resolve();
    });

    expect(handlerRan).toBe(false);

    const snapshot = ctx.response.snapshot();
    expect(snapshot.status).toBe(203);
    expect(snapshot.headers.get('X-Cache-Api')).toBe('HIT');
    expect(snapshot.headers.get('x-origin')).toBe('edge');
    expect(snapshot.streaming).toBe(true);
    // Nothing was written back on a hit.
    expect(cache.puts).toHaveLength(putsAfterSeeding);
  });

  it('strips hop-by-hop headers from the replayed response', async () => {
    const cache = new FakeCacheApi();
    await cache.put(
      'https://example.test/x',
      new Response('body', { headers: { 'x-keep': 'yes', 'transfer-encoding': 'chunked' } }),
    );

    const ctx = contextFor('https://example.test/x');
    await cacheApiMiddleware({ cache })(ctx, () => Promise.resolve());

    const headers = ctx.response.snapshot().headers;
    expect(headers.get('x-keep')).toBe('yes');
    expect(headers.has('transfer-encoding')).toBe(false);
  });

  it('ends the response for a cached entry with no body', async () => {
    const cache = new FakeCacheApi();
    await cache.put('https://example.test/none', new Response(null, { status: 204 }));

    const ctx = contextFor('https://example.test/none');
    await cacheApiMiddleware({ cache })(ctx, () => Promise.resolve());

    const snapshot = ctx.response.snapshot();
    expect(snapshot.status).toBe(204);
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.headers.get('X-Cache-Api')).toBe('HIT');
  });
});

describe('cacheApiMiddleware — skips', () => {
  it('passes through with BYPASS when no cache handle is available', async () => {
    // Composed for several targets: off Workers this must still serve.
    const ctx = contextFor('https://example.test/x');
    let handlerRan = false;

    await cacheApiMiddleware()(ctx, () => {
      handlerRan = true;
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(handlerRan).toBe(true);
    expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('BYPASS');
  });

  it('passes through with BYPASS when the bypass predicate returns true', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/x');
    let handlerRan = false;

    await cacheApiMiddleware({ cache, bypass: () => true })(ctx, () => {
      handlerRan = true;
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(handlerRan).toBe(true);
    expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('BYPASS');
    // Neither read nor written — a bypass is not a miss.
    expect(cache.matches).toEqual([]);
    expect(cache.puts).toEqual([]);
  });

  it('receives the context in the bypass predicate', async () => {
    const cache = new FakeCacheApi();
    const seen: string[] = [];
    const ctx = contextFor('https://example.test/private');

    await cacheApiMiddleware({
      cache,
      bypass: (c) => {
        seen.push(c.request.url);
        return false;
      },
    })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(seen).toEqual(['https://example.test/private']);
  });

  it('does NOT store a streaming response, and never reads its body', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/events');
    let cancelled = false;

    // Deliberately never closed, the way a live SSE body behaves. `locked` and
    // `cancel` are the honest probes: a ReadableStream invokes its own `pull`
    // as soon as it is constructed, with no consumer involved, so counting
    // pulls would report "drained" whether the code reads it or not.
    const body = new ReadableStream<Uint8Array>({
      cancel(): void {
        cancelled = true;
      },
    });

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.stream(body);
      return Promise.resolve();
    });

    expect(cache.puts).toEqual([]);
    expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('MISS');
    // Neither read from nor cancelled — the stream reaches the client intact.
    expect(body.locked).toBe(false);
    expect(cancelled).toBe(false);
  });

  it('does not store a response the platform would refuse', async () => {
    const cache = new FakeCacheApi();

    for (
      const write of [
        (ctx: IRequestContext) => ctx.response.status(500).json({ error: true }),
        (ctx: IRequestContext) => ctx.response.header('vary', '*').json({ ok: true }),
        (ctx: IRequestContext) => ctx.response.header('set-cookie', 'a=1').json({ ok: true }),
      ]
    ) {
      const ctx = contextFor('https://example.test/x');
      await cacheApiMiddleware({ cache })(ctx, () => {
        write(ctx);
        return Promise.resolve();
      });
      expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('MISS');
    }

    expect(cache.puts).toEqual([]);
  });

  it('does not store a non-GET response', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/x', { method: 'POST' });

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(cache.puts).toEqual([]);
  });

  it('never READS the cache for a non-GET request, so a mutation still runs', async () => {
    // The cache key is a URL string, which the Cache API resolves as a GET
    // request. Consulting it for a POST would serve the cached GET body and
    // skip the handler — a mutation silently discarded behind a 200. Reachable
    // whenever the middleware sits on the global pipeline.
    const cache = new FakeCacheApi();
    await cache.put('https://example.test/cart', new Response('{"items":0}', { status: 200 }));

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const ctx = contextFor('https://example.test/cart', { method });
      let mutationRan = false;

      await cacheApiMiddleware({ cache })(ctx, () => {
        mutationRan = true;
        ctx.response.json({ items: 1 });
        return Promise.resolve();
      });

      expect(mutationRan).toBe(true);
      expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('BYPASS');
    }

    // The primed entry was neither read nor overwritten.
    expect(cache.matches).toEqual([]);
    expect(cache.puts).toHaveLength(1);
  });

  it('still serves a GET from the cache after a non-GET passed through', async () => {
    // Guards the fix from being over-broad: the method check must skip only the
    // non-GET request, not disable caching for the route.
    const cache = new FakeCacheApi();
    const seed = contextFor('https://example.test/mixed');
    await cacheApiMiddleware({ cache })(seed, () => {
      seed.response.json({ v: 1 });
      return Promise.resolve();
    });

    const post = contextFor('https://example.test/mixed', { method: 'POST' });
    await cacheApiMiddleware({ cache })(post, () => Promise.resolve());

    const get = contextFor('https://example.test/mixed');
    let handlerRan = false;
    await cacheApiMiddleware({ cache })(get, () => {
      handlerRan = true;
      return Promise.resolve();
    });

    expect(handlerRan).toBe(false);
    expect(get.response.snapshot().headers.get('X-Cache-Api')).toBe('HIT');
  });

  it('honours a widened cacheableStatuses set', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/moved');

    await cacheApiMiddleware({ cache, cacheableStatuses: [200, 301] })(ctx, () => {
      ctx.response.status(301).header('location', '/new').send();
      return Promise.resolve();
    });

    expect(cache.puts).toHaveLength(1);
    expect(cache.puts.at(0)?.response.status).toBe(301);
  });
});

describe('cacheApiMiddleware — ttlSeconds', () => {
  it('adds Cache-Control to the STORED copy only, never the client response', async () => {
    // `snapshot().headers` is the live Headers instance, so mutating it would
    // put the directive on the response the client receives too.
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/x');

    await cacheApiMiddleware({ cache, ttlSeconds: 300 })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(cache.puts.at(0)?.response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(ctx.response.snapshot().headers.has('cache-control')).toBe(false);
  });

  it("leaves an existing Cache-Control alone — the handler's directive wins", async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/x');

    await cacheApiMiddleware({ cache, ttlSeconds: 300 })(ctx, () => {
      ctx.response.header('cache-control', 'max-age=30').json({ ok: true });
      return Promise.resolve();
    });

    expect(cache.puts.at(0)?.response.headers.get('cache-control')).toBe('max-age=30');
  });

  it('adds nothing when no ttlSeconds is configured', async () => {
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/x');

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(cache.puts.at(0)?.response.headers.has('cache-control')).toBe(false);
  });
});

describe('cacheApiMiddleware — the write path', () => {
  it('hands the put to waitUntil when the bindings capability is registered', async () => {
    const cache = new FakeCacheApi();
    const sink: Promise<unknown>[] = [];
    const ctx = contextFor('https://example.test/x', { services: registryWithBindings(sink) });

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(sink).toHaveLength(1);
    await Promise.all(sink);
    expect(cache.puts).toHaveLength(1);
  });

  it('does NOT fail the response when an inline cache write rejects', async () => {
    // The response is already produced by the time the write runs, and
    // `Cache.put` rejects for real reasons (oversized body, quota). Letting
    // that propagate turned a good 200 into the kernel's 500.
    const failing: ICacheApi = {
      match: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error('Response body too large')),
      delete: () => Promise.resolve(false),
    };
    const ctx = contextFor('https://example.test/big');

    await cacheApiMiddleware({ cache: failing })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(ctx.response.snapshot().status).toBe(200);
    expect(ctx.response.snapshot().headers.get('X-Cache-Api')).toBe('MISS');
  });

  it('reports an inline write failure through a registered logger', async () => {
    const failing: ICacheApi = {
      match: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error('Response body too large')),
      delete: () => Promise.resolve(false),
    };
    const logger = new RecordingLogger();
    const services = new MockServiceRegistry();
    services.register(CAPABILITIES.LOGGER, logger);
    const ctx = contextFor('https://example.test/big', { services });

    await cacheApiMiddleware({ cache: failing })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(logger.messages()).toEqual([
      'cloudflare-cache-api: edge cache write failed, response served uncached',
    ]);
    expect(logger.records.at(0)?.meta).toMatchObject({ error: 'Response body too large' });
  });

  it('reports a non-Error rejection as a string', async () => {
    const failing: ICacheApi = {
      match: () => Promise.resolve(undefined),
      put: () => Promise.reject('a bare string'),
      delete: () => Promise.resolve(false),
    };
    const logger = new RecordingLogger();
    const services = new MockServiceRegistry();
    services.register(CAPABILITIES.LOGGER, logger);
    const ctx = contextFor('https://example.test/big', { services });

    await cacheApiMiddleware({ cache: failing })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    expect(logger.records.at(0)?.meta).toMatchObject({ error: 'a bare string' });
  });

  it('stays silent, and still succeeds, when no logger is registered', async () => {
    const failing: ICacheApi = {
      match: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error('nope')),
      delete: () => Promise.resolve(false),
    };
    const ctx = contextFor('https://example.test/big');

    await expect(
      cacheApiMiddleware({ cache: failing })(ctx, () => {
        ctx.response.json({ ok: true });
        return Promise.resolve();
      }),
    ).resolves.toBeUndefined();
  });

  it('awaits the put inline when the bindings capability is absent', async () => {
    // Without a waitUntil host nothing keeps the promise alive, so abandoning
    // it would silently drop the write.
    const cache = new FakeCacheApi();
    const ctx = contextFor('https://example.test/x');

    await cacheApiMiddleware({ cache })(ctx, () => {
      ctx.response.json({ ok: true });
      return Promise.resolve();
    });

    // Already stored by the time the middleware returned — no awaiting a sink.
    expect(cache.puts).toHaveLength(1);
  });
});
