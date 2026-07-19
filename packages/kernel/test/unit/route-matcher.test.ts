import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { isPathDecodable } from '../../src/router/route-matcher.ts';

describe('isPathDecodable', () => {
  it('returns true for a well-formed path', () => {
    expect(isPathDecodable('/users/hello%20world')).toBe(true);
  });

  it('returns true for a path with no percent-escapes', () => {
    expect(isPathDecodable('/users/123')).toBe(true);
  });

  it('returns false for a malformed percent-escape', () => {
    expect(isPathDecodable('/%zz')).toBe(false);
  });

  it('returns false for a truncated percent-escape', () => {
    expect(isPathDecodable('/foo%2')).toBe(false);
  });

  it('returns false for a bare percent sign', () => {
    expect(isPathDecodable('/users/123%')).toBe(false);
  });
});
