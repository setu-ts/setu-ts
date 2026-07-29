/**
 * Tests for the internal `HttpClient` class.
 *
 * Covers URL building, query serialization, headers, JSON request/response,
 * 204 handling, abort, interceptor ordering, non-2xx → HttpClientError, and
 * response-interceptor skip on failure.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HttpClient } from '../../src/http/http-client.ts';
import { ClientCircuitOpenError, HttpClientError } from '../../src/errors.ts';
import type { ClientOptions, IClientTiming, IHttpClient } from '../../src/http/contracts.ts';

// Deterministic fake timing.
const fakeTiming: IClientTiming = {
  now: () => 0,
  sleep: () => Promise.resolve(),
};

/** Build a client with an injectable fake fetch. */
function buildClient(overrides: Partial<ClientOptions> = {}): {
  client: IHttpClient;
  calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const client = new HttpClient({
    baseUrl: 'https://api.example.com',
    timing: fakeTiming,
    fetch: (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h instanceof Headers) {
          for (const [k, v] of h.entries()) headers[k] = v;
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k] = v;
        } else {
          Object.assign(headers, h);
        }
      }
      calls.push({ url, method: init?.method ?? 'GET', headers });
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    },
    ...overrides,
  });
  return { client, calls };
}

describe('HttpClient', () => {
  it('builds correct URL from baseUrl + path', async () => {
    const { client, calls } = buildClient();
    await client.request({ method: 'GET', path: 'users' });
    expect(calls[0].url).toEqual('https://api.example.com/users');
  });

  it('serializes query parameters', async () => {
    const { client, calls } = buildClient();
    await client.request({
      method: 'GET',
      path: 'search',
      query: { q: 'test', page: 1 },
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('q')).toEqual('test');
    expect(url.searchParams.get('page')).toEqual('1');
  });

  it('repeats array query values', async () => {
    const { client, calls } = buildClient();
    await client.request({
      method: 'GET',
      path: 'items',
      query: { id: ['1', '2'] },
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.getAll('id')).toEqual(['1', '2']);
  });

  it('omits nullish query values', async () => {
    const { client, calls } = buildClient();
    await client.request({
      method: 'GET',
      path: 'items',
      query: { a: null, b: undefined, c: 'val' },
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('a')).toEqual(false);
    expect(url.searchParams.has('b')).toEqual(false);
    expect(url.searchParams.get('c')).toEqual('val');
  });

  it('merges default headers with request headers', async () => {
    const { client, calls } = buildClient({
      headers: { 'X-Default': 'yes' },
    });
    await client.request({
      method: 'GET',
      path: 'x',
      headers: { 'X-Request': 'val' },
    });
    expect(calls[0].headers['x-default']).toEqual('yes');
    expect(calls[0].headers['x-request']).toEqual('val');
  });

  it('sets Content-Type: application/json when json body present', async () => {
    const { client, calls } = buildClient();
    await client.request({
      method: 'POST',
      path: 'users',
      json: { name: 'test' },
    });
    expect(calls[0].headers['content-type']).toEqual('application/json');
  });

  it('parses JSON response', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 1, name: 'a' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    const resp = await client.request({ method: 'GET', path: 'users/1' });
    expect(resp.data).toEqual({ id: 1, name: 'a' });
    expect(resp.status).toEqual(200);
  });

  it('returns undefined data for 204', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(new Response(null, { status: 204 }));
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    const resp = await client.request({ method: 'DELETE', path: 'users/1' });
    expect(resp.status).toEqual(204);
    expect(resp.data).toBeUndefined();
  });

  it('throws HttpClientError on non-2xx', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'X-Foo': 'bar' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    await expect(
      client.request({ method: 'GET', path: 'missing' }),
    ).rejects.toThrow('404');
  });

  it('HttpClientError carries status, headers, body', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'bad' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'X-Err': 'yes' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    try {
      await client.request({ method: 'GET', path: 'fail' });
    } catch (err: unknown) {
      if (err instanceof HttpClientError) {
        expect(err.status).toEqual(500);
        expect(err.headers.get('X-Err')).toEqual('yes');
        expect(err.body).toEqual({ detail: 'bad' });
        return;
      }
      throw err;
    }
    // unreachable
  });

  it('executes request interceptors in order', async () => {
    const order: string[] = [];
    const { client } = buildClient({
      requestInterceptors: [
        (ctx) => {
          order.push('a');
          ctx.headers.set('X-A', '1');
        },
        (ctx) => {
          order.push('b');
          ctx.headers.set('X-B', '2');
        },
      ],
    });
    await client.request({ method: 'GET', path: 'x' });
    expect(order).toEqual(['a', 'b']);
  });

  it('executes response interceptors in order', async () => {
    const order: string[] = [];
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
      responseInterceptors: [
        (resp) => {
          order.push('a');
          return resp;
        },
        (resp) => {
          order.push('b');
          return resp;
        },
      ],
    });
    await client.request({ method: 'GET', path: 'x' });
    expect(order).toEqual(['a', 'b']);
  });

  it('skips response interceptors on failure', async () => {
    const order: string[] = [];
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(new Response('not found', { status: 404 }));
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
      responseInterceptors: [(resp) => {
        order.push('should not run');
        return resp;
      }],
    });
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow('404');
    expect(order).toEqual([]);
  });

  it('aborts fetch when signal is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = async (
      _input,
      _init,
    ) => {
      // Wait for abort.
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response('{}', { status: 200 });
    };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    const promise = client.request({ method: 'GET', path: 'x', signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  it('uses array headers', async () => {
    let receivedHeaders: Headers | undefined;
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = (
      _input,
      init,
    ) => {
      receivedHeaders = init?.headers as Headers | undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    await client.request({
      method: 'GET',
      path: 'x',
      headers: [['X-Custom', 'value']],
    });
    expect(receivedHeaders).toBeDefined();
    expect((receivedHeaders as Headers).get('X-Custom')).toEqual('value');
  });

  it('returns text body for non-JSON content type', async () => {
    const fetchImpl: (input: RequestInfo, _init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response('hello world', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    const resp = await client.request({ method: 'GET', path: 'x' });
    expect(resp.data).toBeUndefined();
  });

  it('throws when path has leading slash', async () => {
    const { client } = buildClient();
    await expect(
      client.request({ method: 'GET', path: '/bad' }),
    ).rejects.toThrow('no leading slash');
  });

  it('accepts Headers instance as request headers', async () => {
    let receivedInit: RequestInit | undefined;
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = (
      _input,
      init,
    ) => {
      receivedInit = init;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    await client.request({
      method: 'GET',
      path: 'x',
      headers: new Headers({ 'X-Headers-Instance': 'true' }),
    });
    expect(receivedInit).toBeDefined();
    const h = receivedInit!.headers as Headers;
    expect(h.get('X-Headers-Instance')).toEqual('true');
  });

  it('throws when JSON response body is invalid', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response('not-json{', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(
      'Failed to parse JSON',
    );
  });

  it('creates rate limiter when rateLimit options provided', async () => {
    let limiterAcquired = false;
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () => {
      limiterAcquired = true;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
      rateLimit: { maxRequests: 10, windowMs: 5000 },
    });
    await client.request({ method: 'GET', path: 'x' });
    expect(limiterAcquired).toBe(true);
  });

  it('passes signal to fetch', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = (
      _input,
      init,
    ) => {
      receivedSignal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    await client.request({ method: 'GET', path: 'x', signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('breaker predicate classifies HttpClientError 5xx as failure', async () => {
    // The breaker counts server errors (5xx) as failures.
    // Cause the breaker to open by hitting 5xx enough times.
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response('server error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
      circuitBreaker: { threshold: 1, timeout: 1000, resetTimeout: 5000 },
    });
    // First call should fail with HttpClientError 500 (breaker still closed).
    await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow('500');
  });

  it('HttpClientError carries text body for non-JSON error', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response('plain text error body', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    try {
      await client.request({ method: 'GET', path: 'fail' });
    } catch (err: unknown) {
      if (err instanceof HttpClientError) {
        expect(err.status).toEqual(400);
        expect(err.body).toBe('plain text error body');
        return;
      }
      throw err;
    }
    // unreachable
  });

  it('HttpClientError carries raw text for malformed-JSON error', async () => {
    const fetchImpl: (input: RequestInfo, init?: RequestInit) => Promise<Response> = () =>
      Promise.resolve(
        new Response('{ json: not valid', {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: fetchImpl,
    });
    try {
      await client.request({ method: 'GET', path: 'fail' });
    } catch (err: unknown) {
      if (err instanceof HttpClientError) {
        expect(err.status).toEqual(422);
        expect(err.body).toBe('{ json: not valid');
        return;
      }
      throw err;
    }
    // unreachable
  });
  it('parses a structured +json media type', async () => {
    // `application/problem+json` (RFC 7807) is JSON. A naive
    // `includes('application/json')` test missed every `+json` suffix and handed
    // the caller `undefined` data for a perfectly good body.
    for (const ct of ['application/problem+json', 'application/vnd.api+json']) {
      const client = new HttpClient({
        baseUrl: 'https://api.example.com',
        timing: fakeTiming,
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ ok: ct }), {
              status: 200,
              headers: { 'Content-Type': ct },
            }),
          ),
      });
      const res = await client.request<{ ok: string }>({ method: 'GET', path: 'x' });
      expect(res.data).toEqual({ ok: ct });
    }
  });

  it('parses JSON when the media type carries parameters and odd casing', async () => {
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
          }),
        ),
    });
    const res = await client.request<{ ok: boolean }>({ method: 'GET', path: 'x' });
    expect(res.data).toEqual({ ok: true });
  });

  it('does NOT parse a media type that merely ends in json without a + separator', async () => {
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      fetch: () =>
        Promise.resolve(
          new Response('not json', {
            status: 200,
            headers: { 'Content-Type': 'text/notjson' },
          }),
        ),
    });
    const res = await client.request({ method: 'GET', path: 'x' });
    expect(res.data).toBeUndefined();
  });

  it('rejects an absolute URL path so per-origin policy cannot be bypassed', async () => {
    const { client, calls } = buildClient();
    for (const path of ['https://evil.example.com/steal', 'http://evil.example.com/x']) {
      await expect(client.request({ method: 'GET', path })).rejects.toThrow(
        /must be relative/,
      );
    }
    // Nothing was ever dispatched.
    expect(calls.length).toBe(0);
  });

  it('rejects a scheme-relative path', async () => {
    const { client, calls } = buildClient();
    // `//evil.example.com/x` also leaves the configured origin. It is caught by
    // the leading-slash guard, so the message is that one.
    await expect(
      client.request({ method: 'GET', path: '//evil.example.com/x' }),
    ).rejects.toThrow(/must be relative/);
    expect(calls.length).toBe(0);
  });

  it('still accepts a relative path containing a colon in a later segment', async () => {
    // `users/a:b` is relative — the absolute-URL guard must not over-reject it.
    const { client, calls } = buildClient();
    await client.request({ method: 'GET', path: 'users/a:b' });
    expect(calls[0]!.url).toBe('https://api.example.com/users/a:b');
  });

  it('does not count a caller abort as a circuit-breaker failure', async () => {
    let calls = 0;
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      // threshold 1: if an abort counted, the circuit would open after the first.
      circuitBreaker: { threshold: 1, timeout: 10_000, resetTimeout: 10_000 },
      fetch: () => {
        calls++;
        if (calls <= 3) return Promise.reject(new DOMException('Aborted', 'AbortError'));
        return Promise.resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });

    for (let i = 0; i < 3; i++) {
      await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow('Aborted');
    }
    // Circuit is still closed — the request reaches fetch and succeeds.
    const res = await client.request<{ ok: boolean }>({ method: 'GET', path: 'x' });
    expect(res.data).toEqual({ ok: true });
    expect(calls).toBe(4);
  });

  it('recognises an abort by name even when it is not a DOMException', async () => {
    // A caller may abort with ANY reason. A custom/polyfilled abort reason carries
    // `name: 'AbortError'` without being a `DOMException`, so an
    // `instanceof DOMException` check would misclassify it as a dependency
    // failure and let cancellations trip the breaker.
    const abortLike = Object.assign(new Error('cancelled by caller'), { name: 'AbortError' });
    let calls = 0;
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      circuitBreaker: { threshold: 1, timeout: 10_000, resetTimeout: 10_000 },
      fetch: () => {
        calls++;
        if (calls <= 2) return Promise.reject(abortLike);
        return Promise.resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });

    for (let i = 0; i < 2; i++) {
      await expect(client.request({ method: 'GET', path: 'x' })).rejects.toThrow(
        'cancelled by caller',
      );
    }
    const res = await client.request<{ ok: boolean }>({ method: 'GET', path: 'x' });
    expect(res.data).toEqual({ ok: true });
  });

  it('counts a 5xx as a breaker failure but a 4xx as a user error', async () => {
    const respond = (status: number) => () =>
      Promise.resolve(
        new Response('{}', { status, headers: { 'Content-Type': 'application/json' } }),
      );

    // 4xx: many failures, circuit stays closed.
    const userErrClient = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      circuitBreaker: { threshold: 2, timeout: 10_000, resetTimeout: 10_000 },
      fetch: respond(404),
    });
    for (let i = 0; i < 5; i++) {
      await expect(userErrClient.request({ method: 'GET', path: 'x' })).rejects.toThrow(
        HttpClientError,
      );
    }

    // 5xx: the circuit opens once the threshold is reached.
    let serverCalls = 0;
    const serverErrClient = new HttpClient({
      baseUrl: 'https://api.example.com',
      timing: fakeTiming,
      circuitBreaker: { threshold: 2, timeout: 10_000, resetTimeout: 10_000 },
      fetch: () => {
        serverCalls++;
        return respond(503)();
      },
    });
    for (let i = 0; i < 2; i++) {
      await expect(serverErrClient.request({ method: 'GET', path: 'x' })).rejects.toThrow(
        HttpClientError,
      );
    }
    expect(serverCalls).toBe(2);
    await expect(serverErrClient.request({ method: 'GET', path: 'x' })).rejects.toThrow(
      ClientCircuitOpenError,
    );
    // Fail-fast: no further request was dispatched.
    expect(serverCalls).toBe(2);
  });
});
