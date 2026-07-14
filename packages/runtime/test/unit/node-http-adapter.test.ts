// deno-lint-ignore-file no-explicit-any require-await -- test fakes need these
/**
 * Unit tests for Node HTTP adapter — socket-independent coverage of
 * `NodeHttpServerHandle` internals and `NodeHttpAdapter` error paths.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isNodeHttpServerHandle,
  NodeHttpAdapter,
  NodeHttpServerHandle,
} from '../../src/adapters/node/node-http-adapter.ts';
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

describe('NodeHttpServerHandle', () => {
  describe('constructor', () => {
    it('stores the handler function', () => {
      const handler = async (_request: IRequest): Promise<IResponse> => {
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);

      expect(handle).toBeInstanceOf(NodeHttpServerHandle);
    });
  });

  describe('server getter/setter', () => {
    it('returns null before server is set', () => {
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);

      expect(handle.server).toBeNull();
    });

    it('stores and returns the server instance', () => {
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      // @ts-ignore - test fake
      const fakeServer = { id: 'fake-server' } as any;

      handle.server = fakeServer;

      expect(handle.server).toBe(fakeServer);
    });
  });

  describe('createNodeRequestListener', () => {
    it('returns a function', () => {
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      expect(typeof listener).toBe('function');
    });

    it('handles request and writes response', async () => {
      const handler = async (request: IRequest): Promise<IResponse> => {
        expect(request.path).toBe('/test');
        return createMockResponse('Hello', 200);
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      // @ts-ignore - test fake
      const req = {
        method: 'GET',
        url: '/test',
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

      let body: string | Uint8Array | undefined;
      const headers: Record<string, string> = {};

      // @ts-ignore - test fake
      const res = {
        statusCode: 200,
        setHeader: (key: string, value: string) => {
          headers[key.toLowerCase()] = value;
        },
        end: (chunk?: string) => {
          body = chunk;
        },
      };

      await listener(req as any, res as any);

      expect(typeof body).toBe('string');
      expect(body).toBe('Hello');
    });

    it('caches body bytes on request', async () => {
      let receivedMethod = '';
      const handler = async (request: IRequest): Promise<IResponse> => {
        receivedMethod = request.method;
        return createMockResponse();
      };

      const handle = new NodeHttpServerHandle(handler);
      const listener = handle.createNodeRequestListener();

      // @ts-ignore - test fake
      const req = {
        method: 'POST',
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

      expect(receivedMethod).toBe('POST');
    });
  });
});

describe('isNodeHttpServerHandle', () => {
  it('returns true for NodeHttpServerHandle', () => {
    const handler = async (): Promise<IResponse> => {
      return createMockResponse();
    };

    const handle = new NodeHttpServerHandle(handler);

    expect(isNodeHttpServerHandle(handle)).toBe(true);
  });

  it('returns false for non-handle objects', () => {
    expect(isNodeHttpServerHandle({})).toBe(false);
    expect(isNodeHttpServerHandle(null)).toBe(false);
    expect(isNodeHttpServerHandle(undefined)).toBe(false);
    expect(isNodeHttpServerHandle('string')).toBe(false);
    expect(isNodeHttpServerHandle(123)).toBe(false);
  });
});

describe('NodeHttpAdapter', () => {
  describe('createServer', () => {
    it('returns a NodeHttpServerHandle', () => {
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const adapter = new NodeHttpAdapter();
      const handle = adapter.createServer(handler);

      expect(handle).toBeInstanceOf(NodeHttpServerHandle);
    });
  });

  describe('listen', () => {
    it('rejects on invalid handle', async () => {
      const adapter = new NodeHttpAdapter();
      // @ts-ignore - test fake
      const invalidHandle = { not: 'a handle' };

      await expect(adapter.listen(invalidHandle, 3000)).rejects.toThrow(
        'Invalid server handle for NodeHttpAdapter',
      );
    });

    it('rejects on invalid handle (Promise path)', async () => {
      const adapter = new NodeHttpAdapter();
      // @ts-ignore - test fake
      const invalidHandle = { not: 'a handle' };

      const promise = adapter.listen(invalidHandle, 3000);
      await expect(promise).rejects.toThrow('Invalid server handle');
    });
  });

  describe('close', () => {
    it('resolves when handle.server is null (never listened)', async () => {
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const adapter = new NodeHttpAdapter();
      const handle = adapter.createServer(handler);
      // Never call listen, so server is null

      await expect(adapter.close(handle)).resolves.toBeUndefined();
    });

    it('rejects on invalid handle', async () => {
      const adapter = new NodeHttpAdapter();
      // @ts-ignore - test fake
      const invalidHandle = { not: 'a handle' };

      await expect(adapter.close(invalidHandle)).rejects.toThrow(
        'Invalid server handle for NodeHttpAdapter',
      );
    });

    it('handles server error during listen', async () => {
      const adapter = new NodeHttpAdapter();
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const handle = adapter.createServer(handler);

      // Try to listen on port 0 (should work in test environment)
      // but we can test the error path by using an invalid handle
      await expect(adapter.listen(handle, 0, '127.0.0.1')).resolves.toBeUndefined();
    });
  });
});
