import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { parseAcceptLanguage } from '../../src/format/negotiate.ts';

describe('parseAcceptLanguage', () => {
  it('answers an empty parse for a missing header', () => {
    expect(parseAcceptLanguage(null)).toEqual({ preferred: [], excluded: [] });
    expect(parseAcceptLanguage(undefined)).toEqual({ preferred: [], excluded: [] });
    expect(parseAcceptLanguage('')).toEqual({ preferred: [], excluded: [] });
  });

  it('orders by q descending, stable on ties', () => {
    expect(parseAcceptLanguage('fr;q=0.5, de, en;q=0.5, es').preferred).toEqual([
      'de',
      'es',
      'fr',
      'en',
    ]);
  });

  it('returns q=0 ranges in excluded', () => {
    expect(parseAcceptLanguage('de, en;q=0, *')).toEqual({
      preferred: ['de', '*'],
      excluded: ['en'],
    });
    expect(parseAcceptLanguage('en;q=0.000').excluded).toEqual(['en']);
  });

  it('reads Q= case-insensitively and ignores other parameters', () => {
    expect(parseAcceptLanguage('de;Q=0, fr;foo=bar').excluded).toEqual(['de']);
    expect(parseAcceptLanguage('de;Q=0, fr;foo=bar').preferred).toEqual(['fr']);
  });

  it('treats a malformed q as 1', () => {
    for (const q of ['2', '0.1234', 'abc', '-1', '1.5']) {
      expect(parseAcceptLanguage(`fr;q=0.5, de;q=${q}`).preferred).toEqual(['de', 'fr']);
    }
  });

  it('drops an empty range and one longer than 35 characters', () => {
    expect(parseAcceptLanguage(` , ${'a'.repeat(36)}, ${'b'.repeat(35)}`).preferred).toEqual([
      'b'.repeat(35),
    ]);
  });

  it('reads at most 16 ranges from a 64 KiB header', () => {
    const header = Array.from({ length: 64 * 1024 / 4 }, () => 'de-x').join(',');
    expect(header.length).toBeGreaterThan(64 * 1000);
    const parsed = parseAcceptLanguage(header);
    expect(parsed.preferred.length + parsed.excluded.length).toBe(16);
  });

  it('slices before splitting: a range past 1024 characters is never read', () => {
    const header = `${'x'.repeat(1030)}, de`;
    expect(parseAcceptLanguage(header).preferred).toEqual([]);
  });
});
