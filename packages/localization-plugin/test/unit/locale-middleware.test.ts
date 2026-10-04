import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRequestContext, ITenant } from '@setu-ts/common';
import { replaceLocale } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';

import {
  DEFAULT_EXCLUDED_PATHS,
  localeMiddleware,
} from '../../src/middleware/locale-middleware.ts';
import type { LocaleMiddlewareOptions } from '../../src/interfaces/index.ts';

const SUPPORTED = ['en', 'de', 'fr', 'es'];

interface Request {
  readonly path?: string;
  readonly query?: Record<string, string>;
  readonly cookie?: string;
  readonly acceptLanguage?: string;
  readonly tenant?: ITenant;
}

function context(request: Request = {}): IRequestContext {
  const headers = new Headers();
  if (request.cookie !== undefined) headers.set('cookie', request.cookie);
  if (request.acceptLanguage !== undefined) headers.set('accept-language', request.acceptLanguage);
  return createTestContext({
    request: {
      url: `http://localhost${request.path ?? '/page'}`,
      headers,
      ...(request.tenant === undefined ? {} : { tenant: request.tenant }),
    },
    query: request.query ?? {},
  });
}

async function run(
  request: Request,
  options: Partial<LocaleMiddlewareOptions> = {},
  handler: (ctx: IRequestContext) => void = () => {},
): Promise<IRequestContext> {
  const ctx = context(request);
  await localeMiddleware({ supportedLocales: SUPPORTED, ...options })(ctx, () => {
    handler(ctx);
    return Promise.resolve();
  });
  return ctx;
}

const tenantLocale = (tenant: ITenant): string | undefined =>
  tenant.metadata?.locale as string | undefined;
const ACME: ITenant = { id: 'acme', metadata: { locale: 'es' } };

describe('localeMiddleware — resolution chain', () => {
  it('uses the query parameter first', async () => {
    const ctx = await run(
      { query: { locale: 'de' }, cookie: 'setu_locale=fr', acceptLanguage: 'es', tenant: ACME },
      { tenantLocale },
    );
    expect(ctx.request.locale).toBe('de');
  });

  it('uses the cookie when the query does not select a supported locale', async () => {
    const ctx = await run(
      { query: { locale: 'tlh' }, cookie: 'setu_locale=fr', acceptLanguage: 'es', tenant: ACME },
      { tenantLocale },
    );
    expect(ctx.request.locale).toBe('fr');
  });

  it('uses Accept-Language when neither query nor cookie selects', async () => {
    const ctx = await run(
      { cookie: 'other=1', acceptLanguage: 'es;q=0.5, de', tenant: ACME },
      { tenantLocale },
    );
    expect(ctx.request.locale).toBe('de');
  });

  it('uses the tenant default when nothing above selects', async () => {
    const ctx = await run({ acceptLanguage: 'tlh', tenant: ACME }, { tenantLocale });
    expect(ctx.request.locale).toBe('es');
  });

  it('falls back to the default locale', async () => {
    const ctx = await run({ tenant: { id: 'plain' } }, { tenantLocale });
    expect(ctx.request.locale).toBe('en');
  });

  it('skips the tenant source when no tenant is resolved, or no callback is set', async () => {
    expect((await run({}, { tenantLocale })).request.locale).toBe('en');
    expect((await run({ tenant: ACME })).request.locale).toBe('en');
  });

  it('honours renamed query and cookie sources', async () => {
    expect((await run({ query: { lang: 'fr' } }, { query: 'lang' })).request.locale).toBe('fr');
    expect((await run({ cookie: 'lang=fr' }, { cookie: 'lang' })).request.locale).toBe('fr');
  });

  it('disables the query and cookie sources with false', async () => {
    const ctx = await run(
      { query: { locale: 'de' }, cookie: 'setu_locale=fr' },
      { query: false, cookie: false },
    );
    expect(ctx.request.locale).toBe('en');
  });

  it('honours q=0 under * in Accept-Language', async () => {
    const ctx = await run({ acceptLanguage: 'en;q=0, *' });
    expect(ctx.request.locale).toBe('de');
  });

  it('resolves hostile input to the default without throwing', async () => {
    // Query values can carry anything; a header value cannot hold NUL or CR/LF
    // (the platform refuses them before any middleware runs), so each source
    // gets the hostile set it can actually receive.
    for (const value of ['en_US', '', 'x'.repeat(40), 'de\u0000', 'en\r\nX-Injected: 1']) {
      expect((await run({ query: { locale: value } })).request.locale).toBe('en');
    }
    for (const value of ['en_US', 'x'.repeat(40), ';;;q=', ',,,']) {
      const ctx = await run({ acceptLanguage: value, query: { locale: 'tlh' } });
      expect(ctx.request.locale).toBe('en');
    }
    // The FIRST q parameter decides; a malformed one counts as 1.
    expect((await run({ acceptLanguage: 'de;q=abc;q=0' })).request.locale).toBe('de');
  });

  it('negotiates a regional variant to its language', async () => {
    expect((await run({ acceptLanguage: 'de-CH' })).request.locale).toBe('de');
  });

  it('writes through replaceLocale, so a second run on one request does not throw', async () => {
    const ctx = context({ query: { locale: 'de' } });
    const middleware = localeMiddleware({ supportedLocales: SUPPORTED });
    const next = () => Promise.resolve();
    await middleware(ctx, next);
    await middleware(ctx, next);
    expect(ctx.request.locale).toBe('de');
  });

  it('refuses invalid supported locales at construction', () => {
    expect(() => localeMiddleware({ supportedLocales: [] })).toThrow('non-empty array');
  });
});

