import { describe, expect, it } from 'vitest';
import { createPathCache } from '../../src/redaction/path-cache.ts';

describe('createPathCache', () => {
  it('should not store a path longer than the key bound', () => {
    const cache = createPathCache<string>(4, 8);
    cache.set('123456789', 'long');
    cache.set('12345678', 'at-bound');
    expect(cache.has('123456789')).toBe(false);
    expect(cache.get('123456789')).toBeUndefined();
    expect(cache.get('12345678')).toBe('at-bound');
  });

  it('should drop the oldest path at the entry bound and keep a re-set path in place', () => {
    const cache = createPathCache<number>(2, 8);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 3); // An existing key is replaced, not counted again.
    expect(cache.get('a')).toBe(3);
    expect(cache.has('b')).toBe(true);
    cache.set('c', 4);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(4);
  });

  it('should cache an undefined result as a known miss', () => {
    const cache = createPathCache<string | undefined>(2, 8);
    cache.set('miss', undefined);
    expect(cache.has('miss')).toBe(true);
    expect(cache.get('miss')).toBeUndefined();
  });
});
