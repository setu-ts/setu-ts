// deno-lint-ignore-file no-explicit-any, require-await
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { BunHttpAdapter, BunHttpServerHandle } from '../../src/adapters/bun/bun-http-adapter.ts';
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
// RPC interceptor — post-M70a behavior
//
// After M70a, the adapter fetch handler no longer consults #rpcStore.
// The framework handler (kernel pipeline) runs FIRST, and gRPC dispatch
// happens inside the kernel terminal handler. setRpcHandler is deprecated
// but still accepted for backward compatibility.
// ---------------------------------------------------------------------------

describe('bun-http-adapter | RPC interceptor (post-M70a)', () => {
  it('setRpcHandler stores the handler but fetch does not consult it', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    const mockHandler = (_request: Request): Promise<Response | null> => {
      return Promise.resolve(new Response('grpc response'));
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

  it('setRpcHandler with null-returning handler still lets framework handler run', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

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
    const adapter = new BunHttpAdapter(host);

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

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('framework');
  });

  it('no RPC handler: framework handler runs', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

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

// ---------------------------------------------------------------------------
// The serve callback — post-M70a
//
// After M70a, the Bun serve callback no longer consults the RPC interceptor.
// It runs the framework handler (kernel pipeline) first, and gRPC dispatch
// happens inside the kernel terminal handler.
// ---------------------------------------------------------------------------

describe('bun-http-adapter | serve callback (post-M70a)', () => {
  /** Builds a handle whose framework handler answers a fixed body. */
  function createHandle() {
    const handle = new BunHttpServerHandle();
    handle.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers(),
          body: 'framework',
        }),
      } as any;
    });
    return handle;
  }

  /** Bun's server stand-in for a request that is not a WebSocket upgrade. */
  const fakeServer = { upgrade: () => false } as any;

  it('serve callback runs the framework handler (no RPC consult)', async () => {
    const handle = createHandle();

    // setRpcHandler is accepted but the serve callback does not consult it
    handle.setRpcHandler((_request: Request) => {
      return Promise.resolve(new Response('grpc response'));
    });

    const response = await handle.createServeCallback()(
      new Request('http://localhost/grpc/pkg.Svc/Method', { method: 'POST' }),
      fakeServer,
    );

    // Framework handler response wins — RPC is handled in the kernel, not adapter
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('framework');
  });

  it('serve callback lets the framework handler read the body', async () => {
    const handle = createHandle();

    const response = await handle.createServeCallback()(
      new Request('http://localhost/users', { method: 'POST', body: 'payload' }),
      fakeServer,
    );

    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('framework');
  });
});
