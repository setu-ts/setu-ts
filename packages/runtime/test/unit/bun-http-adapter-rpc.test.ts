// deno-lint-ignore-file no-explicit-any, require-await
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BunHttpAdapter } from '../../src/adapters/bun/bun-http-adapter.ts';
import type { BunServeHost } from '../../src/adapters/bun/bun-http-adapter.ts';

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): { host: BunServeHost } {
  const host = {
    serve: () => ({
      stop: () => {},
    }),
  };
  return { host };
}

// ---------------------------------------------------------------------------
// RPC interceptor integration tests
// ---------------------------------------------------------------------------

describe('bun-http-adapter | RPC interceptor', () => {
  it('RPC handler short-circuits before body mapping', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    const mockHandler = (_request: Request): Promise<Response | null> => {
      return Promise.resolve(new Response('grpc response'));
    };
    adapter.setRpcHandler(mockHandler);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'hono' }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('grpc response');
  });

  it('RPC handler returning null falls through to framework handler', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    const mockHandler = (_request: Request): Promise<Response | null> => {
      return Promise.resolve(null);
    };
    adapter.setRpcHandler(mockHandler);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'hono' }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hono');
  });

  it('RPC throwing handler returns 500 error', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    const mockHandler = (_request: Request): Promise<Response | null> => {
      throw new Error('handler failed');
    };
    adapter.setRpcHandler(mockHandler);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'hono' }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Internal server error');
  });

  it('no RPC handler falls through to framework handler', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'hono' }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hono');
  });
});
