/**
 * Unit tests for rateLimitMiddleware.
 *
 * Covers: under-limit pass-through with headers, 429 short-circuit (downstream
 * NOT invoked), custom keyGenerator isolation, standardHeaders toggle on both
 * paths, custom message, injected store, and the default-memory-store path.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { rateLimitMiddleware } from '../../src/middleware/rate-limit-middleware.ts';
import type { RateLimitResult, RateLimitStore } from '../../src/stores/rate-limit-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HandlerResult,
  IPrincipal,
  IRequest,
  IRequestContext,
  IResponse,
  IServiceRegistry,
} from '@hono-enterprise/common';

interface CapturedResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

function createContext(
  runtime: ReturnType<typeof createFakeRuntime>,
  options?: { ip?: string; user?: IPrincipal },
): { ctx: IRequestContext; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 200, headers: new Headers(), body: null };

  const request: IRequest & { user?: IPrincipal } = {
    method: 'GET',
    url: 'http://localhost/',
    path: '/',
    headers: new Headers(),
    ...(options?.ip !== undefined ? { ip: options.ip } : {}),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
  if (options?.user !== undefined) {
    request.user = options.user;
  }

  const response: IResponse = {
    status: (code: number) => {
      captured.status = code;
      return response;
    },
    header: (name: string, value: string) => {
      captured.headers.set(name, value);
      return response;
    },
    appendHeader: () => response,
    json: (body: unknown): HandlerResult => {
      captured.body = body;
      return { __handlerResult: true } as unknown as HandlerResult;
    },
    text: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    send: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    redirect: (): HandlerResult => ({ __handlerResult: true } as unknown as HandlerResult),
    snapshot: () => ({ status: captured.status, headers: captured.headers, body: null }),
  };

  const services = {
    get: <T>(token: string): T => {
      if (token === CAPABILITIES.RUNTIME) {
        return runtime as T;
      }
      throw new Error(`unexpected token: ${token}`);
    },
    has: () => true,
    register: () => {},
  } as unknown as IServiceRegistry;

  const ctx: IRequestContext = {
    id: 'test',
    request,
    response,
    services,
    params: {},
    query: {},
    state: new Map(),
    startTime: 0,
  };

  return { ctx, captured };
}

describe('rateLimitMiddleware', () => {
  it('under-limit request calls next and sets RateLimit-* headers', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({ windowMs: 60000, max: 100 });
    const { ctx, captured } = createContext(runtime, { ip: '1.2.3.4' });
    let nextCalled = false;

    await middleware(ctx, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(nextCalled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers.get('RateLimit-Limit')).toBe('100');
    expect(captured.headers.get('RateLimit-Remaining')).toBe('99');
    expect(captured.headers.get('RateLimit-Reset')).toBe('60'); // delta-seconds
    expect(captured.headers.get('Retry-After')).toBeNull(); // only on 429
  });

  it('the max+1-th request returns 429 and the downstream is NOT invoked', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({ windowMs: 60000, max: 2 });
    let downstreamInvocations = 0;
    const next = () => {
      downstreamInvocations++;
      return Promise.resolve();
    };

    const first = createContext(runtime, { ip: '5.6.7.8' });
    await middleware(first.ctx, next);
    const second = createContext(runtime, { ip: '5.6.7.8' });
    await middleware(second.ctx, next);
    expect(downstreamInvocations).toBe(2);

    const third = createContext(runtime, { ip: '5.6.7.8' });
    const result = await middleware(third.ctx, next);

    expect(downstreamInvocations).toBe(2); // downstream NOT invoked
    expect(third.captured.status).toBe(429);
    expect(third.captured.headers.get('Retry-After')).toBe('60'); // ceil(60000/1000)
    expect(third.captured.headers.get('RateLimit-Limit')).toBe('2');
    expect(third.captured.headers.get('RateLimit-Remaining')).toBe('0');
    expect(third.captured.headers.get('RateLimit-Reset')).toBe('60'); // delta-seconds
    expect(third.captured.body).toEqual({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
    });
    expect(result).toBeDefined(); // the HandlerResult short-circuits the pipeline
  });

  it('uses a custom message in the 429 body', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({
      windowMs: 60000,
      max: 0,
      message: 'Slow down',
    });
    const { ctx, captured } = createContext(runtime, { ip: '1.2.3.4' });

    await middleware(ctx, () => Promise.resolve());

    expect(captured.status).toBe(429);
    expect(captured.body).toEqual({ error: 'Too Many Requests', message: 'Slow down' });
  });

  it('custom keyGenerator isolates callers into separate counters', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({
      windowMs: 60000,
      max: 1,
      keyGenerator: (ctx) => ctx.request.user?.id ?? 'anonymous',
    });
    let nextCount = 0;
    const next = () => {
      nextCount++;
      return Promise.resolve();
    };

    const a1 = createContext(runtime, { user: { id: 'user-a' } });
    await middleware(a1.ctx, next);
    expect(nextCount).toBe(1);

    const a2 = createContext(runtime, { user: { id: 'user-a' } });
    await middleware(a2.ctx, next);
    expect(a2.captured.status).toBe(429); // user A over limit

    const b1 = createContext(runtime, { user: { id: 'user-b' } });
    await middleware(b1.ctx, next);
    expect(nextCount).toBe(2); // user B unaffected
  });

  it('standardHeaders: false omits RateLimit-* on the under-limit path', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({
      windowMs: 60000,
      max: 100,
      standardHeaders: false,
    });
    const { ctx, captured } = createContext(runtime, { ip: '1.2.3.4' });

    await middleware(ctx, () => Promise.resolve());

    expect(captured.headers.get('RateLimit-Limit')).toBeNull();
    expect(captured.headers.get('RateLimit-Remaining')).toBeNull();
    expect(captured.headers.get('RateLimit-Reset')).toBeNull();
  });

  it('standardHeaders: false keeps Retry-After on the 429 path', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({
      windowMs: 60000,
      max: 0,
      standardHeaders: false,
    });
    const { ctx, captured } = createContext(runtime, { ip: '1.2.3.4' });

    await middleware(ctx, () => Promise.resolve());

    expect(captured.status).toBe(429);
    expect(captured.headers.get('Retry-After')).toBe('60');
    expect(captured.headers.get('RateLimit-Limit')).toBeNull();
    expect(captured.headers.get('RateLimit-Remaining')).toBeNull();
    expect(captured.headers.get('RateLimit-Reset')).toBeNull();
  });

  it('default key falls back to anonymous when the request has no IP', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({ windowMs: 60000, max: 1 });

    const first = createContext(runtime); // no ip
    await middleware(first.ctx, () => Promise.resolve());
    expect(first.captured.status).toBe(200);

    const second = createContext(runtime); // no ip — same 'anonymous' key
    await middleware(second.ctx, () => Promise.resolve());
    expect(second.captured.status).toBe(429);
  });

  it('uses an injected store and passes windowMs through to increment', async () => {
    const runtime = createFakeRuntime();
    const calls: { key: string; windowMs: number }[] = [];
    const store: RateLimitStore = {
      increment: (key: string, windowMs: number): Promise<RateLimitResult> => {
        calls.push({ key, windowMs });
        return Promise.resolve({ count: 999, resetTime: runtime.now() + 5000 });
      },
      reset: () => Promise.resolve(),
    };
    const middleware = rateLimitMiddleware({ windowMs: 12345, max: 10, store });
    const { ctx, captured } = createContext(runtime, { ip: '9.9.9.9' });

    await middleware(ctx, () => Promise.resolve());

    expect(calls).toEqual([{ key: '9.9.9.9', windowMs: 12345 }]);
    expect(captured.status).toBe(429); // injected store's count drives the decision
    expect(captured.headers.get('Retry-After')).toBe('5'); // ceil(5000/1000)
  });

  it('builds the default memory store once and shares it across requests', async () => {
    const runtime = createFakeRuntime();
    const middleware = rateLimitMiddleware({ windowMs: 60000, max: 2 });

    // Three requests through the SAME middleware instance share one counter,
    // proving the lazily-built store is memoized rather than rebuilt.
    const r1 = createContext(runtime, { ip: '8.8.8.8' });
    await middleware(r1.ctx, () => Promise.resolve());
    const r2 = createContext(runtime, { ip: '8.8.8.8' });
    await middleware(r2.ctx, () => Promise.resolve());
    const r3 = createContext(runtime, { ip: '8.8.8.8' });
    await middleware(r3.ctx, () => Promise.resolve());

    expect(r1.captured.status).toBe(200);
    expect(r2.captured.status).toBe(200);
    expect(r3.captured.status).toBe(429);
  });
});
