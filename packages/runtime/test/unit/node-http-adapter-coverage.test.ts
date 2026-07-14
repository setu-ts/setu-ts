// deno-lint-ignore-file no-explicit-any require-await -- test fakes need these
/**
 * Additional unit tests for Node HTTP adapter to improve coverage.
 * Focuses on uncovered branches in the request listener body handling.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NodeHttpServerHandle } from '../../src/adapters/node/node-http-adapter.ts';
import type { IRequest, IResponse } from '@hono-enterprise/common';

/**
 * Creates a minimal IResponse mock for testing.
 */
function createMockResponse(body: string = 'OK', status = 200): IResponse {
  const state = {
    _status: status,
    _headers: new Headers(),
    _body: body as Uint8Array | string | null,
  };

  // @ts-ignore - test fake
  const mock: IResponse = {
    status: (code: number): IResponse => {
      state._status = code;
      return mock;
    },
    header: (name: string, value: string): IResponse => {
      state._headers.set(name, value);
      return mock;
    },
    appendHeader: (name: string, value: string): IResponse => {
      state._headers.append(name, value);
      return mock;
    },
    json: <T>(_body: T) => {
      return { __handlerResult: true } as any;
    },
    text: (_body: string) => {
      return { __handlerResult: true } as any;
    },
    send: (_body?: Uint8Array) => {
      return { __handlerResult: true } as any;
    },
    redirect: (_url: string, _status?: number) => {
      return { __handlerResult: true } as any;
    },
    snapshot: () => {
      return {
        status: state._status,
        headers: state._headers,
        body: state._body,
      };
    },
  };

  return mock;
}

describe('NodeHttpServerHandle - body handling coverage', () => {
  describe('createNodeRequestListener - chunk handling', () => {
    it('handles chunk with Buffer instance', async () => {
      let handlerCalled = false;
      const handler = async (_request: IRequest): Promise<IResponse> => {
        handlerCalled = true;
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      // Create a Buffer chunk (simulating Node.js behavior)
      const bufferChunk = Buffer.from('test data');

      // @ts-ignore - test fake
      const req = {
        method: 'POST',
        url: '/api',
        headers: {},
        socket: {},
        [Symbol.asyncIterator]() {
          return {
            next() {
              return { done: true, value: bufferChunk };
            },
          };
        },
      };

      // @ts-ignore - test fake
      const res = {
        statusCode: 200,
        setHeader: () => {},
        end: () => {},
      };

      await listener(req as any, res as any);

      expect(handlerCalled).toBe(true);
    });

    it('handles chunk without Buffer instance (Uint8Array)', async () => {
      let handlerCalled = false;
      const handler = async (_request: IRequest): Promise<IResponse> => {
        handlerCalled = true;
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      // Create a non-Buffer chunk (simulating Deno compatibility layer)
      const uint8Chunk = new Uint8Array([1, 2, 3, 4, 5]);

      // @ts-ignore - test fake
      const req = {
        method: 'POST',
        url: '/api',
        headers: {},
        socket: {},
        [Symbol.asyncIterator]() {
          return {
            next() {
              return { done: true, value: uint8Chunk };
            },
          };
        },
      };

      // @ts-ignore - test fake
      const res = {
        statusCode: 200,
        setHeader: () => {},
        end: () => {},
      };

      await listener(req as any, res as any);

      expect(handlerCalled).toBe(true);
    });

    it('handles multiple chunks', async () => {
      let handlerCalled = false;
      const handler = async (_request: IRequest): Promise<IResponse> => {
        handlerCalled = true;
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      const chunk1 = Buffer.from('part1');
      const chunk2 = new Uint8Array([65, 66, 67]); // ABC

      let callCount = 0;
      // @ts-ignore - test fake
      const req = {
        method: 'POST',
        url: '/api',
        headers: {},
        socket: {},
        [Symbol.asyncIterator]() {
          return {
            next() {
              callCount++;
              if (callCount === 1) {
                return { done: false, value: chunk1 };
              } else if (callCount === 2) {
                return { done: false, value: chunk2 };
              } else {
                return { done: true, value: undefined };
              }
            },
          };
        },
      };

      // @ts-ignore - test fake
      const res = {
        statusCode: 200,
        setHeader: () => {},
        end: () => {},
      };

      await listener(req as any, res as any);

      expect(handlerCalled).toBe(true);
    });

    it('handles empty body (no chunks)', async () => {
      let handlerCalled = false;
      const handler = async (_request: IRequest): Promise<IResponse> => {
        handlerCalled = true;
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      // @ts-ignore - test fake
      const req = {
        method: 'GET',
        url: '/api',
        headers: {},
        socket: {},
        [Symbol.asyncIterator]() {
          return {
            next() {
              return { done: true, value: undefined };
            },
          };
        },
      };

      // @ts-ignore - test fake
      const res = {
        statusCode: 200,
        setHeader: () => {},
        end: () => {},
      };

      await listener(req as any, res as any);

      expect(handlerCalled).toBe(true);
    });
  });
});
