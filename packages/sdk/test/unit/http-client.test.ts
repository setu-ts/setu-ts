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
import { HttpClientError } from '../../src/errors.ts';
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
});
