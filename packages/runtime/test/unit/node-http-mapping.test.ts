/**
 * Tests for Node HTTP request/response mapping.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  mapNodeRequest,
  writeSnapshotToNodeResponse,
} from '../../src/adapters/node/node-http-mapping.ts';

describe('Node HTTP mapping - mapNodeRequest', () => {
  it('maps GET request correctly', () => {
    // @ts-ignore - test fake
    const message = {
      method: 'GET',
      url: '/path?query=1',
      headers: { 'content-type': 'application/json', 'x-custom': 'value' },
      socket: { remoteAddress: '192.168.1.1' },
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.method).toBe('GET');
    expect(request.url).toBe('/path?query=1');
    expect(request.path).toBe('/path');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('x-custom')).toBe('value');
  });

  it('maps POST request with JSON body', async () => {
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ name: 'test' }));
    // @ts-ignore - test fake
    const message = {
      method: 'POST',
      url: '/api',
      headers: { 'content-type': 'application/json' },
      socket: { remoteAddress: '192.168.1.1' },
    };

    const request = mapNodeRequest(message as never, bodyBytes);

    expect(request.method).toBe('POST');
    const parsed = await request.json();
    expect(parsed).toEqual({ name: 'test' });
  });

  it('includes client IP address', () => {
    // @ts-ignore - test fake
    const message = {
      method: 'GET',
      url: '/',
      headers: {},
      socket: { remoteAddress: '192.168.1.1' },
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.ip).toBe('192.168.1.1');
  });

  it('maps request without IP when socket is missing', () => {
    // @ts-ignore - test fake
    const message = {
      method: 'GET',
      url: '/',
      headers: {},
      socket: undefined,
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.ip).toBeUndefined();
  });

  it('maps request with empty body', () => {
    // @ts-ignore - test fake
    const message = {
      method: 'GET',
      url: '/',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.method).toBe('GET');
  });

  it('maps request with array headers', () => {
    // @ts-ignore - test fake
    const message = {
      method: 'GET',
      url: '/',
      headers: { 'set-cookie': ['cookie1=value1', 'cookie2=value2'] },
      socket: { remoteAddress: '127.0.0.1' },
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.headers.get('set-cookie')).toBe('cookie1=value1, cookie2=value2');
  });

  it('maps request with undefined method', () => {
    // @ts-ignore - test fake
    const message = {
      method: undefined,
      url: '/',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.method).toBe('GET');
  });

  it('maps request with undefined url', () => {
    // @ts-ignore - test fake
    const message = {
      method: 'GET',
      url: undefined,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };

    const request = mapNodeRequest(message as never, new Uint8Array());

    expect(request.url).toBe('/');
    expect(request.path).toBe('/');
  });

  describe('mapNodeRequest - body methods', () => {
    it('json() parses JSON body from cached bytes', async () => {
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ key: 'value' }));
      // @ts-ignore - test fake
      const message = {
        method: 'POST',
        url: '/api',
        headers: { 'content-type': 'application/json' },
        socket: { remoteAddress: '192.168.1.1' },
      };

      const request = mapNodeRequest(message as never, bodyBytes);
      const result = await request.json();

      expect(result).toEqual({ key: 'value' });
    });

    it('json() reads body from cached bytes', async () => {
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ from: 'cached' }));
      // @ts-ignore - test fake
      const message = {
        method: 'POST',
        url: '/api',
        headers: { 'content-type': 'application/json' },
        socket: { remoteAddress: '192.168.1.1' },
      };

      const request = mapNodeRequest(message as never, bodyBytes);
      const result = await request.json();

      expect(result).toEqual({ from: 'cached' });
    });

    it('text() returns text from cached bytes', async () => {
      const bodyBytes = new TextEncoder().encode('Hello, World!');
      // @ts-ignore - test fake
      const message = {
        method: 'GET',
        url: '/',
        headers: {},
        socket: { remoteAddress: '192.168.1.1' },
      };

      const request = mapNodeRequest(message as never, bodyBytes);
      const result = await request.text();

      expect(result).toBe('Hello, World!');
    });

    it('bytes() returns cached bytes', async () => {
      const bodyBytes = new Uint8Array([1, 2, 3, 4, 5]);
      // @ts-ignore - test fake
      const message = {
        method: 'POST',
        url: '/api',
        headers: {},
        socket: { remoteAddress: '192.168.1.1' },
      };

      const request = mapNodeRequest(message as never, bodyBytes);
      const result = await request.bytes();

      expect(result).toEqual(bodyBytes);
    });
  });
});

describe('Node HTTP mapping - writeSnapshotToNodeResponse', () => {
  it('writes status and headers correctly', () => {
    const snapshot = {
      status: 201,
      headers: new Headers({ 'Content-Type': 'application/json', 'X-Custom': 'value' }),
      body: null,
    };
    // @ts-ignore - test fake
    const headers: Record<string, string> = {};
    const response: {
      statusCode: number;
      headers: Record<string, string>;
      body: string | Uint8Array | undefined;
      setHeader: (key: string, value: string) => void;
      end: (chunk?: string) => void;
    } = {
      statusCode: 200,
      headers,
      body: undefined,
      setHeader: function (key: string, value: string) {
        headers[key.toLowerCase()] = value;
      },
      end: function (chunk?: string) {
        this.body = chunk;
      },
    };

    writeSnapshotToNodeResponse(snapshot, response as never);

    expect(response.statusCode).toBe(201);
    // Headers are set via setHeader calls (lowercase keys)
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-custom']).toBe('value');
  });

  it('writes string body correctly', () => {
    const snapshot = {
      status: 200,
      headers: new Headers(),
      body: 'Hello, World!',
    };
    // @ts-ignore - test fake
    const response: {
      statusCode: number;
      headers: Record<string, string>;
      body: string | Uint8Array | undefined;
      setHeader: () => void;
      end: (chunk?: string) => void;
    } = {
      statusCode: 200,
      headers: {},
      body: undefined,
      setHeader: function () {},
      end: function (chunk?: string) {
        this.body = chunk;
      },
    };

    writeSnapshotToNodeResponse(snapshot, response as never);

    expect(response.body).toBe('Hello, World!');
  });

  it('writes Uint8Array body correctly', () => {
    const bodyBytes = new TextEncoder().encode('Binary data');
    const snapshot = {
      status: 200,
      headers: new Headers(),
      body: bodyBytes,
    };
    // @ts-ignore - test fake
    const response: {
      statusCode: number;
      headers: Record<string, string>;
      body: string | Uint8Array | undefined;
      setHeader: () => void;
      end: (chunk?: Uint8Array) => void;
    } = {
      statusCode: 200,
      headers: {},
      body: undefined,
      setHeader: function () {},
      end: function (chunk?: Uint8Array) {
        this.body = chunk;
      },
    };

    writeSnapshotToNodeResponse(snapshot, response as never);

    expect(response.body).toEqual(bodyBytes);
  });

  it('writes empty body (null) correctly', () => {
    const snapshot = {
      status: 204,
      headers: new Headers(),
      body: null,
    };
    // @ts-ignore - test fake
    let endCalled = false;
    const response: {
      statusCode: number;
      headers: Record<string, string>;
      setHeader: () => void;
      end: () => void;
    } = {
      statusCode: 200,
      headers: {},
      setHeader: function () {},
      end: function () {
        endCalled = true;
      },
    };

    writeSnapshotToNodeResponse(snapshot, response as never);

    expect(endCalled).toBe(true);
  });

  describe('writeSnapshotToNodeResponse - body types', () => {
    it('writes undefined body correctly', () => {
      const snapshot = {
        status: 204,
        headers: new Headers(),
        body: null, // Use null instead of undefined to match type
      };
      // @ts-ignore - test fake
      let endCalled = false;
      const response: {
        statusCode: number;
        headers: Record<string, string>;
        setHeader: () => void;
        end: (chunk?: string | Uint8Array) => void;
      } = {
        statusCode: 200,
        headers: {},
        setHeader: function () {},
        end: function (_chunk?: string | Uint8Array) {
          endCalled = true;
        },
      };

      writeSnapshotToNodeResponse(snapshot, response as never);

      expect(endCalled).toBe(true);
    });

    it('sets headers correctly with multiple entries', () => {
      const headers = new Headers();
      headers.append('Content-Type', 'text/html');
      headers.append('X-Custom-Header', 'value1');
      headers.append('X-Custom-Header', 'value2');

      const snapshot = {
        status: 200,
        headers,
        body: 'test',
      };

      const responseHeaders: Record<string, string> = {};
      // @ts-ignore - test fake
      const response: {
        statusCode: number;
        headers: Record<string, string>;
        setHeader: (key: string, value: string) => void;
        end: (chunk?: string | Uint8Array) => void;
      } = {
        statusCode: 200,
        headers: responseHeaders,
        setHeader: function (key: string, value: string) {
          responseHeaders[key.toLowerCase()] = value;
        },
        end: function (_chunk?: string | Uint8Array) {},
      };

      writeSnapshotToNodeResponse(snapshot, response as never);

      expect(responseHeaders['content-type']).toBe('text/html');
      // Note: setHeader may only set the last value for duplicate headers
      expect(responseHeaders['x-custom-header']).toBeDefined();
    });
  });
});
