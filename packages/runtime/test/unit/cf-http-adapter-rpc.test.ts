import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';

// ---------------------------------------------------------------------------
// RPC interceptor integration tests
// ---------------------------------------------------------------------------

describe('cf-http-adapter | RPC interceptor', () => {
  it('RPC handler short-circuits before body mapping', async () => {
    const adapter = new CloudflareWorkersHttpAdapter(undefined as any);

    const mockHandler = async (_request: Request): Promise<Response | null> => {
      return new Response('grpc response');
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
    const adapter = new CloudflareWorkersHttpAdapter(undefined as any);

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
    const adapter = new CloudflareWorkersHttpAdapter(undefined as any);

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
    const adapter = new CloudflareWorkersHttpAdapter(undefined as any);

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
