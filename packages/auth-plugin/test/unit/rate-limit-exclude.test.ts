/**
 * `RateLimitOptions.exclude` — the operational-probe exemption (M90a §3.2).
 *
 * X32-1: `rateLimitMiddleware` is documented as a GLOBAL middleware and had no
 * exclusion member at all, so an exhausted bucket answered `/live` with a
 * `429`. A Kubernetes kubelet reads that as a failed liveness probe and
 * restarts the container — whose only fault was being under load.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DEFAULT_RATE_LIMIT_EXCLUDED_PATHS,
  rateLimitMiddleware,
} from '../../src/middleware/rate-limit-middleware.ts';
import type { RateLimitResult, RateLimitStore } from '../../src/stores/rate-limit-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { createContext } from '../fixtures/rate-limit-context.ts';
import type { MiddlewareFunction } from '@setu-ts/common';

/** A store that reports every key as already past any budget. */
function exhaustedStore(): RateLimitStore & { increments: string[] } {
  const increments: string[] = [];
  return {
    increments,
    increment(key: string): Promise<RateLimitResult> {
      increments.push(key);
      return Promise.resolve({ count: 1_000_000, resetTime: 60_000 });
    },
    reset(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Drives one request at `path` and reports what happened. */
async function drive(
  middleware: MiddlewareFunction,
  path: string,
): Promise<{ status: number; nextCalled: boolean; headers: Headers }> {
  const runtime = createFakeRuntime();
  const { ctx, captured } = createContext(runtime, { ip: '1.2.3.4', path });
  let nextCalled = false;
  await middleware(ctx, () => {
    nextCalled = true;
    return Promise.resolve();
  });
  return { status: captured.status, nextCalled, headers: captured.headers };
}

describe('rateLimitMiddleware exclude (X32-1)', () => {
  it('names the six operational paths as its default', () => {
    expect(DEFAULT_RATE_LIMIT_EXCLUDED_PATHS).toEqual([
      '/live',
      '/ready',
      '/health',
      '/metrics',
      '/openapi.json',
      '/docs',
    ]);
  });

  it('an EXHAUSTED limiter still serves every default-excluded path', async () => {
    // The whole finding: with the bucket empty, these must still answer.
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 1,
      store: exhaustedStore(),
    });

    for (const path of ['/live', '/ready', '/health', '/metrics', '/openapi.json', '/docs']) {
      const result = await drive(middleware, path);
      expect(result.nextCalled).toBe(true);
      expect(result.status).toBe(200);
    }
  });

  it('an exhausted limiter still REFUSES an ordinary path', async () => {
    // The discriminating half: the exemption must not disable the limiter.
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 1,
      store: exhaustedStore(),
    });
    const result = await drive(middleware, '/orders');
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(429);
  });

  it('an excluded path increments NO counter', async () => {
    // Skipping the refusal but still counting would let a probe every second
    // consume the budget a real caller needs.
    const store = exhaustedStore();
    const middleware = rateLimitMiddleware({ windowMs: 60_000, max: 100, store });

    await drive(middleware, '/live');
    expect(store.increments).toEqual([]);

    await drive(middleware, '/orders');
    expect(store.increments).toEqual(['ip:1.2.3.4']);
  });

  it('an excluded path carries no RateLimit-* headers', async () => {
    // The limit does not govern the request, so advertising one would be a lie.
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 100,
      store: exhaustedStore(),
    });
    const result = await drive(middleware, '/live');
    expect(result.headers.get('RateLimit-Limit')).toBeNull();
    expect(result.headers.get('RateLimit-Remaining')).toBeNull();
    expect(result.headers.get('Retry-After')).toBeNull();
  });

  it('`exclude: []` exempts nothing — the pre-0.5.0 behaviour', async () => {
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 1,
      store: exhaustedStore(),
      exclude: [],
    });

    for (const path of ['/live', '/ready', '/health']) {
      const result = await drive(middleware, path);
      expect(result.nextCalled).toBe(false);
      expect(result.status).toBe(429);
    }
  });

  it('a caller list REPLACES the defaults rather than extending them', async () => {
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 1,
      store: exhaustedStore(),
      exclude: ['/internal'],
    });

    expect((await drive(middleware, '/internal')).status).toBe(200);
    // `/live` is no longer exempt, because the caller's list took over.
    expect((await drive(middleware, '/live')).status).toBe(429);
  });

  it('a RegExp entry matches, and does not match a path outside it', async () => {
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 1,
      store: exhaustedStore(),
      exclude: [/^\/internal\//],
    });

    expect((await drive(middleware, '/internal/debug')).status).toBe(200);
    expect((await drive(middleware, '/public/internal/debug')).status).toBe(429);
  });

  it('defaults can be extended by spreading the exported constant', async () => {
    // The reason the constant is exported: otherwise "mine plus the defaults"
    // means retyping six strings, which is exactly the drift M90a removes.
    const middleware = rateLimitMiddleware({
      windowMs: 60_000,
      max: 1,
      store: exhaustedStore(),
      exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
    });

    expect((await drive(middleware, '/live')).status).toBe(200);
    expect((await drive(middleware, '/internal/x')).status).toBe(200);
    expect((await drive(middleware, '/orders')).status).toBe(429);
  });

  it('an excluded path does not even resolve the runtime capability', async () => {
    // The exemption returns before `ctx.services.get(RUNTIME)`, so a probe
    // costs nothing at all — asserted through a registry that refuses.
    const runtime = createFakeRuntime();
    const { ctx, captured } = createContext(runtime, { ip: '1.2.3.4', path: '/live' });
    const refusing = {
      get: () => {
        throw new Error('the exemption must return before any capability lookup');
      },
      has: () => true,
      register: () => {},
    };
    const probed = {
      ...ctx,
      services: refusing as unknown as typeof ctx.services,
    };

    const middleware = rateLimitMiddleware({ windowMs: 60_000, max: 1 });
    let nextCalled = false;
    await middleware(probed, () => {
      nextCalled = true;
      return Promise.resolve();
    });

    expect(nextCalled).toBe(true);
    expect(captured.status).toBe(200);
  });
});
