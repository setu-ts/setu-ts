import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isPathDecodable,
  parsePattern,
  staticSegmentCount,
  wildcardSegmentCount,
} from '../../src/router/route-matcher.ts';

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

describe('parsePattern segment kinds', () => {
  it('classifies a bare `*` as a wildcard, not a static segment (M70g)', () => {
    expect(parsePattern('/*')).toEqual([{ type: 'wildcard' }]);
    expect(parsePattern('/assets/*')).toEqual([
      { type: 'static', value: 'assets' },
      { type: 'wildcard' },
    ]);
  });

  it('classifies a segment merely CONTAINING an asterisk as static', () => {
    // Deliberate: `/a*` matches literally in Hono, so lowering its specificity
    // would demote a pattern that names its own text.
    expect(parsePattern('/a*')).toEqual([{ type: 'static', value: 'a*' }]);
  });

  it('still classifies `:name` as a param and `/` as one static segment', () => {
    expect(parsePattern('/a/:id')).toEqual([
      { type: 'static', value: 'a' },
      { type: 'param', name: 'id' },
    ]);
    expect(parsePattern('/')).toEqual([{ type: 'static', value: '' }]);
  });
});

describe('segment counting', () => {
  it('excludes wildcards from the static count', () => {
    expect(staticSegmentCount(parsePattern('/*'))).toBe(0);
    expect(staticSegmentCount(parsePattern('/assets/*'))).toBe(1);
    expect(staticSegmentCount(parsePattern('/openapi.json'))).toBe(1);
  });

  it('counts wildcards, and only wildcards', () => {
    expect(wildcardSegmentCount(parsePattern('/*'))).toBe(1);
    expect(wildcardSegmentCount(parsePattern('/a/*/b'))).toBe(1);
    expect(wildcardSegmentCount(parsePattern('/a/:id'))).toBe(0);
    expect(wildcardSegmentCount(parsePattern('/a/b'))).toBe(0);
  });
});
