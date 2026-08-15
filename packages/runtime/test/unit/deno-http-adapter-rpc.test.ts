// deno-lint-ignore-file no-explicit-any, require-await
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DenoHttpAdapter } from '../../src/adapters/deno/deno-http-adapter.ts';
import type { DenoServeHost } from '../../src/adapters/deno/deno-http-adapter.ts';

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): { host: DenoServeHost } {
  const host = {
    serve: () => ({
      shutdown: async () => {},
    }),
  };
  return { host };
}

// ---------------------------------------------------------------------------
// RPC interceptor — post-M70a behavior
//
// After M70a, the adapter fetch handler no longer consults #rpcStore.
// The framework handler (kernel pipeline) runs FIRST, and gRPC dispatch
// happens inside the kernel terminal handler. setRpcHandler is deprecated
// but still accepted for backward compatibility.
// ---------------------------------------------------------------------------

describe('deno-http-adapter | RPC interceptor (post-M70a)', () => {
  it('setRpcHandler stores the handler but fetch does not consult it', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // setRpcHandler is accepted (deprecated, backward compatible)
    const mockHandler = (_request: Request): Promise<Response | null> => {
      return Promise.resolve(new Response('grpc response'));
    };
    adapter.setRpcHandler(mockHandler);

    // Framework handler runs — it is the ONLY path now
    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: 'framework',
        }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    // Framework handler response wins — RPC is no longer short-circuited
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('framework');
  });

  it('setRpcHandler with null-returning handler still lets framework handler run', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    const mockHandler = (_request: Request): Promise<Response | null> => {
      return Promise.resolve(null);
    };
    adapter.setRpcHandler(mockHandler);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: 'framework',
        }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('framework');
  });

  it('setRpcHandler with throwing handler does not affect fetch path', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    const mockHandler = (_request: Request): Promise<Response | null> => {
      throw new Error('handler failed');
    };
    adapter.setRpcHandler(mockHandler);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: 'framework',
        }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    // The throwing RPC handler is never called; framework handler runs fine
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('framework');
  });

  it('no RPC handler: framework handler runs', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    adapter.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: 'framework',
        }),
      } as any;
    });

    const request = new Request('http://localhost/');
    const response = await adapter.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('framework');
  });
});
