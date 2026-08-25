import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  replacePrincipal,
  replaceTenant,
  sealRequestIdentity,
} from '../../src/request-identity.ts';
import type { IPrincipal, IRequest, ITenant } from '../../src/index.ts';

function request(overrides: Partial<IRequest> = {}): IRequest {
  return {
    method: 'GET',
    url: 'http://localhost/',
    path: '/',
    headers: new Headers(),
    json: <T>(): Promise<T> => Promise.resolve({} as T),
    text: (): Promise<string> => Promise.resolve(''),
    bytes: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
    ...overrides,
  };
}

describe('sealRequestIdentity', () => {
  it('allows one implicit write and refuses the second', () => {
    const req = request();
    const first: IPrincipal = { id: 'first', roles: [] };
    sealRequestIdentity(req);
    req.user = first;
    expect(req.user).toBe(first);
    expect(() => {
      req.user = { id: 'second', roles: [] };
    }).toThrow('ctx.request.user has already been set');
  });

  it('guards tenant independently of the principal', () => {
    const req = request();
    const first: ITenant = { id: 'first', name: 'First' };
    sealRequestIdentity(req);
    req.tenant = first;
    expect(req.tenant).toBe(first);
    expect(() => {
      req.tenant = { id: 'second', name: 'Second' };
    }).toThrow('ctx.request.tenant has already been set');
  });

  it('keeps identity fields visible and preserves seeded values as first writes', () => {
    const principal: IPrincipal = { id: 'seeded', roles: [] };
    const req = request({ user: principal });
    sealRequestIdentity(req);
    expect('user' in req).toBe(true);
    expect(req.user).toBe(principal);
    expect(() => {
      req.user = { id: 'later', roles: [] };
    }).toThrow('ctx.request.user has already been set');
  });

  it('replaces both identities deliberately without exposing backing slots', () => {
    const req = request();
    const tenant: ITenant = { id: 'tenant', name: 'Tenant' };
    sealRequestIdentity(req);
    replacePrincipal(req, { id: 'replacement', roles: ['admin'] });
    replaceTenant(req, tenant);
    expect(req.user?.id).toBe('replacement');
    expect(req.tenant).toBe(tenant);
    expect(Object.keys(req)).not.toContain('setu.request.user');
    expect(JSON.stringify(req)).not.toContain('setu.request.user');
    sealRequestIdentity(req);
    expect(req.user?.id).toBe('replacement');
  });

  it('uses ordinary assignments when an unsealed request is deliberately replaced', () => {
    const req = request();
    const principal: IPrincipal = { id: 'unsealed-principal', roles: [] };
    const tenant: ITenant = { id: 'unsealed-tenant', name: 'Unsealed Tenant' };
    replacePrincipal(req, principal);
    replaceTenant(req, tenant);
    expect(req.user).toBe(principal);
    expect(req.tenant).toBe(tenant);
  });
});
