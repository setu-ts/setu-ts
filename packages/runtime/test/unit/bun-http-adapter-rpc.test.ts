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

// ---------------------------------------------------------------------------
// The serve callback shares createFetchHandler with fetch(), so it must not
// consult the interceptor a second time of its own.
// ---------------------------------------------------------------------------

describe('bun-http-adapter | RPC interceptor on the serve callback', () => {
  /** Builds a handle whose framework handler answers a fixed body. */
  function createHandle() {
    const handle = new BunHttpServerHandle();
    handle.setHandler(async (_request: any) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: 'hono' }),
      } as any;
    });
    return handle;
  }

  /** Bun's server stand-in for a request that is not a WebSocket upgrade. */
  const fakeServer = { upgrade: () => false } as any;

  it('consults the interceptor exactly once per request', async () => {
    const handle = createHandle();
    let consults = 0;
    handle.setRpcHandler((_request: Request) => {
      consults++;
      return Promise.resolve(null);
    });

    await handle.createServeCallback()(new Request('http://localhost/users'), fakeServer);

    // Two consults would dispatch every request through the RPC handler twice.
    expect(consults).toBe(1);
  });

  it('lets a body-inspecting handler fall through when it clones, per the contract', async () => {
    // RpcFetchHandler requires a handler returning `null` to leave the body
    // unread; inspecting means reading `request.clone()`. That only holds if
    // the request is consulted once — a second consult would hand the SAME
    // request to the handler again, and the clone taken there would come from
    // an already-used body, throwing and being swallowed as a 500.
    const handle = createHandle();
    const bodies: string[] = [];
    handle.setRpcHandler(async (request: Request) => {
      bodies.push(await request.clone().text());
      return null;
    });

    const response = await handle.createServeCallback()(
      new Request('http://localhost/users', { method: 'POST', body: 'payload' }),
      fakeServer,
    );

    expect(bodies).toEqual(['payload']);
    // Fall-through reached the framework handler with the body still readable.
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('hono');
  });

  it('still short-circuits an RPC request through the serve callback', async () => {
    const handle = createHandle();
    handle.setRpcHandler(() => Promise.resolve(new Response('grpc response')));

    const response = await handle.createServeCallback()(
      new Request('http://localhost/grpc/pkg.Svc/Method', { method: 'POST' }),
      fakeServer,
    );

    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('grpc response');
  });
});
