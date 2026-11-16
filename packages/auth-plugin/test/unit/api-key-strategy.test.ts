/**
 * Tests for ApiKeyStrategy.
 */

import { describe, expect, it } from 'vitest';
import { ApiKeyStrategy } from '../../src/strategies/api-key-strategy.ts';
import type { IPrincipal, IRequest } from '@setu-ts/common';
import { httpStatusHintOf, serializeError } from '@setu-ts/common';
import { AuthenticationUnavailableError, AuthPluginConfigurationError } from '../../src/index.ts';

/** An Error whose constructor name is the given text. */
function named(name: string): Error {
  const error = new Error('k3y');
  Object.defineProperty(error, 'constructor', { value: { name } });
  return error;
}

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

  it('passes the request to validate, so a key can be bound to its tenant', async () => {
    const seen: Array<IRequest | undefined> = [];
    const strategy = new ApiKeyStrategy({
      validate: (key, request) => {
        seen.push(request);
        return Promise.resolve(
          key === 'acme-key' && request?.tenant?.id === 'acme' ? { id: 'svc' } : null,
        );
      },
    });
    const acme = { ...createRequest({ 'X-API-Key': 'acme-key' }), tenant: { id: 'acme' } };
    const globex = { ...createRequest({ 'X-API-Key': 'acme-key' }), tenant: { id: 'globex' } };
    expect(await strategy.authenticate(acme)).toEqual({ id: 'svc' });
    expect(await strategy.authenticate(globex)).toBeNull();
    expect(seen).toEqual([acme, globex]);
  });

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

  it('V12-138 preserves validator failures as fixed 503 errors', async () => {
    const cause = new Error('lookup failed');
    const strategy = new ApiKeyStrategy({
      validate: () => Promise.reject(cause),
    });
    const request = createRequest({ 'X-API-Key': 'some-key' });
    const error = await strategy.authenticate(request).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AuthenticationUnavailableError);
    expect(error).toHaveProperty('cause', cause);
    expect(httpStatusHintOf(error)).toEqual({
      status: 503,
      title: 'Service Unavailable',
      detail: 'Authentication is temporarily unavailable.',
    });
  });

  it('F2 logs only the failure class, never its text or the presented key', async () => {
    const key = 'k3y-CANARY-0042';
    class DatabaseError extends Error {}
    const cause = Object.assign(new DatabaseError(`invalid input syntax for type uuid: "${key}"`), {
      code: '22P02',
    });
    const strategy = new ApiKeyStrategy({ validate: () => Promise.reject(cause) });
    const error = (await strategy
      .authenticate(createRequest({ 'X-API-Key': key }))
      .catch((caught: unknown) => caught)) as AuthenticationUnavailableError;
    expect(error.message).toBe('Authentication is temporarily unavailable. (DatabaseError)');
    expect(error.cause).toBe(cause);
    const serialized = JSON.stringify(serializeError(error));
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain('invalid input syntax');
  });

  it.each([
    ['a thrown string', 'k3y in a string', 'string'],
    ['an Error whose constructor name is not an identifier', named('bad name k3y'), 'Error'],
    ['an Error with no constructor', Object.setPrototypeOf(new Error('k3y'), null), 'object'],
    ['a plain Error', new Error('k3y'), 'Error'],
  ])('F2 logs %s by class only', (_, cause, expected) => {
    const error = new AuthenticationUnavailableError(cause);
    expect(error.message).toBe(`Authentication is temporarily unavailable. (${expected})`);
    expect(JSON.stringify(serializeError(error))).not.toContain('k3y');
  });

  it.each(['cookie', 'COOKIE', 'Cookie'])('V12-136 refuses ambient API-key header %s', (header) => {
    expect(() => new ApiKeyStrategy({ header, validate: () => Promise.resolve(null) })).toThrow(
      AuthPluginConfigurationError,
    );
  });

  it('accepts Authorization as an API-key header', async () => {
    const strategy = new ApiKeyStrategy({
      header: 'authorization',
      validate: () => Promise.resolve({ id: 'api-user' }),
    });
    await expect(
      strategy.authenticate(createRequest({ authorization: 'Bearer key' })),
    ).resolves.toEqual({ id: 'api-user' });
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
