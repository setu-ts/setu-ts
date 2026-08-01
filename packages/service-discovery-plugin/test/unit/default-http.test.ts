/**
 * Unit tests for the default `fetch`-backed HTTP seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createDefaultDiscoveryHttp } from '../../src/http/default-http.ts';

/** Records what `fetch` was called with and answers with a canned response. */
function recordingFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createDefaultDiscoveryHttp — request', () => {
  it('passes method, headers, and body through and maps the response', async () => {
    const { fetchImpl, calls } = recordingFetch(
      new Response('{"ok":1}', { status: 200, headers: { 'X-Consul-Index': '42' } }),
    );
    const http = createDefaultDiscoveryHttp(fetchImpl);

    const result = await http.request('http://consul:8500/v1/health/service/billing', {
      method: 'PUT',
      headers: { 'X-Consul-Token': 'secret' },
      body: '{"Name":"orders"}',
    });

    expect(calls[0].url).toBe('http://consul:8500/v1/health/service/billing');
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].init?.body).toBe('{"Name":"orders"}');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.text).toBe('{"ok":1}');
    expect(result.headers.get('X-Consul-Index')).toBe('42');
  });

  it('maps a non-2xx to ok: false without throwing', async () => {
    const { fetchImpl } = recordingFetch(new Response('gone', { status: 410 }));
    const http = createDefaultDiscoveryHttp(fetchImpl);

    const result = await http.request('http://api/x');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(410);
    expect(result.text).toBe('gone');
  });

  it('threads an AbortSignal down to fetch', async () => {
    const { fetchImpl, calls } = recordingFetch(new Response('[]'));
    const http = createDefaultDiscoveryHttp(fetchImpl);
    const controller = new AbortController();

    await http.request('http://api/x', { signal: controller.signal });
    expect(calls[0].init?.signal).toBe(controller.signal);
  });
});

describe('createDefaultDiscoveryHttp — stream', () => {
  it('exposes the body without reading it', async () => {
    const { fetchImpl } = recordingFetch(new Response('line\n', { status: 200 }));
    const http = createDefaultDiscoveryHttp(fetchImpl);

    const result = await http.stream('http://api/watch');
    expect(result.ok).toBe(true);
    expect(result.body).not.toBeNull();

    const text = await new Response(result.body).text();
    expect(text).toBe('line\n');
  });

  it('yields body: null for a bodiless response', async () => {
    const { fetchImpl } = recordingFetch(new Response(null, { status: 204 }));
    const http = createDefaultDiscoveryHttp(fetchImpl);

    const result = await http.stream('http://api/watch');
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });

  it('maps a non-2xx stream response to ok: false', async () => {
    const { fetchImpl } = recordingFetch(new Response('expired', { status: 410 }));
    const http = createDefaultDiscoveryHttp(fetchImpl);

    const result = await http.stream('http://api/watch');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(410);
  });
});
