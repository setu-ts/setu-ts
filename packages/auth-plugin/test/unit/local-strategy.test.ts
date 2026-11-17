/**
 * Tests for LocalStrategy.
 */

import { describe, expect, it } from 'vitest';
import { LocalStrategy } from '../../src/services/auth-service.ts';
import type { IPrincipal } from '@setu-ts/common';

describe('LocalStrategy', () => {
  it('delegates to the verify callback and returns the principal', async () => {
    const expected: IPrincipal = { id: 'user1', roles: ['user'] };
    const strategy = new LocalStrategy((identifier, secret) => {
      if (identifier === 'user1' && secret === 'password') {
        return Promise.resolve(expected);
      }
      return Promise.resolve(null);
    });

    const result = await strategy.verify('user1', 'password');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user1');
  });

  it('returns null when credentials are invalid', async () => {
    const strategy = new LocalStrategy(() => Promise.resolve(null));
    const result = await strategy.verify('user1', 'wrong');
    expect(result).toBeNull();
  });

  it('passes identifier and secret to the callback', async () => {
    let capturedId: string | undefined;
    let capturedSecret: string | undefined;
    const strategy = new LocalStrategy((identifier, secret) => {
      capturedId = identifier;
      capturedSecret = secret;
      return Promise.resolve({ id: identifier });
    });

    await strategy.verify('myuser', 'mypassword');
    expect(capturedId).toBe('myuser');
    expect(capturedSecret).toBe('mypassword');
  });

  it('propagates the principal from the callback', async () => {
    const principal: IPrincipal = {
      id: 'admin-user',
      roles: ['admin'],
      permissions: ['*'],
      claims: { email: 'admin@example.com' },
    };
    const strategy = new LocalStrategy(() => Promise.resolve(principal));
    const result = await strategy.verify('admin', 'pass');
    expect(result).toEqual(principal);
  });
});

describe('M139a local request forwarding', () => {
  it.each([true, false])(
    'passes optional request as third callback argument: %j',
    async (supplied) => {
      const request = supplied
        ? ({ tenant: { id: 'acme' } } as import('@setu-ts/common').IRequest)
        : undefined;
      const calls: unknown[][] = [];
      const local = new LocalStrategy((...args) => {
        calls.push(args);
        return Promise.resolve(null);
      });
      await local.verify('u1', 'pw', request);
      expect(calls).toEqual([['u1', 'pw', request]]);
    },
  );
});
