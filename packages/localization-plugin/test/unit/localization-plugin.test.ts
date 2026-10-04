import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILocalizer, MessageCatalogue } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import type { LocalizationPluginOptions } from '../../src/interfaces/index.ts';
import { LocalizationPlugin } from '../../src/plugin/localization-plugin.ts';
import { CATALOGUES, EN } from '../fixtures/catalogues.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

const BASE = { supportedLocales: ['en', 'de', 'fr'], catalogues: CATALOGUES } as const;

describe('LocalizationPlugin — construction refusals', () => {
  it('refuses invalid supported locales', () => {
    expect(() => LocalizationPlugin({ ...BASE, supportedLocales: [] })).toThrow('non-empty');
  });

  it('refuses both and neither of catalogues/source at runtime too', () => {
    const both = { ...BASE, source: { load: () => Promise.resolve({}) } };
    expect(() => LocalizationPlugin(both as unknown as LocalizationPluginOptions)).toThrow(
      'exactly one of `catalogues`',
    );
    const neither = { supportedLocales: ['en'] };
    expect(() => LocalizationPlugin(neither as unknown as LocalizationPluginOptions)).toThrow(
      'exactly one of `catalogues`',
    );
  });

  it('refuses both and neither at compile time', () => {
    const load = () => Promise.resolve({});
    // @ts-expect-error — both arms supplied
    const both: LocalizationPluginOptions = { ...BASE, source: { load } };
    // @ts-expect-error — neither arm supplied
    const neither: LocalizationPluginOptions = { supportedLocales: ['en'] };
    void both;
    void neither;
  });

  it('refuses an unknown or non-string timeZone, naming it', () => {
    expect(() => LocalizationPlugin({ ...BASE, timeZone: 'Mars/Base' })).toThrow(
      'timeZone "Mars/Base"',
    );
    expect(() => LocalizationPlugin({ ...BASE, timeZone: 7 as unknown as string })).toThrow(
      'timeZone 7',
    );
  });

  it('refuses a non-integer middleware priority', () => {
    for (const priority of [45.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => LocalizationPlugin({ ...BASE, middleware: { priority } })).toThrow(
        'must be an integer',
      );
    }
  });

  it('refuses a Cache-Control value no response could carry', () => {
    for (const cacheControl of ['no-store\r\nX-Injected: 1', 7 as unknown as string]) {
      expect(() =>
        LocalizationPlugin({ ...BASE, exposeCatalogues: { basePath: '/i18n', cacheControl } })
      ).toThrow('exposeCatalogues.cacheControl is not a valid header value');
    }
  });

  it('refuses a bad catalogue basePath', () => {
    for (const basePath of ['i18n', '/i18n/:x', '/i18n/*', 7 as unknown as string]) {
      expect(() => LocalizationPlugin({ ...BASE, exposeCatalogues: { basePath } })).toThrow(
        'exposeCatalogues.basePath',
      );
    }
  });
});

describe('LocalizationPlugin — metadata', () => {
  it('provides the localization token and orders after the logger only', () => {
    const plugin = LocalizationPlugin(BASE);
    expect(plugin.name).toBe('localization-plugin');
    expect(plugin.provides).toEqual([CAPABILITIES.LOCALIZATION]);
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.LOGGER]);
    expect(plugin.dependencies).toBeUndefined();
  });
});

