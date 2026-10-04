import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { dateCacheSize, format, MissingPluralCountError } from '../../src/format/format.ts';

const EPOCH = new Date(0);

describe('format — placeholders', () => {
  it('substitutes named placeholders', () => {
    expect(format('Hello {name}', { name: 'Ada' }, 'en')).toBe('Hello Ada');
  });

  it('leaves a placeholder whose value is absent verbatim', () => {
    expect(format('Hello {name}, {missing}', { name: 'Ada' }, 'en')).toBe(
      'Hello Ada, {missing}',
    );
  });

  it('never resolves a placeholder through the prototype chain', () => {
    expect(format('{constructor} {toString}', {}, 'en')).toBe('{constructor} {toString}');
  });

  it('renders null and undefined as the empty string', () => {
    expect(format('[{a}][{b}]', { a: null, b: undefined }, 'en')).toBe('[][]');
  });

  it('renders other values with String()', () => {
    expect(format('{flag} {list}', { flag: true, list: [1, 2] }, 'en')).toBe('true 1,2');
  });

  it('escapes NOTHING — escaping belongs to the renderer', () => {
    expect(format('{x}', { x: '<b>&amp;' }, 'en')).toBe('<b>&amp;');
  });
});

describe('format — numbers', () => {
  it('formats a number per locale', () => {
    expect(format('{n}', { n: 1234.5 }, 'de-DE')).toBe('1.234,5');
    expect(format('{n}', { n: 1234.5 }, 'en')).toBe('1,234.5');
  });

  it('formats a bigint', () => {
    expect(format('{n}', { n: 1234567n }, 'en')).toBe('1,234,567');
  });
});

describe('format — dates', () => {
  it('formats a Date per locale in the given zone', () => {
    expect(format('{d}', { d: EPOCH }, 'en-GB', { timeZone: 'UTC' })).toBe('01/01/1970');
  });

  it('honours timeZone', () => {
    expect(format('{d}', { d: EPOCH }, 'en-GB', { timeZone: 'America/New_York' })).toBe(
      '31/12/1969',
    );
  });

  it('keys the date cache by locale AND zone (a per-locale cache would fail this)', () => {
    const utc = format('{d}', { d: EPOCH }, 'en-GB', { timeZone: 'UTC' });
    const ny = format('{d}', { d: EPOCH }, 'en-GB', { timeZone: 'America/New_York' });
    const utcAgain = format('{d}', { d: EPOCH }, 'en-GB', { timeZone: 'UTC' });
    expect([utc, ny, utcAgain]).toEqual(['01/01/1970', '31/12/1969', '01/01/1970']);
  });

  it('formats in the runtime zone when no zone is given', () => {
    const expected = new Intl.DateTimeFormat('en-GB').format(EPOCH);
    expect(format('{d}', { d: EPOCH }, 'en-GB')).toBe(expected);
  });

  it('renders an invalid Date as its string form instead of throwing', () => {
    expect(format('{d}', { d: new Date(Number.NaN) }, 'en')).toBe('Invalid Date');
  });

  it('bounds the date cache at 64 entries', () => {
    const zones = Intl.supportedValuesOf('timeZone').slice(0, 65);
    expect(zones).toHaveLength(65);
    for (const timeZone of zones) {
      format('{d}', { d: EPOCH }, 'en', { timeZone });
    }
    expect(dateCacheSize()).toBe(64);
  });
});

describe('format — plurals', () => {
  const items = { one: '{count} item', other: '{count} items' } as const;

  it('selects the form with Intl.PluralRules', () => {
    expect(format(items, { count: 1 }, 'en')).toBe('1 item');
    expect(format(items, { count: 3 }, 'en')).toBe('3 items');
  });

  it('selects "other" for count 0 in English, not "zero"', () => {
    expect(format({ zero: 'none', one: 'one', other: '{count} many' }, { count: 0 }, 'en')).toBe(
      '0 many',
    );
  });

  it('selects "two" in Arabic', () => {
    expect(format({ two: 'pair', other: 'many' }, { count: 2 }, 'ar')).toBe('pair');
  });

  it('falls back to "other" when the selected form is absent', () => {
    expect(format({ other: 'fallback' }, { count: 1 }, 'en')).toBe('fallback');
  });

  it('refuses a plural message without a finite count', () => {
    expect(() => format(items, {}, 'en')).toThrow(MissingPluralCountError);
    expect(() => format(items, { count: '3' }, 'en')).toThrow(MissingPluralCountError);
    expect(() => format(items, { count: Number.NaN }, 'en')).toThrow(MissingPluralCountError);
  });

  it('names the key when one is given', () => {
    const error = new MissingPluralCountError('cart.items');
    expect(error.key).toBe('cart.items');
    expect(error.message).toContain('cart.items');
    expect(new MissingPluralCountError().key).toBeUndefined();
  });
});
