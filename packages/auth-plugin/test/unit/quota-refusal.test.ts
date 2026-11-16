/* eslint-disable require-await -- Test doubles preserve asynchronous provider and service contracts. */
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import type { ErrorFormat } from '@setu-ts/exceptions';
import { httpStatusHintOf } from '@setu-ts/common';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import {
  QuotaExceededError,
  QuotaStoreUnavailableError,
  rateLimitMiddleware,
  respondQuotaExceeded,
  createQuota,
  MemoryQuotaStore,
} from '../../src/index.ts';
import before from '../fixtures/limiter-429-before.json' with { type: 'json' };

async function boot(format: ErrorFormat) {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.middleware.add(errorHandler({ format, logErrors: false }), { priority: 1 });
  app.router.get('/limited', {
    middleware: [
      rateLimitMiddleware({
        windowMs: 60_000,
        max: 0,
        policyName: 'budget-policy',
        message: 'Custom refusal',
        store: { increment: async () => ({ count: 1, resetTime: 0 }), reset: async () => {} },
      }),
    ],
    handler: (ctx) => ctx.response.text('must not run'),
  });
  app.router.get('/quota', {
    middleware: [
      async (ctx) => {
        respondQuotaExceeded(ctx, new QuotaExceededError('budget-policy', 7));
      },
    ],
    handler: (ctx) => ctx.response.text('must not run'),
  });
  app.router.get('/throw', {
    handler: () => {
      throw new QuotaExceededError('budget-policy', 7);
    },
  });
  app.router.get('/store-down', {
    handler: () => {
      throw new QuotaStoreUnavailableError(new Error('redis-secret-host:6379 refused'));
    },
  });
  await app.start();
  return app;
}

describe('quota refusals', () => {
  it('V12-134 refuses a non-string message without coercing it', () => {
    const toString = vi.fn(() => {
      throw new Error('must not run');
    });
    expect(() => new QuotaExceededError('policy', 1, { toString } as unknown as string)).toThrow(
      TypeError,
    );
    expect(toString).not.toHaveBeenCalled();
  });
  it.each(['', 1, null])('V12-134 constructor refuses invalid message %j', (message) => {
    expect(() => new QuotaExceededError('policy', 1, message as string)).toThrow(
      'Quota message must be a non-empty string',
    );
  });
  it('V12-134 shares configured detail through reserve, hint and response helper', async () => {
    const runtime = createFakeRuntime(0);
    const quota = createQuota({
      name: 'budget-policy',
      store: new MemoryQuotaStore(runtime),
      runtime,
      window: 7000,
      limit: 0,
      message: 'Quotum op',
    });
    const refusal = await quota.reserve('tenant', 1).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(QuotaExceededError);
    const error = refusal as QuotaExceededError;
    expect(error.message).toBe('Quotum op');
    expect(error.detail).toBe('Quotum op');
    expect(httpStatusHintOf(error)?.detail).toBe('Quotum op');
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 0 });
    app.router.get('/quota', (ctx) => {
      if (ctx.request.headers.has('helper')) {
        respondQuotaExceeded(ctx, error);
        return { __handlerResult: true };
      }
      throw error;
    });
    await app.start();
    try {
      const bodies = [];
      for (const headers of [{}, { helper: 'true' }]) {
        const response = await app.fetch(new Request('http://localhost/quota', { headers }));
        expect(response.status).toBe(429);
        bodies.push(await response.json());
      }
      expect(bodies[0]).toEqual({
        type: 'https://iana.org/assignments/http-problem-types#quota-exceeded',
        title: 'Quota Exceeded',
        status: 429,
        detail: 'Quotum op',
        instance: '/quota',
        'violated-policies': ['budget-policy'],
        'retry-after': 7,
      });
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[1]).not.toHaveProperty('message');
    } finally {
      await app.stop();
    }
  });
  it.each([NaN, -3, 0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retryAfterSeconds %s (F6)',
    (seconds) => {
      expect(() => new QuotaExceededError('policy', seconds)).toThrow(TypeError);
    },
  );

  it('rejects an empty policy name (F6)', () => {
    expect(() => new QuotaExceededError('', 1)).toThrow(TypeError);
  });
  it('names the error class and carries the policy separately', () => {
    const error = new QuotaExceededError('budget-policy', 7);
    expect(error.name).toBe('QuotaExceededError');
    expect(error.policyName).toBe('budget-policy');
    expect(error.detail).toBe('The quota for this request is spent.');
    expect(String(error)).toBe('QuotaExceededError: The quota for this request is spent.');
  });

  it('answers a store outage 503 with a value-free body, like the rate limiter', async () => {
    const app = await boot('rfc9457');
    try {
      const response = await app.fetch(new Request('http://localhost/store-down'));
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        status: 503,
        title: 'Service Unavailable',
        detail: 'Quota storage is temporarily unavailable.',
      });
      expect(body).not.toContain('redis-secret-host');
    } finally {
      await app.stop();
    }
  });

  it.each(before)('keeps the pre-refactor limiter 429 byte-identical: $format', async (fixture) => {
    const app = await boot(fixture.format as ErrorFormat);
    try {
      const response = await app.fetch(new Request('http://localhost/limited'));
      expect({
        status: response.status,
        headers: [...response.headers],
        body: await response.text(),
      }).toEqual({ status: fixture.status, headers: fixture.headers, body: fixture.body });
    } finally {
      await app.stop();
    }
  });

  it('discloses only the policy and reset, field by field, with no message (O9)', async () => {
    const app = await boot('rfc9457');
    try {
      const response = await app.fetch(new Request('http://localhost/quota'));
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('7');
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await response.json()).toEqual({
        type: 'https://iana.org/assignments/http-problem-types#quota-exceeded',
        title: 'Quota Exceeded',
        status: 429,
        detail: 'The quota for this request is spent.',
        instance: '/quota',
        'violated-policies': ['budget-policy'],
        'retry-after': 7,
      });
      const thrown = await app.fetch(new Request('http://localhost/throw'));
      expect(thrown.status).toBe(429);
      expect(thrown.headers.has('Retry-After')).toBe(false);
      expect(await thrown.json()).toEqual({
        type: 'https://iana.org/assignments/http-problem-types#quota-exceeded',
        title: 'Quota Exceeded',
        status: 429,
        detail: 'The quota for this request is spent.',
        instance: '/throw',
        'violated-policies': ['budget-policy'],
        'retry-after': 7,
      });
    } finally {
      await app.stop();
    }
  });

  it.each(['rfc7807', 'default'] as const)(
    'drives limiter and quota through the same non-default format: %s',
    async (format) => {
      const app = await boot(format);
      try {
        const limited = await app.fetch(new Request('http://localhost/limited'));
        const quota = await app.fetch(new Request('http://localhost/quota'));
        expect(limited.status).toBe(429);
        expect(quota.status).toBe(429);
        expect(limited.headers.get('content-type')).toBe(quota.headers.get('content-type'));
        const left = (await limited.json()) as Record<string, unknown>;
        const right = (await quota.json()) as Record<string, unknown>;
        if (format === 'default') {
          expect(left.message).toBe(right.message);
          expect(Object.keys(left).sort()).toEqual(Object.keys(right).sort());
        } else {
          expect(left.type).toBe(right.type);
          expect(left.title).toBe(right.title);
          expect(left['violated-policies']).toEqual(right['violated-policies']);
          expect(Object.keys(left).sort()).toEqual(
            Object.keys(right)
              .filter((key) => key !== 'retry-after')
              .sort(),
          );
        }
      } finally {
        await app.stop();
      }
    },
  );
});
