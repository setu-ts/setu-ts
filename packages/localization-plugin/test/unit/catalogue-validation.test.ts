import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { validateCatalogues, validateSupportedLocales } from '../../src/catalogue/validate.ts';
import { DE, EN } from '../fixtures/catalogues.ts';

const noWarn = (): void => {};

describe('validateSupportedLocales', () => {
  it('canonicalizes and keeps the configured order', () => {
    expect(validateSupportedLocales(['en', 'de-at'])).toEqual(['en', 'de-AT']);
  });

  it('refuses an empty list or a non-array', () => {
    expect(() => validateSupportedLocales([])).toThrow('non-empty array');
    expect(() => validateSupportedLocales('en')).toThrow('non-empty array');
  });

  it('refuses a non-string entry', () => {
    expect(() => validateSupportedLocales(['en', 7])).toThrow('must be a string');
  });

  it('refuses a malformed tag, naming it', () => {
    expect(() => validateSupportedLocales(['en_US'])).toThrow('"en_US" is not a valid BCP 47 tag');
  });

  it('refuses a tag the runtime Intl has no data for', () => {
    expect(() => validateSupportedLocales(['tlh'])).toThrow('has no locale data');
  });

  it('accepts a private-use tag the runtime resolves', () => {
    expect(validateSupportedLocales(['en-GB-x-acme'])).toEqual(['en-GB-x-acme']);
  });

  it('refuses a duplicate after canonicalization', () => {
    expect(() => validateSupportedLocales(['de-AT', 'de-at'])).toThrow('lists "de-AT" twice');
  });
});

describe('validateCatalogues', () => {
  it('accepts complete catalogues and returns Maps', () => {
    const store = validateCatalogues(['en', 'de'], { en: EN, de: DE }, false, noWarn);
    expect(store.supported).toEqual(['en', 'de']);
    expect(store.messages.get('de')?.get('greeting')).toBe('Hallo {name}');
  });

  it('canonicalizes catalogue keys', () => {
    const store = validateCatalogues(['de-AT'], { 'de-at': { a: 'x' } }, false, noWarn);
    expect(store.messages.get('de-AT')?.get('a')).toBe('x');
  });

  it('keeps prototype-named keys as ordinary keys', () => {
    const raw = JSON.parse('{"en":{"__proto__":"p","constructor":"c"}}');
    const store = validateCatalogues(['en'], raw, false, noWarn);
    expect(store.messages.get('en')?.get('__proto__')).toBe('p');
    expect(store.messages.get('en')?.get('constructor')).toBe('c');
  });

  it('refuses a non-object catalogue set', () => {
    expect(() => validateCatalogues(['en'], null, false, noWarn)).toThrow('keyed by locale tag');
    expect(() => validateCatalogues(['en'], [], false, noWarn)).toThrow('keyed by locale tag');
  });

  it('refuses a catalogue for an unsupported or malformed tag', () => {
    expect(() => validateCatalogues(['en'], { en: EN, fr: {} }, false, noWarn)).toThrow(
      'supplied for "fr", which is not in supportedLocales',
    );
    expect(() => validateCatalogues(['en'], { en: EN, en_US: {} }, false, noWarn)).toThrow(
      'supplied for "en_US"',
    );
  });

  it('refuses two catalogues that canonicalize to one tag', () => {
    expect(() => validateCatalogues(['de'], { de: {}, DE: {} }, false, noWarn)).toThrow(
      'two catalogues canonicalize to "de"',
    );
  });

  it('refuses a non-object catalogue', () => {
    expect(() => validateCatalogues(['en'], { en: 'nope' }, false, noWarn)).toThrow(
      'catalogue for en must be an object',
    );
  });

  it('refuses a default locale with no catalogue', () => {
    expect(() => validateCatalogues(['en', 'de'], { de: DE }, false, noWarn)).toThrow(
      'default locale en has no catalogue',
    );
  });

  it('refuses a malformed message, naming the key', () => {
    for (
      const bad of [
        7,
        null,
        ['x'],
        { one: 'x' },
        { other: 7 },
        { other: 'x', several: 'y' },
        { other: 'x', one: 1 },
      ]
    ) {
      expect(() => validateCatalogues(['en'], { en: { k: bad } }, false, noWarn)).toThrow(
        'message "k" in locale en',
      );
    }
  });

  it('copies a plural record so the caller cannot mutate it later', () => {
    const forms = { one: 'x', other: 'y' };
    const store = validateCatalogues(['en'], { en: { k: forms } }, false, noWarn);
    forms.other = 'mutated';
    expect(store.messages.get('en')?.get('k')).toEqual({ one: 'x', other: 'y' });
  });

  it('refuses a locale missing default keys, naming the first ten', () => {
    const en = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'x']));
    let message = '';
    try {
      validateCatalogues(['en', 'de'], { en, de: { k0: 'y' } }, false, noWarn);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('locale de lacks 11 key(s)');
    expect(message).toContain('k1, k2');
    expect(message).toContain('and 1 more');
    expect(message).toContain('allowPartialCatalogues');
  });

  it('refuses a supported locale with no catalogue at all', () => {
    expect(() => validateCatalogues(['en', 'de'], { en: EN }, false, noWarn)).toThrow(
      'locale de lacks 3 key(s)',
    );
  });

  it('warns once per incomplete locale under allowPartialCatalogues', () => {
    const warnings: string[] = [];
    const store = validateCatalogues(
      ['en', 'de', 'fr'],
      { en: EN, de: { title: 'Warenkorb' } },
      true,
      (message) => warnings.push(message),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('locale de lacks 2 key(s)');
    expect(warnings[1]).toContain('locale fr lacks 3 key(s)');
    expect(store.messages.get('fr')?.size).toBe(0);
  });
});
