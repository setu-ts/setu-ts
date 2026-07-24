import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { hasMethods } from '../../src/providers/shape.ts';

describe('hasMethods', () => {
  it('accepts an object exposing every named method as a function', () => {
    expect(hasMethods({ a: () => {}, b: () => {} }, ['a', 'b'])).toBe(true);
  });

  it('rejects a missing method, a non-function member, a non-object, and null', () => {
    expect(hasMethods({ a: () => {} }, ['a', 'b'])).toBe(false);
    expect(hasMethods({ a: 1 }, ['a'])).toBe(false);
    expect(hasMethods('str', ['a'])).toBe(false);
    expect(hasMethods(null, ['a'])).toBe(false);
  });
});
