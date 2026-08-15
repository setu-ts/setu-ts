/**
 * Unit tests for `createRequestContext` threading `IRequest.raw` to
 * `IRequestContext.raw` (M70a).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRequest } from '@setu-ts/common';
import { createRequestContext } from '../../src/context/request-context.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';

function makeRequest(raw?: Request): IRequest {
  return {
    method: 'GET',
    url: 'http://localhost/test',
    path: '/test',
    headers: new Headers(),
    ...(raw !== undefined ? { raw } : {}),
    json: <T = unknown>() => Promise.resolve({}) as Promise<T>,
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
}

describe('createRequestContext — raw Request threading (M70a)', () => {
  it('exposes ctx.raw when the adapter provides IRequest.raw', () => {
    const raw = new Request('http://localhost/ws', {
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });
    const request = makeRequest(raw);
    const runtime = createFakeRuntime().runtime;

    const handle = createRequestContext(request, new ServiceRegistry(), runtime);
    expect(handle.ctx.raw).toBe(raw);
  });

  it('ctx.raw is the same Request instance the adapter passed', () => {
    const raw = new Request('http://localhost/test');
    const request = makeRequest(raw);
    const runtime = createFakeRuntime().runtime;

    const handle = createRequestContext(request, new ServiceRegistry(), runtime);
    expect(handle.ctx.raw).toBe(raw);
    expect(handle.ctx.raw?.url).toBe('http://localhost/test');
  });

  it('ctx.raw is absent when the adapter omits IRequest.raw', () => {
    const request = makeRequest(undefined);
    const runtime = createFakeRuntime().runtime;

    const handle = createRequestContext(request, new ServiceRegistry(), runtime);
    expect(handle.ctx.raw).toBeUndefined();
  });

  it('ctx.raw preserves WebSocket upgrade headers', () => {
    const raw = new Request('http://localhost/ws', {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    const request = makeRequest(raw);
    const runtime = createFakeRuntime().runtime;

    const handle = createRequestContext(request, new ServiceRegistry(), runtime);
    expect(handle.ctx.raw?.headers.get('upgrade')).toBe('websocket');
    expect(handle.ctx.raw?.headers.get('connection')).toBe('Upgrade');
    expect(handle.ctx.raw?.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
  });

  it('ctx.raw is undisturbed (body not consumed by framework mapping)', () => {
    const raw = new Request('http://localhost/test', { method: 'POST', body: 'payload' });
    const request = makeRequest(raw);
    const runtime = createFakeRuntime().runtime;

    const handle = createRequestContext(request, new ServiceRegistry(), runtime);
    // The raw request body has not been consumed — the framework mapping
    // reads the body separately, but the raw Request is preserved as-is.
    expect(handle.ctx.raw).toBe(raw);
  });
});
