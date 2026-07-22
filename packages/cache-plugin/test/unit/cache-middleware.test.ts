// deno-lint-ignore-file require-await -- test fixtures use sync methods matching async interface signatures
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  HandlerResult,
  ICacheStore,
  IRequestContext,
  IServiceRegistry,
} from '@hono-enterprise/common';

import { cacheMiddleware } from '../../src/middleware/cache-middleware.ts';

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
        return v === undefined ? null : v as T;
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

  function createContext(store: ICacheStore, opts?: {
    method?: string;
    url?: string;
  }): {
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
        json: async <T = unknown>() => ({} as T),
        text: async () => '',
        bytes: async () => new Uint8Array(0),
      },
      response: {
        status: (code: number) => {
          responseStatus.push(code);
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
      const base64 = btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(''));
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
          json: async <T = unknown>() => ({} as T),
          text: async () => '',
          bytes: async () => new Uint8Array(0),
        },
        response: {
          status: () => ctx.response,
          header: () => ctx.response,
          appendHeader: () => ctx.response,
          json: () => hr,
          text: () => hr,
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
          json: async <T = unknown>() => ({} as T),
          text: async () => '',
          bytes: async () => new Uint8Array(0),
        },
        response: {
          status: (_code: number) => ctx.response,
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
