/**
 * Unit tests for rateLimitMiddleware.
 *
 * Covers: under-limit request, 429 short-circuit, custom keyGenerator,
 * standardHeaders toggle, standardHeaders off.
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { rateLimitMiddleware } from '../../src/middleware/rate-limit-middleware.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import type { IRequestContext } from '../../src/index.ts';

/** Minimal test fixture for rate-limit middleware tests. */
interface FixtureCtx {
  request: {
    headers: Headers;
    ip: string | undefined;
    user?: { readonly id: string };
    method: string;
    path: string;
    url: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    bytes: () => Promise<Uint8Array>;
  };
  response: {
    _status: number;
    _headers: Headers;
    _body: unknown;
    status(code: number): FixtureCtx['response'];
    header(name: string, value: string): FixtureCtx['response'];
    json(body: unknown): FixtureCtx['response'];
    appendHeader(): FixtureCtx['response'];
    text(): Promise<string>;
    send(): Promise<void>;
    redirect(): FixtureCtx['response'];
    snapshot(): { status: number; headers: Headers; body: null };
  };
  services: { get<T>(): T };
}

function makeCtx(options?: { ip?: string; user?: { id: string } }): FixtureCtx {
  const runtime = createFakeRuntime();
  const headers = new Headers();
  const response: FixtureCtx['response'] = {
    _status: 200,
    _headers: headers,
    _body: {} as unknown,
    status(code: number) {
      response._status = code;
      return response;
    },
    header(name: string, value: string) {
      headers.set(name, value);
      return response;
    },
    json(body: unknown) {
      response._body = body;
      return response;
    },
    appendHeader() {
      return response;
    },
    text() {
      return Promise.resolve('');
    },
    send() {
      return Promise.resolve();
    },
    redirect() {
      return response;
    },
    snapshot() {
      return { status: response._status, headers, body: null };
    },
  };
  return {
    request: {
      headers,
      ip: options?.ip,
      user: options?.user as { readonly id: string } | undefined as { readonly id: string },
      method: 'GET',
      path: '/',
      url: 'http://localhost/',
      json: () => Promise.resolve({} as unknown),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
    },
    response,
    services: {
      get<T>(): T {
        return runtime as T;
      },
    },
  };
}

Deno.test('rateLimitMiddleware — under-limit request calls next and sets headers', async () => {
  const middleware = rateLimitMiddleware({ windowMs: 60000, max: 100 });
  const ctx = makeCtx({ ip: '1.2.3.4' });
  let nextCalled = false;

  const next = () => {
    nextCalled = true;
  };

  // First request
  await middleware(ctx as unknown as IRequestContext, () => Promise.resolve(next()));

  assertEquals(nextCalled, true);
  assertEquals(ctx.response._status, 200);
  assertEquals(ctx.response._headers.get('RateLimit-Limit'), '100');
  assertEquals(ctx.response._headers.get('RateLimit-Remaining'), '99');
  assertExists(ctx.response._headers.get('RateLimit-Reset'));
});

Deno.test('rateLimitMiddleware — 429 short-circuit (downstream NOT invoked)', async () => {
  const middleware = rateLimitMiddleware({ windowMs: 60000, max: 2 });
  const ctx = makeCtx({ ip: '5.6.7.8' });
  let downstreamInvoked = false;

  const downstream = () => {
    downstreamInvoked = true;
  };

  // Requests 1 and 2 — under limit
  await middleware(ctx as unknown as IRequestContext, () => Promise.resolve(downstream()));
  assertEquals(downstreamInvoked, true);
  downstreamInvoked = false;

  await middleware(ctx as unknown as IRequestContext, () => Promise.resolve(downstream()));
  assertEquals(downstreamInvoked, true);
  downstreamInvoked = false;

  // Request 3 — over limit, short-circuit
  await middleware(ctx as unknown as IRequestContext, () => Promise.resolve(downstream()));

  assertEquals(ctx.response._status, 429);
  assertEquals(ctx.response._headers.get('Retry-After'), '60'); // ceil(60000/1000)
  assertEquals(ctx.response._headers.get('RateLimit-Limit'), '2');
  assertEquals(ctx.response._headers.get('RateLimit-Remaining'), '0');
  assertExists(ctx.response._headers.get('RateLimit-Reset'));
  assertEquals(downstreamInvoked, false); // DOWNSTREAM NOT INVOKED
  assertEquals((ctx.response._body as { error: string }).error, 'Too Many Requests');
});

Deno.test('rateLimitMiddleware — custom keyGenerator isolates callers', async () => {
  const middleware = rateLimitMiddleware({
    windowMs: 60000,
    max: 1,
    keyGenerator: (ctx: IRequestContext) =>
      (ctx.request as { user?: { readonly id: string } }).user?.id ?? 'anonymous',
  });
  let nextCount = 0;
  const next = () => {
    nextCount++;
  };

  const ctx1 = makeCtx({ user: { id: 'user-a' } });
  const ctx2 = makeCtx({ user: { id: 'user-b' } });

  // User A hits limit
  await middleware(ctx1 as unknown as IRequestContext, () => Promise.resolve(next()));
  assertEquals(nextCount, 1);
  await middleware(ctx1 as unknown as IRequestContext, () => Promise.resolve(next()));
  assertEquals(ctx1.response._status, 429);

  // User B still under limit (separate key)
  await middleware(ctx2 as unknown as IRequestContext, () => Promise.resolve(next()));
  assertEquals(nextCount, 2);
});

Deno.test('rateLimitMiddleware — standardHeaders: false omits headers', async () => {
  const middleware = rateLimitMiddleware({
    windowMs: 60000,
    max: 100,
    standardHeaders: false,
  });
  const ctx = makeCtx({ ip: '1.2.3.4' });
  const next = async () => {};

  await middleware(ctx as unknown as IRequestContext, next);

  assertEquals(ctx.response._headers.get('RateLimit-Limit'), null);
  assertEquals(ctx.response._headers.get('RateLimit-Remaining'), null);
  assertEquals(ctx.response._headers.get('RateLimit-Reset'), null);
});

Deno.test('rateLimitMiddleware — default key falls back to anonymous when IP missing', async () => {
  const middleware = rateLimitMiddleware({ windowMs: 60000, max: 1 });
  const ctx = makeCtx(); // no ip
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  await middleware(ctx as unknown as IRequestContext, () => Promise.resolve(next()));
  assertEquals(nextCalled, true);

  // Second request from anonymous hits limit
  await middleware(ctx as unknown as IRequestContext, () => Promise.resolve(next()));
  assertEquals(ctx.response._status, 429);
});
