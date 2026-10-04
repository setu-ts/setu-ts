import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { negotiateLocale } from '../../src/format/negotiate.ts';

const SUPPORTED = ['en', 'de', 'fr'];

describe('negotiateLocale', () => {
  it('matches exactly', () => {
    expect(negotiateLocale(['de'], SUPPORTED)).toBe('de');
  });

  it('canonicalizes the candidate first (de-at → de-AT → de)', () => {
    expect(negotiateLocale(['de-at'], SUPPORTED)).toBe('de');
  });

  it('strips subtags right to left across three subtags', () => {
    expect(negotiateLocale(['de-Latn-AT'], SUPPORTED)).toBe('de');
    expect(negotiateLocale(['de-Latn-AT'], ['de-Latn', 'de'])).toBe('de-Latn');
  });

  it('prefers the first candidate that matches', () => {
    expect(negotiateLocale(['es', 'fr', 'de'], SUPPORTED)).toBe('fr');
  });

  it('treats a malformed tag as no match, never a throw', () => {
    for (const tag of ['en_US', '', 'x'.repeat(40), 'de\u0000']) {
      expect(negotiateLocale([tag], SUPPORTED)).toBeUndefined();
    }
  });

  it('answers undefined when nothing matches', () => {
    expect(negotiateLocale(['tlh', 'es'], SUPPORTED)).toBeUndefined();
  });

  it('returns the supported spelling as configured', () => {
    expect(negotiateLocale(['DE-at'], ['en', 'de-AT'])).toBe('de-AT');
  });

  it('resolves * to the first supported locale', () => {
    expect(negotiateLocale(['*'], SUPPORTED)).toBe('en');
  });

  it('honours a q=0 exclusion under *: en;q=0, * selects fr when en is the default', () => {
    expect(negotiateLocale(['*'], ['en', 'fr'], ['en'])).toBe('fr');
  });

  it('excludes by subtag prefix, not the other way round', () => {
    // `en-US;q=0` excludes en-US but not en.
    expect(negotiateLocale(['*'], ['en', 'en-US'], ['en-US'])).toBe('en');
    // `en;q=0` excludes en and en-US alike.
    expect(negotiateLocale(['*'], ['en-US', 'fr'], ['EN'])).toBe('fr');
  });

  it('lets * match nothing when every locale is excluded, and moves on', () => {
    expect(negotiateLocale(['*'], ['en', 'fr'], ['en', 'fr'])).toBeUndefined();
    expect(negotiateLocale(['*', 'fr'], ['en', 'fr'], ['*'])).toBe('fr');
  });

  it('applies exclusion to * only', () => {
    expect(negotiateLocale(['en'], ['en', 'fr'], ['en'])).toBe('en');
  });
});
