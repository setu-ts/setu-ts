/**
 * Tests for `createDefaultNotificationHttp` — fetch-backed `INotificationHttp`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDefaultNotificationHttp } from '../../src/http/default-http.ts';

describe('createDefaultNotificationHttp', () => {
  it('issues a POST with body and headers, maps response to {ok, status, text}', async () => {
    let actualUrl = '';
    let actualMethod = '';
    const actualHeaders: Record<string, string> = {};
    let actualBody = '';
    let actualText = 'result-text';

    const mockFetch = (url: string, init?: RequestInit): Promise<Response> => {
      actualUrl = url;
      actualMethod = init?.method ?? 'GET';
      Object.assign(actualHeaders, init?.headers as Record<string, string> ?? {});
      actualBody = init?.body as string;
      actualText = 'result-text';
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(actualText),
      } as Response);
    };

    const http = createDefaultNotificationHttp(mockFetch as unknown as typeof fetch);

    const result = await http.post(
      'https://example.com/api',
      '{"key":"val"}',
      { 'X-Custom': 'abc', 'Content-Type': 'application/json' },
    );

    expect(actualUrl).toBe('https://example.com/api');
    expect(actualMethod).toBe('POST');
    expect(actualHeaders['X-Custom']).toBe('abc');
    expect(actualHeaders['Content-Type']).toBe('application/json');
    expect(actualBody).toBe('{"key":"val"}');
    expect(result).toEqual({ ok: true, status: 200, text: 'result-text' });
  });

  it('maps non-OK response correctly', async () => {
    const mockFetch = (): Response => ({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server Error'),
    } as Response);

    const http = createDefaultNotificationHttp(mockFetch as unknown as typeof fetch);

    const result = await http.post(
      'https://example.com/api',
      '{}',
      { 'Content-Type': 'application/json' },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.text).toBe('Server Error');
  });
});
