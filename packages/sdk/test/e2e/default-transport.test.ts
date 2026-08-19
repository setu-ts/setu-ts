/**
 * End-to-end test of the SDK's **default** transport (M70e §3.2).
 *
 * Starts a real `Deno.serve` on an unused loopback port and drives a
 * **default** client — no injected `fetch`, no injected `timing` — against it.
 * This is the first test in the package to make a real network request: the
 * existing `http-client.test.ts` injects a fake `fetch`, which is precisely
 * why it can never see the receiver defect this milestone fixes (X11-1). The
 * unit `fetch-receiver.test.ts` reproduces the browser's receiver rule; this
 * file proves the default actually reaches a network end to end.
 *
 * @module
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createClient } from '../../src/sdk.ts';
import { HttpClientError } from '../../src/errors.ts';

let server: ReturnType<typeof Deno.serve> | undefined;
let baseUrl = '';

/** A JSON API that echoes the method and body, and 500s on `/boom`. */
async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/boom') {
    return Response.json({ error: 'boom' }, { status: 500 });
  }
  if (url.pathname === '/echo') {
    const body = request.method === 'GET' ? undefined : (await request.json());
    return Response.json({ method: request.method, body }, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return Response.json({ hello: 'world' }, { status: 200 });
}

describe('default transport (real socket)', () => {
  afterEach(() => {
    if (server) {
      server.shutdown();
      server = undefined;
    }
  });

  function startServer(): void {
    server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler);
    baseUrl = `http://127.0.0.1:${server.addr.port}`;
  }

  it('performs a GET with the default client and reads a typed body', async () => {
    await startServer();
    const client = createClient({ baseUrl });

    const response = await client.request<{ hello: string }>({
      method: 'GET',
      path: 'users/123',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ hello: 'world' });
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('performs a POST with a JSON body and reads the echo back', async () => {
    await startServer();
    const client = createClient({ baseUrl });

    const response = await client.request<{ method: string; body: { name: string } }>({
      method: 'POST',
      path: 'echo',
      json: { name: 'setu' },
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ method: 'POST', body: { name: 'setu' } });
  });

  it('surfaces a non-2xx as HttpClientError with the parsed body', async () => {
    await startServer();
    const client = createClient({ baseUrl });

    let thrown: unknown;
    try {
      await client.request({ method: 'GET', path: 'boom' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpClientError);
    const error = thrown as HttpClientError;
    expect(error.status).toBe(500);
    expect(error.body).toEqual({ error: 'boom' });
  });
});
