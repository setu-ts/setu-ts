import { describe, expect, it } from 'vitest';
import { withHttpStatusHint } from '@setu-ts/common';
import { conflict, HttpError, notFound } from '@setu-ts/exceptions';
import { pageAction, serviceCall } from '../../src/index.ts';
import type { PageActionResult } from '../../src/index.ts';

const request = new Request('http://localhost/orders/7?tab=items');

/** Runs `serviceCall` and returns what it threw. */
async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await serviceCall(request, work);
  } catch (error) {
    return error;
  }
  throw new Error('serviceCall did not throw');
}

describe('serviceCall', () => {
  it('returns the value of a call that succeeds', async () => {
    expect(await serviceCall(request, () => Promise.resolve({ id: '7' }))).toEqual({ id: '7' });
  });

  it('throws a 4xx HttpError as a Problem Details response', async () => {
    const response = await thrown(() => Promise.reject(notFound('Order 7 does not exist.')));
    expect(response).toBeInstanceOf(Response);
    const refused = response as Response;
    expect(refused.status).toBe(404);
    expect(refused.headers.get('content-type')).toBe('application/problem+json');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Order 7 does not exist.',
      instance: '/orders/7',
    });
    expect(body).not.toHaveProperty('message');
  });

  it('throws a hinted 4xx error with its detail and problem type', async () => {
    const error = withHttpStatusHint(new Error('internal text'), {
      status: 429,
      title: 'Too Many Requests',
      detail: 'Try again later.',
      problem: { type: 'https://example.test/quota', title: 'Quota exceeded' },
    });
    const response = (await thrown(() => Promise.reject(error))) as Response;
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      type: 'https://example.test/quota',
      title: 'Quota exceeded',
      status: 429,
      detail: 'Try again later.',
      instance: '/orders/7',
    });
  });

  it("names the page's path in instance for its .data request, root included", async () => {
    for (const [url, instance] of [
      ['http://localhost/orders/7.data?_routes=routes%2Forders', '/orders/7'],
      ['http://localhost/orders/7.data?index', '/orders/7'],
      ['http://localhost/orders/_.data', '/orders'],
      ['http://localhost/_.data', '/'],
      ['http://localhost/', '/'],
    ] as const) {
      const response = await serviceCall(new Request(url), () =>
        Promise.reject(notFound('Order 7 does not exist.')),
      ).catch((error: unknown) => error as Response);
      expect(((await response.json()) as { instance: string }).instance).toBe(instance);
    }
  });

  it('carries no problem extensions or details, as documented', async () => {
    const error = withHttpStatusHint(new Error('internal'), {
      status: 429,
      title: 'Too Many Requests',
      detail: 'Try again later.',
      details: { errors: ['x'] },
      problem: {
        type: 'https://example.test/quota',
        title: 'Quota exceeded',
        extensions: { 'retry-after': 30 },
      },
    });
    const response = (await thrown(() => Promise.reject(error))) as Response;
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['detail', 'instance', 'status', 'title', 'type']);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('rethrows a 5xx HttpError, a 5xx hint and an unknown error untouched', async () => {
    const fault = new HttpError(503, 'Database unavailable');
    const hinted = withHttpStatusHint(new Error('x'), {
      status: 502,
      title: 'Bad Gateway',
      detail: 'Upstream failed.',
    });
    const plain = new Error('boom');
    for (const error of [fault, hinted, plain, 'a string']) {
      expect(await thrown(() => Promise.reject(error))).toBe(error);
    }
  });
});

describe('pageAction', () => {
  it('returns the value with its intent', async () => {
    const result: PageActionResult<number> = await pageAction('create', () => Promise.resolve(3));
    expect(result).toEqual({ ok: true, intent: 'create', value: 3 });
  });

  it('returns a refusal with its detail and status', async () => {
    const result = await pageAction('create', () =>
      Promise.reject(conflict('A product with that name exists.')),
    );
    expect(result).toEqual({
      ok: false,
      intent: 'create',
      error: 'A product with that name exists.',
      status: 409,
    });
  });

  it('returns a hinted quota refusal with its detail', async () => {
    const error = withHttpStatusHint(new Error('internal'), {
      status: 429,
      title: 'Too Many Requests',
      detail: 'Try again later.',
    });
    expect(await pageAction('ask', () => Promise.reject(error))).toEqual({
      ok: false,
      intent: 'ask',
      error: 'Try again later.',
      status: 429,
    });
  });

  it('rethrows a fault', async () => {
    const fault = new HttpError(500, 'boom');
    await expect(pageAction('create', () => Promise.reject(fault))).rejects.toBe(fault);
  });
});
