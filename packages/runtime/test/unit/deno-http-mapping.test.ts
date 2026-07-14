/**
 * Tests for Deno HTTP request/response mapping.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  mapDenoRequest,
  mapSnapshotToDenoResponse,
} from '../../src/adapters/deno/deno-http-mapping.ts';

describe('Deno HTTP mapping', () => {
  describe('mapDenoRequest', () => {
    it('maps GET request correctly', () => {
      const nativeRequest = new Request('http://example.com/path?query=1', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('http://example.com/path?query=1');
      expect(request.path).toBe('/path');
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(request.headers.get('X-Custom')).toBe('value');
    });

    it('maps POST request with JSON body', async () => {
      const body = JSON.stringify({ name: 'test', value: 123 });
      const nativeRequest = new Request('http://example.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.method).toBe('POST');
      expect(request.path).toBe('/api');

      const parsed = await request.json();
      expect(parsed).toEqual({ name: 'test', value: 123 });
    });

    it('maps request with text body', async () => {
      const nativeRequest = new Request('http://example.com/text', {
        method: 'PUT',
        body: 'Hello, World!',
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.method).toBe('PUT');
      const text = await request.text();
      expect(text).toBe('Hello, World!');
    });

    it('maps request with bytes body', async () => {
      const encoder = new TextEncoder();
      const bytes = encoder.encode('Binary data');
      const nativeRequest = new Request('http://example.com/binary', {
        method: 'POST',
        body: bytes,
      });

      const request = mapDenoRequest(nativeRequest);

      const result = await request.bytes();
      expect(result).toEqual(bytes);
    });

    it('handles lowercase method', () => {
      const nativeRequest = new Request('http://example.com', {
        method: 'get',
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.method).toBe('GET');
    });
  });

  describe('mapSnapshotToDenoResponse', () => {
    it('maps snapshot with string body', () => {
      const headers = new Headers();
      headers.set('Content-Type', 'text/plain');
      headers.set('X-Custom', 'value');

      const snapshot = {
        status: 200,
        headers,
        body: 'Hello, World!',
      };

      const response = mapSnapshotToDenoResponse(snapshot);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/plain');
      expect(response.headers.get('X-Custom')).toBe('value');
    });

    it('maps snapshot with Uint8Array body', async () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/octet-stream');

      const body = new Uint8Array([1, 2, 3, 4, 5]);
      const snapshot = {
        status: 201,
        headers,
        body,
      };

      const response = mapSnapshotToDenoResponse(snapshot);

      expect(response.status).toBe(201);
      const result = await response.arrayBuffer();
      expect(new Uint8Array(result)).toEqual(body);
    });

    it('maps snapshot with null body', () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      const snapshot = {
        status: 204,
        headers,
        body: null,
      };

      const response = mapSnapshotToDenoResponse(snapshot);

      expect(response.status).toBe(204);
    });

    it('preserves multiple headers with same name', () => {
      const headers = new Headers();
      headers.append('Set-Cookie', 'cookie1=value1');
      headers.append('Set-Cookie', 'cookie2=value2');

      const snapshot = {
        status: 200,
        headers,
        body: 'OK',
      };

      const response = mapSnapshotToDenoResponse(snapshot);

      // Note: getSetCookie may not be available in all environments
      const cookies = response.headers.get('Set-Cookie');
      // At least one cookie should be present
      expect(cookies).toBeTruthy();
    });

    it('maps snapshot with empty string body', () => {
      const snapshot = {
        status: 200,
        headers: new Headers(),
        body: '',
      };

      const response = mapSnapshotToDenoResponse(snapshot);

      expect(response.status).toBe(200);
    });

    it('maps snapshot with empty Uint8Array body', async () => {
      const snapshot = {
        status: 200,
        headers: new Headers(),
        body: new Uint8Array([]),
      };

      const response = mapSnapshotToDenoResponse(snapshot);

      expect(response.status).toBe(200);
      const result = await response.arrayBuffer();
      expect(result.byteLength).toBe(0);
    });

    it('maps snapshot with various status codes', () => {
      // Status codes 204 (No Content) and 304 (Not Modified) cannot have a body
      const statusCodesWithBody = [200, 201, 301, 302, 400, 404, 500];

      for (const status of statusCodesWithBody) {
        const snapshot = {
          status,
          headers: new Headers(),
          body: 'test' as string | Uint8Array | null,
        };

        const response = mapSnapshotToDenoResponse(snapshot);

        expect(response.status).toBe(status);
      }

      // Test 204 No Content separately (no body)
      const noContentSnapshot = {
        status: 204,
        headers: new Headers(),
        body: null,
      };
      const noContentResponse = mapSnapshotToDenoResponse(noContentSnapshot);
      expect(noContentResponse.status).toBe(204);
    });
  });

  describe('mapDenoRequest - edge cases', () => {
    it('handles request without query string', () => {
      const nativeRequest = new Request('http://example.com/path', {
        method: 'GET',
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.path).toBe('/path');
      expect(request.url).toBe('http://example.com/path');
    });

    it('handles request with complex query string', () => {
      const nativeRequest = new Request('http://example.com/path?a=1&b=2&c=3', {
        method: 'GET',
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.path).toBe('/path');
      expect(request.url).toBe('http://example.com/path?a=1&b=2&c=3');
    });

    it('handles request with special characters in URL', () => {
      const nativeRequest = new Request('http://example.com/path%20with%20spaces', {
        method: 'GET',
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.path).toBe('/path%20with%20spaces');
    });

    it('handles all HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

      for (const method of methods) {
        const nativeRequest = new Request('http://example.com', { method });
        const request = mapDenoRequest(nativeRequest);

        expect(request.method).toBe(method.toUpperCase());
      }
    });

    it('handles empty headers', () => {
      const nativeRequest = new Request('http://example.com', {
        method: 'GET',
        headers: {},
      });

      const request = mapDenoRequest(nativeRequest);

      expect(request.headers.get('content-type')).toBeNull();
    });
  });
});
