/**
 * Integration tests for Deno HTTP adapter - REAL round-trip tests.
 *
 * These tests bind a real OS socket and issue real fetch requests.
 * They require the `net` permission to be granted.
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DenoHttpAdapter,
  DenoHttpServerHandle,
  isDenoHttpServerHandle,
} from '../../src/adapters/deno/deno-http-adapter.ts';
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

describe('DenoHttpAdapter - Real Round-Trip', () => {
  let adapter: DenoHttpAdapter;
  let handle: unknown;

  beforeEach(() => {
    adapter = new DenoHttpAdapter();
    handle = null;
  });

  afterEach(async () => {
    if (handle !== null) {
      await adapter.close(handle);
    }
  });

  describe('createServer', () => {
    it('creates a handle before listen', () => {
      // deno-lint-ignore require-await
      const handler = async (_request: IRequest): Promise<IResponse> => {
        return createMockResponse('Created');
      };

      handle = adapter.createServer(handler);

      expect(handle).toBeInstanceOf(DenoHttpServerHandle);
      expect(isDenoHttpServerHandle(handle)).toBe(true);
    });
  });

  describe('listen and close', () => {
    it('binds to a port and serves requests', async () => {
      // deno-lint-ignore require-await
      const handler = async (_request: IRequest): Promise<IResponse> => {
        return createMockResponse('Hello, World!', 200);
      };

      handle = adapter.createServer(handler);

      // Use port 0 to get an OS-assigned port
      await adapter.listen(handle, 0, '127.0.0.1');

      // The handle should now have the server attached
      expect(isDenoHttpServerHandle(handle)).toBe(true);
      if (isDenoHttpServerHandle(handle)) {
        expect(handle.server).not.toBeNull();
      }
    });

    it('serves a real request through the full pipeline', async () => {
      let capturedMethod: string | null = null;
      let capturedPath: string | null = null;

      // deno-lint-ignore require-await
      const handler = async (request: IRequest): Promise<IResponse> => {
        capturedMethod = request.method;
        capturedPath = request.path;
        return createMockResponse(
          JSON.stringify({ method: capturedMethod, path: capturedPath }),
          200,
        );
      };

      handle = adapter.createServer(handler);
      await adapter.listen(handle, 0, '127.0.0.1');

      let boundPort = 0;
      if (isDenoHttpServerHandle(handle)) {
        boundPort = (handle.server!.addr as Deno.NetAddr).port;
      }

      // Make a real fetch request
      const fetchUrl = `http://127.0.0.1:${boundPort}/test/path`;
      const fetchResponse = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      });

      expect(fetchResponse.status).toBe(200);

      const body = await fetchResponse.json();
      expect(body.method).toBe('POST');
      expect(body.path).toBe('/test/path');
    });

    it('shuts down gracefully', async () => {
      // deno-lint-ignore require-await
      const handler = async (_request: IRequest): Promise<IResponse> => {
        return createMockResponse('OK');
      };

      handle = adapter.createServer(handler);

      await adapter.listen(handle, 0, '127.0.0.1');

      let boundPort = 0;
      if (isDenoHttpServerHandle(handle)) {
        boundPort = (handle.server!.addr as Deno.NetAddr).port;
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

  describe('type guard', () => {
    it('correctly identifies DenoHttpServerHandle', () => {
      // deno-lint-ignore require-await
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      const validHandle = adapter.createServer(handler);
      const invalidHandle = { not: 'a handle' };

      expect(isDenoHttpServerHandle(validHandle)).toBe(true);
      expect(isDenoHttpServerHandle(invalidHandle)).toBe(false);
    });
  });

  describe('createDenoHandler', () => {
    it('creates a Deno handler from the handle', () => {
      // deno-lint-ignore require-await
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      handle = adapter.createServer(handler);

      if (isDenoHttpServerHandle(handle)) {
        const denoHandler = handle.createDenoHandler();
        expect(typeof denoHandler).toBe('function');
      }
    });
  });

  describe('error handling', () => {
    it('throws on invalid handle for listen', () => {
      const invalidHandle = { not: 'a handle' };

      expect(() => adapter.listen(invalidHandle, 3000)).toThrow('Invalid server handle');
    });

    it('throws on invalid handle for close', async () => {
      const invalidHandle = { not: 'a handle' };

      await expect(adapter.close(invalidHandle)).rejects.toThrow('Invalid server handle');
    });

    it('handles close on handle with null server (no-op)', async () => {
      // deno-lint-ignore require-await
      const handler = async (): Promise<IResponse> => {
        return createMockResponse();
      };

      handle = adapter.createServer(handler);

      // Don't call listen, just close
      await adapter.close(handle);
    });
  });
});
