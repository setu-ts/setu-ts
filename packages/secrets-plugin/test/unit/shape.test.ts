import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { hasMethods } from '../../src/providers/shape.ts';

describe('hasMethods', () => {
  it('returns true when every named method is a function', () => {
    expect(hasMethods({ a: () => {}, b: () => {} }, ['a', 'b'])).toBe(true);
    expect(hasMethods({ a: () => {} }, [])).toBe(true);
  });

  it('returns false for non-objects and missing methods', () => {
    expect(hasMethods(null, ['a'])).toBe(false);
    expect(hasMethods('x', ['a'])).toBe(false);
    expect(hasMethods({ a: 1 }, ['a'])).toBe(false);
    expect(hasMethods({ a: () => {} }, ['a', 'b'])).toBe(false);
  });
});
