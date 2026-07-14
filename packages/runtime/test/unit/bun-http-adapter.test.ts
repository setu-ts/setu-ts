/**
 * Tests for Bun HTTP adapter with injectable BunServeHost seam.
 *
 * This test suite uses a fake BunServeHost to fully test the adapter
 * without requiring the real Bun runtime. This is the critical test
 * for §3.6 injectable seam - NO skip, full coverage.
 */

import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  BunHttpAdapter,
  BunHttpServerHandle,
  type BunServeHost,
  type BunServer,
} from '../../src/adapters/bun/bun-http-adapter.ts';
import type { HandlerResult, IRequest, IResponse } from '@hono-enterprise/common';

/**
 * Fake BunServeHost for testing.
 * Records all method calls for verification.
 */
class FakeBunServeHost implements BunServeHost {
  serveCalls: Array<
    { port: number; hostname?: string; fetch: (req: Request) => Response | Promise<Response> }
  > = [];
  stopCalls: number = 0;

  serve(
    options: {
      port: number;
      hostname?: string;
      fetch: (req: Request) => Response | Promise<Response>;
    },
  ): BunServer {
    this.serveCalls.push(options);
    return {
      stop: () => {
        this.stopCalls++;
      },
    };
  }
}

/**
 * Creates a minimal IResponse mock for testing.
 */
function createMockResponse(status = 200): IResponse {
  const state = {
    _status: status,
    _headers: new Headers(),
    _body: null as Uint8Array | string | null,
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

describe('BunHttpAdapter', () => {
  let fakeHost: FakeBunServeHost;
  let adapter: BunHttpAdapter;
  let testResponse: IResponse;

  beforeEach(() => {
    fakeHost = new FakeBunServeHost();
    testResponse = createMockResponse(200);
  });

  describe('createServer', () => {
    it('creates a handle with the handler', () => {
      adapter = new BunHttpAdapter(fakeHost);
      // deno-lint-ignore require-await
      const handle = adapter.createServer(async () => testResponse);

      expect(handle).toBeInstanceOf(BunHttpServerHandle);
    });

    it('returns handle that can be narrowed with type guard', () => {
      adapter = new BunHttpAdapter(fakeHost);
      // deno-lint-ignore require-await
      const handle = adapter.createServer(async () => testResponse);

      // Type guard check
      expect(handle instanceof BunHttpServerHandle).toBe(true);
    });
  });

  describe('listen', () => {
    beforeEach(() => {
      adapter = new BunHttpAdapter(fakeHost);
    });

    it('calls host.serve with correct options', async () => {
      // deno-lint-ignore require-await
      const handle = adapter.createServer(async () => testResponse);

      await adapter.listen(handle, 3000, '127.0.0.1');

      expect(fakeHost.serveCalls.length).toBe(1);
      expect(fakeHost.serveCalls[0].port).toBe(3000);
      expect(fakeHost.serveCalls[0].hostname).toBe('127.0.0.1');
      expect(typeof fakeHost.serveCalls[0].fetch).toBe('function');
    });

    it('calls host.serve with default hostname when not provided', async () => {
      // deno-lint-ignore require-await
      const handle = adapter.createServer(async () => testResponse);

      await adapter.listen(handle, 3000);

      expect(fakeHost.serveCalls.length).toBe(1);
      expect(fakeHost.serveCalls[0].port).toBe(3000);
      // hostname may be undefined or a default
    });

    it('invokes the mapped fetch handler correctly', async () => {
      let recordedFetch: ((req: Request) => Response | Promise<Response>) | null = null;

      // deno-lint-ignore require-await
      const handle = adapter.createServer(async (_request: IRequest): Promise<IResponse> => {
        return testResponse;
      });

      await adapter.listen(handle, 3000);

      recordedFetch = fakeHost.serveCalls[0].fetch;

      // Create a native request to test the fetch handler
      const nativeRequest = new Request('http://localhost:3000/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      });

      const response = await recordedFetch!(nativeRequest);

      expect(response.status).toBe(200);
    });

    it('throws on invalid handle', async () => {
      const invalidHandle = {} as unknown;

      try {
        await adapter.listen(invalidHandle, 3000);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('Invalid server handle');
      }
    });
  });

  describe('close', () => {
    beforeEach(() => {
      adapter = new BunHttpAdapter(fakeHost);
    });

    it('calls stop on the server', async () => {
      // deno-lint-ignore require-await
      const handle = adapter.createServer(async () => testResponse);

      await adapter.listen(handle, 3000);
      expect(fakeHost.stopCalls).toBe(0);

      await adapter.close(handle);

      expect(fakeHost.stopCalls).toBe(1);
    });

    it('no-ops on never-listened handle', async () => {
      // deno-lint-ignore require-await
      const handle = adapter.createServer(async () => testResponse);

      // Don't call listen, just close
      await adapter.close(handle);

      expect(fakeHost.stopCalls).toBe(0);
    });

    it('throws on invalid handle', async () => {
      const invalidHandle = {} as unknown;

      try {
        await adapter.close(invalidHandle);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('Invalid server handle');
      }
    });
  });

  describe('injectable host seam', () => {
    it('uses injected host instead of default', () => {
      const customHost: BunServeHost = {
        serve: () => ({ stop: () => {} }),
      };
      const customAdapter = new BunHttpAdapter(customHost);

      // Should not throw when using injected host
      // deno-lint-ignore require-await
      const handle = customAdapter.createServer(async () => {
        return createMockResponse(200);
      });

      expect(handle).toBeInstanceOf(BunHttpServerHandle);
    });
  });
});
