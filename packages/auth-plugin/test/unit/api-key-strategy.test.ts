/**
 * Tests for ApiKeyStrategy.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ApiKeyStrategy } from '../../src/strategies/api-key-strategy.ts';
import type { IPrincipal, IRequest } from '@hono-enterprise/common';

describe('ApiKeyStrategy', () => {
  function createRequest(headers: Record<string, string> = {}): IRequest {
    const h = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      h.set(key, value);
    }
    return {
      method: 'GET',
      url: 'http://localhost/',
      path: '/',
      headers: h,
      json: <T>() => Promise.resolve({} as T),
      text: () => Promise.resolve(''),
      bytes: () => Promise.resolve(new Uint8Array()),
    };
  }

  it('returns a principal when the key validates', async () => {
    const expectedPrincipal: IPrincipal = { id: 'api-user', roles: ['service'] };
    const strategy = new ApiKeyStrategy({
      validate: (key) => Promise.resolve(key === 'valid-key' ? expectedPrincipal : null),
    });
    const request = createRequest({ 'X-API-Key': 'valid-key' });
    const principal = await strategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.id).toBe('api-user');
    expect(principal!.roles).toEqual(['service']);
  });

  it('returns null when the header is absent', async () => {
    const strategy = new ApiKeyStrategy({
      validate: () => Promise.resolve({ id: 'should-not-reach' }),
    });
    const request = createRequest();
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('returns null when validate returns null', async () => {
    const strategy = new ApiKeyStrategy({
      validate: () => Promise.resolve(null),
    });
    const request = createRequest({ 'X-API-Key': 'invalid-key' });
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('returns null when validate throws', async () => {
    const strategy = new ApiKeyStrategy({
      validate: () => Promise.reject(new Error('lookup failed')),
    });
    const request = createRequest({ 'X-API-Key': 'some-key' });
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('respects a custom header name', async () => {
    const expectedPrincipal: IPrincipal = { id: 'api-user' };
    const strategy = new ApiKeyStrategy({
      header: 'X-Custom-Key',
      validate: () => Promise.resolve(expectedPrincipal),
    });
    const request = createRequest({ 'X-Custom-Key': 'my-key' });
    const principal = await strategy.authenticate(request);
    expect(principal).not.toBeNull();
    expect(principal!.id).toBe('api-user');
  });

  it('does not read the default header when a custom header is set', async () => {
    const strategy = new ApiKeyStrategy({
      header: 'X-Custom-Key',
      validate: () => Promise.resolve({ id: 'reached' }),
    });
    const request = createRequest({ 'X-API-Key': 'some-key' });
    const principal = await strategy.authenticate(request);
    expect(principal).toBeNull();
  });

  it('has the name "api-key"', () => {
    const strategy = new ApiKeyStrategy({
      validate: () => Promise.resolve(null),
    });
    expect(strategy.name).toBe('api-key');
  });
});
