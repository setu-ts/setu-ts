import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RpcInterceptorStore } from '../../src/adapters/shared/rpc-interceptor-store.ts';

function mockResponse(_request: Request): Promise<Response> {
  return Promise.resolve(new Response('mocked'));
}

function mockNull(_request: Request): Promise<Response | null> {
  return Promise.resolve(null);
}

function mockThrow(_request: Request): Promise<Response | null> {
  throw new Error('handler failed');
}

describe('RpcInterceptorStore', () => {
  it('falls through when no handler is installed', async () => {
    const store = new RpcInterceptorStore();
    const request = new Request('http://localhost/');

    expect(await store.consult(request)).toBeNull();
  });

  it("returns the handler's response when it returns a Response", async () => {
    const store = new RpcInterceptorStore();
    store.set(mockResponse);
    const request = new Request('http://localhost/');

    const result = await store.consult(request);
    if (result === null) {
      throw new Error('Expected a Response, got null');
    }
    expect(result).toBeInstanceOf(Response);
    expect(await result.text()).toBe('mocked');
  });

  it('passes the request through undisturbed so the caller can still map it', async () => {
    // The adapter maps this same Request after a null consult; a store that
    // consumed the body would break every fall-through.
    const store = new RpcInterceptorStore();
    store.set(() => Promise.resolve(null));
    const request = new Request('http://localhost/', { method: 'POST', body: 'payload' });

    expect(await store.consult(request)).toBeNull();
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe('payload');
  });

  it('returns null when the handler returns null', async () => {
    const store = new RpcInterceptorStore();
    store.set(mockNull);
    const request = new Request('http://localhost/');

    expect(await store.consult(request)).toBeNull();
  });

  it('converts a throwing handler to a 500 Response rather than crashing', async () => {
    const store = new RpcInterceptorStore();
    store.set(mockThrow);
    const request = new Request('http://localhost/');

    const result = await store.consult(request);
    if (result === null) {
      throw new Error('Expected a Response, got null');
    }
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(500);
    expect(await result.text()).toBe('Internal server error');
  });

  it('replaces a previously installed handler', async () => {
    const store = new RpcInterceptorStore();
    store.set(mockResponse);
    store.set(mockNull);

    const request = new Request('http://localhost/');
    expect(await store.consult(request)).toBeNull();
  });
});
