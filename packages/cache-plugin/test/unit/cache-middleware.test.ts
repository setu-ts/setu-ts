/* eslint-disable require-await -- test fixtures use sync methods matching async interface signatures */
import { describe, expect, it } from 'vitest';

import type {
  HandlerResult,
  ICacheStore,
  IPluginContext,
  IRequestContext,
  IServiceRegistry,
  ITenant,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import type { CacheMiddlewareOptions } from '../../src/interfaces/index.ts';
import { cacheMiddleware } from '../../src/middleware/cache-middleware.ts';
import { CachePlugin } from '../../src/plugin/cache-plugin.ts';

describe('cacheMiddleware', () => {
  function createFakeStore(): {
    store: ICacheStore;
    calls: Array<{ method: string; args: unknown[] }>;
  } {
    const storeData = new Map<string, unknown>();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const store: ICacheStore = {
      get: async <T>(key: string): Promise<T | null> => {
        calls.push({ method: 'get', args: [key] });
        const v = storeData.get(key);
        return v === undefined ? null : (v as T);
      },
      set: async <T>(key: string, value: T, ttl?: number): Promise<void> => {
        calls.push({ method: 'set', args: [key, value, ttl] });
        storeData.set(key, value);
      },
      delete: async (key: string): Promise<boolean> => {
        calls.push({ method: 'delete', args: [key] });
        return storeData.delete(key);
      },
      has: async (key: string): Promise<boolean> => {
        calls.push({ method: 'has', args: [key] });
        return storeData.has(key);
      },
      clear: async (): Promise<void> => {
        calls.push({ method: 'clear', args: [] });
        storeData.clear();
      },
    };
    return { store, calls };
  }

  function createContext(
    store: ICacheStore,
    opts?: {
      method?: string;
      url?: string;
      tenant?: ITenant;
    },
  ): {
    ctx: IRequestContext;
    nextCalled: boolean[];
    responseStatus: number[];
    responseHeaders: Map<string, string>;
    responseBody: () => Uint8Array | string | null;
  } {
    const nextCalled: boolean[] = [];
    const responseStatus: number[] = [];
    const responseHeaders = new Map<string, string>();
    let responseBodyVal: Uint8Array | string | null = null;

    const serviceRegistry: IServiceRegistry = {
      has: () => true,
      get: <T>(): T => store as T,
      getAll: () => [],
      register: () => {},
      registerFactory: () => {},
      unregister: () => false,
    };

    const hr: HandlerResult = { __handlerResult: true };

    const ctx: IRequestContext = {
      id: 'test-req',
      request: {
        method: (opts?.method ?? 'GET') as IRequestContext['request']['method'],
        url: opts?.url ?? 'http://localhost/test',
        path: '/test',
        headers: new Headers(),
        ...(opts?.tenant !== undefined ? { tenant: opts.tenant } : {}),
        json: async <T = unknown>() => ({}) as T,
        text: async () => '',
        bytes: async () => new Uint8Array(0),
      },
      response: {
        status: (code: number) => {
          responseStatus.push(code);
          return ctx.response;
        },
        setHeaders: (headers: Readonly<Record<string, string>>) => {
          for (const name of Object.keys(headers)) ctx.response.header(name, headers[name]!);
          return ctx.response;
        },
        header: (name: string, value: string) => {
          responseHeaders.set(name.toLowerCase(), value);
          return ctx.response;
        },
        appendHeader: (name: string, value: string) => {
          responseHeaders.set(name.toLowerCase(), value);
          return ctx.response;
        },
        json: () => hr,
        text: (body: string) => {
          responseBodyVal = body;
          responseHeaders.set('content-type', 'text/plain; charset=utf-8');
          return hr;
        },
        html: (body: string) => {
          responseBodyVal = body;
          responseHeaders.set('content-type', 'text/html; charset=utf-8');
          return hr;
        },
        send: (body?: Uint8Array) => {
          responseBodyVal = body ?? null;
          return hr;
        },
        redirect: () => hr,
        stream: () => hr,
        snapshot: () => ({
          streaming: false,
          status: responseStatus.at(-1) ?? 200,
          headers: (() => {
            const h = new Headers();
            for (const [k, v] of responseHeaders) {
              h.set(k, v);
            }
            return h;
          })(),
          body: responseBodyVal,
        }),
      },
      services: serviceRegistry,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: new AbortController().signal,
    };

    return {
      ctx,
      nextCalled,
      responseStatus,
      responseHeaders,
      responseBody: () => responseBodyVal,
    };
  }

  describe('HIT path', () => {
    it('serves cached response and does NOT call next()', async () => {
      const { store } = createFakeStore();
      await store.set('GET:http://localhost/test', {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: '{"hello":"world"}',
      });

      const { ctx, nextCalled, responseHeaders } = createContext(store);

      const mw = cacheMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
      });

      expect(nextCalled.length).toBe(0);
      expect(responseHeaders.get('x-cache')).toBe('HIT');
    });

    it('replays original content-type for non-JSON body', async () => {
      const { store } = createFakeStore();
      // Simulate a text/html cached payload (string body, no encoding flag)
      await store.set('GET:http://localhost/html', {
        status: 200,
        headers: [['content-type', 'text/html; charset=utf-8']],
        body: '<html><body>Hello</body></html>',
      });

      const { ctx, responseHeaders } = createContext(store, {
        method: 'GET',
        url: 'http://localhost/html',
      });

      const mw = cacheMiddleware();
      await mw(ctx, async () => {});

      expect(responseHeaders.get('content-type')).toBe('text/html; charset=utf-8');
      expect(responseHeaders.get('x-cache')).toBe('HIT');
    });

    it('strips hop-by-hop headers on replay', async () => {
      const { store } = createFakeStore();
      await store.set('GET:http://localhost/hop', {
        status: 200,
        headers: [
          ['content-type', 'application/json'],
          ['connection', 'keep-alive'],
          ['keep-alive', 'timeout=5'],
          ['transfer-encoding', 'chunked'],
          ['proxy-authorization', 'secret'],
        ],
        body: '{}',
      });

      const { ctx, responseHeaders } = createContext(store, {
        method: 'GET',
        url: 'http://localhost/hop',
      });

      const mw = cacheMiddleware();
      await mw(ctx, async () => {});

      expect(responseHeaders.get('content-type')).toBe('application/json');
      expect(responseHeaders.has('connection')).toBe(false);
      expect(responseHeaders.has('keep-alive')).toBe(false);
      expect(responseHeaders.has('transfer-encoding')).toBe(false);
      expect(responseHeaders.has('proxy-authorization')).toBe(false);
    });

    it('replays base64-encoded body as bytes', async () => {
      const { store } = createFakeStore();
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const base64 = btoa(
        Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join(''),
      );
      await store.set('GET:http://localhost/bin', {
        status: 200,
        headers: [['content-type', 'application/octet-stream']],
        body: base64,
        bodyEncoding: 'base64',
      });

      const { ctx, responseBody } = createContext(store, {
        method: 'GET',
        url: 'http://localhost/bin',
      });

      const mw = cacheMiddleware();
      await mw(ctx, async () => {});

      const body = responseBody();
      expect(body).toBeInstanceOf(Uint8Array);
      expect(body).toEqual(bytes);
    });

    it('replays string body as string (so inject() surfaces it)', async () => {
      const { store } = createFakeStore();
      await store.set('GET:http://localhost/json2', {
        status: 200,
        headers: [['content-type', 'application/json; charset=utf-8']],
        body: '{"msg":"ok"}',
      });

      const { ctx, responseBody, responseHeaders } = createContext(store, {
        method: 'GET',
        url: 'http://localhost/json2',
      });

      const mw = cacheMiddleware();
      await mw(ctx, async () => {});

      const body = responseBody();
      // Body must be a string (not Uint8Array) so that kernel inject() returns it.
      expect(typeof body).toBe('string');
      expect(body).toBe('{"msg":"ok"}');
      // Content-type should be re-asserted from cache.
      expect(responseHeaders.get('content-type')).toBe('application/json; charset=utf-8');
    });

    it('terminates null body with send()', async () => {
      const { store } = createFakeStore();
      await store.set('GET:http://localhost/empty', {
        status: 204,
        headers: [],
        body: null,
      });

      const { ctx, responseBody } = createContext(store, {
        method: 'GET',
        url: 'http://localhost/empty',
      });

      const mw = cacheMiddleware();
      await mw(ctx, async () => {});

      const body = responseBody();
      expect(body).toBeNull();
    });
  });

  describe('MISS path', () => {
    it('coalesces concurrent cacheable misses and replays the leader response for waiters', async () => {
      const { store } = createFakeStore();
      const first = createContext(store);
      const second = createContext(store);
      const middleware = cacheMiddleware();
      let originCalls = 0;
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });

      const leader = middleware(first.ctx, async () => {
        originCalls++;
        await pending;
        first.ctx.response.status(200);
        first.ctx.response.text('{"leader":true}');
      });
      const waiter = middleware(second.ctx, async () => {
        originCalls++;
        second.ctx.response.status(200);
        second.ctx.response.text('{"waiter":true}');
      });

      await Promise.resolve();
      await Promise.resolve();
      release?.();
      await Promise.all([leader, waiter]);

      expect(originCalls).toBe(1);
      expect(first.responseHeaders.get('x-cache')).toBe('MISS');
      expect(second.responseHeaders.get('x-cache')).toBe('COALESCED');
      expect(second.responseBody()).toBe('{"leader":true}');
    });

    it('runs the waiters origin after its leader fails', async () => {
      const { store } = createFakeStore();
      const first = createContext(store);
      const second = createContext(store);
      const middleware = cacheMiddleware();
      let releaseFailure: (() => void) | undefined;
      const pendingFailure = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      let waiterCalls = 0;

      const leader = middleware(first.ctx, async () => {
        await pendingFailure;
        throw new Error('origin failed');
      });
      const waiter = middleware(second.ctx, async () => {
        waiterCalls++;
        second.ctx.response.status(200);
        second.ctx.response.text('{"recovered":true}');
      });

      await Promise.resolve();
      await Promise.resolve();
      releaseFailure?.();
      await expect(leader).rejects.toThrow('origin failed');
      await waiter;

      expect(waiterCalls).toBe(1);
      expect(second.responseHeaders.get('x-cache')).toBe('MISS');
      expect(second.responseBody()).toBe('{"recovered":true}');
    });

    it('calls next() and stores response on 200', async () => {
      const { store, calls } = createFakeStore();
      const { ctx, nextCalled, responseHeaders } = createContext(store);

      const mw = cacheMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
        ctx.response.status(200);
        ctx.response.header('content-type', 'application/json');
      });

      expect(nextCalled.length).toBeGreaterThanOrEqual(1);
      expect(responseHeaders.get('x-cache')).toBe('MISS');
      // The set call should have been made (with encoded payload)
      const setCalls = calls.filter((c) => c.method === 'set');
      expect(setCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT store when status is not cacheable', async () => {
      const { store, calls } = createFakeStore();
      const { ctx, nextCalled } = createContext(store);

      const mw = cacheMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
        // Set a non-cacheable status
        ctx.response.status(500);
      });

      const setCalls = calls.filter((c) => c.method === 'set');
      expect(setCalls.length).toBe(0);
    });

    it('does NOT store when Set-Cookie is present', async () => {
      const { store, calls } = createFakeStore();
      const { ctx, nextCalled } = createContext(store);

      const mw = cacheMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
        ctx.response.status(200);
        ctx.response.header('set-cookie', 'session=abc123');
      });

      const setCalls = calls.filter((c) => c.method === 'set');
      expect(setCalls.length).toBe(0);
    });
  });

  describe('bypass', () => {
    it('skips cache when bypass returns true', async () => {
      const { store, calls } = createFakeStore();
      const { ctx, nextCalled } = createContext(store);

      const mw = cacheMiddleware({ bypass: () => true });
      await mw(ctx, async () => {
        nextCalled.push(true);
      });

      expect(nextCalled.length).toBeGreaterThanOrEqual(1);
      // No cache read or write
      const cacheCalls = calls.filter((c) => c.method === 'get' || c.method === 'set');
      expect(cacheCalls.length).toBe(0);
    });

    it('does not bypass when bypass returns false', async () => {
      const { store, calls } = createFakeStore();
      const { ctx } = createContext(store);

      const mw = cacheMiddleware({ bypass: () => false });
      await mw(ctx, async () => {});

      // Should attempt a cache read
      const getCall = calls.find((c) => c.method === 'get');
      expect(getCall).toBeDefined();
    });
  });

  describe('options', () => {
    it('uses custom key function', async () => {
      const { store, calls } = createFakeStore();
      const { ctx } = createContext(store);

      const mw = cacheMiddleware({
        key: (c) => `custom:${c.request.path}`,
      });
      await mw(ctx, async () => {});

      const getCall = calls.find((c) => c.method === 'get');
      expect(getCall?.args[0]).toBe('custom:/test');
    });

    it('uses custom store token', async () => {
      const altStore = createFakeStore();

      const serviceRegistry: IServiceRegistry = {
        has: () => true,
        get: <T>(token: string): T => {
          if (token === 'cache.session') return altStore.store as T;
          throw new Error('Unexpected token');
        },
        getAll: () => [],
        register: () => {},
        registerFactory: () => {},
        unregister: () => false,
      };

      const hr: HandlerResult = { __handlerResult: true };
      const ctx: IRequestContext = {
        id: 'test-req',
        request: {
          method: 'GET' as const,
          url: 'http://localhost/test',
          path: '/test',
          headers: new Headers(),
          json: async <T = unknown>() => ({}) as T,
          text: async () => '',
          bytes: async () => new Uint8Array(0),
        },
        response: {
          status: () => ctx.response,
          setHeaders: () => ctx.response,
          header: () => ctx.response,
          appendHeader: () => ctx.response,
          json: () => hr,
          text: () => hr,
          html: () => hr,
          send: () => hr,
          redirect: () => hr,
          stream: () => hr,
          snapshot: () => ({
            streaming: false,
            status: 200,
            headers: new Headers(),
            body: null,
          }),
        },
        services: serviceRegistry,
        params: {},
        query: {},
        state: new Map(),
        startTime: 0,
        signal: new AbortController().signal,
      };

      const mw = cacheMiddleware({ store: 'cache.session' });
      await mw(ctx, async () => {});

      const getCall = altStore.calls.find((c) => c.method === 'get');
      expect(getCall).toBeDefined();
    });
  });

  describe('tenant keying (X4-1)', () => {
    it('keys the default key per tenant', async () => {
      const { store, calls } = createFakeStore();
      const { ctx } = createContext(store, { tenant: { id: 'acme' } });

      const mw = cacheMiddleware();
      await mw(ctx, async () => {});

      const getCall = calls.find((c) => c.method === 'get');
      expect(getCall?.args[0]).toBe('t:4:acme|GET:http://localhost/test');
    });

    it('applies the tenant segment around a custom key function too', async () => {
      const { store, calls } = createFakeStore();
      const { ctx } = createContext(store, { tenant: { id: 'acme' } });

      const mw = cacheMiddleware({ key: (c) => `custom:${c.request.path}` });
      await mw(ctx, async () => {});

      const getCall = calls.find((c) => c.method === 'get');
      expect(getCall?.args[0]).toBe('t:4:acme|custom:/test');
    });

    it('stores one entry per tenant for the same route', async () => {
      const { store, calls } = createFakeStore();

      const acme = createContext(store, { tenant: { id: 'acme' } });
      await cacheMiddleware()(acme.ctx, async () => {
        acme.ctx.response.status(200);
      });

      const globex = createContext(store, { tenant: { id: 'globex' } });
      await cacheMiddleware()(globex.ctx, async () => {
        globex.ctx.response.status(200);
      });

      const setKeys = calls.filter((c) => c.method === 'set').map((c) => c.args[0]);
      expect(setKeys).toHaveLength(2);
      expect(setKeys[0]).toBe('t:4:acme|GET:http://localhost/test');
      expect(setKeys[1]).toBe('t:6:globex|GET:http://localhost/test');
    });

    it('serves each tenant its own cached body (HIT per tenant)', async () => {
      const { store, calls } = createFakeStore();
      await store.set('t:4:acme|GET:http://localhost/test', {
        status: 200,
        headers: [['content-type', 'application/json']],
        body: '{"tenant":"acme"}',
      });

      const acme = createContext(store, { tenant: { id: 'acme' } });
      await cacheMiddleware()(acme.ctx, async () => {
        acme.nextCalled.push(true);
      });
      expect(acme.nextCalled.length).toBe(0);
      expect(acme.responseBody()).toBe('{"tenant":"acme"}');
      expect(acme.responseHeaders.get('x-cache')).toBe('HIT');

      // globex has no entry under its own key — a MISS, not acme's body.
      const globex = createContext(store, { tenant: { id: 'globex' } });
      await cacheMiddleware()(globex.ctx, async () => {
        globex.nextCalled.push(true);
        globex.ctx.response.status(200);
        globex.ctx.response.text('{"tenant":"globex"}');
      });
      expect(globex.nextCalled.length).toBe(1);
      expect(globex.responseHeaders.get('x-cache')).toBe('MISS');

      const globexGets = calls.filter(
        (c) => c.method === 'get' && c.args[0] === 't:6:globex|GET:http://localhost/test',
      );
      expect(globexGets.length).toBe(1);
    });

    it('appends vary values after the tenant segment', async () => {
      const { store, calls } = createFakeStore();
      const { ctx } = createContext(store, { tenant: { id: 'acme' } });

      const mw = cacheMiddleware({
        vary: (c) => [c.request.headers.get('accept-language') ?? 'en'],
      });
      await mw(ctx, async () => {});

      const getCall = calls.find((c) => c.method === 'get');
      expect(getCall?.args[0]).toBe('t:4:acme|v:2:en|GET:http://localhost/test');
    });

    it('keeps byte-identical keys when no tenant is resolved', async () => {
      const { store, calls } = createFakeStore();
      const { ctx } = createContext(store);

      await cacheMiddleware()(ctx, async () => {});

      const getCall = calls.find((c) => c.method === 'get');
      expect(getCall?.args[0]).toBe('GET:http://localhost/test');
    });
  });

  describe('streaming guard (M42)', () => {
    it('skips caching and sets X-Cache: MISS when snapshot().streaming === true', async () => {
      const { store, calls } = createFakeStore();
      const nextCalled: boolean[] = [];
      const responseHeaders = new Map<string, string>();

      // Create a ReadableStream to use as the streaming body.
      const streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });

      const hr: HandlerResult = { __handlerResult: true };
      const serviceRegistry: IServiceRegistry = {
        has: () => true,
        get: <T>(): T => store as T,
        getAll: () => [],
        register: () => {},
        registerFactory: () => {},
        unregister: () => false,
      };

      const ctx: IRequestContext = {
        id: 'test-req-stream',
        request: {
          method: 'GET' as IRequestContext['request']['method'],
          url: 'http://localhost/stream',
          path: '/stream',
          headers: new Headers(),
          json: async <T = unknown>() => ({}) as T,
          text: async () => '',
          bytes: async () => new Uint8Array(0),
        },
        response: {
          status: (_code: number) => ctx.response,
          setHeaders: (headers: Readonly<Record<string, string>>) => {
            for (const name of Object.keys(headers)) ctx.response.header(name, headers[name]!);
            return ctx.response;
          },
          header: (name: string, value: string) => {
            responseHeaders.set(name.toLowerCase(), value);
            return ctx.response;
          },
          appendHeader: (name: string, value: string) => {
            responseHeaders.set(name.toLowerCase(), value);
            return ctx.response;
          },
          json: () => hr,
          text: () => hr,
          html: () => hr,
          send: () => hr,
          redirect: () => hr,
          stream: () => hr,
          snapshot: () => ({
            streaming: true,
            status: 200,
            headers: new Headers(),
            body: streamBody,
          }),
        },
        services: serviceRegistry,
        params: {},
        query: {},
        state: new Map(),
        startTime: 0,
        signal: new AbortController().signal,
      };

      const mw = cacheMiddleware();
      await mw(ctx, async () => {
        nextCalled.push(true);
        // Handler writes nothing; streaming body is already baked into snapshot.
      });

      // next() must be called (handler runs).
      expect(nextCalled.length).toBeGreaterThanOrEqual(1);

      // X-Cache: MISS must be set.
      expect(responseHeaders.get('x-cache')).toBe('MISS');

      // store.set and encodePayload must NOT be called (streaming responses skip caching).
      const setCalls = calls.filter((c) => c.method === 'set');
      expect(setCalls.length).toBe(0);
    });
  });
});

