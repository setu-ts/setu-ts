/**
 * Tests for AuthService.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthService, LocalStrategy } from '../../src/services/auth-service.ts';
import type { IAuthStrategy, IPrincipal, IRequest } from '@hono-enterprise/common';

function createRequest(): IRequest {
  return {
    method: 'GET',
    url: 'http://localhost/',
    path: '/',
    headers: new Headers(),
    json: <T>() => Promise.resolve({} as T),
    text: () => Promise.resolve(''),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
}

describe('AuthService', () => {
  describe('authenticate', () => {
    it('returns the first non-null principal from the strategy chain', async () => {
      const principal1: IPrincipal = { id: 'p1' };
      const principal2: IPrincipal = { id: 'p2' };

      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: async () => null },
        { name: 's2', authenticate: async () => principal1 },
        { name: 's3', authenticate: async () => principal2 },
      ];
      const local = new LocalStrategy(async () => null);
      const service = new AuthService(strategies, local);

      const result = await service.authenticate(createRequest());
      expect(result).toBe(principal1);
    });

    it('returns null when all strategies return null', async () => {
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: async () => null },
        { name: 's2', authenticate: async () => null },
      ];
      const local = new LocalStrategy(async () => null);
      const service = new AuthService(strategies, local);

      const result = await service.authenticate(createRequest());
      expect(result).toBeNull();
    });

    it('returns null when the strategy list is empty', async () => {
      const local = new LocalStrategy(async () => null);
      const service = new AuthService([], local);

      const result = await service.authenticate(createRequest());
      expect(result).toBeNull();
    });

    it('runs strategies in order and stops at the first match', async () => {
      let secondCalled = false;
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: async () => ({ id: 'first' }) },
        {
          name: 's2',
          authenticate: async () => {
            secondCalled = true;
            return { id: 'second' };
          },
        },
      ];
      const local = new LocalStrategy(async () => null);
      const service = new AuthService(strategies, local);

      const result = await service.authenticate(createRequest());
      expect(result!.id).toBe('first');
      expect(secondCalled).toBe(false);
    });
  });

  describe('verifyCredentials', () => {
    it('delegates to the LocalStrategy', async () => {
      const expected: IPrincipal = { id: 'login-user', roles: ['user'] };
      const local = new LocalStrategy(async (identifier, secret) => {
        if (identifier === 'login-user' && secret === 'pass') {
          return expected;
        }
        return null;
      });
      const service = new AuthService([], local);

      const result = await service.verifyCredentials({ identifier: 'login-user', secret: 'pass' });
      expect(result).toEqual(expected);
    });

    it('returns null when LocalStrategy returns null', async () => {
      const local = new LocalStrategy(async () => null);
      const service = new AuthService([], local);

      const result = await service.verifyCredentials({ identifier: 'x', secret: 'y' });
      expect(result).toBeNull();
    });
  });
});
