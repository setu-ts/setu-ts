/**
 * Tests for LocalStrategy.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { LocalStrategy } from '../../src/services/auth-service.ts';
import type { IPrincipal } from '@hono-enterprise/common';

describe('LocalStrategy', () => {
  it('delegates to the verify callback and returns the principal', async () => {
    const expected: IPrincipal = { id: 'user1', roles: ['user'] };
    const strategy = new LocalStrategy(async (identifier, secret) => {
      if (identifier === 'user1' && secret === 'password') {
        return expected;
      }
      return null;
    });

    const result = await strategy.verify('user1', 'password');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('user1');
  });

  it('returns null when credentials are invalid', async () => {
    const strategy = new LocalStrategy(async () => null);
    const result = await strategy.verify('user1', 'wrong');
    expect(result).toBeNull();
  });

  it('passes identifier and secret to the callback', async () => {
    let capturedId: string | undefined;
    let capturedSecret: string | undefined;
    const strategy = new LocalStrategy(async (identifier, secret) => {
      capturedId = identifier;
      capturedSecret = secret;
      return { id: identifier };
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
    const strategy = new LocalStrategy(async () => principal);
    const result = await strategy.verify('admin', 'pass');
    expect(result).toEqual(principal);
  });
});
