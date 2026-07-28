/**
 * End-to-end test for generated client code against the REAL `HttpClient`.
 *
 * Builds the client via `createClient({ baseUrl, fetch })` with an injected
 * fake `fetch`, then invokes generated methods end-to-end. This proves the
 * generated client runs against the real client (not a hand-rolled fake) and
 * that generated paths are relative and correctly formatted.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createClient } from '../../src/index.ts';
import { createApi } from '../fixtures/generated-client.ts';
import type { ClientResponse } from '../../src/index.ts';

function makeFetch(
  handler: (req: Request) => Response | Promise<Response>,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return Promise.resolve(handler(req));
  };
}

describe('generated-client e2e', () => {
  it('calls a generated GET method through createClient with injected fetch', async () => {
    let lastUrl = '';
    let lastMethod = '';
    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: makeFetch((req) => {
        lastUrl = req.url;
        lastMethod = req.method;
        return new Response(JSON.stringify({ id: '1', name: 'Test User' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });

    const api = createApi(client);
    const resp: ClientResponse<{ id: string; name: string }> = await api.getuserbyid('1');

    expect(lastMethod).toBe('GET');
    // Path must be relative (no leading slash) — HttpClient rejects leading slash.
    expect(lastUrl).toBe('https://api.example.com/users/1');
    expect(resp.data).toEqual({ id: '1', name: 'Test User' });
  });

  it('forwards query params through generated code with relative path', async () => {
    let lastUrl = '';
    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: makeFetch((req) => {
        lastUrl = req.url;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });

    const api = createApi(client);
    const resp = await api.listusers({ page: 2, limit: 10 });

    expect(lastUrl).toBe('https://api.example.com/users?page=2&limit=10');
    expect(resp.data).toEqual([]);
  });

  it('propagates a non-2xx response as HttpClientError through generated code', async () => {
    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: makeFetch(() =>
        new Response(JSON.stringify({ detail: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
    });

    const api = createApi(client);
    await expect(api.getuserbyid('999')).rejects.toThrow();
  });
});
