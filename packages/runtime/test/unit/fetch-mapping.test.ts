/**
 * Tests for the shared web-standard request/response mapping.
 *
 * @module
 */

import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../../src/adapters/shared/fetch-mapping.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ResponseSnapshot } from '@hono-enterprise/common';

// ---------------------------------------------------------------------------
// mapWebRequestToFrameworkRequest — field mapping
// ---------------------------------------------------------------------------

describe('fetch-mapping | field mapping', () => {
  it('maps method, url, path, headers from a web Request', async () => {
    const body = JSON.stringify({ key: 'value' });
    const request = new Request('https://example.com/api/users?page=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'abc' },
      body,
    });

    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    expect(frameworkRequest.method).toBe('POST');
    expect(frameworkRequest.url).toBe('https://example.com/api/users?page=1');
    expect(frameworkRequest.path).toBe('/api/users');
    expect(frameworkRequest.headers.get('content-type')).toBe('application/json');
    expect(frameworkRequest.headers.get('x-custom')).toBe('abc');
  });

  it('forwards native Request.signal to IRequest.signal', async () => {
    const ac = new AbortController();
    const nativeReq = new Request('https://example.com/', { signal: ac.signal });
    const frameworkRequest = await mapWebRequestToFrameworkRequest(nativeReq);
    // Verify the signal property is present and is the same object
    expect(frameworkRequest.signal).toBeDefined();
    expect(frameworkRequest.signal?.aborted).toBe(false);
  });

  it('ip is undefined on the mapped request', async () => {
    const request = new Request('https://example.com/');
    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);
    expect(frameworkRequest.ip).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapWebRequestToFrameworkRequest — idempotent body access
// ---------------------------------------------------------------------------

describe('fetch-mapping | idempotent body access', () => {
  it('json(), text(), bytes() are idempotent', async () => {
    const body = JSON.stringify({ foo: 'bar' });
    const request = new Request('https://example.com/', {
      method: 'PUT',
      body,
    });

    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    const jsonResult = await frameworkRequest.json<{ foo: string }>();
    expect(jsonResult).toEqual({ foo: 'bar' });

    // Second call must still work
    const jsonResult2 = await frameworkRequest.json();
    expect(jsonResult2).toEqual({ foo: 'bar' });

    const textResult = await frameworkRequest.text();
    expect(textResult).toBe(body);

    const bytesResult = await frameworkRequest.bytes();
    const expectedBytes = new TextEncoder().encode(body);
    expect(bytesResult).toEqual(expectedBytes);

    // Third json call
    const jsonResult3 = await frameworkRequest.json();
    expect(jsonResult3).toEqual({ foo: 'bar' });
  });

  it('handles empty body', async () => {
    const request = new Request('https://example.com/', { method: 'GET' });
    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);

    expect(await frameworkRequest.text()).toBe('');
    expect(await frameworkRequest.bytes()).toEqual(new Uint8Array(0));
  });
});

// ---------------------------------------------------------------------------
// mapSnapshotToWebResponse — status, headers, body variants
// ---------------------------------------------------------------------------

describe('fetch-mapping | snapshot→Response', () => {
  it('with string body', () => {
    const headers = new Headers();
    headers.set('content-type', 'text/plain');

    const snapshot: ResponseSnapshot = { streaming: false, status: 200, headers, body: 'hello' };
    const response = mapSnapshotToWebResponse(snapshot);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('transfer-encoding')).toBeNull();
  });

  it('with Uint8Array body', () => {
    const headers = new Headers();
    const bytes = new Uint8Array([1, 2, 3]);

    const snapshot: ResponseSnapshot = { streaming: false, status: 200, headers, body: bytes };
    const response = mapSnapshotToWebResponse(snapshot);

    expect(response.status).toBe(200);
  });

  it('with null body', () => {
    const headers = new Headers();

    const snapshot: ResponseSnapshot = { streaming: false, status: 204, headers, body: null };
    const response = mapSnapshotToWebResponse(snapshot);

    expect(response.status).toBe(204);
  });

  it('preserves multiple headers', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');

    const snapshot: ResponseSnapshot = { streaming: false, status: 200, headers, body: null };
    const response = mapSnapshotToWebResponse(snapshot);

    expect(response.status).toBe(200);
  });

  // C2 test: multi-valued Set-Cookie headers must NOT be flattened
  it('preserves multiple Set-Cookie headers (C2)', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'access=xyz; Path=/; HttpOnly');
    headers.append('set-cookie', 'refresh=abc; Path=/auth; HttpOnly');
    headers.set('content-type', 'application/json');

    const snapshot: ResponseSnapshot = { streaming: false, status: 200, headers, body: '{}' };
    const response = mapSnapshotToWebResponse(snapshot);

    // Use getSetCookie() which returns an array of all Set-Cookie values
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBe(2);
    expect(cookies).toContain('access=xyz; Path=/; HttpOnly');
    expect(cookies).toContain('refresh=abc; Path=/auth; HttpOnly');
  });

  // M42: streaming snapshot passes ReadableStream through
  it('passes ReadableStream body through for streaming snapshots', async () => {
    const headers = new Headers();
    headers.set('content-type', 'text/event-stream');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
        controller.close();
      },
    });

    const snapshot: ResponseSnapshot = {
      streaming: true,
      status: 200,
      headers,
      body: stream,
    };
    const response = mapSnapshotToWebResponse(snapshot);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    // Verify the stream is readable and yields the expected chunk
    const reader = response.body!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual(new TextEncoder().encode('data: hello\n\n'));
    const { done: done2 } = await reader.read();
    expect(done2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: Request→IRequest→snapshot→Response round-trip
// ---------------------------------------------------------------------------

describe('fetch-mapping | full round-trip', () => {
  it('preserves method, headers, body', async () => {
    const body = '{"data":"test"}';
    const request = new Request('https://example.com/echo', {
      method: 'PATCH',
      headers: { 'X-Request-Id': '123' },
      body,
    });

    const frameworkRequest = await mapWebRequestToFrameworkRequest(request);
    const jsonBody = await frameworkRequest.json();
    expect(jsonBody).toEqual({ data: 'test' });

    const snapshot: ResponseSnapshot = {
      streaming: false,
      status: 201,
      headers: new Headers({ 'Location': '/echo/1' }),
      body: 'created',
    };

    const response = mapSnapshotToWebResponse(snapshot);
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/echo/1');
  });
});