describe('LocalizationPlugin — register()', () => {
  it('registers the localizer, the middleware at 45, and the health indicator', async () => {
    const fake = createFakeContext();
    await LocalizationPlugin(BASE).register(fake.ctx);
    const service = fake.services.get(CAPABILITIES.LOCALIZATION) as ILocalizer;
    expect(service.forLocale('de').t('title')).toBe('Warenkorb');
    expect(fake.middleware).toHaveLength(1);
    expect(fake.middleware[0]?.options).toEqual({ priority: 45, name: 'locale' });
    expect(fake.routes.size).toBe(0);
    const health = await fake.health.get('localization')?.();
    expect(health).toEqual({
      status: 'up',
      data: { locales: 3, default: 'en', source: 'static' },
    });
  });

  it('honours middleware.priority and enabled: false', async () => {
    const moved = createFakeContext();
    await LocalizationPlugin({ ...BASE, middleware: { priority: 310 } }).register(moved.ctx);
    expect(moved.middleware[0]?.options?.priority).toBe(310);

    const off = createFakeContext();
    await LocalizationPlugin({ ...BASE, middleware: { enabled: false } }).register(off.ctx);
    expect(off.middleware).toHaveLength(0);
  });

  it('threads middleware settings and tenantLocale into the middleware', async () => {
    const fake = createFakeContext();
    await LocalizationPlugin({
      ...BASE,
      tenantLocale: () => 'fr',
      middleware: { query: 'lang', cookie: false, exclude: [] },
    }).register(fake.ctx);
    // Observed through the middleware's behaviour rather than its options,
    // which are closed over.
    const { createTestContext } = await import('@setu-ts/testing');
    const ctx = createTestContext({
      request: { url: 'http://localhost/health', tenant: { id: 't' } },
      query: { lang: 'de' },
    });
    await fake.middleware[0]?.fn(ctx, () => Promise.resolve());
    expect(ctx.request.locale).toBe('de');
    expect(ctx.response.snapshot().headers.get('vary')).toBe('Accept-Language');

    const fallback = createTestContext({
      request: { url: 'http://localhost/x', tenant: { id: 't' } },
    });
    await fake.middleware[0]?.fn(fallback, () => Promise.resolve());
    expect(fallback.request.locale).toBe('fr');
  });

  it('loads a source once, reports it in health, and validates its result', async () => {
    let loads = 0;
    const fake = createFakeContext();
    await LocalizationPlugin({
      supportedLocales: ['en'],
      source: {
        name: 'kv',
        load: () => {
          loads++;
          return Promise.resolve({ en: EN });
        },
      },
    }).register(fake.ctx);
    expect(loads).toBe(1);
    expect((await fake.health.get('localization')?.())?.data).toEqual({
      locales: 1,
      default: 'en',
      source: 'injected:kv',
    });

    const unnamed = createFakeContext();
    await LocalizationPlugin({
      supportedLocales: ['en'],
      source: { load: () => Promise.resolve({ en: EN }) },
    }).register(unnamed.ctx);
    expect((await unnamed.health.get('localization')?.())?.data).toMatchObject({
      source: 'injected',
    });
  });

  it('fails register() when the source rejects or loads an invalid catalogue', async () => {
    const rejecting = LocalizationPlugin({
      supportedLocales: ['en'],
      source: { load: () => Promise.reject(new Error('store down')) },
    });
    await expect(rejecting.register(createFakeContext().ctx)).rejects.toThrow('store down');

    const invalid = LocalizationPlugin({
      supportedLocales: ['en', 'de'],
      source: { load: () => Promise.resolve({ en: EN }) },
    });
    await expect(invalid.register(createFakeContext().ctx)).rejects.toThrow('locale de lacks');
  });

  it('warns through ctx.logger for a partial catalogue, and survives without one', async () => {
    const partial: LocalizationPluginOptions = {
      supportedLocales: ['en', 'de'],
      catalogues: { en: EN, de: { title: 'Warenkorb' } as MessageCatalogue },
      allowPartialCatalogues: true,
    };
    const fake = createFakeContext();
    await LocalizationPlugin(partial).register(fake.ctx);
    expect(fake.logs.filter((line) => line.level === 'warn')).toHaveLength(1);

    const silent = createFakeContext(false);
    await LocalizationPlugin(partial).register(silent.ctx);
    expect(silent.services.has(CAPABILITIES.LOCALIZATION)).toBe(true);
  });

  it('reads ctx.logger at call time for a missing key on the registered service', async () => {
    const fake = createFakeContext();
    await LocalizationPlugin(BASE).register(fake.ctx);
    const service = fake.services.get(CAPABILITIES.LOCALIZATION) as ILocalizer;
    expect(service.t('nope')).toBe('nope');
    expect(fake.logs.filter((line) => line.level === 'warn').map((line) => line.message))
      .toEqual(['localization-plugin: no catalogue defines this message key']);
  });

  it('honours onMissing and timeZone on the registered service', async () => {
    const fake = createFakeContext();
    await LocalizationPlugin({
      supportedLocales: ['en-GB'],
      catalogues: { 'en-GB': { d: '{d}' } },
      onMissing: 'throw',
      timeZone: 'America/New_York',
    }).register(fake.ctx);
    const service = fake.services.get(CAPABILITIES.LOCALIZATION) as ILocalizer;
    expect(service.t('d', { d: new Date(0) })).toBe('31/12/1969');
    expect(() => service.t('nope')).toThrow('No catalogue defines message "nope"');
  });

  it('registers the catalogue route when exposeCatalogues is set', async () => {
    const fake = createFakeContext();
    await LocalizationPlugin({ ...BASE, exposeCatalogues: { basePath: '/i18n/' } }).register(
      fake.ctx,
    );
    expect([...fake.routes.keys()]).toEqual(['/i18n/:locale']);

    const root = createFakeContext();
    await LocalizationPlugin({ ...BASE, exposeCatalogues: { basePath: '/' } }).register(root.ctx);
    expect([...root.routes.keys()]).toEqual(['/:locale']);
  });
});
