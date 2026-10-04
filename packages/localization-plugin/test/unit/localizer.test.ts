import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILocalizer, ILogger } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createTestContext, MockServiceRegistry } from '@setu-ts/testing';

import { validateCatalogues } from '../../src/catalogue/validate.ts';
import { MissingMessageError, UnsupportedLocaleError } from '../../src/errors.ts';
import { MissingPluralCountError } from '../../src/format/format.ts';
import { createLocalizer, localizerFor, warnedKeyCount } from '../../src/service/localizer.ts';
import { CATALOGUES, EN } from '../fixtures/catalogues.ts';

interface Warning {
  readonly message: string;
  readonly meta: unknown;
}

function recordingLogger(): { logger: ILogger; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const logger = {
    warn: (message: string, meta?: unknown) => warnings.push({ message, meta }),
  } as unknown as ILogger;
  return { logger, warnings };
}

function localizer(
  options: {
    onMissing?: 'key' | 'throw';
    timeZone?: string;
    partial?: boolean;
    logger?: ILogger;
  } = {},
): ILocalizer {
  const store = options.partial === true
    ? validateCatalogues(['en', 'de'], { en: EN, de: { title: 'Warenkorb' } }, true, () => {})
    : validateCatalogues(['en', 'de', 'fr'], CATALOGUES, false, () => {});
  return createLocalizer({
    store,
    onMissing: options.onMissing ?? 'key',
    timeZone: options.timeZone,
    logger: () => options.logger,
  });
}

describe('createLocalizer', () => {
  it('is bound to the default locale and lists the supported set', () => {
    const service = localizer();
    expect(service.locale).toBe('en');
    expect(service.locales).toEqual(['en', 'de', 'fr']);
    expect(service.t('greeting', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('formats plurals through the shared formatter', () => {
    expect(localizer().forLocale('fr').t('items', { count: 2 })).toBe('2 articles');
  });

  it('keeps t and forLocale working when destructured', () => {
    const { t, forLocale } = localizer();
    expect(t('title')).toBe('Cart');
    expect(forLocale('de').t('title')).toBe('Warenkorb');
  });

  it('returns the same bound instance for the same tag', () => {
    const service = localizer();
    expect(service.forLocale('de')).toBe(service.forLocale('de'));
    expect(service.forLocale('en')).toBe(service);
  });

  it('accepts a non-canonical spelling of a supported tag', () => {
    expect(localizer().forLocale('DE').locale).toBe('de');
  });

  it('refuses an unsupported or malformed tag', () => {
    expect(() => localizer().forLocale('es')).toThrow(UnsupportedLocaleError);
    expect(() => localizer().forLocale('en_US')).toThrow(UnsupportedLocaleError);
    const error = new UnsupportedLocaleError('x'.repeat(80), ['en']);
    expect(error.message).toContain('…');
    expect(error.locale).toHaveLength(80);
  });

  it('passes timeZone to the formatter', () => {
    const service = createLocalizer({
      store: validateCatalogues(['en-GB'], { 'en-GB': { d: '{d}' } }, false, () => {}),
      onMissing: 'key',
      timeZone: 'America/New_York',
      logger: () => undefined,
    });
    expect(service.t('d', { d: new Date(0) })).toBe('31/12/1969');
  });

  it('names the key when a plural message lacks a count', () => {
    let error: unknown;
    try {
      localizer().t('items');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MissingPluralCountError);
    expect((error as MissingPluralCountError).key).toBe('items');
    expect((error as Error).cause).toBeInstanceOf(MissingPluralCountError);
  });

  it('rethrows a formatter error that is not a missing count', () => {
    const service = createLocalizer({
      store: validateCatalogues(['en'], { en: { n: '{n}' } }, false, () => {}),
      onMissing: 'key',
      timeZone: undefined,
      logger: () => undefined,
    });
    const hostile = {
      get n() {
        throw new SyntaxError('boom');
      },
    };
    expect(() => service.t('n', hostile)).toThrow(SyntaxError);
  });
});

describe('missing keys', () => {
  it('answers the key and warns once per key', () => {
    const { logger, warnings } = recordingLogger();
    const service = localizer({ logger });
    expect(service.t('nope')).toBe('nope');
    expect(service.t('nope')).toBe('nope');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta).toEqual({ key: 'nope', locale: 'en' });
  });

  it('truncates a long key in the warning', () => {
    const { logger, warnings } = recordingLogger();
    localizer({ logger }).t('k'.repeat(100));
    expect((warnings[0]?.meta as { key: string }).key).toHaveLength(65);
  });

  it('caps the warned-key set at 256, with one cap warning', () => {
    const { logger, warnings } = recordingLogger();
    const service = localizer({ logger });
    for (let i = 0; i < 300; i++) {
      service.t(`missing-${i}`);
    }
    expect(warnings).toHaveLength(257);
    expect(warnings[256]?.message).toContain('256 distinct missing message keys');
    expect(warnedKeyCount(service)).toBe(256);
  });

  it('survives a missing logger', () => {
    expect(localizer().t('nope')).toBe('nope');
  });

  it('throws MissingMessageError under onMissing: throw', () => {
    let error: unknown;
    try {
      localizer({ onMissing: 'throw' }).forLocale('de').t('nope');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MissingMessageError);
    expect((error as MissingMessageError).key).toBe('nope');
    expect((error as MissingMessageError).locale).toBe('de');
    expect(new MissingMessageError('k'.repeat(80), 'en').message).toContain('…');
  });

  it('serves the default locale for a key a partial catalogue lacks, without warning', () => {
    const { logger, warnings } = recordingLogger();
    const de = localizer({ partial: true, logger }).forLocale('de');
    expect(de.t('greeting', { name: 'Ada' })).toBe('Hello Ada');
    expect(de.t('title')).toBe('Warenkorb');
    expect(warnings).toHaveLength(0);
  });

  it('reports no count for a localizer it did not create', () => {
    const foreign: ILocalizer = localizer().forLocale('de');
    expect(warnedKeyCount(foreign)).toBeUndefined();
  });
});

describe('localizerFor', () => {
  function context(locale?: string) {
    const services = new MockServiceRegistry();
    services.register(CAPABILITIES.LOCALIZATION, localizer());
    return createTestContext({
      services,
      ...(locale === undefined ? {} : { request: { locale } }),
    });
  }

  it('binds to the request locale', () => {
    expect(localizerFor(context('de')).t('title')).toBe('Warenkorb');
  });

  it('falls back to the default locale when the request has none', () => {
    expect(localizerFor(context()).locale).toBe('en');
  });

  it('negotiates an unsupported request locale instead of throwing', () => {
    expect(localizerFor(context('de-CH')).locale).toBe('de');
    expect(localizerFor(context('es')).locale).toBe('en');
  });

  it('reaches the same implementation as forLocale (one capability, one implementation)', () => {
    const ctx = context('fr');
    const service = ctx.services.get<ILocalizer>(CAPABILITIES.LOCALIZATION);
    const values = { name: 'Ada', count: 2 };
    expect(localizerFor(ctx).t('greeting', values)).toBe(
      service.forLocale('fr').t('greeting', values),
    );
    expect(localizerFor(ctx).t('items', values)).toBe(service.forLocale('fr').t('items', values));
    expect(localizerFor(ctx)).toBe(service.forLocale('fr'));
  });
});
