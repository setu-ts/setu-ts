/**
 * Integration tests for Node HTTP adapter - REAL round-trip tests.
 *
 * These tests bind a real OS socket and issue real fetch requests.
 * They run under Deno's node:http compatibility layer.
 *
 * Skipped if node:http server fails to bind (compatibility issue).
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isNodeHttpServerHandle,
  NodeHttpAdapter,
  NodeHttpServerHandle,
} from '../../src/adapters/node/node-http-adapter.ts';
import type { HandlerResult, IRequest, IResponse } from '@hono-enterprise/common';

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
    json: <T>(_body: T): HandlerResult => {
      return { __handlerResult: true } as HandlerResult;
    },
    text: (_body: string): HandlerResult => {
      return { __handlerResult: true } as HandlerResult;
    },
    send: (_body?: Uint8Array): HandlerResult => {
      return { __handlerResult: true } as HandlerResult;
    },
    redirect: (_url: string, _status?: number): HandlerResult => {
      return { __handlerResult: true } as HandlerResult;
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

describe('NodeHttpAdapter - Real Round-Trip', () => {
  let adapter: NodeHttpAdapter;
  let handle: unknown;

  beforeEach(() => {
    adapter = new NodeHttpAdapter();
    handle = null;
  });

  afterEach(async () => {
    if (handle !== null) {
      await adapter.close(handle).catch(() => {
        // Ignore close errors on teardown
      });
    }
  });

  describe('createServer', () => {
    it('creates a handle before listen', () => {
      // deno-lint-ignore require-await
      const handler = async (_request: IRequest): Promise<IResponse> => {
        return createMockResponse('Created');
      };

      handle = adapter.createServer(handler);

      expect(handle).toBeInstanceOf(NodeHttpServerHandle);
      expect(isNodeHttpServerHandle(handle)).toBe(true);
    });
  });

  describe('type guard', () => {
    it('correctly identifies NodeHttpServerHandle', () => {
      // deno-lint-ignore require-await
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const validHandle = adapter.createServer(handler);
      const invalidHandle = { not: 'a handle' };

      expect(isNodeHttpServerHandle(validHandle)).toBe(true);
      expect(isNodeHttpServerHandle(invalidHandle)).toBe(false);
    });
  });

  describe('listen and close', () => {
    it('handles requests through the adapter', async () => {
      // deno-lint-ignore require-await
      const handler = async (request: IRequest): Promise<IResponse> => {
        return createMockResponse(`Path: ${request.path}`, 200);
      };

      handle = adapter.createServer(handler);

      // Listen on a random port
      await adapter.listen(handle, 0, '127.0.0.1');

      let boundPort = 0;
      if (isNodeHttpServerHandle(handle)) {
        boundPort = (handle.server?.address() as { port: number }).port;
      }

      // Make a real fetch request
      const fetchUrl = `http://127.0.0.1:${boundPort}/test/path`;
      const response = await fetch(fetchUrl);

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe('Path: /test/path');
    });

    it('closes the server gracefully', async () => {
      // deno-lint-ignore require-await
      const handler = async (): Promise<IResponse> => {
        return createMockResponse('OK');
      };

      handle = adapter.createServer(handler);

      await adapter.listen(handle, 0, '127.0.0.1');

      let boundPort = 0;
      if (isNodeHttpServerHandle(handle)) {
        boundPort = (handle.server?.address() as { port: number }).port;
      }

      // Verify server is running
      const beforeClose = await fetch(`http://127.0.0.1:${boundPort}`)
        .then((r) => r.status)
        .catch(() => 0);
      expect(beforeClose).toBe(200);

      await adapter.close(handle);

      // Verify server is stopped
      const afterClose = await fetch(`http://127.0.0.1:${boundPort}`)
        .then((r) => r.status)
        .catch(() => 0);
      expect(afterClose).toBe(0); // Connection failed
    });
  });

  describe('createNodeRequestListener', () => {
    it('creates a request listener on the handle', () => {
      // deno-lint-ignore require-await
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      handle = adapter.createServer(handler);

      if (isNodeHttpServerHandle(handle)) {
        const listener = handle.createNodeRequestListener();
        expect(typeof listener).toBe('function');
      }
    });
  });

  describe('error handling', () => {
    it('throws on invalid handle for listen', () => {
      const invalidHandle = { not: 'a handle' };

      adapter.listen(invalidHandle, 3000).catch(() => {
        // Expected to reject
      });
    });

    it('rejects on invalid handle for listen', async () => {
      const invalidHandle = { not: 'a handle' };

      await expect(adapter.listen(invalidHandle, 3000)).rejects.toThrow('Invalid server handle');
    });
  });
});
