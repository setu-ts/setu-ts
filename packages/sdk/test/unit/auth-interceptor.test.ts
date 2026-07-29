/**
 * Tests for authentication interceptor factories.
 *
 * Covers bearer literal + async provider, API-key literal + async provider
 * + custom header, and precedence/overwrite behavior.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  createApiKeyAuthInterceptor,
  createBearerAuthInterceptor,
} from '../../src/auth/auth-interceptor.ts';
import type { ClientRequestContext } from '../../src/http/contracts.ts';

function makeCtx(): ClientRequestContext {
  return {
    url: new URL('https://example.com/'),
    headers: new Headers(),
  };
}

describe('createBearerAuthInterceptor', () => {
  it('sets Bearer header with literal token', async () => {
    const interceptor = createBearerAuthInterceptor('my-token');
    const ctx = makeCtx();
    await interceptor(ctx);
    expect(ctx.headers.get('Authorization')).toEqual('Bearer my-token');
  });

  it('sets Bearer header with async provider', async () => {
    const interceptor = createBearerAuthInterceptor(() => Promise.resolve('async-token'));
    const ctx = makeCtx();
    await interceptor(ctx);
    expect(ctx.headers.get('Authorization')).toEqual('Bearer async-token');
  });

  it('does not overwrite existing Authorization header', async () => {
    const interceptor = createBearerAuthInterceptor('my-token');
    const ctx = makeCtx();
    ctx.headers.set('Authorization', 'Bearer existing');
    await interceptor(ctx);
    expect(ctx.headers.get('Authorization')).toEqual('Bearer existing');
  });

  it('propagates provider rejection', async () => {
    const interceptor = createBearerAuthInterceptor(() =>
      Promise.reject(new Error('provider failed'))
    );
    await expect(interceptor(makeCtx())).rejects.toThrow('provider failed');
  });
});

describe('createApiKeyAuthInterceptor', () => {
  it('sets X-API-Key with literal key', async () => {
    const interceptor = createApiKeyAuthInterceptor('my-key');
    const ctx = makeCtx();
    await interceptor(ctx);
    expect(ctx.headers.get('X-API-Key')).toEqual('my-key');
  });

  it('uses custom header name', async () => {
    const interceptor = createApiKeyAuthInterceptor('my-key', 'X-Custom-Key');
    const ctx = makeCtx();
    await interceptor(ctx);
    expect(ctx.headers.get('X-Custom-Key')).toEqual('my-key');
  });

  it('sets key with async provider', async () => {
    const interceptor = createApiKeyAuthInterceptor(() => Promise.resolve('async-key'));
    const ctx = makeCtx();
    await interceptor(ctx);
    expect(ctx.headers.get('X-API-Key')).toEqual('async-key');
  });

  it('does not overwrite existing key header', async () => {
    const interceptor = createApiKeyAuthInterceptor('my-key');
    const ctx = makeCtx();
    ctx.headers.set('X-API-Key', 'existing');
    await interceptor(ctx);
    expect(ctx.headers.get('X-API-Key')).toEqual('existing');
  });

  it('does not overwrite custom header when present', async () => {
    const interceptor = createApiKeyAuthInterceptor('my-key', 'X-Custom-Key');
    const ctx = makeCtx();
    ctx.headers.set('X-Custom-Key', 'existing');
    await interceptor(ctx);
    expect(ctx.headers.get('X-Custom-Key')).toEqual('existing');
  });

  it('propagates provider rejection', async () => {
    const interceptor = createApiKeyAuthInterceptor(() => Promise.reject(new Error('key failed')));
    await expect(interceptor(makeCtx())).rejects.toThrow('key failed');
  });
});
