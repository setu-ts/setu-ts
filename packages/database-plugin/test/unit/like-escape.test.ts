/**
 * Unit tests for the shared `escapeLikePattern` helper.
 *
 * Input→output shown literally for `%`, `_`, `\`, and a mixed value, plus
 * identity for a value with no metacharacter.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { escapeLikePattern } from '../../src/query/like-escape.ts';

describe('escapeLikePattern', () => {
  it('escapes a bare % to \\%', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
  });

  it('escapes a bare _ to \\_', () => {
    expect(escapeLikePattern('_')).toBe('\\_');
  });

  it('escapes a bare backslash to \\\\', () => {
    expect(escapeLikePattern('\\')).toBe('\\\\');
  });

  it('escapes a mixed value, backslash first so it is not double-mangled', () => {
    // A value that already contains a backslash: the backslash is escaped
    // first, then the metacharacters, so the result is unambiguous.
    expect(escapeLikePattern('50% off')).toBe('50\\% off');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('is the identity for a value with no metacharacter', () => {
    expect(escapeLikePattern('plain')).toBe('plain');
    expect(escapeLikePattern('50 off')).toBe('50 off');
  });
});
