import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DenoHttpAdapter } from '../../src/adapters/deno/deno-http-adapter.ts';

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): {
  host: {
    serve: (_options: any) => {
      shutdown: () => Promise<void>;
    };
  };
} {
  const host = {
    serve: () => ({
      shutdown: async () => {},
    }),
  };
  return { host };
}

// ---------------------------------------------------------------------------
// RPC interceptor integration tests
// ---------------------------------------------------------------------------

describe('deno-http-adapter | RPC interceptor', () => {
  it('RPC handler short-circuits before body mapping', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host as any);

    const mockHandler = async (_request: Request): Promise<Response | null> => {
      return new Response('grpc response');
    };
    adapter.setRpcHandler(mockHandler);

    // Set a framework handler that should NOT be called
    let frameworkCalled = false;
    adapter.setHandler(async (_request: any) => {
      frameworkCalled = true;
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'hono' }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('grpc response');
    expect(frameworkCalled).toBe(false);
  });

  it('RPC handler returning null falls through to framework handler', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host as any);

    const mockHandler = async (_request: Request): Promise<Response | null> => {
      return null;
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
    const adapter = new DenoHttpAdapter(host as any);

    const mockHandler = async (_request: Request): Promise<Response | null> => {
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
    const adapter = new DenoHttpAdapter(host as any);

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
