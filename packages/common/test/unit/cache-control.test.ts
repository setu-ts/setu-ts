import { describe, expect, it } from 'vitest';

import { cacheControlDirectives } from '../../src/index.ts';

describe('cacheControlDirectives', () => {
  it.each([
    ['public, max-age=60', ['public', 'max-age']],
    ['PRIVATE="set-cookie", No-Store', ['private', 'no-store']],
    ['max-age=60, example="one,public,two"', ['max-age', 'example']],
    ['example="a\\",public", max-age=60', ['example', 'max-age']],
    ['', ['']],
  ] as const)('reads %j as its directive names', (value, names) => {
    expect(cacheControlDirectives(value)).toEqual(names);
  });

  it('returns undefined for a quoted-string that never closes', () => {
    expect(cacheControlDirectives('public, x="a, private')).toBeUndefined();
  });
});
