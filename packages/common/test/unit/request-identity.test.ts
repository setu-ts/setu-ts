import { describe, expect, it } from 'vitest';
import {
  installRequestIdentityGuard,
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
    expect(
      Object.getOwnPropertySymbols(req)
        .map(String)
        .filter((s) => s.includes('locale')),
    ).toHaveLength(2);
  });
});

/** A request class guarded on its prototype, as the framework's own request classes are. */
class GuardedRequest {
  static {
    installRequestIdentityGuard(this.prototype);
  }

  readonly method = 'GET' as const;
  readonly url = 'http://localhost/';
  readonly path = '/';
  readonly headers = new Headers();
  declare user?: IPrincipal;
  declare tenant?: ITenant;
  declare locale?: string;

  json<T>(): Promise<T> {
    return Promise.resolve({} as T);
  }

  text(): Promise<string> {
    return Promise.resolve('');
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }
}

/** One row per guarded field: a first value, a second value, and its deliberate replacer. */
const FIELDS = [
  {
    field: 'user',
    first: { id: 'first', roles: [] } as IPrincipal,
    second: { id: 'second', roles: [] } as IPrincipal,
    replace: (req: IRequest, value: unknown) => replacePrincipal(req, value as IPrincipal),
  },
  {
    field: 'tenant',
    first: { id: 'first', name: 'First' } as ITenant,
    second: { id: 'second', name: 'Second' } as ITenant,
    replace: (req: IRequest, value: unknown) => replaceTenant(req, value as ITenant),
  },
  {
    field: 'locale',
    first: 'fr',
    second: 'de',
    replace: (req: IRequest, value: unknown) => replaceLocale(req, value as string),
  },
] as const;

describe('installRequestIdentityGuard', () => {
  describe.each(FIELDS)('$field on a guarded prototype', ({ field, first, second, replace }) => {
    it('allows one write and refuses the second without any per-instance seal', () => {
      const req = new GuardedRequest() as unknown as Record<string, unknown>;
      req[field] = first;
      expect(req[field]).toBe(first);
      expect(() => {
        req[field] = second;
      }).toThrow(`ctx.request.${field} has already been set`);
      expect(Object.hasOwn(req, field)).toBe(false);
    });

    it('is already sealed: sealRequestIdentity adds no own property', () => {
      const req = new GuardedRequest() as unknown as IRequest;
      sealRequestIdentity(req);
      expect(Object.getOwnPropertyNames(req)).not.toContain(field);
    });

    it('replaces deliberately through the replacer, then still refuses an implicit write', () => {
      const req = new GuardedRequest() as unknown as Record<string, unknown>;
      req[field] = first;
      replace(req as unknown as IRequest, second);
      expect(req[field]).toBe(second);
      expect(() => {
        req[field] = first;
      }).toThrow(`ctx.request.${field} has already been set`);
    });

    it('falls back to the per-instance seal when an own property shadows the guard', () => {
      const req = new GuardedRequest() as unknown as Record<string, unknown>;
      Object.defineProperty(req, field, {
        value: first,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      sealRequestIdentity(req as unknown as IRequest);
      expect(req[field]).toBe(first);
      expect(() => {
        req[field] = second;
      }).toThrow(`ctx.request.${field} has already been set`);
    });

    it('falls back to the per-instance seal for a subclass instance', () => {
      class Derived extends GuardedRequest {}
      const req = new Derived() as unknown as Record<string, unknown>;
      sealRequestIdentity(req as unknown as IRequest);
      expect(Object.getOwnPropertyNames(req)).toContain(field);
      req[field] = first;
      expect(() => {
        req[field] = second;
      }).toThrow(`ctx.request.${field} has already been set`);
    });
  });

  it('keeps the identity fields off Object.keys and JSON.stringify', () => {
    const req = new GuardedRequest();
    req.user = { id: 'u', roles: [] };
    req.locale = 'fr';
    expect(Object.keys(req)).not.toContain('user');
    expect(Object.keys(req)).not.toContain('locale');
    expect(JSON.stringify(req)).not.toContain('"user"');
    expect(JSON.stringify(req)).not.toContain('setu.request');
  });

  it('is idempotent on an already guarded prototype', () => {
    expect(() => installRequestIdentityGuard(GuardedRequest.prototype)).not.toThrow();
  });

  it.each(['user', 'tenant', 'locale'])('refuses a prototype that already defines %s', (field) => {
    const prototype = {};
    Object.defineProperty(prototype, field, { get: () => undefined });
    expect(() => installRequestIdentityGuard(prototype)).toThrow(
      `Cannot guard request identity on a prototype that already defines '${field}'.`,
    );
  });

  it('does not treat a null-prototype object as guarded', () => {
    const req = Object.assign(Object.create(null) as object, request()) as IRequest;
    sealRequestIdentity(req);
    req.user = { id: 'first', roles: [] };
    expect(() => {
      req.user = { id: 'second', roles: [] };
    }).toThrow('ctx.request.user has already been set');
  });
});
