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
import { createApi as createParamsApi } from '../fixtures/params-client.ts';
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
    const resp: ClientResponse<{ id: string; name: string }> = await api.getUserById('1');

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
    const resp = await api.listUsers({ page: 2, limit: 10 });

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
    await expect(api.getUserById('999')).rejects.toThrow();
  });

  it('substitutes a path placeholder that shares a segment with literal text', async () => {
    let lastUrl = '';
    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: makeFetch((req) => {
        lastUrl = req.url;
        return new Response(JSON.stringify({ size: 12 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });

    const api = createParamsApi(client);
    // `/tenants/{tenantId}/files/{fileId}.json` — the second placeholder is not a
    // whole segment, and used to be emitted as the literal text `{fileId}.json`.
    const resp = await api.downloadFileMetadata('acme', 'report 1');

    expect(lastUrl).toBe('https://api.example.com/tenants/acme/files/report%201.json');
    expect(resp.data).toEqual({ size: 12 });
  });

  it('stringifies a non-string header and omits an unset optional header', async () => {
    let headerNames: string[] = [];
    let retryCount: string | null = null;
    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: makeFetch((req) => {
        headerNames = [...req.headers.keys()];
        retryCount = req.headers.get('x-retry-count');
        return new Response(null, { status: 204 });
      }),
    });

    const api = createParamsApi(client);
    // `X-Retry-Count` has an `integer` schema; only it is supplied.
    await api.pingService({ xRetryCount: 3 });

    expect(retryCount).toBe('3');
    expect(headerNames).not.toContain('x-api-key');
  });

  it('sends a required query parameter and required JSON body', async () => {
    let lastUrl = '';
    let lastBody = '';
    let contentType: string | null = null;
    const client = createClient({
      baseUrl: 'https://api.example.com',
      fetch: makeFetch(async (req) => {
        lastUrl = req.url;
        contentType = req.headers.get('content-type');
        lastBody = await req.text();
        return new Response(JSON.stringify({ id: 'u1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    });

    const api = createParamsApi(client);
    // `opts` is REQUIRED here because both `format` and the body are required.
    const resp = await api.createReport({ format: 'csv', body: { id: 'u1', age: 30 } });

    expect(lastUrl).toBe('https://api.example.com/reports?format=csv');
    expect(contentType).toBe('application/json');
    expect(JSON.parse(lastBody)).toEqual({ id: 'u1', age: 30 });
    expect(resp.data).toEqual({ id: 'u1' });
  });
});