describe('localeMiddleware — headers', () => {
  it('appends Vary for Accept-Language and Cookie, and writes Content-Language', async () => {
    const ctx = await run({ acceptLanguage: 'fr' });
    const headers = ctx.response.snapshot().headers;
    expect(headers.get('vary')).toBe('Accept-Language, Cookie');
    expect(headers.get('content-language')).toBe('fr');
  });

  it('omits Cookie from Vary when the cookie source is disabled', async () => {
    const ctx = await run({}, { cookie: false });
    expect(ctx.response.snapshot().headers.get('vary')).toBe('Accept-Language');
  });

  it('composes with an existing Vary value', async () => {
    const ctx = context({});
    ctx.response.appendHeader('Vary', 'Origin');
    await localeMiddleware({ supportedLocales: SUPPORTED })(ctx, () => Promise.resolve());
    expect(ctx.response.snapshot().headers.get('vary')).toBe('Origin, Accept-Language, Cookie');
  });

  it('writes Content-Language from the FINAL locale after a replaceLocale', async () => {
    const ctx = await run({ acceptLanguage: 'fr' }, {}, (c) => replaceLocale(c.request, 'de'));
    expect(ctx.response.snapshot().headers.get('content-language')).toBe('de');
  });

  it('preserves a handler-set Content-Language', async () => {
    const ctx = await run({}, {}, (c) => {
      c.response.header('Content-Language', 'en-x-custom');
    });
    expect(ctx.response.snapshot().headers.get('content-language')).toBe('en-x-custom');
  });

  it('writes no Content-Language for an unsupported final locale', async () => {
    const ctx = await run({}, {}, (c) => replaceLocale(c.request, 'en\r\nX: 1'));
    expect(ctx.response.snapshot().headers.has('content-language')).toBe(false);
  });

  it('writes no Content-Language when next() rejects, and propagates', async () => {
    const ctx = context({ acceptLanguage: 'de' });
    const failing = localeMiddleware({ supportedLocales: SUPPORTED })(
      ctx,
      () => Promise.reject(new Error('handler failed')),
    );
    await expect(failing).rejects.toThrow('handler failed');
    expect(ctx.response.snapshot().headers.has('content-language')).toBe(false);
    expect(ctx.response.snapshot().headers.get('vary')).toBe('Accept-Language, Cookie');
  });
});

describe('localeMiddleware — excluded paths', () => {
  it('skips the six operational paths by default, writing nothing', async () => {
    expect(DEFAULT_EXCLUDED_PATHS).toEqual([
      '/live',
      '/ready',
      '/health',
      '/metrics',
      '/openapi.json',
      '/docs',
    ]);
    for (const path of DEFAULT_EXCLUDED_PATHS as readonly string[]) {
      const ctx = await run({ path, query: { locale: 'de' } });
      expect(ctx.request.locale).toBeUndefined();
      expect(ctx.response.snapshot().headers.has('vary')).toBe(false);
    }
  });

  it('accepts a custom list, and [] disables exclusion', async () => {
    expect((await run({ path: '/private' }, { exclude: ['/private'] })).request.locale)
      .toBeUndefined();
    expect((await run({ path: '/health' }, { exclude: [] })).request.locale).toBe('en');
  });

  it('still calls next() on an excluded path', async () => {
    let called = false;
    await run({ path: '/health' }, {}, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe('localeMiddleware — tenant callback', () => {
  it('propagates a throw from the application callback', async () => {
    const ctx = context({ tenant: ACME });
    const middleware = localeMiddleware({
      supportedLocales: SUPPORTED,
      tenantLocale: () => {
        throw new Error('callback failed');
      },
    });
    await expect(middleware(ctx, () => Promise.resolve())).rejects.toThrow('callback failed');
  });

  it('ignores an unsupported tenant default', async () => {
    const ctx = await run({ tenant: { id: 't', metadata: { locale: 'tlh' } } }, {
      tenantLocale,
    });
    expect(ctx.request.locale).toBe('en');
  });
});
