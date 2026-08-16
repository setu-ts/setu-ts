// deno-lint-ignore-file no-explicit-any, require-await
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';

// ---------------------------------------------------------------------------
// RPC interceptor — post-M70a behavior
//
// After M70a, the adapter fetch handler no longer consults #rpcStore.
// The framework handler (kernel pipeline) runs FIRST, and gRPC dispatch
// happens inside the kernel terminal handler. setRpcHandler is deprecated
// but still accepted for backward compatibility.
// ---------------------------------------------------------------------------

describe('cf-http-adapter | RPC interceptor (post-M70a)', () => {
  it('setRpcHandler stores the handler but fetch does not consult it', async () => {
    const adapter = new CloudflareWorkersHttpAdapter();

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
    const adapter = new CloudflareWorkersHttpAdapter();

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
    const adapter = new CloudflareWorkersHttpAdapter();

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
    const adapter = new CloudflareWorkersHttpAdapter();

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
