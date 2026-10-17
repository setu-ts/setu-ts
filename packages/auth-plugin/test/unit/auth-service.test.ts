/**
 * Tests for AuthService.
 */

import { describe, expect, it } from 'vitest';
import { AuthService, LocalStrategy } from '../../src/services/auth-service.ts';
import type { IAuthStrategy, IPrincipal, IRequest } from '@setu-ts/common';

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
  describe('authenticateWithSource', () => {
    it('returns the first match with the header credential of a header strategy', async () => {
      const principal: IPrincipal = { id: 'p1' };
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: () => Promise.resolve(null) },
        { name: 's2', credential: 'header', authenticate: () => Promise.resolve(principal) },
      ];
      const service = new AuthService(strategies, new LocalStrategy(() => Promise.resolve(null)));

      const result = await service.authenticateWithSource(createRequest());
      expect(result).toEqual({ principal, credential: 'header' });
    });

    it('returns the cookie credential of a cookie strategy', async () => {
      const principal: IPrincipal = { id: 'p2' };
      const strategies: IAuthStrategy[] = [
        { name: 's1', credential: 'cookie', authenticate: () => Promise.resolve(principal) },
      ];
      const service = new AuthService(strategies, new LocalStrategy(() => Promise.resolve(null)));

      const result = await service.authenticateWithSource(createRequest());
      expect(result).toEqual({ principal, credential: 'cookie' });
    });

    it('treats a strategy without a credential as cookie (fail closed)', async () => {
      const principal: IPrincipal = { id: 'p3' };
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: () => Promise.resolve(principal) },
      ];
      const service = new AuthService(strategies, new LocalStrategy(() => Promise.resolve(null)));

      const result = await service.authenticateWithSource(createRequest());
      expect(result).toEqual({ principal, credential: 'cookie' });
    });

    it('returns null when nothing matches', async () => {
      const service = new AuthService([], new LocalStrategy(() => Promise.resolve(null)));

      const result = await service.authenticateWithSource(createRequest());
      expect(result).toBeNull();
    });

    it('runs the same one loop as authenticate, which returns the same principal', async () => {
      const principal: IPrincipal = { id: 'p4' };
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: () => Promise.resolve(null) },
        { name: 's2', credential: 'header', authenticate: () => Promise.resolve(principal) },
        { name: 's3', authenticate: () => Promise.reject(new Error('must not be reached')) },
      ];
      const service = new AuthService(strategies, new LocalStrategy(() => Promise.resolve(null)));

      const viaSource = await service.authenticateWithSource(createRequest());
      expect(viaSource?.credential).toBe('header');
      const viaAuthenticate = await service.authenticate(createRequest());
      expect(viaAuthenticate).toBe(viaSource?.principal);
    });
  });

  describe('authenticate', () => {
    it('returns the first non-null principal from the strategy chain', async () => {
      const principal1: IPrincipal = { id: 'p1' };
      const principal2: IPrincipal = { id: 'p2' };

      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: () => Promise.resolve(null) },
        { name: 's2', authenticate: () => Promise.resolve(principal1) },
        { name: 's3', authenticate: () => Promise.resolve(principal2) },
      ];
      const local = new LocalStrategy(() => Promise.resolve(null));
      const service = new AuthService(strategies, local);

      const result = await service.authenticate(createRequest());
      expect(result).toBe(principal1);
    });

    it('returns null when all strategies return null', async () => {
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: () => Promise.resolve(null) },
        { name: 's2', authenticate: () => Promise.resolve(null) },
      ];
      const local = new LocalStrategy(() => Promise.resolve(null));
      const service = new AuthService(strategies, local);

      const result = await service.authenticate(createRequest());
      expect(result).toBeNull();
    });

    it('returns null when the strategy list is empty', async () => {
      const local = new LocalStrategy(() => Promise.resolve(null));
      const service = new AuthService([], local);

      const result = await service.authenticate(createRequest());
      expect(result).toBeNull();
    });

    it('runs strategies in order and stops at the first match', async () => {
      let secondCalled = false;
      const strategies: IAuthStrategy[] = [
        { name: 's1', authenticate: () => Promise.resolve({ id: 'first' }) },
        {
          name: 's2',
          authenticate: () => {
            secondCalled = true;
            return Promise.resolve({ id: 'second' });
          },
        },
      ];
      const local = new LocalStrategy(() => Promise.resolve(null));
      const service = new AuthService(strategies, local);

      const result = await service.authenticate(createRequest());
      expect(result!.id).toBe('first');
      expect(secondCalled).toBe(false);
    });
  });

  describe('verifyCredentials', () => {
    it('delegates to the LocalStrategy', async () => {
      const expected: IPrincipal = { id: 'login-user', roles: ['user'] };
      const local = new LocalStrategy((identifier, secret) => {
        if (identifier === 'login-user' && secret === 'pass') {
          return Promise.resolve(expected);
        }
        return Promise.resolve(null);
      });
      const service = new AuthService([], local);

      const result = await service.verifyCredentials({ identifier: 'login-user', secret: 'pass' });
      expect(result).toEqual(expected);
    });

    it('returns null when LocalStrategy returns null', async () => {
      const local = new LocalStrategy(() => Promise.resolve(null));
      const service = new AuthService([], local);

      const result = await service.verifyCredentials({ identifier: 'x', secret: 'y' });
      expect(result).toBeNull();
    });
  });
});
