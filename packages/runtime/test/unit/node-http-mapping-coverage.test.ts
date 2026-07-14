// deno-lint-ignore-file no-explicit-any -- test fakes need these
/**
 * Additional unit tests for Node HTTP mapping to improve coverage.
 * Focuses on uncovered branches in `readBodyAsBytes` and `writeSnapshotToNodeResponse`.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  mapNodeRequest,
  writeSnapshotToNodeResponse,
} from '../../src/adapters/node/node-http-mapping.ts';

describe('Node HTTP mapping - writeSnapshotToNodeResponse coverage', () => {
  describe('body handling', () => {
    it('writes null body correctly', () => {
      const snapshot = {
        status: 204,
        headers: new Headers(),
        body: null,
      };
      // @ts-ignore - test fake
      let endCalled = false;
      const response = {
        statusCode: 200,
        setHeader: () => {},
        end: function () {
          endCalled = true;
        },
      };

      writeSnapshotToNodeResponse(snapshot, response as any);

      expect(endCalled).toBe(true);
    });

    it('writes undefined body correctly', () => {
      const snapshot = {
        status: 204,
        headers: new Headers(),
        body: undefined as any,
      };
      // @ts-ignore - test fake
      let endCalled = false;
      const response = {
        statusCode: 200,
        setHeader: () => {},
        end: function () {
          endCalled = true;
        },
      };

      writeSnapshotToNodeResponse(snapshot, response as any);

      expect(endCalled).toBe(true);
    });

    it('writes string body correctly', () => {
      const snapshot = {
        status: 200,
        headers: new Headers(),
        body: 'Hello, World!',
      };
      // @ts-ignore - test fake
      let endBody: string | Uint8Array | undefined;
      const response = {
        statusCode: 200,
        setHeader: () => {},
        end: function (chunk?: string | Uint8Array) {
          endBody = chunk;
        },
      };

      writeSnapshotToNodeResponse(snapshot, response as any);

      expect(endBody).toBe('Hello, World!');
    });

    it('writes Uint8Array body correctly', () => {
      const bodyBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const snapshot = {
        status: 200,
        headers: new Headers(),
        body: bodyBytes,
      };
      // @ts-ignore - test fake
      let endBody: string | Uint8Array | undefined;
      const response = {
        statusCode: 200,
        setHeader: () => {},
        end: function (chunk?: string | Uint8Array) {
          endBody = chunk;
        },
      };

      writeSnapshotToNodeResponse(snapshot, response as any);

      expect(endBody).toEqual(bodyBytes);
    });

    it('sets status code correctly', () => {
      const snapshot = {
        status: 404,
        headers: new Headers(),
        body: null,
      };
      // @ts-ignore - test fake
      const response = {
        statusCode: 200,
        setHeader: () => {},
        end: () => {},
      };

      writeSnapshotToNodeResponse(snapshot, response as any);

      expect(response.statusCode).toBe(404);
    });

    it('sets multiple headers correctly', () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      headers.set('X-Custom-Header', 'value');

      const snapshot = {
        status: 200,
        headers,
        body: null,
      };

      const responseHeaders: Record<string, string> = {};
      // @ts-ignore - test fake
      const response = {
        statusCode: 200,
        setHeader: function (key: string, value: string) {
          responseHeaders[key.toLowerCase()] = value;
        },
        end: () => {},
      };

      writeSnapshotToNodeResponse(snapshot, response as any);

      expect(responseHeaders['content-type']).toBe('application/json');
      expect(responseHeaders['x-custom-header']).toBe('value');
    });
  });

  describe('mapNodeRequest - edge cases', () => {
    it('handles request without IP address', () => {
      // @ts-ignore - test fake
      const message = {
        method: 'GET',
        url: '/',
        headers: {},
        socket: { remoteAddress: undefined },
      };

      const request = mapNodeRequest(message as any, new Uint8Array([]));

      expect(request.ip).toBeUndefined();
    });

    it('handles request with undefined socket', () => {
      // @ts-ignore - test fake
      const message = {
        method: 'GET',
        url: '/',
        headers: {},
        socket: undefined,
      };

      const request = mapNodeRequest(message as any, new Uint8Array([]));

      expect(request.ip).toBeUndefined();
    });
  });
});
