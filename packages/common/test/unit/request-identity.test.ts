import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  replaceLocale,
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

describe('request locale (M103)', () => {
  it('guards locale independently, naming replaceLocale in the second-write error', () => {
    const req = request();
    sealRequestIdentity(req);
    req.locale = 'de';
    expect(req.locale).toBe('de');
    expect(() => {
      req.locale = 'fr';
    }).toThrow('replaceLocale(ctx.request, value)');
    expect(req.locale).toBe('de');
  });

  it('does not touch user or tenant when the locale is written', () => {
    const req = request();
    sealRequestIdentity(req);
    req.locale = 'de';
    const principal: IPrincipal = { id: 'p', roles: [] };
    req.user = principal;
    expect(req.user).toBe(principal);
    expect(req.tenant).toBeUndefined();
  });

  it('treats a seeded locale as the first write', () => {
    const req = request({ locale: 'fr' });
    sealRequestIdentity(req);
    expect(req.locale).toBe('fr');
    expect(() => {
      req.locale = 'de';
    }).toThrow('ctx.request.locale has already been set');
  });

  it('replaces a sealed locale deliberately, also after an implicit write', () => {
    const req = request();
    sealRequestIdentity(req);
    req.locale = 'en';
    replaceLocale(req, 'de');
    expect(req.locale).toBe('de');
    replaceLocale(req, 'fr');
    expect(req.locale).toBe('fr');
  });

  it('assigns on an unsealed request', () => {
    const req = request();
    replaceLocale(req, 'de');
    expect(req.locale).toBe('de');
  });

  it('keeps the locale slots off every enumeration', () => {
    const req = request();
    sealRequestIdentity(req);
    replaceLocale(req, 'de');
    expect(Object.keys(req)).toContain('locale');
    expect(Object.keys(req).join()).not.toContain('setu.request');
    expect(JSON.parse(JSON.stringify(req)).locale).toBe('de');
    expect(JSON.stringify(req)).not.toContain('setu.request.locale');
    expect(Object.getOwnPropertySymbols(req).map(String).filter((s) => s.includes('locale')))
      .toHaveLength(2);
  });
});