describe('cacheMiddleware — per-visitor responses', () => {
  type Handler = (ctx: IRequestContext) => HandlerResult | Promise<HandlerResult>;

  async function appWith(
    handler: Handler,
    options: CacheMiddlewareOptions = {},
  ): Promise<{ app: Awaited<ReturnType<typeof start>>; calls: () => number }> {
    let count = 0;
    const app = await start(async (ctx) => {
      count += 1;
      return await handler(ctx);
    }, options);
    return { app, calls: () => count };
  }

  async function start(handler: Handler, options: CacheMiddlewareOptions) {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CachePlugin({ store: 'memory' }),
        {
          name: 'per-visitor-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60, ...options }));
            ctx.router.get('/page', handler);
          },
        },
      ],
    });
    await app.start();
    return app;
  }

  async function bothInOrigin(calls: () => number): Promise<void> {
    for (let i = 0; i < 1_000 && calls() < 2; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(calls()).toBe(2);
  }

  const get = (headers: Record<string, string> = {}) =>
    ({ method: 'GET', url: 'http://localhost/page', headers }) as const;

  const plain: Handler = (ctx) => ctx.response.text('page');
  const withCacheControl =
    (value: string): Handler =>
    (ctx) =>
      ctx.response.header('cache-control', value).text('page');

  it.each([
    ['private', withCacheControl('private, max-age=60')],
    ['no-store', withCacheControl('no-store')],
    ['private with a field list', withCacheControl('private="set-cookie", max-age=60')],
  ] as const)('never stores a response marked %s', async (_name, handler) => {
    const { app, calls } = await appWith(handler);
    try {
      expect((await app.inject(get())).headers.get('x-cache')).toBe('MISS');
      expect((await app.inject(get())).headers.get('x-cache')).toBe('MISS');
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });

  // A response that varies on a credential is the cookie-less variant only when a cookie-less request
  // produced it, and only a cookie-less request may be served it. Each handler says `public`, so the
  // `public` rule alone would let a credentialed request through: only the Vary check refuses it.
  it.each([
    ['Vary: Cookie', 'Accept, Cookie', { cookie: 'theme=dark' }],
    ['Vary: Authorization', 'authorization', { authorization: 'Bearer t' }],
  ] as const)(
    'stores a %s response from a cookie-less request and never serves it to a credentialed one',
    async (_name, vary, credential) => {
      const { app, calls } = await appWith((ctx) =>
        ctx.response.setHeaders({ 'cache-control': 'public, max-age=60', vary }).text('page'),
      );
      try {
        await app.inject(get());
        expect((await app.inject(get())).headers.get('x-cache')).toBe('HIT');
        expect(calls()).toBe(1);
        const credentialed = await app.inject(get(credential));
        expect(credentialed.headers.get('x-cache')).toBe('MISS');
        expect(calls()).toBe(2);
        // The credentialed response varies on a credential too, so it replaced nothing.
        expect((await app.inject(get())).headers.get('x-cache')).toBe('HIT');
        expect(calls()).toBe(2);
      } finally {
        await app.stop();
      }
    },
  );

  // RFC 9111 §4.1: a stored `Vary: *` response can never be reused.
  it('never stores a Vary: * response', async () => {
    const { app, calls } = await appWith((ctx) =>
      ctx.response.setHeaders({ 'cache-control': 'public, max-age=60', vary: '*' }).text('page'),
    );
    try {
      await app.inject(get());
      expect((await app.inject(get())).headers.get('x-cache')).toBe('MISS');
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });

  // With `credentialCookies` narrowed, a cookie it does not name makes no credential, but a page
  // varying on Cookie may still depend on it: such a request neither stores nor is served that page.
  it('with credentialCookies a Vary: Cookie entry is stored and served only without any cookie', async () => {
    const { app, calls } = await appWith(
      (ctx) =>
        ctx.response
          .header('vary', 'Cookie')
          .text(ctx.request.headers.get('cookie') ?? 'no cookie'),
      { credentialCookies: ['setu_session'] },
    );
    try {
      expect((await app.inject(get({ cookie: 'theme=dark' }))).body).toBe('theme=dark');
      const anonymous = await app.inject(get());
      expect([anonymous.body, anonymous.headers.get('x-cache')]).toEqual(['no cookie', 'MISS']);
      expect((await app.inject(get())).headers.get('x-cache')).toBe('HIT');
      const light = await app.inject(get({ cookie: 'theme=light' }));
      expect([light.body, light.headers.get('x-cache')]).toEqual(['theme=light', 'MISS']);
      expect(calls()).toBe(3);
      // A nameless pair is still a cookie an application may read raw.
      const nameless = await app.inject(get({ cookie: 'abc' }));
      expect([nameless.body, nameless.headers.get('x-cache')]).toEqual(['abc', 'MISS']);
      expect(calls()).toBe(4);
    } finally {
      await app.stop();
    }
  });

  it('stores a non-public Vary: Cookie response for cookie-less requests only', async () => {
    const { app, calls } = await appWith((ctx) =>
      ctx.response.header('vary', 'Cookie').text('page'),
    );
    try {
      await app.inject(get());
      expect((await app.inject(get())).headers.get('x-cache')).toBe('HIT');
      expect((await app.inject(get({ cookie: 'a=1' }))).headers.get('x-cache')).toBe('MISS');
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('still stores and replays an anonymous page', async () => {
    const { app, calls } = await appWith(plain);
    try {
      await app.inject(get());
      expect((await app.inject(get())).headers.get('x-cache')).toBe('HIT');
      expect(calls()).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it.each([
    ['an Authorization header', { authorization: 'Bearer t' }],
    ['any cookie', { cookie: 'theme=dark' }],
  ] as const)(
    'a request carrying %s is neither stored nor served a non-public entry',
    async (_n, headers) => {
      const { app, calls } = await appWith(plain);
      try {
        await app.inject(get(headers));
        expect(calls()).toBe(1);
        // Nothing was stored for the credentialed request...
        expect((await app.inject(get())).headers.get('x-cache')).toBe('MISS');
        expect(calls()).toBe(2);
        // ...and the anonymous entry now stored is not replayed to it.
        const again = await app.inject(get(headers));
        expect(again.headers.get('x-cache')).toBe('MISS');
        expect(calls()).toBe(3);
      } finally {
        await app.stop();
      }
    },
  );

  it('a credentialed request is replayed a HIT from a public entry', async () => {
    const { app, calls } = await appWith(withCacheControl('public, max-age=60'));
    try {
      await app.inject(get());
      const hit = await app.inject(get({ cookie: 'setu_session=abc' }));
      expect(hit.headers.get('x-cache')).toBe('HIT');
      expect(calls()).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('stores a credentialed public response without Vary: Cookie (a bearer API)', async () => {
    const { app, calls } = await appWith(withCacheControl('public, max-age=60'));
    try {
      await app.inject(get({ authorization: 'Bearer t' }));
      expect((await app.inject(get({ authorization: 'Bearer u' }))).headers.get('x-cache')).toBe(
        'HIT',
      );
      expect(calls()).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it('does not store a credentialed public response that varies on Cookie', async () => {
    const { app, calls } = await appWith((ctx) =>
      ctx.response.setHeaders({ 'cache-control': 'public, max-age=60', vary: 'Cookie' }).text('p'),
    );
    try {
      await app.inject(get({ cookie: 'a=1' }));
      await app.inject(get({ cookie: 'a=1' }));
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('with credentialCookies only the named cookies make a request credentialed', async () => {
    const { app, calls } = await appWith(plain, { credentialCookies: ['setu_session'] });
    try {
      await app.inject(get({ cookie: 'theme=dark' }));
      expect((await app.inject(get({ cookie: 'consent=yes' }))).headers.get('x-cache')).toBe('HIT');
      expect(calls()).toBe(1);
      const named = await app.inject(get({ cookie: 'theme=dark; setu_session=abc' }));
      expect(named.headers.get('x-cache')).toBe('MISS');
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('with credentialCookies: [] only Authorization counts', async () => {
    const { app, calls } = await appWith(plain, { credentialCookies: [] });
    try {
      await app.inject(get({ cookie: 'setu_session=abc' }));
      expect((await app.inject(get({ cookie: 'setu_session=xyz' }))).headers.get('x-cache')).toBe(
        'HIT',
      );
      expect((await app.inject(get({ authorization: 'Bearer t' }))).headers.get('x-cache')).toBe(
        'MISS',
      );
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('a credentialed request never joins an anonymous flight, and never leads one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, calls } = await appWith(async (ctx) => {
      await gate;
      return ctx.response.text(ctx.request.headers.get('cookie') ?? 'anonymous');
    });
    try {
      // Anonymous leader, credentialed concurrent request: the credentialed one runs its own origin.
      const leader = app.inject(get());
      const credentialed = app.inject(get({ cookie: 'setu_session=abc' }));
      // Release only once BOTH requests are inside the origin: a coalesced joiner never gets there,
      // so this wait would time out (and the test fail) if one joined the other's flight.
      await bothInOrigin(calls);
      release();
      const [a, c] = await Promise.all([leader, credentialed]);
      expect(a.body).toBe('anonymous');
      expect(c.body).toBe('setu_session=abc');
      expect(c.headers.get('x-cache')).toBe('MISS');
    } finally {
      await app.stop();
    }
  });

  it('an anonymous request does not join a credentialed request in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, calls } = await appWith(async (ctx) => {
      await gate;
      return ctx.response.text(ctx.request.headers.get('cookie') ?? 'anonymous');
    });
    try {
      const credentialed = app.inject(get({ cookie: 'setu_session=abc' }));
      const anonymous = app.inject(get());
      // Release only once BOTH requests are inside the origin: a coalesced joiner never gets there,
      // so this wait would time out (and the test fail) if one joined the other's flight.
      await bothInOrigin(calls);
      release();
      const [c, a] = await Promise.all([credentialed, anonymous]);
      expect(c.body).toBe('setu_session=abc');
      expect(a.body).toBe('anonymous');
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
    }
  });
});
